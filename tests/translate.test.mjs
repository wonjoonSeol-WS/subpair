import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, resolveMode, cueIndexAt, nextBatch, fillFromSrt } from '../src/translate.js';
import { toSrt } from '../src/srt.js';
import { textsHash } from '../src/hash.js';

const mk = (n) => {
  const cues = Array.from({ length: n }, (_, i) => ({ start: i * 10, end: i * 10 + 5, text: `L${i}` }));
  return { cues, sub: cues.map((c) => ({ start: c.start, end: c.end, text: '' })) };
};
const tick = () => new Promise((r) => setImmediate(r));

test('resolveMode: auto is each translator\'s own way, live for ezTrans and a whole-title pass for the LLM backends', () => {
  assert.equal(resolveMode('auto', 'eztrans'), 'live');
  assert.equal(resolveMode('auto', 'claude'), 'process');
  assert.equal(resolveMode('auto', 'api'), 'process');
  assert.equal(resolveMode('live', 'claude'), 'live');
  assert.equal(resolveMode('off', 'eztrans'), 'off');
});

test('cueIndexAt: the cue on screen, the next one in a gap, the last one at the end', () => {
  const { cues } = mk(3);                       // 0-5, 10-15, 20-25
  assert.equal(cueIndexAt(cues, 2), 0);
  assert.equal(cueIndexAt(cues, 7), 1);         // gap: next cue
  assert.equal(cueIndexAt(cues, 999), 2);
  assert.equal(cueIndexAt([], 1), -1);
});

test('nextBatch starts at the playhead cue, wraps to the start, and skips done and failed cues', () => {
  const { sub } = mk(6);
  sub[4].text = 'done';
  assert.deepEqual(nextBatch(sub, 3, 3), [3, 5, 0]);
  assert.deepEqual(nextBatch(sub, 3, 10, new Set([5])), [3, 0, 1, 2]);
});

test('fillFromSrt maps by start time, keeps existing text, ignores unknown times', () => {
  const { cues, sub } = mk(3);
  sub[1].text = 'keep';
  const srt = toSrt([{ start: 0, end: 5, text: 'A' }, { start: 10, end: 15, text: 'B' }, { start: 20, end: 25, text: 'C' }, { start: 99, end: 100, text: 'Z' }]);
  assert.equal(fillFromSrt(cues, sub, srt), 2);
  assert.deepEqual(sub.map((c) => c.text), ['A', 'keep', 'C']);
});

// A fake bridge. `lineHandler(body)` answers POST /line and `pollHandler(id)` GET /line/<id> (an answer with `pending` is a
// 202 ticket); `job(n)` answers the n-th GET /jobs/<key> (default: finished at once); `entries` may be a function, so a
// title can become saved while a test runs.
function fakeBridge({ backends = { eztrans: ['ja-ko'], claude: true, api: false, openai: false }, models = { claude: 'haiku', api: 'claude-haiku-5-5', openai: '' },
  entries = {}, srt = {}, lineHandler, pollHandler, job = () => ({ state: 'done' }) } = {}) {
  const calls = [];
  const call = async (path, body) => {
    calls.push({ path, body });
    const ok = (json) => ({ ok: true, status: json && json.pending ? 202 : 200, json, text: JSON.stringify(json) });
    if (path === '/health') return ok({ ok: true, backends, models });
    if (/^\/subs\/[^/]+$/.test(path)) return ok({ entries: typeof entries === 'function' ? entries() : entries });
    if (path.startsWith('/subs/')) return srt[path] ? { ok: true, status: 200, text: srt[path] } : { ok: false, status: 404, json: null, text: '' };
    if (path === '/line/cancel') return ok({ cancelled: 1 });
    if (path.startsWith('/line/')) return ok(await pollHandler(path.slice('/line/'.length)));
    if (path === '/line') return ok(await lineHandler(body));
    if (path === '/jobs') return ok({ state: 'running' });
    if (path.startsWith('/jobs/')) return ok(job(calls.filter((c) => c.path.startsWith('/jobs/')).length));
    return { ok: false, status: 404, error: 'nope' };
  };
  return { call, calls };
}

const base = (extra) => {
  const { cues, sub } = mk(40);
  let t = 0;
  const statuses = [];
  const o = { key: '99', title: 'T', from: 'ja', to: 'ko', backend: 'eztrans', mode: 'live', cues, subCues: sub, getTime: () => t, onStatus: (s) => statuses.push(s), ...extra };
  return { o, cues, sub, setT: (v) => { t = v; }, statuses };
};

test('prepare: bridge down, unsupported pair, backend not set up', async () => {
  const down = base({ call: async () => ({ ok: false, status: 0, error: 'x' }) });
  assert.match((await createTranslator(down.o).prepare()).reason, /not running/);
  const noApi = base({ call: fakeBridge().call, backend: 'api' });
  assert.match((await createTranslator(noApi.o).prepare()).reason, /Anthropic API cannot translate/);
  const wrongPair = base({ call: fakeBridge().call, to: 'en' });
  assert.match((await createTranslator(wrongPair.o).prepare()).reason, /ezTrans cannot translate ja to en/);
});

test('automatic translator: the first one ready for the pair, and one without a model only when the profile names one', async () => {
  const chosen = async (extra, bridge = {}) => {
    const b = fakeBridge({ ...bridge, lineHandler: async (body) => ({ texts: body.texts.map(() => 'x'), stale: false }) });
    const t = base({ call: b.call, backend: 'auto', mode: 'live', ...extra });
    const tr = createTranslator(t.o);
    const r = await tr.prepare();
    return r.ok ? tr.status().backend : r.reason;
  };
  assert.equal(await chosen({}), 'eztrans');                                  // ja -> ko: ezTrans is first and can
  assert.equal(await chosen({ to: 'en' }), 'claude');                          // ezTrans only does ja -> ko
  const onlyOpenai = { backends: { eztrans: false, claude: false, api: false, openai: true } };
  assert.match(await chosen({}, onlyOpenai), /no translator is ready for ja to ko/);       // no model configured anywhere
  assert.equal(await chosen({ models: { openai: 'my-model' } }, onlyOpenai), 'openai');
});

test('prepare: loads a translation saved earlier, even from another backend, and does not start live work', async () => {
  const { cues } = mk(40);
  const srt = toSrt(cues.map((c) => ({ ...c, text: `KO${c.text}` })));
  const b = fakeBridge({ entries: { 'ko.claude': { to: 'ko', backend: 'claude' } }, srt: { '/subs/99/ko/claude': srt } });
  const t = base({ call: b.call });
  const tr = createTranslator(t.o);
  const r = await tr.prepare();
  assert.deepEqual(r, { ok: true, saved: 40 });
  assert.equal(t.sub[7].text, 'KOL7');
  tr.start();
  await tick();
  assert.equal(b.calls.filter((c) => c.path === '/line').length, 0);
  tr.stop();
});

test('live: the first request covers the playhead window, then a seek re-aims it with a newer gen', async () => {
  const lines = [];
  const b = fakeBridge({ lineHandler: async (body) => { lines.push(body); return { texts: body.texts.map((x) => `KO${x}`), stale: false }; } });
  const t = base({ call: b.call });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();                                   // t = 0
  await tick();
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].texts, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  assert.equal(lines[0].gen, 0);
  assert.equal(t.sub[3].text, 'KOL3');

  t.setT(302);                                  // jump forward into cue 30 (300 to 305)
  tr._tick();
  await tick();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].gen, 1);
  assert.deepEqual(lines[1].texts.slice(0, 2), ['L30', 'L31']);

  t.setT(25);                                   // and back: the old window is already translated, so it asks for the next gap
  tr._tick();
  await tick();
  assert.equal(lines[2].gen, 2);
  assert.deepEqual(lines[2].texts[0], 'L8');    // L0-L7 were done on the first request
  tr.stop();
});

test('live: a stale reply keeps what it translated and its cut-off cues are asked for again, not abandoned', async () => {
  let n = 0;
  const b = fakeBridge({ lineHandler: async (body) => (++n === 1 ? { texts: ['KO0', 'KO1', '', '', '', '', '', ''], stale: true } : { texts: body.texts.map((x) => `KO${x}`), stale: false }) });
  const t = base({ call: b.call });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();
  await tick();
  assert.deepEqual(t.sub.slice(0, 3).map((c) => c.text), ['KO0', 'KO1', '']);
  tr._tick();
  await tick();
  assert.equal(t.sub[2].text, 'KOL2');
  tr.stop();
});

test('live: a cue that translates to nothing is not retried forever, and the finished title is saved once', async () => {
  const seen = [];
  const b = fakeBridge({ lineHandler: async (body) => { seen.push(body.texts.length); return { texts: body.texts.map((x) => (x === 'L5' ? '' : `KO${x}`)), stale: false }; } });
  const t = base({ call: b.call });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();
  for (let i = 0; i < 12; i++) { tr._tick(); await tick(); }
  assert.equal(t.sub[5].text, '');
  assert.equal(seen.reduce((a, x) => a + x, 0), 40);           // every cue asked for exactly once
  assert.equal(b.calls.filter((c) => c.path === '/jobs').length, 1);
  tr.stop();
});

// Timings small enough that these tests wait milliseconds, not seconds (the real ones live in src/tuning.js).
const FAST = { tickMs: 5, retryMs: 10, maxRetryMs: 40, notifyAfterErrors: 3, jobPollMs: 1, saveWaitPollMs: 1, lostAfterPolls: 2 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('live: bridge errors back off, the user is told after a few, and translation resumes when the bridge answers again', async (ctx) => {
  const lineAt = [];
  let up = false;
  const b = fakeBridge({ lineHandler: async (body) => { lineAt.push(Date.now()); if (!up) throw new Error('down'); return { texts: body.texts.map((x) => `KO${x}`), stale: false }; } });
  const call = async (p, body) => { try { return await b.call(p, body); } catch (e) { return { ok: false, status: 0, error: e.message }; } };
  const t = base({ call, tuning: FAST });
  const tr = createTranslator(t.o);
  ctx.after(() => tr.stop());                                 // a failed assertion must not leave the loop running
  await tr.prepare();
  tr.start();
  await wait(220);                                            // several failures: waits of 10, 20, 40, 40 ... ms
  assert.ok(t.statuses.some((s) => /paused, retrying/.test(s)), t.statuses.join('|'));
  assert.ok(lineAt.length >= 4 && lineAt.length <= 10, `${lineAt.length} requests while the bridge was down`);
  const gaps = lineAt.slice(1).map((x, i) => x - lineAt[i]);
  assert.ok(gaps[gaps.length - 1] >= 35, `gaps did not grow to the cap: ${gaps.join(',')}`);
  up = true;                                                  // the bridge comes back
  await wait(120);
  assert.equal(t.sub[0].text, 'KOL0');
  assert.ok(t.statuses.filter((s) => s === 'Translating live').length >= 2, 'user was not told it recovered');
  tr.stop();
});

test('live: a translated reply that is not a string is ignored, not stored', async () => {
  const b = fakeBridge({ lineHandler: async (body) => ({ texts: body.texts.map((x, i) => (i === 0 ? { oops: 1 } : `KO${x}`)), stale: false }) });
  const t = base({ call: b.call, tuning: FAST });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();
  await wait(60);
  tr.stop();
  assert.ok(t.sub.every((c) => typeof c.text === 'string'));
  assert.equal(t.sub[1].text, 'KOL1');
});

test('saved translation: cues sharing a start time each keep their own line', () => {
  const cues = [{ start: 5, end: 8, text: 'a' }, { start: 5, end: 9, text: 'b' }, { start: 20, end: 25, text: 'c' }];
  const sub = cues.map((c) => ({ ...c, text: '' }));
  const srt = toSrt([{ start: 5, end: 8, text: 'A' }, { start: 5, end: 9, text: 'B' }, { start: 20, end: 25, text: 'C' }]);
  assert.equal(fillFromSrt(cues, sub, srt), 3);
  assert.deepEqual(sub.map((c) => c.text), ['A', 'B', 'C']);                  // not ['B', 'B', 'C']
});

test('prepare: a translation saved from another source language is not applied', async () => {
  const { cues } = mk(10);
  const srt = toSrt(cues.map((c) => ({ ...c, text: `X${c.text}` })));
  const b = fakeBridge({ entries: { 'ko.claude': { to: 'ko', from: 'en', backend: 'claude' } }, srt: { '/subs/99/ko/claude': srt } });
  const t = base({ call: b.call });
  const r = await createTranslator(t.o).prepare();
  assert.deepEqual(r, { ok: true, saved: 0 });
  assert.ok(t.sub.every((c) => c.text === ''));
  assert.ok(!b.calls.some((c) => c.path.startsWith('/subs/99/ko/')), 'it should not even download it');
});

test('prepare: a saved translation that fits only part of the cues is used, and live translation fills the rest', async () => {
  const { cues } = mk(40);
  const srt = toSrt(cues.slice(0, 30).map((c) => ({ ...c, text: `KO${c.text}` })));               // 75 % of the title
  const b = fakeBridge({ entries: { 'ja-ko.claude': { to: 'ko', from: 'ja', backend: 'claude', file: '99.ja-ko.claude.srt' } }, srt: { '/subs/99/99.ja-ko.claude.srt': srt },
    lineHandler: async (body) => ({ texts: body.texts.map((x) => `LIVE${x}`), stale: false }) });
  const t = base({ call: b.call, tuning: FAST });
  const tr = createTranslator(t.o);
  assert.deepEqual(await tr.prepare(), { ok: true, saved: 0 });
  assert.equal(t.sub[3].text, 'KOL3');                                       // what fit was applied
  assert.ok(t.statuses.some((s) => /only fits 30 of 40/.test(s)), t.statuses.join('|'));
  tr.start();
  await wait(80);
  tr.stop();
  assert.equal(t.sub[35].text, 'LIVEL35');                                   // the gap was filled live
  assert.equal(t.sub[3].text, 'KOL3');                                       // and what was saved was not redone
});

test('saving the finished title: reported only once the job is done; a failing job is reported as such and retried later', async () => {
  const done = fakeBridge({ job: (n) => (n < 3 ? { state: 'running' } : { state: 'done', backend: 'eztrans' }) });
  const a = base({ call: done.call, tuning: FAST });
  a.sub.forEach((c, i) => { c.text = `KO${i}`; });                                  // everything already translated
  const tr = createTranslator(a.o);
  await tr.prepare();
  tr.start();
  await wait(60);
  tr.stop();
  assert.deepEqual(a.statuses.filter((s) => /saved|save/i.test(s)), ['Translation saved for this title']);
  assert.ok(done.calls.filter((c) => c.path.startsWith('/jobs/')).length >= 3, 'it did not wait for the job');

  const broken = fakeBridge({ job: () => ({ state: 'error', error: 'disk full' }) });
  const b = base({ call: broken.call, tuning: { ...FAST, maxRetryMs: 5000 } });        // a long wait before the next try
  b.sub.forEach((c, i) => { c.text = `KO${i}`; });
  const tr2 = createTranslator(b.o);
  await tr2.prepare();
  tr2.start();
  await wait(60);
  tr2.stop();
  assert.ok(b.statuses.some((s) => /Could not save the translation: disk full/.test(s)), b.statuses.join('|'));
  assert.ok(!b.statuses.includes('Translation saved for this title'));
  assert.equal(broken.calls.filter((c) => c.path === '/jobs').length, 1, 'it retried at once instead of waiting');

  // ... and with a short wait it does try again (the failure was not remembered for ever).
  const flaky = fakeBridge({ job: (n) => (n === 1 ? { state: 'error', error: 'busy' } : { state: 'done' }) });
  const c = base({ call: flaky.call, tuning: { ...FAST, maxRetryMs: 15 } });
  c.sub.forEach((x, i) => { x.text = `KO${i}`; });
  const tr3 = createTranslator(c.o);
  await tr3.prepare();
  tr3.start();
  await wait(120);
  tr3.stop();
  assert.ok(c.statuses.includes('Translation saved for this title'), c.statuses.join('|'));
});

// The bridge's saved entry for a whole-title job of these cues (numbered by source position, see fillFromSrt).
const savedEntry = (cues, extra = {}) => ({ to: 'ko', from: 'ja', backend: 'claude', model: 'haiku', file: '99.ja-ko.claude.srt',
  numbering: 'source', count: cues.length, sourceHash: textsHash(cues.map((c) => c.text)), ...extra });

test('whole-title mode: shows progress, loads the result, and gives up when the bridge stops knowing the job', async () => {
  const { cues } = mk(10);
  const srt = toSrt(cues.map((c, i) => ({ ...c, text: `KO${c.text}`, n: i + 1 })));
  let finished = false;
  const ok = fakeBridge({ entries: () => (finished ? { 'ja-ko.claude': savedEntry(cues) } : {}), srt: { '/subs/99/99.ja-ko.claude.srt': srt },
    job: (n) => (n < 3 ? { state: 'running', done: n * 3, total: 10 } : ((finished = true), { state: 'done' })) });
  const a = base({ call: ok.call, backend: 'claude', mode: 'process', tuning: FAST });
  const sub = cues.map((c) => ({ ...c, text: '' }));
  const tr = createTranslator({ ...a.o, cues, subCues: sub });
  await tr.prepare();
  tr.start();
  await wait(80);
  assert.ok(a.statuses.some((s) => /Translating 3\/10/.test(s)), a.statuses.join('|'));
  assert.equal(a.statuses.at(-1), 'Translation ready');
  assert.equal(sub[4].text, 'KOL4');
  assert.equal(tr.status().phase, 'saved');
  assert.match(ok.calls.find((c) => c.path.startsWith('/jobs/')).path, /^\/jobs\/99\?from=ja&to=ko&backend=claude$/);

  const lost = fakeBridge({ job: () => ({ state: 'none' }) });             // a restarted bridge has forgotten the job
  const b = base({ call: lost.call, backend: 'claude', mode: 'process', tuning: FAST });
  const trLost = createTranslator(b.o);
  await trLost.prepare();
  trLost.start();
  await wait(60);
  assert.equal(b.statuses.at(-1), 'Lost contact with the translation bridge');
  assert.equal(lost.calls.filter((c) => c.path.startsWith('/jobs/')).length, FAST.lostAfterPolls);

  const cancelled = fakeBridge({ job: () => ({ state: 'cancelled' }) });
  const c = base({ call: cancelled.call, backend: 'claude', mode: 'process', tuning: FAST });
  const trCancelled = createTranslator(c.o);
  await trCancelled.prepare();
  trCancelled.start();
  await wait(40);
  assert.equal(c.statuses.at(-1), 'Translation stopped');
});

test('a model named in the profile goes with every request and picks the saved file made with it', async () => {
  const { cues } = mk(10);
  const sonnet = toSrt(cues.map((c, i) => ({ ...c, text: `S${c.text}`, n: i + 1 })));
  const haiku = toSrt(cues.map((c, i) => ({ ...c, text: `H${c.text}`, n: i + 1 })));
  const entries = {
    'ja-ko.claude': savedEntry(cues),                                                          // the default model, haiku
    'ja-ko.claude-sonnet': savedEntry(cues, { model: 'sonnet', file: '99.ja-ko.claude-sonnet.srt' }),
  };
  const b = fakeBridge({ entries, srt: { '/subs/99/99.ja-ko.claude.srt': haiku, '/subs/99/99.ja-ko.claude-sonnet.srt': sonnet } });
  const pick = async (models) => {
    const t = base({ call: b.call, backend: 'claude', mode: 'process', models, cues, subCues: cues.map((c) => ({ ...c, text: '' })) });
    await createTranslator(t.o).prepare();
    return t.o.subCues[0].text;
  };
  assert.equal(await pick({ claude: 'sonnet' }), 'SL0');
  assert.equal(await pick({}), 'HL0');                                       // no model named: the bridge's default (haiku)

  const lines = [];
  const live = fakeBridge({ lineHandler: async (body) => { lines.push(body); return { texts: body.texts.map(() => 'x'), stale: false }; } });
  const t = base({ call: live.call, backend: 'claude', mode: 'live', models: { claude: 'opus' } });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();
  await tick();
  tr.stop();
  assert.equal(lines[0].model, 'opus');
});

test('translate again: nothing saved is loaded, the job asks for a fresh run, and its result replaces the lines', async () => {
  const { cues } = mk(10);
  const old = toSrt(cues.map((c, i) => ({ ...c, text: `OLD${c.text}`, n: i + 1 })));
  const fresh = toSrt(cues.map((c, i) => ({ ...c, text: `NEW${c.text}`, n: i + 1 })));
  let done = false;
  const b = fakeBridge({ entries: () => ({ 'ja-ko.claude': savedEntry(cues) }), job: () => ((done = true), { state: 'done' }) });
  const call = async (path, body) => (path === '/subs/99/99.ja-ko.claude.srt' ? { ok: true, status: 200, text: done ? fresh : old } : b.call(path, body));
  const t = base({ call, backend: 'claude', mode: 'live', fresh: true, cues, subCues: cues.map((c) => ({ ...c, text: '' })), tuning: FAST });
  const tr = createTranslator(t.o);
  assert.deepEqual(await tr.prepare(), { ok: true, saved: 0 });
  assert.equal(t.o.subCues[0].text, '');                                     // the old translation was not even loaded
  tr.start();
  await wait(40);
  assert.equal(b.calls.find((c) => c.path === '/jobs').body.fresh, true);    // a whole-title job, although the mode is live
  assert.equal(t.o.subCues[3].text, 'NEWL3');
});

test('live: a slow translation answers with a ticket that is polled until the lines are ready', async () => {
  let polls = 0;
  const b = fakeBridge({
    lineHandler: async () => ({ pending: 'abc123' }),
    pollHandler: async (id) => (++polls < 3 ? { pending: id } : { texts: ['KO0', 'KO1', 'KO2', 'KO3', 'KO4', 'KO5', 'KO6', 'KO7'], stale: false }),
  });
  const t = base({ call: b.call });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(polls, 3);
  assert.ok(b.calls.filter((c) => c.path.startsWith('/line/')).every((c) => c.path === '/line/abc123' && c.body === undefined));
  assert.equal(t.sub[2].text, 'KO2');
  tr.stop();
});

test('stop: a request still in flight is cancelled at the bridge, so it does not hold the live queue', async () => {
  const b = fakeBridge({ lineHandler: () => new Promise(() => {}) });       // never answers
  const t = base({ call: b.call });
  const tr = createTranslator(t.o);
  await tr.prepare();
  tr.start();
  await tick();
  tr.stop();
  const cancel = b.calls.find((c) => c.path === '/line/cancel');
  assert.ok(cancel, 'no cancel sent');
  assert.equal(cancel.body.client, b.calls.find((c) => c.path === '/line').body.client);

  const idle = fakeBridge({ lineHandler: async (body) => ({ texts: body.texts.map(() => 'x'), stale: false }) });
  const u = base({ call: idle.call });
  const tr2 = createTranslator(u.o);
  await tr2.prepare();
  tr2.start();
  await tick(); await tick();
  tr2.stop();
  assert.ok(!idle.calls.some((c) => c.path === '/line/cancel'), 'nothing in flight, nothing to cancel');
});

test('saved file: numbered by source position it is matched by number, unless the main track changed since', () => {
  // Two cues were re-timed after the file was saved (the main track's sync was fixed): their texts are the same.
  const saved = [{ start: 0, end: 2, text: 'a' }, { start: 3, end: 5, text: 'b' }, { start: 10, end: 12, text: 'c' }];
  const retimed = [{ start: 10.2, end: 12.2, text: 'a' }, { start: 13.2, end: 15.2, text: 'b' }, { start: 20, end: 22, text: 'c' }];
  const srt = toSrt(saved.map((c, i) => ({ ...c, text: c.text.toUpperCase(), n: i + 1 })));
  const entry = { numbering: 'source', count: 3, sourceHash: textsHash(saved.map((c) => c.text)) };
  const fill = (cues, e) => { const sub = cues.map((c) => ({ ...c, text: '' })); fillFromSrt(cues, sub, srt, e); return sub.map((c) => c.text); };
  assert.deepEqual(fill(retimed, entry), ['A', 'B', 'C']);                    // same texts: every line, on the new times
  // Another main track (different texts) with the same count: numbers would put lines on the wrong cues, so times decide.
  const other = [{ start: 0, end: 2, text: 'x' }, { start: 7, end: 9, text: 'y' }, { start: 10, end: 12, text: 'z' }];
  assert.deepEqual(fill(other, entry), ['A', '', 'C']);                      // by number it would have been A, B, C
  assert.deepEqual(fill(retimed, {}), ['', '', '']);                         // an old file without numbering: times only
});

import { wantsTranslation } from '../src/translate.js';

test('wantsTranslation: only for a different wanted language with no real track, unless translation is off', () => {
  const p = (sub, mode = 'auto') => ({ sub, translate: { mode } });
  assert.equal(wantsTranslation(p(['ko', 'en']), 'ja', false), true);
  assert.equal(wantsTranslation(p(['ko', 'en']), 'ja', true), false);        // a real Korean track exists
  assert.equal(wantsTranslation(p(['ko']), 'ko', false), false);             // main is already Korean
  assert.equal(wantsTranslation(p(['kor']), 'ko', false), false);            // 639-2 code normalised
  assert.equal(wantsTranslation(p([]), 'ja', false), false);                 // no sub language wanted
  assert.equal(wantsTranslation(p(['ko'], 'off'), 'ja', false), false);      // translation off
  assert.equal(wantsTranslation(p(['ko'], 'live'), 'ja', false), true);
});

test('each translator names itself, and every /line request carries that name', async () => {
  const seen = [];
  const mkTr = () => {
    const { cues, sub } = mk(10);
    const b = fakeBridge({ lineHandler: async (body) => { seen.push(body.client); return { texts: body.texts.map((x) => `KO${x}`), stale: false }; } });
    return createTranslator({ call: b.call, key: 'k', title: 't', from: 'ja', to: 'ko', backend: 'eztrans', mode: 'live', cues, subCues: sub, getTime: () => 0 });
  };
  const a = mkTr(), b = mkTr();
  await a.prepare(); await b.prepare();
  a.start(); b.start();
  await tick();
  a.stop(); b.stop();
  assert.equal(seen.length, 2);
  assert.ok(seen[0] && seen[1] && seen[0] !== seen[1], seen.join());
});

test('any wanted language reaches the bridge as asked: German here, in live lines and in the whole-title job', async () => {
  const lines = [];
  const b = fakeBridge({ backends: { eztrans: ['ja-ko'], claude: true }, lineHandler: async (body) => { lines.push(body); return { texts: body.texts.map(() => 'de'), stale: false }; } });
  const live = base({ call: b.call, to: 'de', backend: 'auto', mode: 'live' });
  const tr = createTranslator(live.o);
  assert.deepEqual(await tr.prepare(), { ok: true, saved: 0 });
  tr.start();
  await tick();
  tr.stop();
  assert.equal(tr.status().backend, 'claude');                               // ezTrans cannot do ja -> de
  assert.equal(lines[0].to, 'de');
  assert.equal(lines[0].from, 'ja');

  const job = fakeBridge({ backends: { claude: true } });
  const whole = base({ call: job.call, to: 'de', backend: 'claude', mode: 'process', tuning: FAST });
  const tr2 = createTranslator(whole.o);
  await tr2.prepare();
  tr2.start();
  await wait(20);
  assert.equal(job.calls.find((c) => c.path === '/jobs').body.to, 'de');
  assert.match(job.calls.find((c) => c.path.startsWith('/jobs/')).path, /[?&]to=de(&|$)/);
});
