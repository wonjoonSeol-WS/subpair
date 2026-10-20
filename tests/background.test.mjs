// background.js is a plain worker script; it runs here in a sandbox with a fake chrome API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isBridgeUrl } from '../src/profile.js';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const english = JSON.parse(fs.readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));

function load({ fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{}' }) } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const store = {};
  const badge = {};
  const opened = [];
  const fetches = [];
  const chrome = {
    action: {
      onClicked: on('action'),
      setBadgeText: async ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }) => { badge.title = title; },
    },
    commands: { onCommand: on('command') },
    storage: {
      onChanged: on('storage'),
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => {
          const changes = {};
          for (const [k, v] of Object.entries(o)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
          listeners.storage(changes, 'local');
        },
      },
    },
    i18n: { getMessage: (key, subs = []) => (english[key] ? english[key].message.replace(/\$(\d)/g, (m, n) => subs[n - 1] ?? m) : '') },
    runtime: { onStartup: on('startup'), onInstalled: on('installed'), onMessage: on('message'), openOptionsPage: () => opened.push(true) },
  };
  const ctx = vm.createContext({ chrome, AbortSignal, fetch: async (url, init) => { fetches.push({ url, init }); return fetchImpl(url, init); } });
  vm.runInContext(source, ctx);
  const ask = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
  return { ctx, listeners, store, badge, opened, fetches, ask };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('the toolbar button and the keyboard command flip the switch, and the badge says OFF while it is off', async () => {
  const bg = load();
  bg.listeners.action();
  await settle(); await settle();
  assert.equal(bg.store.enabled, false);                     // missing meant on, so the first click turns it off
  assert.equal(bg.badge.text, 'OFF');
  bg.listeners.command('toggle-subpair');
  await settle(); await settle();
  assert.equal(bg.store.enabled, true);
  assert.equal(bg.badge.text, '');
  bg.listeners.command('something-else');
  await settle();
  assert.equal(bg.store.enabled, true);
});

test('a new install opens the options page (it asks for languages); an update does not', async () => {
  const bg = load();
  bg.listeners.installed({ reason: 'update' });
  assert.equal(bg.opened.length, 0);
  bg.listeners.installed({ reason: 'install' });
  assert.equal(bg.opened.length, 1);
});

test('bridge calls: only a loopback address and the bridge\'s own routes, with the timeout kept under Chrome\'s 30 s fetch limit', async () => {
  const bg = load();
  const refused = english.bridgeBadUrl.message;
  assert.equal((await bg.ask({ type: 'bridge', base: 'http://evil.example', path: '/health' })).error, refused);
  assert.equal((await bg.ask({ type: 'bridge', base: 'http://127.0.0.1:8765', path: '/admin' })).error, refused);
  assert.equal(bg.fetches.length, 0);
  const r = await bg.ask({ type: 'bridge', base: 'http://127.0.0.1:8765', path: '/line', method: 'POST', body: { a: 1 }, timeoutMs: 600000 });
  assert.equal(r.ok, true);
  assert.equal(bg.fetches[0].url, 'http://127.0.0.1:8765/line');
  assert.equal(bg.fetches[0].init.method, 'POST');
  assert.ok(vm.runInContext('MAX_TIMEOUT_MS', bg.ctx) < 30000);
});

test('the worker\'s address rule is the profile\'s isBridgeUrl', () => {
  const bg = load();
  const LOCAL = vm.runInContext('LOCAL', bg.ctx);
  for (const u of ['http://127.0.0.1:8765', 'http://localhost', 'http://localhost:9', 'https://127.0.0.1:8765', 'http://127.0.0.1:8765.evil.com',
    'http://127.0.0.2:8765', 'http://localhost:123456', 'http://127.0.0.1:8765/']) {
    assert.equal(LOCAL.test(u), isBridgeUrl(u), u);
  }
});

test('a bridge that does not answer is reported in the UI language with the time it was given', async () => {
  const bg = load({ fetchImpl: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; } });
  const r = await bg.ask({ type: 'bridge', base: 'http://127.0.0.1:8765', path: '/health', timeoutMs: 5000 });
  assert.equal(r.error, 'the bridge did not answer within 5000 ms');
});
