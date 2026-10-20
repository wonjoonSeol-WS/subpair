// background.js is a plain worker script; it runs here in a sandbox with a fake chrome API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isBridgeUrl } from '../src/profile.js';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const english = JSON.parse(fs.readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));

// granted: origin patterns the user already allowed; servers: the enabled list in storage; grant: what a permission prompt
// answers; firefox: a `browser` global.
function load({ fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{}' }), granted = [], servers, grant = true, firefox = false } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const store = servers ? { servers: [...servers] } : {};
  const badge = {};
  const opened = [];
  const fetches = [];
  const origins = ['http://127.0.0.1/*', 'http://localhost/*', '*://*.netflix.com/*', ...granted];
  const site = { requested: [], registered: [], injected: [] };
  const chrome = {
    permissions: {
      getAll: async () => ({ origins: [...origins], permissions: ['storage', 'scripting'] }),
      // The manifest's http://localhost/* and http://127.0.0.1/* cover every port, so a server on this computer needs no prompt.
      contains: async ({ origins: asked }) => asked.every((o) => origins.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\*$/.test(o)),
      request({ origins: asked }) {
        site.requested.push(...asked);
        return this.contains({ origins: asked }).then((has) => { if (!has && grant) origins.push(...asked); return has || grant; });
      },
      onAdded: on('permAdded'), onRemoved: on('permRemoved'),
      revoke(pattern) { origins.splice(origins.indexOf(pattern), 1); listeners.permRemoved({ origins: [pattern] }); },
    },
    scripting: {
      getRegisteredContentScripts: async () => site.registered.map((s) => ({ ...s })),
      registerContentScripts: async (list) => { site.registered.push(...list); },
      unregisterContentScripts: async ({ ids }) => { site.registered = site.registered.filter((s) => !ids.includes(s.id)); },
      executeScript: async (o) => { site.injected.push(o); },
    },
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
  const globals = { chrome, AbortSignal, URL, fetch: async (url, init) => { fetches.push({ url, init }); return fetchImpl(url, init); } };
  if (firefox) globals.browser = chrome;
  const ctx = vm.createContext(globals);
  vm.runInContext(source, ctx);
  const ask = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
  return { ctx, listeners, store, badge, opened, fetches, ask, site, chrome };
}

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const page = (url, id = 7) => ({ id, url });
const plain = (v) => JSON.parse(JSON.stringify(v));            // values made in the sandbox, compared as plain data

test('the toolbar button and the keyboard command flip the switch, and the badge says OFF while it is off', async () => {
  const bg = load();
  bg.listeners.action(page('https://example.com/some/page'));
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

test('the toolbar button on a Jellyfin page of a server not enabled yet asks for it, then starts Subpair there at once', async () => {
  const bg = load();
  await settle();
  bg.store.enabled = false;                                   // even when it was off: enabling a server means using it
  bg.listeners.action(page('http://192.168.0.10:8096/web/#/video', 42));
  await settle(10);
  assert.deepEqual(plain(bg.site.requested), ['http://192.168.0.10:8096/*']);
  assert.deepEqual(plain(bg.store.servers), ['http://192.168.0.10:8096']);
  assert.deepEqual(plain(bg.site.registered.map((s) => [s.matches, s.js])), [[['http://192.168.0.10:8096/*'], ['content.js']]]);
  assert.deepEqual(plain(bg.site.injected.map((o) => [o.target.tabId, o.files])), [[42, ['content.js']]]);
  assert.equal(bg.store.enabled, true);
});

test('a Jellyfin server on this computer is enabled without a prompt and gets the content script like any other', async () => {
  const bg = load({ grant: false });                          // a prompt would be refused: none is needed here
  await settle();
  bg.listeners.action(page('http://localhost:8096/web/#/home', 5));
  await settle(10);
  assert.deepEqual(plain(bg.store.servers), ['http://localhost:8096']);
  assert.deepEqual(plain(bg.site.registered.map((s) => s.matches[0])), ['http://localhost:8096/*']);
  assert.equal(bg.site.injected.length, 1);
});

test('a refused prompt changes nothing; an enabled server, Netflix and any other page just flip the switch', async () => {
  const refused = load({ grant: false });
  await settle();
  refused.listeners.action(page('https://jf.example/web/index.html'));
  await settle(10);
  assert.deepEqual(plain(refused.site.requested), ['https://jf.example/*']);
  assert.deepEqual(plain([refused.site.registered, refused.site.injected]), [[], []]);
  assert.equal(refused.store.servers, undefined);
  assert.equal(refused.store.enabled, undefined);

  const bg = load({ granted: ['https://jf.example/*'], servers: ['https://jf.example'] });
  await settle();
  for (const url of ['https://jf.example/web/index.html', 'https://www.netflix.com/watch/1', 'https://example.com/news/page']) {
    const before = bg.store.enabled;
    bg.listeners.action(page(url));
    await settle();
    assert.notEqual(bg.store.enabled, before, url);
  }
  assert.deepEqual(plain(bg.site.requested), []);
});

test('the content script follows the enabled servers the browser lets Subpair read, and gets shim.js first in Firefox', async () => {
  const bg = load({ granted: ['https://a.example/*', 'http://b.example:8096/*'], servers: ['https://a.example', 'http://b.example:8096', 'https://gone.example'] });
  bg.listeners.startup();
  await settle(10);
  assert.deepEqual(plain(bg.site.registered.map((s) => s.matches[0]).sort()), ['http://b.example:8096/*', 'https://a.example/*']);
  assert.deepEqual(plain(bg.store.servers), ['https://a.example', 'http://b.example:8096']);      // no permission: dropped
  bg.chrome.permissions.revoke('https://a.example/*');                                           // taken back in the browser
  await settle(10);
  assert.deepEqual(plain(bg.site.registered.map((s) => s.matches[0])), ['http://b.example:8096/*']);
  await bg.chrome.storage.local.set({ servers: [] });                                            // removed in the options page
  await settle(10);
  assert.deepEqual(plain(bg.site.registered), []);

  const ff = load({ granted: ['https://a.example/*'], servers: ['https://a.example'], firefox: true });
  ff.listeners.startup();
  await settle(10);
  assert.deepEqual(plain(ff.site.registered[0].js), ['shim.js', 'content.js']);
});
