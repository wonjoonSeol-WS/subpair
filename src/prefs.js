// Per-browser state that is not part of a profile (chrome.storage.local): the on/off switch, the transcript panel in
// fullscreen, and titles whose second line is translated despite a real track. Profiles live in src/storage.js, the
// Jellyfin servers Subpair may run on in the browser's own permissions (src/servers.js).
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
