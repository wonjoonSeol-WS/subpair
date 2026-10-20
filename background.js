// The extension's worker: the on/off switch (toolbar button and keyboard command), opening the options page for content
// scripts, and calls to the local translation bridge.

// Text in the browser's language (_locales/<lang>/messages.json).
const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

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

chrome.action.onClicked.addListener(() => { toggle(); });
chrome.commands.onCommand.addListener((command) => { if (command === 'toggle-subpair') toggle(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.enabled) showState(); });
chrome.runtime.onStartup.addListener(() => { showState(); });
// A new install has no languages yet: the options page asks for them.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  showState();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

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
