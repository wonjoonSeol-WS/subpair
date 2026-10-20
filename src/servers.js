// The Jellyfin servers Subpair runs on, for the options page: origins kept in storage.local `servers`, each readable through
// a host permission (asked for per server; on this computer it is part of the manifest already). background.js registers
// the content script for them.
const NETFLIX = /^https?:\/\/([a-z0-9-]+\.)*netflix\.com(:\d+)?$/i;
// The manifest's own host permissions: never removed when a server on this computer is taken off the list.
const MANIFEST_HOSTS = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

// "jellyfin.local:8096/web/" or a full address -> "http://jellyfin.local:8096"; '' when it is not an http(s) address.
export function serverOrigin(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.origin : '';
  } catch { return ''; }
}

export const isNetflix = (origin) => NETFLIX.test(origin);

export async function enabledServers() {
  const { servers } = await chrome.storage.local.get('servers');
  return Array.isArray(servers) ? servers.filter((o) => typeof o === 'string') : [];
}

// Must run straight from a click: the browser shows its permission prompt only for a user action. -> enabled or not.
export function addServer(origin) {
  return chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    if (!granted) return false;
    const list = await enabledServers();
    if (!list.includes(origin)) await chrome.storage.local.set({ servers: [...list, origin] });
    return true;
  });
}

export async function removeServer(origin) {
  await chrome.storage.local.set({ servers: (await enabledServers()).filter((o) => o !== origin) });
  if (!MANIFEST_HOSTS.test(origin)) await chrome.permissions.remove({ origins: [`${origin}/*`] });
}

export function onServersChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.servers) cb(); });
}
