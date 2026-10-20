// Per-browser state that is not part of a profile (chrome.storage.local): the on/off switch, the transcript panel in
// fullscreen, the Jellyfin servers Subpair may work on, and titles whose second line is translated despite a real track.
// Profiles themselves live in src/storage.js.
const MAX_TITLES = 500;                                  // remembered "translate instead of the track" titles

const local = () => chrome.storage.local;
const get = async (name) => (await local().get(name))[name];

// The switch is on unless it was turned off. background.js flips it from the toolbar button and the keyboard command.
export const isEnabled = async () => (await get('enabled')) !== false;
export const setEnabled = (on) => local().set({ enabled: !!on });
export function onEnabledChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.enabled) cb(changes.enabled.newValue !== false); });
}

// The transcript panel in fullscreen (in normal view it is the profile's `panel`). Older versions kept { normal, fs }.
export async function fullscreenPanel() {
  const v = await get('fullscreenPanel');
  if (typeof v === 'boolean') return v;
  const old = await get('panelPrefs');
  return !!(old && old.fs);
}
export const setFullscreenPanel = (on) => local().set({ fullscreenPanel: !!on });

// Origins (https://jellyfin.example) of the Jellyfin servers the user allowed. Any site can have a /web/ page that looks
// like Jellyfin, so a server is only used once the user says so.
export async function allowedSites() {
  const v = await get('sites');
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}
export async function allowSite(origin) {
  const sites = await allowedSites();
  if (!sites.includes(origin)) await local().set({ sites: [...sites, origin] });
}
export async function forgetSite(origin) {
  await local().set({ sites: (await allowedSites()).filter((s) => s !== origin) });
}
export function onSitesChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.sites) allowedSites().then(cb); });
}

// Titles (the session key: a Netflix id or jf-<item>) whose second line is translated from the main line even though the
// video has a track in the wanted language, because that track is bad or out of sync.
export async function translatesOverTrack(key) {
  const v = await get('translateOver');
  return Array.isArray(v) && v.includes(key);
}
export async function setTranslateOverTrack(key, on) {
  const v = (await get('translateOver')) || [];
  const rest = (Array.isArray(v) ? v : []).filter((k) => k !== key);
  await local().set({ translateOver: on ? [...rest, key].slice(-MAX_TITLES) : rest });
}
