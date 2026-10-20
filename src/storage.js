// Settings live in chrome.storage.sync so they follow the browser profile, not the Jellyfin server.
// If they outgrow sync's per-item limit they fall back to local storage (see saveSettings).
import { DEFAULTS, sanitizeSettings } from './profile.js';

export async function loadSettings() {
  const [{ settings: synced }, { settings: local }] = await Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get('settings'),
  ]);
  // Local only holds settings that did not fit in sync, so it wins when present.
  return sanitizeSettings(local) || sanitizeSettings(synced) || structuredClone(DEFAULTS);
}

// Returns 'sync' or 'local' depending on where the settings ended up; throws if neither accepted them.
export async function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  if (!clean) throw new Error('no valid profiles');
  try {
    await chrome.storage.sync.set({ settings: clean });
    await chrome.storage.local.remove('settings');
    return 'sync';
  } catch (e) {
    await chrome.storage.local.set({ settings: clean });      // e.g. QUOTA_BYTES_PER_ITEM exceeded
    return 'local';
  }
}

export function activeProfile(settings) {
  return settings.profiles.find((p) => p.id === settings.activeProfile) || settings.profiles[0];
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'sync' || area === 'local') && changes.settings) cb();
  });
}
