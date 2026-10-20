// Saves a finished whole-title translation to the Jellyfin item (POST /Videos/{itemId}/Subtitles) so every Jellyfin app
// lists it as an external track, unless the item already has a subtitle in that language. All side effects are injected.
import { iso6392, normLang } from './lang.js';
import { parseSrt } from './srt.js';
import { savedEntries as entriesFor, savedUrl } from './bridge.js';
import { t } from './i18n.js';

const COVERS_LINES = 0.95;              // a saved translation covering less of the main lines than this is not finished
const MATCHES_TIMINGS = 0.98;           // and nearly all of its cues must start where a main cue starts (same source track)
const POLL_MS = 5000;
const MAX_WAIT_MS = 3600 * 1000;        // how long to wait for a whole-title job; wall clock, as hidden tabs run timers late
const RETRY_FAILURES = 3;
const MARK_TTL_MS = 24 * 3600 * 1000;   // after an upload, leave the item alone this long even if Jellyfin has not listed the track yet
const NO_PERMISSION = [401, 403];
const REJECTED = [400, 404, 413];       // the server understood and refused: trying again cannot help
const BASE64_CHUNK = 0x8000;
const LOCK_NAME = 'subpair-save';
const MAX_MARKS = 200;                  // uploaded items remembered per browser, newest first
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Jellyfin names the file <video>.<language>.srt after what it is given; its own client sends ISO 639-2 codes.
export const jellyfinLanguage = iso6392;

// A forced-only track (signs, foreign speech) does not make the item "have" a subtitle; any other track does, image-based too.
export const hasSubtitleIn = (streams, lang) =>
  (streams || []).some((s) => s.Type === 'Subtitle' && !s.IsForced && normLang(s.Language) === normLang(lang));

// Identifies a subtitle by its cues, so the same track still matches after Jellyfin serves it back re-encoded.
export function fingerprint(srtText) {
  let h = FNV_OFFSET;
  for (const c of parseSrt(srtText)) {
    const line = `${Math.round(c.start * 1000)}|${Math.round(c.end * 1000)}|${c.text}\n`;
    for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return h.toString(16);
}

export function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  return btoa(binary);
}

export const uploadBody = (lang, srt) => ({
  Language: jellyfinLanguage(lang), Format: 'srt', IsForced: false, IsHearingImpaired: false, Data: toBase64Utf8(srt),
});

const authHeader = (token) => ({ Authorization: `MediaBrowser Token="${token}"` });
const problemDetail = async (r) => {
  const problem = r.ok ? null : await r.json().catch(() => null);
  return (problem && (problem.detail || problem.title)) || '';
};

// -> async (itemId, body) => { ok, status, detail }. `base` is the server address without a trailing slash, `token` the
// signed-in user's access token; `detail` is the server's own explanation of a refusal, when it sends one.
export function makeUploader({ base, token, fetchImpl = fetch }) {
  return async (itemId, body) => {
    const r = await fetchImpl(`${base}/Videos/${encodeURIComponent(itemId)}/Subtitles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(token) }, body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, detail: await problemDetail(r) };
  };
}

// -> async (itemId, streamIndex) => { ok, status, detail }. Jellyfin deletes the track's file; it needs an administrator.
export function makeRemover({ base, token, fetchImpl = fetch }) {
  return async (itemId, index) => {
    const r = await fetchImpl(`${base}/Videos/${encodeURIComponent(itemId)}/Subtitles/${encodeURIComponent(index)}`, {
      method: 'DELETE', headers: authHeader(token),
    });
    return { ok: r.ok, status: r.status, detail: await problemDetail(r) };
  };
}

// Remembers when a translation was uploaded to which item, per browser: { at }, so that a second tab does not upload it again
// before Jellyfin lists the new track. Not atomic: callers hold the save lock.
export function storageMarks(area, name = 'jellyfinSaved') {
  const at = (mark) => (typeof mark === 'number' ? mark : (mark && mark.at) || 0);
  return {
    async get(k) { const o = (await area.get(name))[name]; return o && o[k]; },
    async set(k, mark) {
      const o = (await area.get(name))[name] || {};
      const recent = Object.entries({ ...o, [k]: mark }).sort((a, b) => at(b[1]) - at(a[1])).slice(0, MAX_MARKS);
      await area.set({ [name]: Object.fromEntries(recent) });
    },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Web Locks are shared by every tab of the site, which is what stops two tabs uploading the same translation.
const defaultLock = (fn) => (globalThis.navigator && navigator.locks ? navigator.locks.request(LOCK_NAME, fn) : fn());
const defaultAlive = () => typeof chrome === 'undefined' || !!(chrome.runtime && chrome.runtime.id);
const isSubtitleIn = (s, lang) => s.Type === 'Subtitle' && normLang(s.Language) === normLang(lang);

// With `replace`, a regenerated translation takes the place of the track that holds a translation the bridge had saved when
// the saver started (same fingerprint), so any browser using that bridge finds it; a track Subpair did not make is never
// replaced or deleted. `readSubtitle(stream)` resolves to a track's text and `remove(itemId, index)` deletes one; both are
// only needed with `replace`.
export function createAutoSaver(options) {
  const { call, itemId, key, from, to, backend, cues, enabled, readMediaStreams, upload, marks, replace = false,
    readSubtitle, remove, onStatus = () => {}, now = Date.now, sleep = defaultSleep, lock = defaultLock, alive = defaultAlive,
    pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS } = options;
  const markKey = `${key}.${to}`;
  const mainStarts = new Set(cues.map((c) => Math.round(c.start * 1000)));
  let stopped = false, started = false, failures = 0;
  let earlier = new Set();      // with `replace`: fingerprints of the translations saved before the new one
  let startedAt = 0;

  const say = (text) => { if (!stopped) onStatus(text); };

  const covers = (srtCues) =>
    srtCues.length > 0 &&
    srtCues.length >= cues.length * COVERS_LINES &&
    srtCues.filter((c) => mainStarts.has(Math.round(c.start * 1000))).length >= srtCues.length * MATCHES_TIMINGS;

  // Saved translations for this title and target, the chosen backend first.
  async function savedEntries() {
    const m = await call(`/subs/${encodeURIComponent(key)}`);
    const entries = m.ok ? entriesFor(m.json, { from, to }) : [];
    return [...entries.filter((e) => e.backend === backend), ...entries.filter((e) => e.backend !== backend)];
  }

  // The complete saved translations as { entry, text }, in the order of `entries`.
  async function completeSaves(entries) {
    const saves = [];
    for (const entry of entries) {
      const r = await call(savedUrl(key, entry));
      if (r.ok && r.text && covers(parseSrt(r.text))) saves.push({ entry, text: r.text });
    }
    return saves;
  }

  async function readMark() {
    const mark = await marks.get(markKey);
    return typeof mark === 'number' ? { at: mark } : mark || null;           // marks from before they were objects
  }

  const recent = (mark) => {
    const age = mark && mark.at !== undefined ? now() - mark.at : -1;
    return age >= 0 && age < MARK_TTL_MS;                                      // a mark from the future (clock change) is ignored
  };

  // The external track in the target language that holds one of the earlier translations.
  async function ownTrack(streams) {
    for (const s of streams.filter((x) => isSubtitleIn(x, to) && x.IsExternal)) {
      try { if (earlier.has(fingerprint(await readSubtitle(s)))) return s; } catch { /* unreadable: not known to be ours */ }
    }
    return null;
  }

  const send = (srt) => Promise.resolve().then(() => upload(itemId, uploadBody(to, srt))).catch(() => ({ ok: false, status: 0 }));

  async function remember(mark) {
    // Without the mark a second playback may upload again, and Jellyfin keeps both (it names the second <name>.<lang>.1.srt).
    try { await marks.set(markKey, mark); } catch { /* storage unavailable (quota, reloaded extension) */ }
  }

  function refused(result) {
    if (NO_PERMISSION.includes(result.status)) { say(t('saveNoPermission')); return 'settled'; }
    if (REJECTED.includes(result.status) || ++failures >= RETRY_FAILURES) {
      const status = result.status || t('noAnswer');
      say(result.detail ? t('saveFailedDetail', status, result.detail) : t('saveFailedStatus', status));
      return 'settled';
    }
    return 'wait';
  }

  async function removeOld(streams, old) {
    const current = streams.find((s) => s.Path === old.Path);                  // indexes shift after an upload
    if (!current) return say(t('saveDone'));
    const result = await Promise.resolve().then(() => remove(itemId, current.Index)).catch(() => ({ ok: false, status: 0 }));
    if (result.ok) return say(t('saveReplaced'));
    say(t('saveNewOldKept', result.status || t('noAnswer')));
  }

  // -> 'settled' when there is nothing more to do (saved, refused, not needed), 'wait' to look again later.
  async function save(entries) {
    if (!replace) {
      if (recent(await readMark())) return 'settled';
      if (hasSubtitleIn(await readMediaStreams(), to)) return 'settled';      // read fresh: the page's list may be stale
    }
    const [newest] = await completeSaves(entries);
    if (!newest) return 'wait';
    const srt = newest.text;
    if (replace && earlier.has(fingerprint(srt))) {
      // Saved again since this started yet word for word the same (a translator that always answers alike): nothing to do.
      if (Date.parse(newest.entry.savedAt) > startedAt) { say(t('saveSame')); return 'settled'; }
      return 'wait';                                                          // the regenerated translation is not saved yet
    }
    if (stopped) return 'settled';
    const before = await readMediaStreams();
    const old = replace ? await ownTrack(before) : null;
    if (!old && hasSubtitleIn(before, to)) {
      if (replace) say(t('saveKeptForeign'));
      return 'settled';
    }
    const result = await send(srt);
    if (!result.ok) return refused(result);
    await remember({ at: now() });
    if (old) await removeOld(await readMediaStreams().catch(() => []), old);
    else say(t('saveDone'));
    return 'settled';
  }

  async function run() {
    // The bridge keeps the old translation until the new one is finished, so what it holds now is what may be on Jellyfin.
    startedAt = now();
    if (replace) {
      try { earlier = new Set((await completeSaves(await savedEntries())).map((s) => fingerprint(s.text))); } catch { /* bridge down: none known */ }
    }
    const deadline = now() + maxWaitMs;
    while (!stopped && now() < deadline) {
      if (!alive()) return say(t('saveStoppedReload'));
      let outcome = 'wait';
      try {
        const entries = await savedEntries();
        if (entries.length) outcome = await lock(() => save(entries));
      } catch (e) {
        if (++failures >= RETRY_FAILURES) return say(t('saveFailedError', e && e.message));
      }
      if (outcome === 'settled') return;
      await sleep(pollMs);
    }
  }

  return {
    // Resolves when the saver is done. One saver serves one playback: after stop() it cannot be started again.
    start() {
      if (!enabled || started || stopped || !jellyfinLanguage(to)) return Promise.resolve();
      if (replace && (typeof readSubtitle !== 'function' || typeof remove !== 'function')) {
        return Promise.reject(new Error('replace needs readSubtitle and remove'));
      }
      started = true;
      return run().catch((e) => say(t('saveFailedError', e && e.message)));
    },
    stop() { stopped = true; },
  };
}
