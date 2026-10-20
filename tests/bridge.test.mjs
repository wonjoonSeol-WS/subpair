import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask, unmask, MASKS, systemPrompt, parseTranslations, translateChunk, buildUser, ValidationError } from '../bridge/backends/llm.mjs';
import { askOpenai, openaiReady } from '../bridge/backends/openai.mjs';
import { askApi } from '../bridge/backends/api.mjs';
import { postJson, retryAfterMs } from '../bridge/backends/http.mjs';
import { askClaude, childEnv, claudeProbe } from '../bridge/backends/claude.mjs';
import { findCommand, spawnPlan } from '../bridge/backends/command.mjs';
import { EzTrans } from '../bridge/backends/eztrans.mjs';
import { cacheIdFor } from '../bridge/backends/index.mjs';
import { WorkQueue, LIVE, JOB } from '../bridge/queue.mjs';
import { Store, migrateLegacyStore } from '../bridge/store.mjs';
import { createBridge } from '../bridge/server.mjs';
import { loadConfig, defaultStoreDir, BRIDGE_DIR, BUNDLED_EZTRANS_HELPER } from '../bridge/config.mjs';
import { parseSrt, toSrt } from '../src/srt.js';
import { textsHash } from '../src/hash.js';
import { ERRORS, fill, backendError } from '../bridge/errors.mjs';

// Settings for tests come from a fixture profile (small limits, fast timeouts) and an empty environment, so neither
// bridge/config.json nor BRIDGE_PORT / API keys of the machine running the tests change what is tested.
const TEST_CONFIG = fileURLToPath(new URL('./fixtures/bridge.test.config.json', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_HELPER = fileURLToPath(new URL('./fixtures/fake-eztrans.mjs', import.meta.url));
const testConfig = () => loadConfig(TEST_CONFIG, {});
const TEST_CFG = testConfig();
const L = TEST_CFG.limits;
const RETRY = TEST_CFG.llm;
const LLM = { ...TEST_CFG.llm, context: TEST_CFG.claude.context };
const KO = { from: 'ja', to: 'ko' }, EN = { from: 'ja', to: 'en' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(2); }
};
const winOnly = { skip: process.platform !== 'win32' && 'Windows only' };

// ---- SRT ----

test('toSrt and parseSrt roundtrip', () => {
  const cues = [{ start: 1.5, end: 3.25, text: 'a\nb' }, { start: 3661.001, end: 3662, text: 'c' }];
  assert.deepEqual(parseSrt(toSrt(cues)), cues);
});

// ---- LLM prompt, masks and reply validation ----

test('masks hide the three special symbols and restore them exactly', () => {
  const text = 'a\u2014b \u30fbc \u00b7d';
  const m = mask(text);
  for (const [sym] of MASKS) assert.ok(!m.includes(sym), `still contains ${sym.charCodeAt(0).toString(16)}`);
  assert.equal(unmask(m), text);
});

test('prompts name the language pair and every placeholder exactly as sent', () => {
  const ja = systemPrompt({ from: 'ja', to: 'ko' }), en = systemPrompt({ from: 'ja', to: 'en' });
  assert.match(ja, /from Japanese to Korean/);
  assert.match(en, /from Japanese to English/);
  assert.doesNotMatch(en, /Korean/);
  for (const [, token] of MASKS) assert.ok(ja.includes(token), token);
});

const chunkOf = (...texts) => texts.map((text, id) => ({ id, text: mask(text) }));
const reply = (...texts) => JSON.stringify({ translations: texts.map((text, id) => ({ id, text })) });
// A model stand-in: translates every cue it is given as "k<text>", except the cues `bad` says to answer with nothing.
const model = (calls, bad = () => false) => async (system, user) => {
  const t = JSON.parse(user).translate;
  calls.push(t.map((x) => x.id));
  return JSON.stringify({ translations: t.map((x) => ({ id: x.id, text: bad(x, t) ? '' : 'k' + x.text })) });
};

test('parseTranslations: accepts fenced JSON, any order, quoted ids, and tidies blank lines', () => {
  const chunk = chunkOf('a', 'b');
  const out = parseTranslations('```json\n' + JSON.stringify({ translations: [{ id: '1', text: ' B2 ' }, { id: 0, text: 'A\n\n\nA2' }] }) + '\n```', chunk);
  assert.deepEqual(out, ['A\nA2', 'B2']);
});

test('parseTranslations: rejects a missing, extra, duplicated or empty cue and a reply that is not JSON', () => {
  const chunk = chunkOf('a', 'b');
  assert.throws(() => parseTranslations(reply('x'), chunk), /missing \[1\]/);
  assert.throws(() => parseTranslations(reply('x', 'y', 'z'), chunk), /unexpected \[2\]/);
  // A duplicate next to a complete set: the right ids are all there, one of them twice.
  assert.throws(() => parseTranslations(JSON.stringify({ translations: [{ id: 0, text: 'x' }, { id: 0, text: 'y' }, { id: 1, text: 'z' }] }), chunk), /cue 0 came back twice/);
  assert.throws(() => parseTranslations(JSON.stringify({ translations: [{ id: 0, text: 'x' }, { id: 7, text: 'y' }] }), chunk), /missing \[1\], unexpected \[7\]/);
  assert.throws(() => parseTranslations(JSON.stringify({ translations: [{ id: 'zero', text: 'x' }, { id: 1, text: 'y' }] }), chunk), /missing \[0\]/);
  assert.throws(() => parseTranslations(reply('x', '   '), chunk), /empty translation/);
  assert.throws(() => parseTranslations('sorry, I cannot', chunk), /no JSON/);
  assert.throws(() => parseTranslations('{"translations": 5}', chunk), /no translations array/);
});

test('parseTranslations: a dropped or duplicated placeholder is rejected, a kept one is restored', () => {
  const chunk = chunkOf('wait \u2014 here \u30fb there');
  assert.throws(() => parseTranslations(reply('T - x'), chunk), /placeholder \{\{EMDASH\}\}/);
  assert.throws(() => parseTranslations(reply('T {{EMDASH}} {{EMDASH}} {{MIDDOT}}'), chunk), /placeholder \{\{EMDASH\}\}/);
  assert.deepEqual(parseTranslations(reply('T {{EMDASH}} x {{MIDDOT}} y'), chunk), ['T \u2014 x \u30fb y']);
});

test('translateChunk: special symbols never reach the model and come back exactly; context is sent masked', async () => {
  const sent = [];
  const ask = async (system, user) => {
    sent.push(user);
    return JSON.stringify({ translations: JSON.parse(user).translate.map((t) => ({ id: t.id, text: 'T ' + t.text })) });
  };
  const out = await translateChunk(ask, ['wait \u2014 here \u30fb there \u00b7 end'], ['before \u2014 line'], { from: 'en', to: 'ko' }, LLM);
  assert.deepEqual(out, ['T wait \u2014 here \u30fb there \u00b7 end']);
  for (const [sym] of MASKS) assert.ok(!sent[0].includes(sym));
  assert.deepEqual(JSON.parse(sent[0]).context_before, [{ text: 'before {{EMDASH}} line' }]);
});

test('translateChunk: a reply that drops a placeholder is rejected and the chunk retried', async () => {
  let calls = 0;
  const ask = async (system, user) => {
    calls++;
    const t = JSON.parse(user).translate;
    return JSON.stringify({ translations: t.map((x) => ({ id: x.id, text: calls === 1 ? 'T - x' : 'T ' + x.text })) });
  };
  assert.deepEqual(await translateChunk(ask, ['wait \u2014 here'], [], { from: 'en', to: 'ko' }, LLM), ['T wait \u2014 here']);
  assert.equal(calls, 2);
});

test('translateChunk: a chunk the model only gets wrong when it is big is split, and every cue ends up translated', async () => {
  const calls = [];
  const out = await translateChunk(model(calls, (x, t) => t.length > 2 && x.id === t[0].id), ['1', '2', '3', '4'], [], KO, LLM);
  assert.deepEqual(out, ['k1', 'k2', 'k3', 'k4']);
  assert.deepEqual(calls.map((c) => c.length), [4, 4, 2, 2]);       // two attempts on the whole chunk, then one call per half
});

test('translateChunk: a cue that always fails comes back empty, the rest of the chunk is still translated', async () => {
  const calls = [];
  const texts = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const out = await translateChunk(model(calls, (x) => x.id === 7), texts, [], KO, { ...LLM, splitDepth: 10 });
  assert.equal(out[7], '');
  assert.deepEqual(out.filter((_, i) => i !== 7), texts.filter((_, i) => i !== 7).map((t) => 'k' + t));
  assert.ok(calls.some((ids) => ids.includes(39)), 'the half without the bad cue was never tried');
  assert.ok(calls.length <= 2 * (2 * 6 + 1), `too many calls: ${calls.length}`);   // two attempts per level on the bad cue's path, one per good half
});

test('translateChunk: at the split depth limit the part that still fails comes back empty, other parts are kept', async () => {
  const calls = [];
  const out = await translateChunk(model(calls, (x) => x.id === 0), ['a', 'b', 'c', 'd'], [], KO, { ...LLM, splitDepth: 1 });
  assert.deepEqual(out, ['', '', 'kc', 'kd']);                       // [a, b] cannot be split again; [c, d] succeeded
});

test('translateChunk: a single cue that always fails is given up after exactly the configured attempts', async () => {
  let calls = 0;
  assert.deepEqual(await translateChunk(async () => { calls++; return reply(''); }, ['x'], [], KO, LLM), ['']);
  assert.equal(calls, LLM.attempts);
});

test('translateChunk: context 0 sends no earlier lines at all', async () => {
  const users = [];
  await translateChunk(async (s, user) => { users.push(JSON.parse(user)); return reply('k'); }, ['x'], ['p1', 'p2'], KO, { ...LLM, context: 0 });
  assert.deepEqual(users[0].context_before, []);
});

test('translateChunk: ids and context follow the position inside a split chunk', async () => {
  const users = [];
  const ask = async (system, user) => {
    users.push(JSON.parse(user));
    const t = JSON.parse(user).translate;
    return JSON.stringify({ translations: (t.length > 1 ? [] : t).map((x) => ({ id: x.id, text: 'k' + x.text })) });
  };
  await translateChunk(ask, ['a', 'b', 'c', 'd'], ['pre'], KO, { ...LLM, context: 3 });
  const single = users.filter((u) => u.translate.length === 1);
  assert.deepEqual(single[0].translate, [{ id: 0, text: 'a' }]);
  assert.deepEqual(single[0].context_before, [{ text: 'pre' }]);
  assert.deepEqual(single[2].context_before, [{ text: 'pre' }, { text: 'a' }, { text: 'b' }]);
});

test('translateChunk: only an unusable reply is retried; a transport or auth error fails at once with no further calls', async () => {
  let calls = 0;
  await assert.rejects(translateChunk(async () => { calls++; throw new Error('Anthropic API 401: bad key'); }, ['a', 'b', 'c', 'd'], [], KO, LLM), /401/);
  assert.equal(calls, 1);
  calls = 0;
  assert.deepEqual(await translateChunk(async () => { calls++; return 'not json at all'; }, ['a'], [], KO, LLM), ['']);
  assert.equal(calls, LLM.attempts);
});

test('buildUser keeps line breaks inside a cue', () => {
  assert.deepEqual(JSON.parse(buildUser([{ id: 0, text: 'a\nb' }])).translate, [{ id: 0, text: 'a\nb' }]);
});

// ---- the HTTP backends ----

// A fetch stand-in answering from a list of replies: { status, body, headers }.
function fakeFetch(replies) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const r = replies[Math.min(seen.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 300, status, headers: new Map(Object.entries(r.headers || {})), json: async () => r.body, text: async () => JSON.stringify(r.body ?? '') };
  };
  return { fetchImpl, seen };
}

test('retryAfterMs reads seconds and HTTP dates, and nothing else', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('soon'), null);
});

test('postJson: 429 and 5xx are retried, honouring retry-after, up to the retry limit; a 400 is not retried', async () => {
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  const retry = { retries: 3, retryBaseMs: 100, retryMaxMs: 5000 };
  const a = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 529 }, { status: 200, body: { ok: 1 } }]);
  assert.deepEqual(await postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, a.fetchImpl, wait), { ok: 1 });
  assert.deepEqual(waits, [2000, 200]);                              // the server's 2 s, then the doubled base delay
  const b = fakeFetch([{ status: 400, body: 'bad request' }]);
  await assert.rejects(postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, b.fetchImpl, wait), /X 400/);
  assert.equal(b.seen.length, 1);
  const c = fakeFetch([{ status: 503 }]);
  await assert.rejects(postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, c.fetchImpl, wait), /X 503/);
  assert.equal(c.seen.length, retry.retries + 1);
  const d = fakeFetch([new TypeError('fetch failed'), { status: 200, body: { ok: 2 } }]);
  assert.deepEqual(await postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, d.fetchImpl, wait), { ok: 2 });
  const e = fakeFetch([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200, body: {} }]);
  waits.length = 0;
  await postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, e.fetchImpl, wait);
  assert.deepEqual(waits, [retry.retryMaxMs]);                       // never longer than retryMaxMs
});

test('openaiReady: needs an address, and a key unless the server is on this computer or the local network', () => {
  const base = { baseUrl: 'https://api.openai.com/v1', model: 'm', key: '' };
  assert.equal(openaiReady(base), false);                                         // hosted, no key
  assert.equal(openaiReady({ ...base, key: 'k' }), true);
  assert.equal(openaiReady({ ...base, model: '', key: 'k' }), true);              // the model may come with each request
  assert.equal(openaiReady({ ...base, baseUrl: '', key: 'k' }), false);
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://192.168.1.20:11434/v1', 'http://10.0.0.5/v1',
    'http://172.20.0.2:8080/v1', 'http://gpu-box.local:1234/v1', 'http://ollama:11434/v1']) {
    assert.equal(openaiReady({ ...base, baseUrl: url }), true, url);
  }
  for (const url of ['http://localhost.evil.com/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1']) assert.equal(openaiReady({ ...base, baseUrl: url }), false, url);
});

test('askOpenai: URL, auth header, body shape and the reply text, including a reply split into parts', async () => {
  const { fetchImpl, seen } = fakeFetch([{ body: { choices: [{ message: { content: '{"translations":[]}' } }] } }]);
  const cfg = { baseUrl: 'https://x.test/v1/', model: 'mdl', key: 'secret', temperature: null, timeoutMs: 5000 };
  assert.equal(await askOpenai(cfg, 'SYS', 'USER', RETRY, fetchImpl), '{"translations":[]}');
  assert.equal(seen[0].url, 'https://x.test/v1/chat/completions');                // trailing slash handled
  assert.equal(seen[0].init.headers.authorization, 'Bearer secret');
  assert.deepEqual(seen[0].body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
  assert.ok(seen[0].init.signal);                                                  // a timeout is always set
  const parts = fakeFetch([{ body: { choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'image' }, { type: 'text', text: '1}' }] } }] } }]);
  assert.equal(await askOpenai({ ...cfg, key: '' }, 's', 'u', RETRY, parts.fetchImpl), '{"a":1}');
  assert.equal(parts.seen[0].init.headers.authorization, undefined);               // no key, no auth header
});

test('askOpenai: errors and replies without content are errors; temperature is only sent when one is configured', async () => {
  const cfg = { baseUrl: 'http://localhost:1/v1', model: 'm', key: '', temperature: null, timeoutMs: 5000 };
  await assert.rejects(askOpenai(cfg, 's', 'u', RETRY, fakeFetch([{ status: 401, body: 'bad key' }]).fetchImpl), /401: "bad key"/);
  await assert.rejects(askOpenai(cfg, 's', 'u', RETRY, fakeFetch([{ body: { choices: [] } }]).fetchImpl), /no message content/);
  const bodies = [];
  for (const temperature of [0.2, 0, null]) {
    const f = fakeFetch([{ body: { choices: [{ message: { content: 'x' } }] } }]);
    await askOpenai({ ...cfg, temperature }, 's', 'u', RETRY, f.fetchImpl);
    bodies.push(f.seen[0].body);
  }
  assert.deepEqual(bodies.map((b) => b.temperature), [0.2, 0, undefined]);
  assert.ok(!('temperature' in bodies[2]));
});

test('askApi: key header, system prompt, effort, text blocks joined after thinking blocks', async () => {
  const { fetchImpl, seen } = fakeFetch([{ body: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }]);
  const cfg = { ...TEST_CFG.api, key: 'k', model: 'm', effort: 'low', maxTokens: 10, timeoutMs: 5000 };
  assert.equal(await askApi(cfg, 'SYS', 'USER', RETRY, fetchImpl), 'ab');
  assert.equal(seen[0].init.headers['x-api-key'], 'k');
  assert.equal(seen[0].body.system, 'SYS');
  assert.deepEqual(seen[0].body.output_config, { effort: 'low' });
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'USER' }]);
  const none = fakeFetch([{ body: { content: [{ type: 'text', text: 'x' }] } }]);
  await askApi({ ...cfg, effort: '' }, 's', 'u', RETRY, none.fetchImpl);
  assert.ok(!('output_config' in none.seen[0].body));                              // models without effort get no field
});

test('askApi: a refusal and a reply cut off by max_tokens are errors of their own and are not retried', async () => {
  const cfg = { ...TEST_CFG.api, key: 'k', model: 'm', maxTokens: 123, timeoutMs: 5000 };
  const refused = fakeFetch([{ body: { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] } }]);
  await assert.rejects(askApi(cfg, 's', 'u', RETRY, refused.fetchImpl), (e) => /declined.*\(cyber\)/.test(e.message) && !(e instanceof ValidationError));
  assert.equal(refused.seen.length, 1);
  const cut = fakeFetch([{ body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"transl' }] } }]);
  await assert.rejects(askApi(cfg, 's', 'u', RETRY, cut.fetchImpl), /max_tokens \(123\)/);
  // A refusal inside translateChunk fails the chunk at once: asking again in smaller pieces would only be refused again.
  let calls = 0;
  await assert.rejects(translateChunk(async () => { calls++; return askApi(cfg, 's', 'u', RETRY, refused.fetchImpl); }, ['a', 'b'], [], KO, LLM), /declined/);
  assert.equal(calls, 1);
});

// ---- claude -p ----

const claudeCfg = (extra = {}) => ({ ...TEST_CFG.claude, command: process.execPath, commandArgs: [FAKE_CLAUDE], model: 'haiku', ...extra });

test('claude -p child never inherits an Anthropic API key, other variables are kept', () => {
  const env = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-a', anthropic_auth_token: 'tok', Anthropic_Api_Key: 'sk-b', HOME: '/h', OPENAI_API_KEY: 'sk-o' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-o' });
  const input = { ANTHROPIC_API_KEY: 'x' };
  childEnv(input);
  assert.equal(input.ANTHROPIC_API_KEY, 'x');                    // the caller's object is not modified
});

test('askClaude: the prompt goes on stdin, the system prompt in a file, and settings files are not loaded', async () => {
  const out = await askClaude(claudeCfg(), 'Translate carefully "quoted" {"json":1}', 'hello');
  const [firstWord, input, args] = out.split('|');
  assert.equal(firstWord, 'Translate');
  assert.equal(input, 'hello');
  assert.match(args, /,--setting-sources,,--system-prompt-file,/);
  assert.match(args, /--tools,,--strict-mcp-config/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('subpair-prompt-') && args.includes(f)), []);   // the prompt file is removed
});

test('askClaude: a character split across two reads of the output arrives whole', async () => {
  assert.equal(await askClaude(claudeCfg(), 'sys', 'SPLIT'), '번역');
});

test('askClaude: output beyond the limit is an error, a failure names the exit code without the home folder', async () => {
  await assert.rejects(askClaude(claudeCfg({ maxOutputBytes: 5 }), 'sys', 'long enough reply'), /more than 5 bytes/);
  await assert.rejects(askClaude(claudeCfg(), 'sys', 'FAIL'), (e) => /claude exited 1: cannot read ~/.test(e.message) && !e.message.includes(os.homedir()));
});

test('askClaude: a child that exits before reading its prompt is an ordinary rejection, not a crash of the bridge', async () => {
  // node rejects the claude flags and exits at once; 5 MB cannot be written into a pipe nobody reads.
  await assert.rejects(askClaude({ ...TEST_CFG.claude, command: process.execPath, model: 'm' }, 'sys', 'x'.repeat(5_000_000)), /claude exited/);
});

test('askClaude: a child that never answers is killed at the timeout', async () => {
  const started = Date.now();
  await assert.rejects(askClaude(claudeCfg({ timeoutMs: 300 }), 'sys', 'HANG'), /claude timed out after 300 ms/);
  assert.ok(Date.now() - started < 5000);
});

test('askClaude: an npm-style claude.cmd shim on Windows runs through cmd.exe with every argument intact', winOnly, async () => {
  const dir = tmp();
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, `@"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
  const out = await askClaude({ ...TEST_CFG.claude, command: shim, model: 'haiku' }, 'Translate "this" {x}', 'hi there');
  const [firstWord, input, args] = out.split('|');
  assert.equal(firstWord, 'Translate');
  assert.equal(input, 'hi there');
  assert.match(args, /^-p,--output-format,text,--model,haiku,--tools,,/);
});

test('findCommand and spawnPlan: PATHEXT lookup, .exe started directly, .cmd only with arguments cmd.exe cannot misread', winOnly, () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off\r\n');
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(findCommand('tool', env, 'win32'), path.join(dir, 'tool.cmd'));
  assert.equal(findCommand('missing', env, 'win32'), null);
  const plan = spawnPlan('tool', ['-p', ''], env, 'win32');
  assert.deepEqual(plan, { file: `"${path.join(dir, 'tool.cmd')}" "-p" ""`, args: [], shell: true });
  assert.throws(() => spawnPlan('tool', ['a & calc'], env, 'win32'), /cannot run .* safely/);
  assert.throws(() => spawnPlan('tool', ['50%'], env, 'win32'), /cannot run .* safely/);
  assert.deepEqual(spawnPlan(process.execPath, ['a & b'], env, 'win32'), { file: process.execPath, args: ['a & b'], shell: false });
  assert.deepEqual(spawnPlan('tool', ['a & b'], env, 'linux'), { file: 'tool', args: ['a & b'], shell: false });   // no PATHEXT outside Windows
});

test('claudeProbe: optimistic until checked, then whether `claude --version` ran', async () => {
  const good = claudeProbe(claudeCfg());
  assert.equal(good(), true);
  const bad = claudeProbe({ ...TEST_CFG.claude, command: path.join(tmp(), 'no-such-claude') });
  assert.equal(bad(), true);
  await until(() => bad() === false, 'the failed probe');
  assert.equal(good(), true);
});

// ---- the work queue ----

test('queue: live goes before jobs, first come first served inside a priority, a running task is not interrupted', async () => {
  const q = new WorkQueue(() => 1);
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = q.add({ key: 'k', priority: JOB, run: async () => { order.push('job0'); await gate; } });
  const rest = [q.add({ key: 'k', priority: JOB, run: async () => order.push('job1') }), q.add({ key: 'k', priority: JOB, run: async () => order.push('job2') }),
    q.add({ key: 'k', priority: LIVE, run: async () => order.push('liveA') }), q.add({ key: 'k', priority: LIVE, run: async () => order.push('liveB') })];
  assert.equal(q.pending, 4);
  release();
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, ['job0', 'liveA', 'liveB', 'job1', 'job2']);
});

test('queue: a backend never runs more tasks than its limit, other backends are independent', async () => {
  const q = new WorkQueue((key) => (key === 'wide' ? 3 : 1));
  const live = { wide: 0, narrow: 0 }, peak = { wide: 0, narrow: 0 };
  const task = (key) => async () => { live[key]++; peak[key] = Math.max(peak[key], live[key]); await sleep(15); live[key]--; };
  await Promise.all([...Array(8)].flatMap(() => [q.add({ key: 'wide', run: task('wide') }), q.add({ key: 'narrow', run: task('narrow') })]));
  assert.equal(peak.wide, 3);
  assert.equal(peak.narrow, 1);
  assert.equal(q.size, 0);
});

test('queue: a skipped task never runs and resolves undefined; a failing task or skip() rejects and the queue keeps going', async () => {
  const q = new WorkQueue(() => 1);
  let ran = false;
  const a = q.add({ key: 'k', run: async () => { await sleep(10); return 1; } });
  const skipped = q.add({ key: 'k', skip: () => true, run: async () => { ran = true; } });
  const bad = q.add({ key: 'k', run: async () => { throw new Error('boom'); } });
  const badSkip = q.add({ key: 'k', skip: () => { throw new Error('skip broke'); }, run: async () => 'never' });
  const after = q.add({ key: 'k', run: async () => 'after' });
  assert.equal(await a, 1);
  assert.equal(await skipped, undefined);
  assert.equal(ran, false);
  await assert.rejects(bad, /boom/);
  await assert.rejects(badSkip, /skip broke/);
  assert.equal(await after, 'after');
});

// ---- the store ----

// The cues a job saves: numbered by their position in the source cues.
const numbered = (...texts) => texts.map((text, i) => ({ number: i + 1, start: i + 1, end: i + 2, text }));
const EZ = { backend: 'eztrans' }, CLAUDE = { backend: 'claude', model: 'haiku' };

test('store saves a subtitle per backend, model and language pair, and caches lines per cache name and pair across instances', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.saveSubtitle('81234', 'Some Show', KO, EZ, numbered('안녕'));
  s.saveSubtitle('81234', 'Some Show', KO, CLAUDE, numbered('안녕하세요'));
  s.saveSubtitle('81234', 'Some Show', KO, { backend: 'claude', model: 'sonnet', cacheId: 'claude-sonnet' }, numbered('안녕 (sonnet)'));
  s.saveSubtitle('81234', 'Some Show', EN, CLAUDE, numbered('Hello'));
  s.saveSubtitle('81234', 'Some Show', { from: 'en', to: 'ko' }, CLAUDE, numbered('안녕 (en)'));
  assert.deepEqual(Object.keys(s.meta('81234').entries).sort(), ['en-ko.claude', 'ja-en.claude', 'ja-ko.claude', 'ja-ko.claude-sonnet', 'ja-ko.eztrans']);
  const { file, backend, model, numbering } = s.meta('81234').entries['ja-ko.claude-sonnet'];
  assert.deepEqual({ file, backend, model, numbering }, { file: '81234.ja-ko.claude-sonnet.srt', backend: 'claude', model: 'sonnet', numbering: 'source' });
  assert.match(s.loadSubtitle('81234', { from: 'ja', to: 'ko', backend: 'claude' }, 'haiku'), /안녕하세요/);
  assert.match(s.loadSubtitle('81234', { from: 'ja', to: 'ko', backend: 'claude' }, 'sonnet'), /\(sonnet\)/);      // the preferred model wins a tie
  assert.match(s.loadSubtitle('81234', { to: 'ko', backend: 'claude', model: 'sonnet' }, 'haiku'), /\(sonnet\)/);  // a named model is a filter
  assert.match(s.loadSubtitle('81234', { from: 'en', to: 'ko', backend: 'claude' }), /\(en\)/);   // another source language is kept apart
  assert.match(s.loadSubtitle('81234', { to: 'en', backend: 'claude' }), /Hello/);
  assert.equal(s.loadSubtitle('81234', { to: 'ko', backend: 'api' }), null);
  assert.match(s.loadFile('81234', '81234.ja-ko.claude-sonnet.srt'), /\(sonnet\)/);
  assert.throws(() => s.saveSubtitle('1', '', KO, EZ, [{ number: 2, start: 0, end: 1, text: 'a' }, { number: 2, start: 1, end: 2, text: 'b' }]), /increasing/);
  s.putLines(KO, 'eztrans', [['こんにちは', '안녕하세요'], ['x', '']]);
  s.putLines(KO, 'api-claude-sonnet-5-5', [['こんにちは', '다른 모델']]);
  const again = new Store(dir);
  assert.equal(again.getLine(KO, 'eztrans', 'こんにちは'), '안녕하세요');
  assert.equal(again.getLine(KO, 'eztrans', 'x'), undefined);        // empty translations are not cached
  assert.equal(again.getLine(KO, 'claude', 'こんにちは'), undefined);  // caches are per backend
  assert.equal(again.getLine(KO, 'api-claude-sonnet-5-5', 'こんにちは'), '다른 모델');   // and per model
  assert.equal(again.getLine(EN, 'eztrans', 'こんにちは'), undefined); // and per language pair
});

test('store: titles saved under the old names (no source language, no model) still load, and the default source wins a tie', () => {
  const s = new Store(tmp(), { defaultFrom: 'ja', shippedModels: { claude: 'haiku' } });
  // As written by earlier versions: "<to>.<backend>" ids, no model, one entry without `from` at all.
  fs.writeFileSync(path.join(s.subs, '82942168.ko.eztrans.srt'), toSrt([{ start: 1, end: 2, text: 'old' }]));
  fs.writeFileSync(path.join(s.subs, '82942168.ko.claude.srt'), toSrt([{ start: 1, end: 2, text: 'old claude' }]));
  fs.writeFileSync(path.join(s.subs, '82942168.json'), JSON.stringify({ title: 'T', entries: {
    'ko.eztrans': { file: '82942168.ko.eztrans.srt', to: 'ko', backend: 'eztrans', cues: 1 },
    'ko.claude': { file: '82942168.ko.claude.srt', from: 'ja', to: 'ko', backend: 'claude', cues: 1 },
  } }));
  assert.deepEqual(Object.keys(s.meta('82942168').entries), ['ja-ko.eztrans', 'ja-ko.claude']);
  assert.equal(s.meta('82942168').entries['ja-ko.eztrans'].from, 'ja');
  assert.equal(s.meta('82942168').entries['ja-ko.eztrans'].model, '');
  assert.equal(s.meta('82942168').entries['ja-ko.claude'].model, 'haiku');                    // the shipped model of its backend
  assert.match(s.loadSubtitle('82942168', { to: 'ko', backend: 'eztrans' }), /old/);
  assert.match(s.loadSubtitle('82942168', { from: 'ja', to: 'ko', backend: 'claude', model: 'haiku' }), /old claude/);
  assert.equal(s.loadSubtitle('82942168', { from: 'en', to: 'ko', backend: 'eztrans' }), null);
  assert.match(s.loadFile('82942168', '82942168.ko.eztrans.srt'), /old/);                    // old file names are served too
  // Two source languages for the same target and backend, the other one listed first: without `from`, the default wins.
  s.saveSubtitle('82942168', 'T', { from: 'en', to: 'ko' }, EZ, numbered('from english'));
  const m = JSON.parse(fs.readFileSync(path.join(s.subs, '82942168.json'), 'utf8'));
  fs.writeFileSync(path.join(s.subs, '82942168.json'), JSON.stringify({ ...m, entries: { 'en-ko.eztrans': m.entries['en-ko.eztrans'], 'ja-ko.eztrans': m.entries['ja-ko.eztrans'] } }));
  assert.match(s.loadSubtitle('82942168', { to: 'ko', backend: 'eztrans' }), /old/);
  assert.match(s.loadSubtitle('82942168', { from: 'en', to: 'ko', backend: 'eztrans' }), /from english/);
});

test('store sanitizes keys and never reads a saved file name outside its folder or not listed for the title', () => {
  const s = new Store(tmp());
  s.saveSubtitle('../../evil', '', KO, EZ, numbered('x'));
  assert.ok(fs.existsSync(path.join(s.subs, '______evil.ja-ko.eztrans.srt')));
  fs.writeFileSync(path.join(s.dir, 'outside.srt'), toSrt([{ start: 0, end: 1, text: 'secret' }]));
  fs.writeFileSync(path.join(s.subs, '9.json'), JSON.stringify({ entries: { x: { file: '../outside.srt', from: 'ja', to: 'ko', backend: 'api' } } }));
  assert.equal(s.loadSubtitle('9', { to: 'ko', backend: 'api' }), null);
  assert.equal(s.loadFile('9', '../outside.srt'), null);
  s.saveSubtitle('7', '', KO, EZ, numbered('seven'));
  assert.equal(s.loadFile('9', '7.ja-ko.eztrans.srt'), null);                                // exists, but belongs to another title
  assert.match(s.loadFile('7', '7.ja-ko.eztrans.srt'), /seven/);
  assert.throws(() => s.saveSubtitle('1', '', KO, { backend: '../api' }, []), /bad backend name/);
  assert.ok(s.saveSubtitle('1', '', KO, { backend: 'deepl' }, numbered('x')));   // a backend the store has never heard of
});

test('store: a saved title numbers each cue by its place in the source cues, so a dropped cue leaves a gap', () => {
  const s = new Store(tmp());
  s.saveSubtitle('5', '', KO, EZ, [{ number: 1, start: 1, end: 2, text: 'a' }, { number: 3, start: 1, end: 2, text: 'c' }]);
  const srt = s.loadFile('5', '5.ja-ko.eztrans.srt');
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:02,000\na\n\n3\n00:00:01,000 --> 00:00:02,000\nc\n$/);
  assert.deepEqual(parseSrt(srt).map((c) => c.text), ['a', 'c']);
});

test('store: a cut-off or broken cache line is dropped when the file is loaded, and the file is rewritten clean', () => {
  const dir = tmp();
  const file = path.join(dir, 'lines.ja-ko.eztrans.jsonl');
  fs.writeFileSync(file, '{"s":"a","t":"A"}\nnot json\n{"s":"b","t":"B"}\n{"s":"c","t');          // power cut mid-write
  const s = new Store(dir);
  assert.equal(s.getLine(KO, 'eztrans', 'a'), 'A');
  assert.equal(s.getLine(KO, 'eztrans', 'c'), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"s":"a","t":"A"}\n{"s":"b","t":"B"}\n');
  s.putLines(KO, 'eztrans', [['d', 'D']]);
  const again = new Store(dir);
  assert.equal(again.getLine(KO, 'eztrans', 'd'), 'D');
  assert.equal(again.getLine(KO, 'eztrans', 'b'), 'B');
  s.saveSubtitle('1', 'T', KO, EZ, numbered('x'));
  assert.deepEqual(fs.readdirSync(s.subs).filter((f) => f.endsWith('.tmp')), []);
});

test('store: a damaged metadata file is left alone when read, and set aside (not overwritten) when the title is saved again', () => {
  const s = new Store(tmp());
  s.saveSubtitle('2', 'T', KO, EZ, numbered('x'));
  fs.writeFileSync(path.join(s.subs, '2.json'), '{"title": "T", "entr');
  assert.equal(s.meta('2'), null);
  assert.equal(fs.readdirSync(s.subs).filter((f) => f.startsWith('2.json.corrupt-')).length, 0);   // reading changes nothing
  s.saveSubtitle('2', 'T', EN, CLAUDE, numbered('y'));
  assert.deepEqual(Object.keys(s.meta('2').entries), ['ja-en.claude']);
  assert.equal(fs.readdirSync(s.subs).filter((f) => f.startsWith('2.json.corrupt-')).length, 1);
  fs.writeFileSync(path.join(s.subs, '3.json'), '{"title": "T"}');             // valid JSON, wrong shape
  assert.equal(s.meta('3'), null);
});

test('migrateLegacyStore: moves the old folder once, only into a folder that does not exist yet, and keeps it when it cannot', () => {
  const root = tmp();
  const legacy = path.join(root, 'bridge-store'), target = path.join(root, 'data', 'subpair');
  fs.mkdirSync(path.join(legacy, 'subs'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'lines.ja-ko.claude.jsonl'), '{"s":"a","t":"A"}\n');
  const logs = [];
  assert.equal(migrateLegacyStore(legacy, target, (m) => logs.push(m)), target);
  assert.ok(fs.existsSync(path.join(target, 'lines.ja-ko.claude.jsonl')));
  assert.ok(!fs.existsSync(legacy));
  assert.equal(logs.length, 1);
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'x'), '');
  assert.equal(migrateLegacyStore(legacy, target, () => {}), target);   // the new folder exists: nothing is moved over it
  assert.ok(fs.existsSync(path.join(legacy, 'x')));
  assert.equal(migrateLegacyStore(path.join(root, 'none'), path.join(root, 'other'), () => {}), path.join(root, 'other'));
  const blocked = path.join(root, 'a-file');
  fs.writeFileSync(blocked, '');
  assert.equal(migrateLegacyStore(legacy, path.join(blocked, 'subpair'), () => {}), legacy);   // cannot create the new folder: keep using the old one
  assert.ok(fs.existsSync(path.join(legacy, 'x')));
});

// ---- config ----

test('config: a damaged config.json is an error naming the file, a missing one is fine, silly values are refused', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const load = (cfg, env = {}) => { fs.writeFileSync(file, typeof cfg === 'string' ? cfg : JSON.stringify(cfg)); return loadConfig(file, env); };
  assert.throws(() => load('{ "port": 1234, }'), /config\.json is not valid JSON/);
  assert.throws(() => load('[1]'), /must contain a JSON object/);
  assert.equal(loadConfig(path.join(dir, 'missing.json'), {}).port, 8765);
  for (const [cfg, what] of [[{ claude: { batch: 0 } }, /claude\.batch/], [{ api: { concurrency: 0 } }, /api\.concurrency/], [{ openai: { batch: '40x' } }, /openai\.batch/],
    [{ claude: { timeoutMs: 5 } }, /claude\.timeoutMs/], [{ port: 70000 }, /port/], [{ limits: { lineWaitMs: 60000 } }, /lineWaitMs/],
    [{ to: 'ko' }, /unknown setting "to"/], [{ constructor: 1 }, /unknown setting "constructor"/], [{ limits: { toString: 1 } }, /unknown setting "limits\.toString"/],
    [{ allowedOrigins: ['https://example.com'] }, /allowedOrigins/], [{ api: { effort: 'huge' } }, /api\.effort/], [{ from: 'japanese' }, /from must/],
    [{ claude: { model: 'haiku & calc' } }, /claude\.model/]]) {
    assert.throws(() => load(cfg), what, JSON.stringify(cfg));
  }
  const ok = load({ '//': 'a comment', claude: { batch: '25' }, port: 9000, allowedOrigins: ['moz-extension://1b2c-3d'] });       // numbers given as text are accepted
  assert.equal(ok.claude.batch, 25);
  assert.equal(ok.port, 9000);
  assert.throws(() => loadConfig(path.join(dir, 'missing.json'), { BRIDGE_PORT: 'abc' }), /port/);
  assert.equal(loadConfig(path.join(dir, 'missing.json'), { BRIDGE_PORT: '8777' }).port, 8777);
});

test('config: storeDir defaults to the per-user data folder; a relative one is relative to bridge/, BRIDGE_STORE to the current folder', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ storeDir: 'my-store' }));
  assert.equal(loadConfig(file, {}).storeDir, path.join(BRIDGE_DIR, 'my-store'));
  assert.equal(loadConfig(file, { BRIDGE_STORE: 'rel' }).storeDir, path.resolve('rel'));
  assert.equal(loadConfig(path.join(dir, 'none.json'), { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }).storeDir, defaultStoreDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }));
  assert.equal(defaultStoreDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\subpair');
  assert.equal(defaultStoreDir({}, 'win32', 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\subpair');
  assert.equal(defaultStoreDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/subpair');
  assert.equal(defaultStoreDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/a'), '/data/subpair');
  assert.equal(defaultStoreDir({}, 'linux', '/home/a'), '/home/a/.local/share/subpair');
});

test('the shipped example config loads, and so does the default config', () => {
  assert.doesNotThrow(() => loadConfig(path.join(BRIDGE_DIR, 'config.example.json'), {}));
  assert.equal(loadConfig(path.join(tmp(), 'none.json'), {}).allowedOrigins.length, 0);
});

test('cacheIdFor: the default model keeps the plain backend name, another model gets its own cache', () => {
  assert.equal(cacheIdFor('claude', 'haiku', 'haiku'), 'claude');
  assert.equal(cacheIdFor('api', 'claude-sonnet-5-5', 'claude-haiku-5-5'), 'api-claude-sonnet-5-5');
  assert.equal(cacheIdFor('openai', 'gpt-4.1-mini', ''), 'openai-gpt-4-1-mini');
  assert.equal(cacheIdFor('eztrans', undefined, undefined), 'eztrans');
});

// ---- the server ----

// Fake backends: every name exists, translating "x" gives "<TO>:x". Options per test: chunk size, delay, a hook per call,
// a failure, texts to give up on ('' back), and models: then claude, api and openai have models (configured and shipped
// "<name>-default") and answer "<TO>:<model>:x"; `run` counts calls, so a fresh translation differs from a cached one.
function fakeBackends({ chunk = 40, concurrency = 1, context = 6, delay = 0, onCall = () => {}, fail, giveUp = () => false, models = false, run = false } = {}) {
  const calls = [];
  const one = (name) => ({
    chunk, concurrency, context, ready: () => true, setup: '', supports: () => true, limit: '',
    model: models && name !== 'eztrans' ? { default: `${name}-default`, shipped: `${name}-default` } : null,
    translate: async (texts, before, pair, model) => {
      calls.push({ texts, before, model });
      await onCall(texts, before);
      if (delay) await sleep(delay);
      if (fail && fail(calls.length)) throw new Error('boom');
      const tag = `${pair.to.toUpperCase()}:${model ? `${model}:` : ''}${run ? `${calls.length}:` : ''}`;
      return texts.map((t) => (giveUp(t) ? '' : tag + t));
    },
  });
  return { backends: { eztrans: one('eztrans'), claude: one('claude'), api: one('api'), openai: one('openai') }, calls };
}

// A gate per test: wait() returns a promise that open() resolves.
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { wait: () => p, open: () => open() };
}

// Test servers take ports from a fixed high range. A random OS-assigned port is sometimes one that fetch() refuses
// ("bad port": 6000, 6667, 10080 ...), all of which are below 10081. The pid keeps two test runs at once apart.
let nextPort = 20000 + (process.pid % 2000) * 10;
async function listenOnUsablePort(server) {
  for (;;) {
    const port = nextPort++;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;                          // taken by something else: try the next one
    }
  }
}

async function withBridge(overrides, fn, tweak = () => {}) {
  const cfg = testConfig();
  cfg.storeDir = tmp();
  tweak(cfg);
  const b = createBridge(cfg, overrides);
  await listenOnUsablePort(b.server);
  const base = `http://127.0.0.1:${b.server.address().port}`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => checkError({ status: r.status, ...(await r.json()) }));
  const get = (p) => fetch(`${base}${p}`).then(async (r) => checkError({ status: r.status, ...(await r.json()) }));
  const line = (body) => post('/line', { backend: 'eztrans', to: 'ko', ...body });
  const job = (body) => post('/jobs', { backend: 'eztrans', to: 'ko', ...body });
  const wait = async (key, query = 'to=ko') => {
    let j;
    for (let i = 0; i < 300; i++) { j = await get(`/jobs/${key}?${query}`); if (j.state !== 'running') break; await sleep(10); }
    return j;
  };
  try { await fn({ base, post, get, line, job, wait, bridge: b, cfg }); } finally { b.close(); }
}

const cuesOf = (n, prefix = 'c') => Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, text: `${prefix}${i}` }));

// An error answer (or a job in state error) has a code from the catalogue, string params, and exactly the catalogue's text.
function checkError(body) {
  if (body.error === undefined || body.error === null) return body;
  assert.ok(Object.hasOwn(ERRORS, body.code), `unknown error code ${body.code} for ${body.error}`);
  assert.ok(Array.isArray(body.params) && body.params.every((p) => typeof p === 'string'), `params of ${body.code}`);
  assert.equal(body.error, fill(ERRORS[body.code], body.params));
  assert.doesNotMatch(body.error, /\$\d/, `a parameter is missing in ${body.code}`);
  return body;
}

test('server: a job translates, saves, and the saved subtitle can be fetched; another language or source is separate', async () => {
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ base, get, job, wait }) => {
    const cues = [{ start: 1, end: 2, text: 'こんにちは' }, { start: 3, end: 4, text: 'さようなら' }];
    assert.equal((await job({ key: '70', title: 'T', cues })).status, 200);
    assert.equal((await wait('70')).state, 'done');
    const srt = await (await fetch(`${base}/subs/70/ko/eztrans`)).text();
    assert.deepEqual(parseSrt(srt), [{ start: 1, end: 2, text: 'KO:こんにちは' }, { start: 3, end: 4, text: 'KO:さようなら' }]);
    assert.equal((await fetch(`${base}/subs/70/ko/claude`)).status, 404);
    assert.equal((await fetch(`${base}/subs/70/en/eztrans`)).status, 404);
    assert.equal((await get('/subs/70')).entries['ja-ko.eztrans'].cues, 2);

    await job({ key: '70', backend: 'claude', to: 'en', cues });
    assert.equal((await wait('70', 'to=en')).state, 'done');
    assert.match(await (await fetch(`${base}/subs/70/en/claude`)).text(), /EN:こんにちは/);
    await job({ key: '70', from: 'en', cues: [{ start: 1, end: 2, text: 'hello' }] });
    assert.equal((await wait('70', 'to=ko&from=en')).state, 'done');
    assert.match(await (await fetch(`${base}/subs/70/ko/eztrans?from=en`)).text(), /KO:hello/);
    assert.match(await (await fetch(`${base}/subs/70/ko/eztrans?from=ja`)).text(), /KO:こんにちは/);
  });
});

test('server: a job in another source language is its own job, not the one already running', async () => {
  const g = gate();
  const { backends } = fakeBackends({ chunk: 1, onCall: () => g.wait() });
  await withBridge({ backends }, async ({ job, get, wait }) => {
    const ja = await job({ key: '8', cues: cuesOf(2) });
    const en = await job({ key: '8', from: 'en', backend: 'claude', cues: cuesOf(3, 'e') });
    assert.deepEqual([ja.from, en.from, en.total, en.backend], ['ja', 'en', 3, 'claude']);
    assert.equal((await get('/jobs/8?to=ko')).from, 'ja');               // without a source language: the configured one, as for a new job
    g.open();
    assert.equal((await wait('8', 'to=ko&from=en')).total, 3);
    assert.equal((await wait('8', 'to=ko&from=ja')).total, 2);
    assert.equal((await get('/jobs/8')).status, 400);                // the target language is required
  });
});

test('server: distinct uncached lines go to the backend once, cached lines never again, blank lines are skipped', async () => {
  const { backends, calls } = fakeBackends();
  await withBridge({ backends }, async ({ line }) => {
    const first = await line({ texts: ['a', 'a', 'b', '  '] });
    assert.deepEqual(first.texts, ['KO:a', 'KO:a', 'KO:b', '']);
    assert.deepEqual(calls.map((c) => c.texts), [['a', 'b']]);
    await line({ texts: ['b', 'c'] });
    assert.deepEqual(calls.map((c) => c.texts), [['a', 'b'], ['c']]);
  });
});

test('server: chunks follow the backend batch size and each gets the lines just before it as context', async () => {
  const { backends, calls } = fakeBackends({ chunk: 4, context: 3 });
  await withBridge({ backends }, async ({ job, wait }) => {
    await job({ key: '1', backend: 'claude', cues: cuesOf(10) });
    assert.equal((await wait('1')).state, 'done');
    assert.deepEqual(calls.map((c) => c.texts.length), [4, 4, 2]);
    assert.deepEqual(calls[0].before, []);
    assert.deepEqual(calls[1].before, ['c1', 'c2', 'c3']);
    assert.deepEqual(calls[2].before, ['c5', 'c6', 'c7']);
  });
});

test('server: a live request passes its own context lines to the first chunk', async () => {
  const { backends, calls } = fakeBackends({ context: 2 });
  await withBridge({ backends }, async ({ line }) => {
    await line({ backend: 'claude', texts: ['x', 'y'], context: ['p1', 'p2', 'p3'] });
    assert.deepEqual(calls[0].before, ['p2', 'p3']);
  });
});

test('server: one queue - a live request overtakes the waiting chunks of a running whole-title job', async () => {
  const order = [];
  const g = gate();
  const { backends } = fakeBackends({ chunk: 1, onCall: async (texts) => { order.push(texts[0]); if (texts[0] === 'job0') await g.wait(); } });
  await withBridge({ backends }, async ({ job, line, wait, bridge }) => {
    await job({ key: '9', cues: cuesOf(8, 'job') });
    await until(() => bridge.queue.pending === 7, 'job1..job7 waiting');
    const live = line({ texts: ['LIVE'] });
    await until(() => bridge.queue.pending === 8, 'the live chunk queued');
    g.open();
    assert.deepEqual((await live).texts, ['KO:LIVE']);
    assert.equal((await wait('9')).state, 'done');
    assert.deepEqual(order.slice(0, 3), ['job0', 'LIVE', 'job1']);   // live went first although it queued last
    assert.equal(order.length, 9);
  });
});

test('server: a failing chunk ends the job in error and the chunks still waiting are not run', async () => {
  const { backends, calls } = fakeBackends({ chunk: 1, fail: (n) => n === 2 });
  await withBridge({ backends }, async ({ job, wait }) => {
    await job({ key: '2', backend: 'api', cues: cuesOf(8) });
    const j = await wait('2');
    assert.equal(j.state, 'error');
    assert.match(j.error, /api: boom/);
    assert.equal(calls.length, 2);
  });
});

test('server: a job saves only the lines the translator did not give up on, and says how many it gave up', async () => {
  const { backends } = fakeBackends({ giveUp: (t) => t === 'c1' });
  await withBridge({ backends }, async ({ base, job, wait }) => {
    await job({ key: '3', cues: cuesOf(3) });
    const j = await wait('3');
    assert.deepEqual([j.state, j.skipped], ['done', 1]);
    assert.deepEqual(parseSrt(await (await fetch(`${base}/subs/3/ko/eztrans`)).text()).map((c) => c.text), ['KO:c0', 'KO:c2']);
  });
});

test('server: a job can be cancelled; its waiting chunks are skipped and nothing is saved', async () => {
  const g = gate();
  const { backends, calls } = fakeBackends({ chunk: 1, onCall: () => g.wait() });
  await withBridge({ backends }, async ({ base, post, job, wait }) => {
    await job({ key: '6', cues: cuesOf(5) });
    await until(() => calls.length === 1, 'the first chunk');
    assert.equal((await post('/jobs/6/cancel?to=ko', {})).state, 'running');
    g.open();
    assert.equal((await wait('6')).state, 'cancelled');
    assert.equal(calls.length, 1);
    assert.equal((await fetch(`${base}/subs/6/ko/eztrans`)).status, 404);
  });
});

test('server: a request from before the latest seek is dropped and a running one stops between chunks', async () => {
  const g = gate();
  const { backends, calls } = fakeBackends({ chunk: 2, onCall: (texts) => (texts[0] === 'a3' ? g.wait() : undefined) });
  await withBridge({ backends }, async ({ line, bridge }) => {
    const old = line({ client: 'A', gen: 1, texts: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] });
    await until(() => calls.length === 2, 'the second chunk running');
    const fresh = line({ client: 'A', gen: 2, texts: ['b1'] });
    await until(() => bridge.queue.pending === 2, 'the new request queued');
    g.open();
    const [o, f] = await Promise.all([old, fresh]);
    assert.deepEqual([f.texts, f.stale], [['KO:b1'], false]);
    assert.equal(o.stale, true);
    assert.deepEqual(o.texts.slice(0, 4), ['KO:a1', 'KO:a2', 'KO:a3', 'KO:a4']);      // finished work is kept
    assert.deepEqual(o.texts.slice(4), ['', '']);                                     // the last chunk never started
    assert.ok(!calls.some((c) => c.texts.includes('a5')));
    const late = await line({ client: 'A', gen: 1, texts: ['zz'] });
    assert.deepEqual([late.texts, late.stale], [[''], true]);
  });
});

test('server: two players at once do not cancel each other (seek counters are per client)', async () => {
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ line }) => {
    assert.equal((await line({ client: 'A', gen: 5, texts: ['a'] })).stale, false);
    const b = await line({ client: 'B', gen: 0, texts: ['b'] });
    assert.deepEqual([b.texts, b.stale], [['KO:b'], false]);
    const late = await line({ client: 'A', gen: 4, texts: ['late'] });
    assert.deepEqual([late.texts, late.stale], [[''], true]);
    assert.equal((await line({ client: 'B', gen: 1, texts: ['b2'] })).stale, false);
  });
});

test('server: seek counters are kept for active players and dropped oldest-first', async () => {
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ line }) => {
    const send = (client, gen) => line({ client, gen, texts: ['x'] });
    await send('active', 5);
    await send('idle', 5);
    for (let i = 0; i < L.maxClients * 3; i++) {
      await send(`c${i}`, 0);
      if (i % 2 === 0) await send('active', 5);                     // the active player keeps talking
    }
    assert.equal((await send('active', 4)).stale, true);            // still remembered: a late request from it is dropped
    assert.equal((await send('idle', 4)).stale, false);             // forgotten after more than maxClients newer clients
  });
});

// ---- the server: slow live requests answer with a ticket ----

const quick = (cfg) => { cfg.limits.lineWaitMs = 20; };
// Polls GET /line/:id until it answers something other than 202 (each poll itself waits up to lineWaitMs).
const pollLine = async (get, id) => {
  let r;
  for (let i = 0; i < 100; i++) { r = await get(`/line/${id}`); if (r.status !== 202) break; }
  return r;
};

test('server: a quick line request answers at once; a slow one answers 202 and is fetched with GET /line/:id', async () => {
  const g = gate();
  const { backends } = fakeBackends({ onCall: (texts) => (texts[0] === 'slow' ? g.wait() : undefined) });
  await withBridge({ backends }, async ({ line, get }) => {
    assert.deepEqual(await line({ texts: ['fast'] }), { status: 200, texts: ['KO:fast'], stale: false });
    const r = await line({ texts: ['slow'] });
    assert.equal(r.status, 202);
    assert.match(r.pending, /^[a-z0-9]{8,32}$/);
    assert.deepEqual(await get(`/line/${r.pending}`), { status: 202, pending: r.pending });     // still running
    g.open();
    assert.deepEqual(await pollLine(get, r.pending), { status: 200, texts: ['KO:slow'], stale: false });
    assert.equal((await get(`/line/${r.pending}`)).status, 404);                                // fetched once, then gone
    assert.equal((await get('/line/nosuchrequest1')).status, 404);
  }, (cfg) => { cfg.limits.lineWaitMs = 200; });
});

test('server: a request that fails after its 202 answers the poll with the status it would have had', async () => {
  const g = gate();
  const { backends } = fakeBackends({ onCall: () => g.wait(), fail: () => true });
  await withBridge({ backends }, async ({ line, get }) => {
    const r = await line({ backend: 'claude', texts: ['x'] });
    assert.equal(r.status, 202);
    g.open();
    const res = await pollLine(get, r.pending);
    assert.deepEqual([res.status, res.code, res.params, res.error], [502, 'backend_failed', ['claude', 'boom'], 'claude: boom']);
  }, quick);
});

test('server: POST /line/cancel stops the chunks of that client still waiting, not those of another client', async () => {
  const g = gate();
  const { backends, calls } = fakeBackends({ chunk: 1, onCall: () => g.wait() });
  await withBridge({ backends }, async ({ post, line, get }) => {
    const a = await line({ client: 'A', texts: ['a1', 'a2', 'a3'] });
    const b = await line({ client: 'B', texts: ['b1'] });
    assert.deepEqual([a.status, b.status], [202, 202]);
    assert.deepEqual(await post('/line/cancel', { client: 'A' }), { status: 200, cancelled: 1 });
    g.open();
    const ra = await pollLine(get, a.pending), rb = await pollLine(get, b.pending);
    assert.deepEqual(ra.texts, ['KO:a1', '', '']);                      // a1 was already running; a2 and a3 never started
    assert.deepEqual(rb.texts, ['KO:b1']);
    assert.deepEqual(calls.map((c) => c.texts[0]), ['a1', 'b1']);
  }, quick);
});

test('server: a request nobody asks about any more is abandoned between chunks', async () => {
  const g = gate();
  const { backends, calls } = fakeBackends({ chunk: 1, onCall: () => g.wait() });
  await withBridge({ backends }, async ({ line }) => {
    const r = await line({ texts: ['a', 'b', 'c', 'd'] });
    assert.equal(r.status, 202);
    await sleep(150);                                                    // no poll for longer than lineAbandonMs
    g.open();
    await sleep(50);
    assert.deepEqual(calls.map((c) => c.texts[0]), ['a']);
  }, (cfg) => { quick(cfg); cfg.limits.lineAbandonMs = 60; });
});

test('server: an unfetched result expires, and a full table of running requests refuses new ones with a 503', async () => {
  const g = gate();
  const { backends } = fakeBackends({ onCall: (texts) => (texts[0].startsWith('hold') ? g.wait() : undefined) });
  await withBridge({ backends }, async ({ line, get }) => {
    const r = await line({ texts: ['hold0'] });
    g.open();
    await sleep(120);                                                    // finished, never fetched, older than lineResultTtlMs
    assert.equal((await get(`/line/${r.pending}`)).status, 404);
  }, (cfg) => { quick(cfg); cfg.limits.lineResultTtlMs = 50; });

  const g2 = gate();
  const held = fakeBackends({ concurrency: 4, onCall: () => g2.wait() });
  await withBridge({ backends: held.backends }, async ({ line }) => {
    const tickets = [];
    for (let i = 0; i < L.maxPendingLines; i++) tickets.push(await line({ texts: [`t${i}`] }));
    assert.ok(tickets.every((t) => t.status === 202));
    const full = await line({ texts: ['one more'] });
    assert.equal(full.status, 503);
    g2.open();
  }, quick);
});

// ---- the server: who may call, and what is refused ----

test('server: web page origins are refused; any extension origin is allowed unless allowedOrigins names the allowed ones', async () => {
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ base }) => {
    assert.equal((await fetch(`${base}/health`, { headers: { origin: 'https://www.netflix.com' } })).status, 403);
    for (const o of ['chrome-extension://abc', 'moz-extension://1b2c-3d']) {
      const ok = await fetch(`${base}/health`, { headers: { origin: o } });
      assert.equal(ok.status, 200, o);
      assert.equal(ok.headers.get('access-control-allow-origin'), o);
    }
    for (const o of ['https://moz-extension.evil.com', 'http://moz-extension://x', 'chrome-extension://abc/path', 'null']) {
      assert.equal((await fetch(`${base}/health`, { headers: { origin: o } })).status, 403, o);
    }
  });
  await withBridge({ backends }, async ({ base }) => {
    const mine = await fetch(`${base}/health`, { headers: { origin: 'chrome-extension://mine' } });
    assert.equal(mine.status, 200);
    const other = await fetch(`${base}/health`, { headers: { origin: 'chrome-extension://other' } });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${base}/health`)).status, 200);                  // curl and other local tools send no Origin
  }, (cfg) => { cfg.allowedOrigins = ['chrome-extension://mine']; });
});

// A raw HTTP exchange, for requests fetch() will not send (odd Host, odd target, a body split mid-character).
function raw(base, head, chunks = []) {
  const port = Number(new URL(base).port);
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(head);
    (async () => { for (const c of chunks) { await sleep(20); if (!s.destroyed) s.write(c); } await sleep(300); s.end(); })();
    setTimeout(() => s.destroy(), 2000);
  });
}
const statusOf = (response) => Number((/^HTTP\/1\.1 (\d+)/.exec(response) || [])[1] || 0);

test('server: only loopback Host headers are served (DNS rebinding)', async () => {
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ base }) => {
    const port = new URL(base).port;
    const get = (host) => raw(base, `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`).then(statusOf);
    assert.equal(await get(`127.0.0.1:${port}`), 200);
    assert.equal(await get(`localhost:${port}`), 200);
    assert.equal(await get('evil.example.com'), 403);
    assert.equal(await get(`evil.example.com:${port}`), 403);
    assert.equal(await get('localhost.evil.com'), 403);
    assert.equal(await get(`127.0.0.1:${Number(port) + 1}`), 403);       // another port on the same name is another origin
  });
});

test('server: unknown paths are 404, a known path with the wrong method is 405, a bad target is 400', async () => {
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ base, get }) => {
    assert.equal((await fetch(`${base}/health/xyz`)).status, 404);
    const put = await fetch(`${base}/line`, { method: 'PUT', body: '{}' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'POST');
    const port = new URL(base).port;
    const r = await raw(base, `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.equal(statusOf(r), 400);
    assert.equal((await get('/health')).ok, true);
  });
});

test('server: a Japanese character split across two network chunks arrives intact', async () => {
  const { backends, calls } = fakeBackends();
  await withBridge({ backends }, async ({ base }) => {
    const port = new URL(base).port;
    const body = Buffer.from(JSON.stringify({ backend: 'eztrans', to: 'ko', texts: ['あいう'] }));
    const cut = body.indexOf(Buffer.from('あ')) + 1;                               // inside the first character's 3 bytes
    const head = `POST /line HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
    const r = await raw(base, head, [body.subarray(0, cut), body.subarray(cut)]);
    assert.equal(statusOf(r), 200);
    assert.deepEqual(calls[0].texts, ['あいう']);
  });
});

test('server: an oversized body is refused with a 413, by its declared length or while it streams in', async () => {
  const { backends, calls } = fakeBackends();
  await withBridge({ backends }, async ({ base }) => {
    const port = new URL(base).port;
    const declared = await raw(base, `POST /line HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n`);
    assert.equal(statusOf(declared), 413);
    const piece = 'x'.repeat(L.bodyBytesLine);
    const chunk = `${piece.length.toString(16)}\r\n${piece}\r\n`;
    const streamed = await raw(base, `POST /line HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`, [chunk, chunk, '0\r\n\r\n']);
    assert.equal(statusOf(streamed), 413);
    assert.equal(calls.length, 0);
  });
});

test('server: request bodies are validated - types, lengths, counts, sizes, languages - and refused with a 4xx, not translated', async () => {
  const { backends, calls } = fakeBackends();
  await withBridge({ backends }, async ({ base, post, line, job }) => {
    assert.equal((await line({ texts: [{ a: 1 }, 5] })).status, 400);                       // not strings
    assert.equal((await line({ texts: ['x'.repeat(L.maxText + 1)] })).status, 400);           // one cue too long
    assert.equal((await line({ texts: ['x'.repeat(L.maxText)] })).status, 200);               // exactly at the limit is fine
    assert.equal((await line({ texts: Array(L.maxLines + 1).fill('x') })).status, 400);       // too many in one request
    assert.equal((await line({ texts: Array(L.maxLines).fill('y') })).status, 200);
    assert.equal((await line({ texts: ['x'], context: [1] })).status, 400);
    assert.equal((await line({ texts: ['x'], context: Array(L.maxContext + 1).fill('c') })).status, 400);
    assert.equal((await line({ texts: ['x'], to: 'k0' })).status, 400);                       // not a language code
    assert.match((await line({ texts: ['x'], to: undefined })).error, /to \(the target language\) is required/);
    assert.equal((await line({ texts: ['x'], from: { a: 1 } })).status, 400);
    assert.equal((await post('/line', { backend: 'nope', to: 'ko', texts: ['x'] })).status, 400);
    const cue = { start: 0, end: 1, text: 'x' };
    assert.equal((await job({ key: 'a b', cues: [cue] })).status, 400);                       // keys are not rewritten, they are refused
    assert.equal((await job({ key: '../x', cues: [cue] })).status, 400);
    assert.equal((await job({ key: 'k'.repeat(81), cues: [cue] })).status, 400);
    assert.equal((await job({ key: '1', cues: [] })).status, 400);
    for (const bad of [{ start: 'a' }, { start: '1' }, { start: true }, { start: [] }, { start: -1 }, { start: 2, end: 1 }, { end: Infinity }, { text: undefined }]) {
      assert.equal((await job({ key: '1', cues: [{ ...cue, ...bad }] })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await job({ key: '1', cues: [null] })).status, 400);
    assert.equal((await job({ key: '1', cues: Array(L.maxCues + 1).fill(cue) })).status, 400);   // over the cue limit
    assert.equal((await job({ key: '1', cues: [{ ...cue, text: 'x'.repeat(L.maxText + 1) }] })).status, 400);
    for (const body of ['null', '[1]', '{broken']) assert.equal((await fetch(`${base}/line`, { method: 'POST', body })).status, 400, body);
    assert.equal((await fetch(`${base}/jobs/a%20b?to=ko`)).status, 400);
    assert.equal((await fetch(`${base}/subs/%E0%A4%A`)).status, 400);                          // malformed escape
    assert.equal((await fetch(`${base}/subs/1/ko/..%2Fx`)).status, 400);                       // not a backend name
    // Only the two requests exactly at the limits went through (one distinct text each); every refused one translated nothing.
    assert.deepEqual(calls.map((c) => c.texts), [['x'.repeat(L.maxText)], ['y']]);
  });
});

test('server: unsupported pairs and bad setup are refused at once (400 / 503) for lines and jobs, never accepted as running', async () => {
  const { backends, calls } = fakeBackends();
  backends.eztrans.supports = EzTrans.supports;
  backends.eztrans.limit = ['ezTrans', 'ja -> ko'];
  backends.api.ready = () => false;
  backends.api.setup = 'api_key_missing';
  backends.openai.ready = () => false;
  await withBridge({ backends }, async ({ line, job }) => {
    const a = await line({ texts: ['x'], to: 'en' });
    assert.equal(a.status, 400);
    assert.deepEqual([a.error, a.code, a.params], ['ezTrans only does ja -> ko, not ja -> en', 'pair_unsupported', ['ezTrans', 'ja -> ko', 'ja', 'en']]);
    assert.match((await line({ backend: 'claude', texts: ['x'], to: 'ja' })).error, /same/);
    assert.match((await line({ backend: 'claude', texts: ['x'], from: 'ja', to: 'jpn' })).error, /same/);   // "jpn" normalises to ja
    const b = await line({ backend: 'api', texts: ['x'] });
    assert.deepEqual([b.status, b.code, b.error], [503, 'api_key_missing', ERRORS.api_key_missing]);
    const c = await line({ backend: 'openai', texts: ['x'] });                   // no setup code of its own
    assert.deepEqual([c.status, c.code, c.params, c.error], [503, 'backend_not_ready', ['openai'], 'openai is not set up']);
    assert.equal((await job({ key: '5', to: 'en', cues: cuesOf(1) })).status, 400);
    assert.equal((await job({ key: '5', backend: 'api', cues: cuesOf(1) })).status, 503);
    assert.equal(calls.length, 0);
  });
});

test('server: jobs for the same title with other backends or models run side by side; the same job is returned while it runs', async () => {
  const g = gate();
  const { backends, calls } = fakeBackends({ chunk: 1, concurrency: 4, models: true, onCall: () => g.wait() });
  await withBridge({ backends }, async ({ get, job, wait }) => {
    const ez = await job({ key: '4', cues: cuesOf(2) });
    const claude = await job({ key: '4', backend: 'claude', cues: cuesOf(2) });
    const sonnet = await job({ key: '4', backend: 'claude', model: 'sonnet', cues: cuesOf(2) });
    assert.deepEqual([ez, claude, sonnet].map((j) => [j.status, j.backend, j.model]),
      [[200, 'eztrans', ''], [200, 'claude', 'claude-default'], [200, 'claude', 'sonnet']]);
    const same = await job({ key: '4', backend: 'claude', cues: cuesOf(5) });          // the running job, not a new one
    assert.deepEqual([same.status, same.total], [200, 2]);
    assert.equal((await job({ key: '4', backend: 'claude', fresh: true, cues: cuesOf(2) })).status, 409);
    assert.equal((await job({ key: '4', backend: 'claude', model: 'opus', fresh: true, cues: cuesOf(2) })).status, 200);   // another id
    g.open();
    assert.equal((await wait('4', 'to=ko&backend=claude&model=sonnet')).model, 'sonnet');
    assert.equal((await wait('4', 'to=ko&backend=claude')).model, 'claude-default');         // the backend's model, as for a new job
    assert.equal((await wait('4', 'to=ko&backend=eztrans')).state, 'done');
    assert.equal((await get('/jobs/4?to=ko&backend=api')).state, 'none');
    assert.equal((await get('/jobs/4?to=ko&model=sonnet')).model, 'sonnet');                 // no backend: the latest with that model
    assert.equal((await get('/jobs/4?to=ko&backend=nope')).status, 400);
    assert.deepEqual([...new Set(calls.map((c) => c.model))].sort(), ['', 'claude-default', 'opus', 'sonnet']);   // each job used its own model
  }, (cfg) => { cfg.limits.maxRunningJobs = 8; });
});

test('server: the model of a request picks the model, the line cache and the saved file; a bad model name is refused', async () => {
  const { backends, calls } = fakeBackends({ models: true });
  await withBridge({ backends }, async ({ base, get, line, job, wait }) => {
    assert.deepEqual((await line({ backend: 'claude', texts: ['x'] })).texts, ['KO:claude-default:x']);
    assert.deepEqual((await line({ backend: 'claude', model: 'sonnet', texts: ['x'] })).texts, ['KO:sonnet:x']);   // not the cached line
    assert.deepEqual((await line({ backend: 'claude', texts: ['x'] })).texts, ['KO:claude-default:x']);
    assert.deepEqual((await line({ backend: 'eztrans', model: 'sonnet', texts: ['x'] })).texts, ['KO:x']);         // no models: ignored
    assert.equal(calls.length, 3);
    for (const model of ['a b', 'x'.repeat(101), 'semi;colon', 5]) assert.equal((await line({ backend: 'claude', model, texts: ['y'] })).status, 400, String(model));
    await job({ key: '6', backend: 'claude', model: 'sonnet', cues: cuesOf(1) });
    await job({ key: '6', backend: 'claude', cues: cuesOf(1) });
    await wait('6', 'to=ko&backend=claude&model=sonnet');
    await wait('6', 'to=ko&backend=claude');
    const entries = Object.values((await get('/subs/6')).entries);
    assert.deepEqual(entries.map((e) => [e.backend, e.model, e.file, e.numbering]).sort(), [
      ['claude', 'claude-default', '6.ja-ko.claude.srt', 'source'], ['claude', 'sonnet', '6.ja-ko.claude-sonnet.srt', 'source']]);
    assert.match(await (await fetch(`${base}/subs/6/6.ja-ko.claude-sonnet.srt`)).text(), /KO:sonnet:c0/);
    assert.match(await (await fetch(`${base}/subs/6/ko/claude?model=sonnet`)).text(), /KO:sonnet:c0/);
    assert.match(await (await fetch(`${base}/subs/6/ko/claude`)).text(), /KO:claude-default:c0/);   // the configured model wins
    assert.equal((await fetch(`${base}/subs/6/6.ja-ko.api.srt`)).status, 404);                      // not saved for this title
    assert.equal((await fetch(`${base}/subs/6/..%2F6.ja-ko.claude.srt`)).status, 404);
  });
});

test('server: a fresh job translates every line again, replacing cached lines and the saved file', async () => {
  const { backends, calls } = fakeBackends({ run: true });
  await withBridge({ backends }, async ({ base, line, job, wait }) => {
    await job({ key: '7', cues: cuesOf(2) });
    assert.equal((await wait('7')).state, 'done');
    const first = await (await fetch(`${base}/subs/7/ko/eztrans`)).text();
    assert.match(first, /KO:1:c0/);
    await job({ key: '7', cues: cuesOf(2) });                                        // not fresh: everything is cached
    assert.equal((await wait('7')).state, 'done');
    assert.equal(calls.length, 1);
    const again = await job({ key: '7', fresh: true, cues: cuesOf(2) });
    assert.equal(again.fresh, true);
    assert.equal((await wait('7')).state, 'done');
    assert.equal(calls.length, 2);
    assert.match(await (await fetch(`${base}/subs/7/ko/eztrans`)).text(), /KO:2:c0[\s\S]*KO:2:c1/);
    assert.deepEqual((await line({ texts: ['c0'] })).texts, ['KO:2:c0']);           // the cache holds the new translation
  });
});

test('server: a fresh job that gives up on a line keeps the saved file it was meant to replace', async () => {
  let giveUp = false;
  const { backends } = fakeBackends({ run: true, giveUp: (t) => giveUp && t === 'c1' });
  await withBridge({ backends }, async ({ base, job, wait }) => {
    await job({ key: '9', cues: cuesOf(2) });
    assert.equal((await wait('9')).state, 'done');
    giveUp = true;
    await job({ key: '9', fresh: true, cues: cuesOf(2) });
    const j = await wait('9');
    assert.equal(j.state, 'error');
    assert.deepEqual([j.code, j.params, j.error], ['lines_failed', ['1'], '1 lines could not be translated; the saved translation was kept']);
    assert.match(await (await fetch(`${base}/subs/9/ko/eztrans`)).text(), /KO:1:c0[\s\S]*KO:1:c1/);
  });
});

test('server: a saved title numbers cues by their place in the job, so a line given up on leaves a gap', async () => {
  const { backends } = fakeBackends({ giveUp: (t) => t === 'c1' });
  await withBridge({ backends }, async ({ base, get, job, wait }) => {
    await job({ key: '10', cues: cuesOf(3) });
    assert.equal((await wait('10')).skipped, 1);
    const srt = await (await fetch(`${base}/subs/10/10.ja-ko.eztrans.srt`)).text();
    assert.deepEqual(srt.split('\n\n').map((block) => block.split('\n')[0]), ['1', '3']);
    const entry = (await get('/subs/10')).entries['ja-ko.eztrans'];
    // What the player needs to tell whether its main cues are still the ones the numbers refer to.
    assert.deepEqual([entry.numbering, entry.count, entry.cues, entry.sourceHash], ['source', 3, 2, textsHash(['c0', 'c1', 'c2'])]);
    assert.notEqual(entry.sourceHash, textsHash(['c0', 'c1', 'c2 (re-timed file, other text)']));
  });
});

test('server: running jobs are capped, finished jobs are forgotten beyond a limit, the newest stay', async () => {
  const g = gate();
  const held = fakeBackends({ concurrency: 4, onCall: () => g.wait() });
  await withBridge({ backends: held.backends }, async ({ job }) => {
    for (let i = 0; i < L.maxRunningJobs; i++) assert.equal((await job({ key: `r${i}`, cues: cuesOf(1) })).status, 200);
    assert.equal((await job({ key: 'one-more', cues: cuesOf(1) })).status, 503);
    g.open();
  });
  const { backends } = fakeBackends();
  await withBridge({ backends }, async ({ get, job, wait }) => {
    const total = L.maxJobs + 3;
    for (let i = 0; i < total; i++) {
      await job({ key: `k${i}`, cues: [{ start: 0, end: 1, text: `t${i}` }] });
      assert.equal((await wait(`k${i}`)).state, 'done');
    }
    assert.equal((await get('/jobs/k0?to=ko')).state, 'none');                     // the oldest finished jobs are forgotten
    assert.equal((await get(`/jobs/k${total - 1}?to=ko`)).state, 'done');           // the newest stay
    assert.equal((await get(`/jobs/k${total - L.maxJobs}?to=ko`)).state, 'done');   // and so does the last one inside the limit
  });
});

test('server: a chunk translated by an earlier request while it waited in the queue is not translated twice', async () => {
  const { backends, calls } = fakeBackends({ chunk: 1, delay: 30 });
  await withBridge({ backends }, async ({ line }) => {
    const [a, b] = await Promise.all([line({ texts: ['p', 'q'] }), line({ texts: ['p', 'q'] })]);
    assert.deepEqual(a.texts, ['KO:p', 'KO:q']);
    assert.deepEqual(b.texts, ['KO:p', 'KO:q']);
    assert.equal(calls.length, 2);
  });
});

test('server: /health reports each backend as the registry sees it, and the configured model of those with models', async () => {
  const { backends } = fakeBackends({ models: true });
  backends.api.ready = () => false;
  backends.eztrans.ready = () => ['ja-ko'];
  backends.openai.model = { default: '', shipped: '' };
  await withBridge({ backends }, async ({ get }) => {
    const h = await get('/health');
    assert.deepEqual(h.backends, { eztrans: ['ja-ko'], claude: true, api: false, openai: true });
    assert.deepEqual(h.models, { claude: 'claude-default', api: 'api-default', openai: '' });
  });
});

test('server: the real registry - openai needs an address it may use and a model, from the config or the request', async () => {
  await withBridge({}, async ({ get, post }) => {
    const h = await get('/health');
    assert.equal(h.backends.openai, false);                              // hosted address, no key
    assert.deepEqual(h.models, { claude: 'haiku', api: 'claude-haiku-5-5', openai: '' });
    assert.match((await post('/line', { backend: 'openai', to: 'ko', texts: ['x'] })).error, /not set up/);
  });
  await withBridge({}, async ({ get, post }) => {
    assert.equal((await get('/health')).backends.openai, true);
    const r = await post('/line', { backend: 'openai', to: 'ko', texts: ['x'] });
    assert.deepEqual([r.status, /needs a model/.test(r.error)], [400, true]);
  }, (cfg) => { cfg.openai = { ...cfg.openai, baseUrl: 'http://127.0.0.1:9/v1', model: '' }; });
});

test('server: openai backend end to end against a local OpenAI-compatible server, lines cached per model', async () => {
  const requests = [];
  const mock = http.createServer((req, res) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => {
      const body = JSON.parse(s);
      requests.push({ url: req.url, body });
      const reqJson = JSON.parse(body.messages[1].content);
      const out = { translations: reqJson.translate.map((t) => ({ id: t.id, text: `${body.model}(${t.text})` })) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
  });
  await listenOnUsablePort(mock);
  const setModel = (model) => (cfg) => { cfg.openai = { ...cfg.openai, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model, key: '' }; };
  let storeDir;
  try {
    await withBridge({}, async ({ get, post, wait, base, cfg }) => {
      storeDir = cfg.storeDir;
      assert.equal((await get('/health')).backends.openai, true);
      const line = await post('/line', { backend: 'openai', to: 'en', texts: ['こんにちは', 'a\u2014b'] });
      assert.deepEqual(line.texts, ['m1(こんにちは)', 'm1(a\u2014b)']);
      assert.equal(requests[0].url, '/v1/chat/completions');
      assert.ok(!requests[0].body.messages[1].content.includes('\u2014'), 'the dash reached the model');
      await post('/line', { backend: 'openai', to: 'en', texts: ['こんにちは'] });          // cached
      assert.equal(requests.length, 1);
      await post('/jobs', { key: '5', backend: 'openai', to: 'en', cues: [{ start: 1, end: 2, text: 'こんにちは' }] });
      assert.equal((await wait('5', 'to=en')).state, 'done');
      assert.match(await (await fetch(`${base}/subs/5/en/openai`)).text(), /m1\(こんにちは\)/);
    }, setModel('m1'));
    await withBridge({}, async ({ post }) => {
      const again = await post('/line', { backend: 'openai', to: 'en', texts: ['こんにちは'] });
      assert.deepEqual(again.texts, ['m2(こんにちは)']);                                  // another model does not reuse m1's lines
      assert.equal(requests.length, 2);
    }, (cfg) => { setModel('m2')(cfg); cfg.storeDir = storeDir; });
  } finally { mock.close(); }
});

// ---- ezTrans through a stand-in helper (Windows named pipes, like the real one) ----

function fakeEz(extra = {}) {
  const marker = path.join(tmp(), 'starts.txt');
  fs.writeFileSync(marker, '');
  const ez = new EzTrans({ ...TEST_CFG.eztrans, helper: process.execPath, helperArgs: [FAKE_HELPER], dir: marker, cwd: os.tmpdir(), ...extra });
  const starts = () => fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
  return { ez, starts };
}

test('ezTrans: lines are translated in order over the pipe, line breaks are joined', winOnly, async () => {
  const { ez, starts } = fakeEz();
  try {
    assert.deepEqual(await ez.translateAll(['a', 'b\nc', '  ']), ['KO:a', 'KO:bc', '']);
    assert.equal(starts(), 1);
    const many = await Promise.all(['1', '2', '3', '4'].map((t) => ez.translate(t)));
    assert.deepEqual(many, ['KO:1', 'KO:2', 'KO:3', 'KO:4']);
    assert.equal(starts(), 1);
  } finally { ez.close(); }
});

test('ezTrans: a line the engine never answers times out, the helper is replaced, and later lines still work', winOnly, async () => {
  const { ez, starts } = fakeEz();
  try {
    assert.equal(await ez.translate('ok1'), 'KO:ok1');
    await assert.rejects(ez.translate('HANG'), /did not answer in time/);
    assert.equal(await ez.translate('ok2'), 'KO:ok2');
    assert.equal(starts(), 2);
  } finally { ez.close(); }
});

test('ezTrans: a nonsense reply length and a dying helper are errors, each followed by a fresh helper', winOnly, async () => {
  const { ez, starts } = fakeEz();
  try {
    await assert.rejects(ez.translate('BADLEN'), /reply length/);
    assert.equal(await ez.translate('fine'), 'KO:fine');
    await assert.rejects(ez.translate('DIE'), /closed the pipe/);
    assert.equal(await ez.translate('again'), 'KO:again');
    assert.equal(starts(), 3);
  } finally { ez.close(); }
});

test('ezTrans: an empty reply (the engine failed on that line) is an empty string and the helper stays', winOnly, async () => {
  const { ez, starts } = fakeEz();
  try {
    assert.equal(await ez.translate('EMPTY'), '');
    assert.equal(await ez.translate('x'), 'KO:x');
    assert.equal(starts(), 1);
  } finally { ez.close(); }
});

test('ezTrans: a helper that exits or cannot be started at all is an error at once, with nothing left behind', winOnly, async () => {
  const exits = new EzTrans({ ...TEST_CFG.eztrans, helper: process.execPath, helperArgs: ['-e', 'process.exit(3)'], dir: 'x', cwd: os.tmpdir() });
  await assert.rejects(exits.translate('a'), /exited/);
  assert.equal(exits.child, null);
  exits.close();
  const started = Date.now();
  const missing = new EzTrans({ ...TEST_CFG.eztrans, helper: path.join(tmp(), 'no-helper.exe'), dir: 'x', cwd: os.tmpdir() });
  await assert.rejects(missing.translate('a'), /could not start/);
  assert.ok(Date.now() - started < TEST_CFG.eztrans.startTimeoutMs / 2, 'waited for a pipe from a helper that never started');
  missing.close();
});

// ---- error codes ----

test('errors: every error code the bridge source can produce is in the catalogue, and every catalogue entry is used', () => {
  const dir = path.join(BRIDGE_DIR);
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f)),
    ...fs.readdirSync(path.join(dir, 'backends')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, 'backends', f))];
  const source = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // The ways the bridge names a code: BridgeError(status, code), CodedError(code), backendError(code), bad(code) in
  // validate.mjs, a backend's setup code in the registry, the two HTTP status codes, and errorBody's fallback.
  const patterns = [/BridgeError\(\d{3}, '([a-z_]+)'/g, /CodedError\('([a-z_]+)'/g, /backendError\('([a-z_]+)'/g, /\bbad\('([a-z_]+)'/g,
    /setup: '([a-z_]+)'/g, /^\s+[a-z]+: llm\(.*, '([a-z_]+)'\),$/gm, /status === 429 \? '([a-z_]+)' : '([a-z_]+)'/g, /code: '([a-z_]+)'/g];
  const used = new Set();
  for (const re of patterns) for (const m of source.matchAll(re)) for (const code of m.slice(1)) used.add(code);
  const unknown = [...used].filter((c) => !Object.hasOwn(ERRORS, c));
  assert.deepEqual(unknown, [], 'codes used but not in ERRORS');
  const unused = Object.keys(ERRORS).filter((c) => !used.has(c));
  assert.deepEqual(unused, [], 'ERRORS entries nothing produces');
  assert.throws(() => backendError('no_such_code'), /no such error code/);
});

test('errors: what the backends throw carries a code; the bridge answers it with the backend name as the first param', async () => {
  const wait = async () => {};
  const retry = { retries: 0, retryBaseMs: 1, retryMaxMs: 1 };
  const limited = await postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, fakeFetch([{ status: 429, body: 'slow' }]).fetchImpl, wait).catch((e) => e);
  assert.deepEqual([limited.code, limited.params], ['upstream_rate_limited', ['X', '429', '"slow"']]);
  const other = await postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, fakeFetch([{ status: 401, body: 'bad key' }]).fetchImpl, wait).catch((e) => e);
  assert.deepEqual([other.code, other.message], ['upstream_error', 'X 401: "bad key"']);
  const timeout = new Error('t'); timeout.name = 'TimeoutError';
  const late = await postJson('X', 'u', { headers: {}, body: {}, timeoutMs: 1000 }, retry, fakeFetch([timeout]).fetchImpl, wait).catch((e) => e);
  assert.deepEqual([late.code, late.message], ['timeout', 'X did not answer within 1000 ms']);
  const cfg = { ...TEST_CFG.api, key: 'k', model: 'm', timeoutMs: 5000 };
  const refused = await askApi(cfg, 's', 'u', RETRY, fakeFetch([{ body: { stop_reason: 'refusal', stop_details: { category: 'bio' } } }]).fetchImpl).catch((e) => e);
  assert.deepEqual([refused.code, refused.params, refused.message], ['refused_for', ['bio'], 'Anthropic API declined to translate this part (bio)']);
  const bare = await askApi(cfg, 's', 'u', RETRY, fakeFetch([{ body: { stop_reason: 'refusal' } }]).fetchImpl).catch((e) => e);
  assert.deepEqual([bare.code, bare.message], ['refused', 'Anthropic API declined to translate this part']);
  const failed = await askClaude(claudeCfg(), 'sys', 'FAIL').catch((e) => e);
  assert.equal(failed.code, 'claude_failed');
  assert.deepEqual(failed.params.slice(0, 1), ['1']);

  // Through the server: the backend's own code, with the backend name put in front.
  const { backends } = fakeBackends({ fail: () => true });
  backends.api.translate = async () => { throw backendError('timeout', 'Anthropic API', 120000); };
  await withBridge({ backends }, async ({ line }) => {
    const r = await line({ backend: 'api', texts: ['x'] });
    assert.deepEqual([r.status, r.code, r.params, r.error], [502, 'timeout', ['api', 'Anthropic API', '120000'], 'api: Anthropic API did not answer within 120000 ms']);
  });
});

test('config: ezTrans uses the bundled helper in its own folder unless told otherwise; relative paths are relative to bridge/', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const load = (eztrans) => { fs.writeFileSync(file, JSON.stringify({ eztrans })); return loadConfig(file, {}).eztrans; };
  const plain = load({ dir: 'C:\ezTrans XP' });
  assert.equal(plain.helper, BUNDLED_EZTRANS_HELPER);
  assert.ok(fs.existsSync(BUNDLED_EZTRANS_HELPER), 'the helper ships in bridge/vendor/lunatranslator');
  assert.equal(plain.cwd, path.dirname(BUNDLED_EZTRANS_HELPER));
  assert.equal(plain.dir, path.resolve(BRIDGE_DIR, 'C:\ezTrans XP'));
  const own = load({ helper: 'D:\Luna\LunaSubProcess32.exe', cwd: 'D:\Luna', dir: 'D:\ezTrans' });     // a user's own install keeps working
  assert.equal(own.helper, path.resolve('D:\Luna\LunaSubProcess32.exe'));
  assert.equal(own.cwd, path.resolve('D:\Luna'));
  const ownNoCwd = load({ helper: 'tools/luna/helper.exe' });
  assert.equal(ownNoCwd.helper, path.join(BRIDGE_DIR, 'tools', 'luna', 'helper.exe'));
  assert.equal(ownNoCwd.cwd, path.join(BRIDGE_DIR, 'tools', 'luna'));
});

test('ezTrans is offered only on Windows, and only once its folder is set and found', () => {
  const dir = tmp();
  const cfg = { helper: process.execPath, dir };
  assert.equal(EzTrans.available(cfg, 'win32'), true);
  assert.equal(EzTrans.available(cfg, 'linux'), false);
  assert.equal(EzTrans.available(cfg, 'darwin'), false);
  assert.equal(EzTrans.available({ ...cfg, dir: '' }, 'win32'), false);
  assert.equal(EzTrans.available({ ...cfg, dir: path.join(dir, 'missing') }, 'win32'), false);
  assert.equal(EzTrans.available({ ...cfg, helper: path.join(dir, 'missing.exe') }, 'win32'), false);
});
