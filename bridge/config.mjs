// Bridge settings, lowest to highest priority:
//   bridge/config.defaults.json   every setting with its default value
//   bridge/config.json            your own overrides, same shape, only the keys you change (see config.example.json)
//   environment                   BRIDGE_PORT, BRIDGE_STORE, ANTHROPIC_API_KEY, OPENAI_API_KEY
// A key that is not in the defaults is an error, so a typo cannot silently do nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_STORE_DIR = path.join(BRIDGE_DIR, 'store');
// LunaTranslator's 32-bit helper, shipped in bridge/vendor (see its README there): ezTrans needs only its own folder set.
export const BUNDLED_EZTRANS_HELPER = path.join(BRIDGE_DIR, 'vendor', 'lunatranslator', 'LunaSubprocess32.exe');

// Whole numbers and their allowed range. Everything numeric in the defaults file must appear here.
const NUMBERS = {
  port: [1, 65535],
  'limits.maxText': [1, 1e6], 'limits.maxLines': [1, 10000], 'limits.maxContext': [0, 1000], 'limits.maxCues': [1, 1e6],
  'limits.maxJobs': [1, 1e5], 'limits.maxRunningJobs': [1, 1000], 'limits.maxClients': [1, 1e5],
  'limits.bodyBytesLine': [1, 1e9], 'limits.bodyBytesJobs': [1, 1e9],
  // The extension gives up on a request after 25 s (a Chrome extension worker is stopped when a fetch takes 30 s).
  'limits.lineWaitMs': [0, 25000], 'limits.lineResultTtlMs': [0, 3600000], 'limits.lineAbandonMs': [0, 3600000],
  'limits.maxPendingLines': [1, 1e5],
  'llm.attempts': [1, 10], 'llm.splitDepth': [0, 10], 'llm.retries': [0, 10], 'llm.retryBaseMs': [0, 600000], 'llm.retryMaxMs': [0, 600000],
  'eztrans.chunk': [1, 500], 'eztrans.loadMs': [0, 600000], 'eztrans.startTimeoutMs': [100, 600000], 'eztrans.connectRetryMs': [1, 10000],
  'eztrans.requestTimeoutMs': [100, 3600000], 'eztrans.maxReplyBytes': [1, 1e9],
  'claude.batch': [1, 500], 'claude.context': [0, 50], 'claude.concurrency': [1, 16], 'claude.timeoutMs': [1000, 3600000], 'claude.maxOutputBytes': [1, 1e9],
  'api.batch': [1, 500], 'api.context': [0, 50], 'api.concurrency': [1, 16], 'api.timeoutMs': [1000, 3600000], 'api.maxTokens': [1, 1e6],
  'openai.batch': [1, 500], 'openai.context': [0, 50], 'openai.concurrency': [1, 16], 'openai.timeoutMs': [1000, 3600000],
};

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const LANG_RE = /^[a-z]{2,3}$/;
const ORIGIN_RE = /^(chrome|moz)-extension:\/\/[A-Za-z0-9-]+$/;
const MODEL_RE = /^[\w.:/@-]{1,100}$/;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function readJson(file, optional) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (optional && e.code === 'ENOENT') return {};
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  let v;
  try { v = JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix it or delete it`); }
  if (!isObject(v)) throw new Error(`${file} must contain a JSON object`);
  return v;
}

// base with over laid on top, key by key. Throws on a key base does not have; keys starting with // are comments.
function merge(base, over, where = '') {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('//')) continue;
    if (!Object.hasOwn(base, k)) throw new Error(`unknown setting "${where}${k}"`);
    if (isObject(base[k]) && !isObject(v)) throw new Error(`"${where}${k}" must be an object`);
    out[k] = isObject(base[k]) ? merge(base[k], v, `${where}${k}.`) : v;
  }
  return out;
}

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => o[k], obj);
const fail = (what) => { throw new Error(`bridge config: ${what}`); };

export const loadDefaults = () => readJson(path.join(BRIDGE_DIR, 'config.defaults.json'), false);

// The per-user data folder the store lives in unless storeDir says otherwise.
export function defaultStoreDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'subpair');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'subpair');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'subpair');
}

// file: the overrides file (config.json by default; the tests pass their own). env: the environment to read.
export function loadConfig(file = path.join(BRIDGE_DIR, 'config.json'), env = process.env) {
  const cfg = merge(loadDefaults(), readJson(file, true));

  if (env.BRIDGE_PORT) cfg.port = env.BRIDGE_PORT;
  if (env.ANTHROPIC_API_KEY) cfg.api.key = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) cfg.openai.key = env.OPENAI_API_KEY;
  // A relative storeDir in the file is relative to bridge/; one in BRIDGE_STORE to the current directory, like any path typed in a shell.
  if (env.BRIDGE_STORE) cfg.storeDir = path.resolve(env.BRIDGE_STORE);
  else cfg.storeDir = cfg.storeDir ? path.resolve(BRIDGE_DIR, cfg.storeDir) : defaultStoreDir(env);
  // ezTrans: the bundled helper unless helper names another one, run in its own folder unless cwd names another. Relative
  // paths are relative to bridge/, so the bridge works from any current directory.
  const ez = cfg.eztrans;
  ez.helper = ez.helper ? path.resolve(BRIDGE_DIR, ez.helper) : BUNDLED_EZTRANS_HELPER;
  ez.cwd = ez.cwd ? path.resolve(BRIDGE_DIR, ez.cwd) : path.dirname(ez.helper);
  if (ez.dir) ez.dir = path.resolve(BRIDGE_DIR, ez.dir);

  // Numbers may be written as text ("25"); anything else that is not a whole number in range is refused up front, because a
  // batch of 0 would loop forever and a concurrency of 0 would never start anything.
  for (const [name, [min, max]] of Object.entries(NUMBERS)) {
    const n = Number(get(cfg, name));
    if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(get(cfg, name))}`);
    const keys = name.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], cfg)[last] = n;
  }
  if (!LANG_RE.test(cfg.from)) fail(`from must be a language code such as ja, got ${JSON.stringify(cfg.from)}`);
  if (!Array.isArray(cfg.allowedOrigins) || !cfg.allowedOrigins.every((o) => typeof o === 'string' && ORIGIN_RE.test(o))) {
    fail('allowedOrigins must be a list of extension origins such as "chrome-extension://<id>" or "moz-extension://<uuid>"');
  }
  if (!EFFORTS.includes(cfg.api.effort)) fail(`api.effort must be one of ${EFFORTS.map((e) => JSON.stringify(e)).join(', ')}`);
  for (const name of ['claude.model', 'api.model']) if (!MODEL_RE.test(get(cfg, name))) fail(`${name} must be a model name such as haiku`);
  if (cfg.openai.model && !MODEL_RE.test(cfg.openai.model)) fail('openai.model must be a model name');
  const t = cfg.openai.temperature;
  if (t !== null && (typeof t !== 'number' || t < 0 || t > 2)) fail(`openai.temperature must be null or a number from 0 to 2, got ${JSON.stringify(t)}`);
  return cfg;
}
