// Adapter for netflix.com. The page-world half is src/netflix-page.js (manifest.json injects it); this file is its
// client in the extension's content-script world, plus the pure helpers (track choice) that tests can reach.
import { parseSrt } from './srt.js';
import { parseTtml } from './ttml.js';
import { TUNING } from './tuning.js';

export const isNetflix = () => /(^|\.)netflix\.com$/.test(location.hostname);

export function movieIdFromPath(pathname) {
  const m = /\/watch\/(\d+)/.exec(pathname);
  return m ? m[1] : null;
}

const movieIdFromUrl = () => movieIdFromPath(location.pathname);

let seq = 0;
function rpc(op, extra = {}, timeoutMs = TUNING.netflix.rpcMs) {
  return new Promise((resolve, reject) => {
    const id = `c${++seq}`;
    const done = (fn, v) => { clearTimeout(timer); window.removeEventListener('message', on); fn(v); };
    const on = (e) => {
      const m = e.data;
      if (e.origin !== location.origin || !m || m.subpair !== true || m.dir !== 'res' || m.id !== id) return;
      if (m.ok) done(resolve, m); else done(reject, new Error(m.error || `${op} failed`));
    };
    const timer = setTimeout(() => done(reject, new Error(`${op} timed out`)), timeoutMs);
    window.addEventListener('message', on);
    window.postMessage({ ...extra, subpair: true, dir: 'req', id, op }, location.origin);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The manifest arrives a moment after the player starts. Resolves the track list, or throws after timeoutMs.
async function waitTracks(movieId, timeoutMs = TUNING.netflix.manifestWaitMs) {
  const until = Date.now() + timeoutMs;
  const reload = 'Netflix subtitle list not seen (reload the page once after installing the extension)';
  for (;;) {
    let r;
    try { r = await rpc('manifest', { movieId }); } catch (e) { throw new Error(`${reload}: ${e.message}`); }   // the page-world script is missing
    if (r.tracks && r.tracks.length) return r.tracks;
    if (Date.now() > until) throw new Error(reload);
    await sleep(TUNING.netflix.manifestPollMs);
  }
}

// A manifest track in the common track shape (see src/tracks.js). Plain subtitles beat closed captions, which add sound
// descriptions; forced-narrative tracks (the common shape's `forced`) only cover foreign speech.
export function toTrack(t) {
  return { id: t.id, lang: t.lang, label: `${t.lang} ${t.kind || 'subtitles'}`, forced: !!t.forced, extra: false, rank: t.kind === 'subtitles' ? 2 : 0, raw: t };
}

async function fetchCues(track) {
  const { text } = await rpc('fetch', { url: track.url }, TUNING.netflix.fetchMs);
  return track.format === 'webvtt-lssdh-ios8' ? parseSrt(text) : parseTtml(text);
}

// Setting video.currentTime makes Netflix's player throw; its own API seeks properly.
async function seek(seconds) {
  await rpc('seek', { ms: seconds * 1000 });
}

// The text of an element's text nodes joined by spaces: the title is split over nested elements (show, episode number,
// episode title) that textContent would glue together.
export function joinedText(el) {
  const parts = [];
  const walk = (n) => {
    if (n.nodeType === 3) { const t = n.nodeValue.trim(); if (t) parts.push(t); } else for (const c of n.childNodes || []) walk(c);
  };
  if (el) walk(el);
  return parts.join(' ');
}

// Netflix's player shows the title in a few places that change between builds; a missing one is fine.
const pageTitle = () => joinedText(document.querySelector('[data-uia="video-title"]')).slice(0, 200);

// The shape main.js works with (the other site is src/jellyfin.js).
export const adapter = {
  name: 'netflix',
  // Every layer of Netflix's player (video, controls, menus) is absolutely positioned inside div.watch-video, so shrinking
  // that one box moves them all together. Checked on a live watch page; Netflix can rename it, and this is the one place to fix.
  // In fullscreen div.watch-video is the fullscreen element, which the browser keeps at the full screen size, so the box
  // inside it is shrunk instead. hide: Netflix's own subtitle layer, hidden while Subpair shows the lines.
  layout: { player: ['.watch-video'], fullscreen: ['.watch-video--player-view'], osd: [], hide: ['.player-timedtext'] },
  findVideo: () => (movieIdFromUrl() ? document.querySelector('video') : null),
  forget() {},
  async currentItem() {                                 // the title id is in the address, nothing to look up
    const id = movieIdFromUrl();
    return id ? { id } : null;
  },
  async open(itemId) {
    const tracks = (await waitTracks(itemId)).map(toTrack);
    const title = itemId === movieIdFromUrl() ? pageTitle() : '';                  // the page shows the title playing, not another one
    return { key: itemId, title: title || `Netflix ${itemId}`, tracks, fetchCues: (track) => fetchCues(track.raw) };
  },
  // The next episode, from the episode list the player loaded. Its subtitle list only exists once Netflix itself prepares
  // that episode, near the end of this one, so ready() says when open() can work.
  async nextItem(itemId) {
    const r = await rpc('next', { movieId: itemId });
    return r.next ? { id: String(r.next) } : null;
  },
  async ready(itemId) {
    const r = await rpc('manifest', { movieId: itemId });
    return !!(r.tracks && r.tracks.length);
  },
  seekTo(video, seconds) { return seek(seconds); },     // a promise: the caller reports a failed seek
};
