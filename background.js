// The extension's worker: the on/off switch (toolbar button and keyboard command), the Jellyfin servers Subpair may run
// on, opening the options page for content scripts, and calls to the local translation bridge.

// Text in the browser's language (_locales/<lang>/messages.json).
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

// ---- Jellyfin servers ----
// Jellyfin is self-hosted at any address. The servers the user enabled are kept in storage.local `servers` (origins);
// reading one needs a host permission, optional in the manifest and asked for per server, except on this computer
// (http://localhost and http://127.0.0.1 are host permissions already, for the bridge). Subpair's content script is
// registered for exactly the enabled servers it may read. Firefox content scripts also need shim.js first.
const SITE_SCRIPT_ID = 'subpair-site-';
const CONTENT_FILES = typeof browser !== 'undefined' ? ['shim.js', 'content.js'] : ['content.js'];
const NETFLIX = /^https?:\/\/([a-z0-9-]+\.)*netflix\.com(:\d+)?$/i;

// The origin of an http(s) page, '' for anything else.
function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}

// A page of a Jellyfin web client: its address has the client's /web/ folder.
const looksLikeJellyfin = (url) => { try { return new URL(url).pathname.includes('/web/'); } catch { return false; } };

async function enabledServers() {
  const { servers: list } = await chrome.storage.local.get('servers');
  return Array.isArray(list) ? list.filter((o) => typeof o === 'string' && originOf(o) === o && !NETFLIX.test(o)) : [];
}

// Registers Subpair's content script for exactly the enabled servers it may still read (run at start-up and whenever the
// list or a permission changes). A server whose permission the user took back in the browser's settings is dropped.
// One run at a time: a run can change the list, which starts another, and two at once would register the same ids.
let syncing = Promise.resolve();
function syncSiteScripts() {
  syncing = syncing.then(syncOnce, syncOnce);
  return syncing;
}
async function syncOnce() {
  const list = await enabledServers();
  const readable = [];
  for (const origin of list) if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) readable.push(origin);
  if (readable.length !== list.length) await chrome.storage.local.set({ servers: readable });
  const registered = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith(SITE_SCRIPT_ID));
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered.map((s) => s.id) });
  if (!readable.length) return;
  await chrome.scripting.registerContentScripts(readable.map((origin, i) => ({
    id: `${SITE_SCRIPT_ID}${i}`, matches: [`${origin}/*`], js: CONTENT_FILES, runAt: 'document_idle',
  })));
}

// Enables one server. The permission request must be the first thing the click does: browsers show their prompt only for
// a user action, so nothing is awaited before it. On this computer it is granted already and no prompt appears.
function askForServer(origin, tabId) {
  return chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    if (!granted) return false;
    const list = await enabledServers();
    if (!list.includes(origin)) await chrome.storage.local.set({ servers: [...list, origin] });
    await syncSiteScripts();
    await chrome.storage.local.set({ enabled: true });
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });     // start on the open page now
    return true;
  });
}

// ---- on/off ----
// One switch for every tab, kept in storage.local `enabled` (missing means on). Pages follow it through storage.onChanged.
const isOn = (v) => v !== false;

async function showState() {
  const { enabled } = await chrome.storage.local.get('enabled');
  const on = isOn(enabled);
  await chrome.action.setBadgeText({ text: on ? '' : msg('badgeOff') });
  await chrome.action.setBadgeBackgroundColor({ color: '#5c5f66' });
  await chrome.action.setTitle({ title: on ? msg('actionOn') : msg('actionOff') });
}

async function toggle() {
  const { enabled } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: !isOn(enabled) });
}

// The toolbar button on a Jellyfin page of a server not enabled yet enables it; anywhere else it turns Subpair on or off.
// The enabled servers are kept here so the click can decide without waiting (see askForServer).
let servers = null;
const refreshServers = () => enabledServers().then((list) => { servers = list; });
chrome.action.onClicked.addListener((tab) => {
  const origin = originOf(tab.url || '');
  const unknown = !servers || !servers.includes(origin);
  if (origin && !NETFLIX.test(origin) && looksLikeJellyfin(tab.url) && unknown) { askForServer(origin, tab.id); return; }
  toggle();
});
chrome.commands.onCommand.addListener((command) => { if (command === 'toggle-subpair') toggle(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled) showState();
  if (changes.servers) { refreshServers(); syncSiteScripts(); }        // the options page adds and removes servers too
});
chrome.permissions.onRemoved.addListener(() => { syncSiteScripts(); });
chrome.runtime.onStartup.addListener(() => { showState(); syncSiteScripts(); });
// A new install has no languages yet: the options page asks for them.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  showState();
  syncSiteScripts();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
refreshServers();

// ---- messages from content scripts ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'open-options') chrome.runtime.openOptionsPage();
  if (msg && msg.type === 'bridge') {
    bridgeFetch(msg).then(sendResponse);
    return true;                                   // answer asynchronously
  }
});

// ---- the translation bridge ----
// A page's own fetch to localhost would be blocked by the page's CORS rules, so content scripts ask this worker. It only
// calls a loopback address (the rule of isBridgeUrl in src/profile.js; tests/background.test.mjs keeps the two in step)
// and only the bridge's own routes.
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const ROUTES = /^\/(health|line|jobs|subs)(\/|\?|$)/;
// Chrome stops an extension worker whose fetch has waited 30 s for a response, so no call may wait that long; the bridge
// answers a slow translation with a ticket to poll instead.
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 28000;

async function bridgeFetch({ base, path, method, body, timeoutMs }) {
  if (!LOCAL.test(base) || typeof path !== 'string' || !ROUTES.test(path)) return { ok: false, status: 0, error: msg('bridgeBadUrl') };
  const limit = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(timeoutMs) || MIN_TIMEOUT_MS));
  try {
    const r = await fetch(base + path, {
      method: method === 'POST' ? 'POST' : 'GET',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(limit),
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    const timedOut = e && e.name === 'TimeoutError';
    return { ok: false, status: 0, error: timedOut ? msg('bridgeTimedOut', limit) : msg('bridgeUnreachable', e && e.message ? e.message : e) };
  }
}
