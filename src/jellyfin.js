// Adapter for the Jellyfin web client: finds the playing item and fetches its subtitle tracks.
// Everything Jellyfin-specific lives here; the other site is src/netflix.js.
import { parseSrt } from './srt.js';
import { TUNING } from './tuning.js';
import { createAutoSaver, makeUploader, makeRemover, storageMarks } from './jellyfin-translate.js';

// The server's address: the page's origin plus any path prefix before the web client's /web/ folder (a reverse proxy's).
export function serverBase() {
  const path = location.pathname;
  const web = path.lastIndexOf('/web/');
  return location.origin + (web >= 0 ? path.slice(0, web) : '');
}

function credentials() {
  try {
    const j = JSON.parse(localStorage.getItem('jellyfin_credentials') || 'null');
    const usable = ((j && j.Servers) || []).filter((s) => s.AccessToken && s.UserId);
    // The entry for this address; failing that (a reverse proxy changes the address) the only one there is. With several
    // to choose from a guess could send one server's token to another, so there is no guess.
    return usable.find((s) => (s.ManualAddress || '').replace(/\/$/, '') === serverBase()) || (usable.length === 1 ? usable[0] : null);
  } catch {
    return null;
  }
}

function login() {
  const c = credentials();
  if (!c) throw new Error('not logged in to Jellyfin');
  return c;
}

async function api(path) {
  const c = login();
  // Jellyfin 12 can refuse the legacy X-Emby-Token header (server setting EnableLegacyAuthorization); this one is current.
  const r = await fetch(serverBase() + path, { headers: { Authorization: `MediaBrowser Token="${c.AccessToken}"` } });
  if (!r.ok) throw new Error(`Jellyfin ${r.status} for ${path}`);
  return r;
}

// Item and media source of the playing video. The stream URL carries both for direct play; transcoded HLS
// uses a blob: URL, so fall back to this device's session.
async function nowPlaying(video) {
  const src = video.currentSrc || video.src || '';
  const m = /\/[Vv]ideos\/([0-9a-fA-F-]{32,36})\//.exec(src);
  if (m) {
    const ms = /[?&]MediaSourceId=([^&]+)/i.exec(src);
    return { itemId: m[1].replace(/-/g, ''), mediaSourceId: ms ? decodeURIComponent(ms[1]) : null };
  }
  const deviceId = localStorage.getItem('_deviceId2');
  if (!deviceId) return null;
  const sessions = await (await api(`/Sessions?DeviceId=${encodeURIComponent(deviceId)}`)).json();
  const s = sessions.find((x) => x.NowPlayingItem);
  if (!s) return null;
  return { itemId: s.NowPlayingItem.Id, mediaSourceId: (s.PlayState && s.PlayState.MediaSourceId) || null };
}

async function getStreams(itemId, mediaSourceId) {
  const c = login();
  const item = await (await api(`/Users/${encodeURIComponent(c.UserId)}/Items/${encodeURIComponent(itemId)}`)).json();
  const sources = item.MediaSources || [];
  const source = sources.find((s) => s.Id === mediaSourceId) || sources[0];
  return { item, mediaSourceId: source ? source.Id : mediaSourceId, streams: source ? source.MediaStreams || [] : [] };
}

async function fetchSubtitle(itemId, mediaSourceId, index) {
  const r = await api(`/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${encodeURIComponent(index)}/0/Stream.srt`);
  return r.text();
}

const EXTRA_TITLE = /sign|song|lyric|commentary/i;

// A Jellyfin subtitle stream in the common track shape (see src/tracks.js).
export function toTrack(s) {
  return {
    id: s.Index,
    lang: s.Language || '',
    label: s.DisplayTitle || s.Language || `Track ${s.Index}`,
    forced: !!s.IsForced,
    extra: EXTRA_TITLE.test(`${s.Title || ''} ${s.DisplayTitle || ''}`),
    rank: (/srt|subrip|vtt/i.test(s.Codec || '') ? 2 : 0) + (s.IsDefault ? 1 : 0),
    raw: s,
  };
}

// Text subtitle streams only: image-based ones (PGS, VobSub) cannot be shown as text.
export const textTracks = (streams) =>
  (streams || []).filter((s) => s.Type === 'Subtitle' && s.IsTextSubtitleStream !== false).map(toTrack);

// What the polling loop remembers between calls: the last stream URL it looked up, and when the current item was accepted.
let lastSrc = null, acceptedAt = 0;

// The shape main.js works with (the other site is src/netflix.js).
export const adapter = {
  name: 'jellyfin',
  // The player box that is shrunk to make room for the bar and the panel, and the seek bar, which is fixed to the bottom of
  // the window and so has to be lifted above the bar.
  // hide: the web client's own subtitle renderers, hidden while Subpair shows the lines (jellyfin-web 12.2: .videoSubtitles
  // for text, .libassjs-canvas-parent for ASS/SSA, a bare <canvas> next to the video for PGS and VobSub).
  layout: { player: ['.videoPlayerContainer'], osd: ['.videoOsdBottom'], hide: ['.videoSubtitles', '.libassjs-canvas-parent', '.videoPlayerContainer > canvas'] },
  findVideo: () => (credentials() ? document.querySelector('video') : null),
  forget() { lastSrc = null; },

  // { id, hint } of what is playing, or null. Jellyfin is a single-page app, so this is asked every tick.
  async currentItem(video, current) {
    const src = video.currentSrc || video.src || '';
    if (current && src === lastSrc) return { id: current };              // same video, nothing to look up
    const now = await nowPlaying(video);
    if (!now) return null;
    const sameItem = now.itemId === current;
    // For blob: (HLS) playback the item comes from the session, which can still report the previous item for a few
    // seconds after an episode change. Only remember this src once the answer is trustworthy.
    if (!sameItem || !src.startsWith('blob:') || Date.now() - acceptedAt > TUNING.session.staleMs) lastSrc = src;
    if (!sameItem) acceptedAt = Date.now();
    return { id: now.itemId, hint: now.mediaSourceId };
  },

  // The episode after this one, across seasons; null for a movie or the last episode. Episodes the library only knows
  // about (no file) are skipped.
  async nextItem(itemId) {
    const { UserId: user } = login();
    const item = await (await api(`/Users/${encodeURIComponent(user)}/Items/${encodeURIComponent(itemId)}`)).json();
    if (!item.SeriesId) return null;
    const list = await (await api(`/Shows/${encodeURIComponent(item.SeriesId)}/Episodes?UserId=${encodeURIComponent(user)}&StartItemId=${encodeURIComponent(itemId)}&Limit=2`)).json();
    const next = (list.Items || [])[1];
    return next && next.LocationType !== 'Virtual' ? { id: next.Id } : null;
  },
  // Every episode of this one's season, in order.
  async seasonItems(itemId) {
    const { UserId: user } = login();
    const item = await (await api(`/Users/${encodeURIComponent(user)}/Items/${encodeURIComponent(itemId)}`)).json();
    if (!item.SeriesId || !item.SeasonId) return [{ id: itemId }];
    const list = await (await api(`/Shows/${encodeURIComponent(item.SeriesId)}/Episodes?UserId=${encodeURIComponent(user)}&SeasonId=${encodeURIComponent(item.SeasonId)}`)).json();
    return (list.Items || []).filter((e) => e.LocationType !== 'Virtual').map((e) => ({ id: e.Id }));
  },
  ready: async () => true,                              // the server lists any item's tracks at any time

  async open(itemId, hint) {
    const { item, mediaSourceId, streams } = await getStreams(itemId, hint);
    return {
      key: `jf-${itemId}`,
      title: [item.SeriesName, item.Name].filter(Boolean).join(' ') || `Jellyfin ${itemId}`,
      tracks: textTracks(streams),
      fetchCues: async (track) => parseSrt(await fetchSubtitle(itemId, mediaSourceId, track.id)),
    };
  },

  seekTo(video, seconds) { video.currentTime = seconds; },

  // Keeps the title's finished translation on the server as a subtitle track of the item, so every Jellyfin app shows it,
  // unless the item already has a subtitle in that language (src/jellyfin-translate.js). With `replace` it takes the place
  // of the track holding the translation the bridge saved before ("Translate again"). -> { start(), stop() }
  saveTranslation({ itemId, hint = null, key, from, to, backend, cues, replace = false, call, onStatus }) {
    const { AccessToken: token } = login();
    const base = serverBase();
    let sourceId = hint;
    return createAutoSaver({
      call, itemId, key, from, to, backend, cues, replace, onStatus, enabled: true,
      readMediaStreams: async () => { const s = await getStreams(itemId, sourceId); sourceId = s.mediaSourceId; return s.streams; },
      readSubtitle: (stream) => fetchSubtitle(itemId, sourceId, stream.Index),
      upload: makeUploader({ base, token }),
      remove: makeRemover({ base, token }),
      marks: storageMarks(chrome.storage.local),
    });
  },
};
