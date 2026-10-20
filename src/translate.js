// Fills the sub line from the local translation bridge when the title has no real track in the wanted language.
//   prepare(): is the bridge up, which translator does this pair, is a translation already saved for this title? (fast)
//   start():   live    = translate a window of cues ahead of the playhead, re-aimed after every seek
//              process = send the whole title as a job, show progress, load the saved .srt when it is done
// subCues has the same length and timing as cues (main line); only its text is filled in.
import { parseSrt } from './srt.js';
import { textsHash } from './hash.js';
import { wantedSub } from './profile.js';
import { TUNING } from './tuning.js';
import { AUTO, backendInfo, backendName, pickBackend } from './backends.js';
import { savedEntries, savedUrl, bridgeMessage } from './bridge.js';
import { t } from './i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

// Should the sub line be machine-translated? Yes when a wanted sub language (the first one in the profile) differs from
// the main language, the title has no real track in it, and translation is not turned off.
export function wantsTranslation(profile, mainLang, hasWantedTrack) {
  const wanted = wantedSub(profile);
  return !!wanted && !hasWantedTrack && wanted !== mainLang && profile.translate.mode !== 'off';
}

// 'auto' means the translator's own way (src/backends.js).
export function resolveMode(mode, backend) {
  if (mode === 'live' || mode === 'process' || mode === 'off') return mode;
  return backendInfo(backend)?.mode || 'process';
}

// First cue still on screen or ahead of `time` (cues are sorted by start).
export function cueIndexAt(cues, time) {
  for (let i = 0; i < cues.length; i++) if (cues[i].end > time) return i;
  return cues.length ? cues.length - 1 : -1;
}

// Up to `size` cue indexes needing a translation: from `from` to the end first, then wrapping to the start.
export function nextBatch(subCues, from, size, skip = new Set()) {
  const out = [];
  const n = subCues.length;
  for (let k = 0; k < n && out.length < size; k++) {
    const i = (from + k) % n;
    if (!subCues[i].text && !skip.has(i)) out.push(i);
  }
  return out;
}

// Copies translated text from a saved .srt onto subCues, which keep the main cues' timings. A file saved from exactly these
// main cues (same count and fingerprint) numbers each cue by its position in them, so it is matched by number. Any other
// file (an older one, or one made before the main track was re-timed or replaced) is matched by start time, cues sharing a
// start time in order; cues it does not cover stay empty and are translated again.
export function fillFromSrt(cues, subCues, srt, entry = {}) {
  let filled = 0;
  const put = (i, text) => { if (text && subCues[i] && !subCues[i].text) { subCues[i].text = text; filled++; } };
  if (entry.numbering === 'source' && entry.count === cues.length && entry.sourceHash === textsHash(cues.map((c) => c.text))) {
    for (const c of parseSrt(srt, { exact: true })) if (Number.isInteger(c.n)) put(c.n - 1, c.text);
    return filled;
  }
  const byStart = new Map();
  for (const c of parseSrt(srt)) {
    const k = Math.round(c.start * 1000);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(c.text);
  }
  const used = new Map();
  cues.forEach((c, i) => {
    const k = Math.round(c.start * 1000);
    const list = byStart.get(k);
    if (!list) return;
    const n = used.get(k) || 0;
    used.set(k, n + 1);
    put(i, list[n]);
  });
  return filled;
}

// o: { call, key, title, from, to, backend (an id or 'auto'), models, mode, fresh, cues, subCues, getTime, onStatus, client, tuning }
//   fresh: translate the whole title again, ignoring what is saved (the bridge replaces the saved file when it is done)
//   onStatus(text, { progress }): progress marks "Translating 120/840" notices, each of which replaces the one before
export function createTranslator(o) {
  const { call, key, title, from, to, cues, subCues, getTime, onStatus = () => {} } = o;
  const models = o.models || {};
  const fresh = !!o.fresh;
  const T = { ...TUNING.translate, ...o.tuning };                       // tests pass faster timings
  // Names this player to the bridge: the seek counter below is only compared with this client's own earlier requests,
  // so two tabs (or Jellyfin and Netflix at once) do not cancel each other's work.
  const client = o.client || Math.random().toString(36).slice(2, 12);
  // Decided by prepare(): the translator (o.backend may be 'auto'), its model ('' = the bridge's default) and how to run.
  let backend = null, model = '', defaultModel = '', mode = o.mode === 'off' ? 'off' : null;
  const state = { backend: null, phase: 'idle', done: 0, total: cues.length };     // what status() reports
  let timer = 0, stopped = false;
  let gen = 0, lastT = null, lastWall = null, flight = null, errors = 0, retryAt = 0;
  let saved = false, saving = false, saveRetryAt = 0;
  const failed = new Set();

  const say = (text, progress = false) => onStatus(text, { progress });
  const withModel = (body) => (model ? { ...body, model } : body);
  const jobBody = (again) => withModel({ key, title, backend, from, to, ...(again ? { fresh: true } : {}), cues: cues.map(({ start, end, text }) => ({ start, end, text })) });
  const jobUrl = () => `/jobs/${enc(key)}?from=${enc(from)}&to=${enc(to)}&backend=${enc(backend)}${model ? `&model=${enc(model)}` : ''}`;

  async function loadSaved(entry) {
    const r = await call(savedUrl(key, entry));
    return r.ok ? fillFromSrt(cues, subCues, r.text, entry) : 0;
  }

  // -> { ok: true, saved: n } or { ok: false, reason }
  async function prepare() {
    if (mode === 'off') return { ok: false, reason: t('trOff') };
    const h = await call('/health');
    if (!h.ok || !h.json) return { ok: false, reason: t('trBridgeDown') };
    backend = pickBackend(o.backend, h.json, from, to, models);
    if (!backend) {
      return { ok: false, reason: o.backend === AUTO ? t('trNoneReady', from, to) : t('trCannot', backendName(o.backend), from, to) };
    }
    model = backendInfo(backend).model ? models[backend] || '' : '';
    defaultModel = (h.json.models && h.json.models[backend]) || '';
    mode = fresh ? 'process' : resolveMode(o.mode, backend);
    state.backend = backend;
    if (fresh) return { ok: true, saved: 0 };
    // A translation made earlier for this title (any translator) is used as is, so nothing is paid for twice; "Translate
    // again" in the quick menu replaces it. One made from another source language is not used: it fits other cues.
    const m = await call(`/subs/${enc(key)}`);
    const entries = savedEntries(m.ok && m.json, { from, to });
    const wantModel = model || defaultModel;
    const pick = entries.find((e) => e.backend === backend && (e.model || '') === wantModel) || entries.find((e) => e.backend === backend) || entries[0];
    if (pick) {
      const n = await loadSaved(pick);
      if (n >= cues.length * T.savedEnough) {
        saved = true;
        state.phase = 'saved';
        state.backend = pick.backend;
        say(t('trSavedLoaded', backendName(pick.backend)));
        return { ok: true, saved: n };
      }
      if (n) say(t('trSavedPartial', backendName(pick.backend), n, cues.length));
    }
    return { ok: true, saved: 0 };
  }

  // Everything is in the bridge's cache by now, so saving the title is a quick job. It is only reported as saved once the
  // bridge says the job finished; a failure is retried a minute later.
  async function saveWhole() {
    if (saved || saving || Date.now() < saveRetryAt) return;
    saving = true;
    try {
      const r = await call('/jobs', jobBody(false));
      if (!r.ok) throw new Error(r.error || `status ${r.status}`);
      for (let i = 0; i < T.saveWaitPolls && !stopped; i++) {
        const job = (await call(jobUrl())).json || {};
        if (job.state === 'error') throw new Error(bridgeMessage(job));
        if (job.state === 'done') { saved = true; state.phase = 'saved'; say(t('trSaved')); return; }
        await sleep(T.saveWaitPollMs);
      }
    } catch (e) {
      saveRetryAt = Date.now() + T.maxRetryMs;
      if (!stopped) say(t('trSaveFailed', e.message));
    } finally { saving = false; }
  }

  async function runProcess() {
    state.phase = 'job';
    const r = await call('/jobs', jobBody(fresh));
    if (!r.ok) { state.phase = 'failed'; return say(t('trFailed', r.error || r.status)); }
    let lost = 0;
    for (;;) {
      if (stopped) return;
      const j = await call(jobUrl());
      if (stopped) return;
      const job = j.json || {};
      // The bridge forgets jobs when it restarts, and a dead bridge answers nothing: give up instead of waiting for ever.
      if (!j.ok || job.state === 'none') {
        if (++lost >= T.lostAfterPolls) { state.phase = 'failed'; return say(t('trLost')); }
      } else {
        lost = 0;
        if (job.state === 'error') { state.phase = 'failed'; return say(t('trFailed', bridgeMessage(job))); }
        if (job.state === 'cancelled') { state.phase = 'failed'; return say(t('trStopped')); }
        if (job.state === 'done') break;
        state.done = job.done || 0;
        state.total = job.total || cues.length;
        say(t('trProgress', state.done, state.total), true);
      }
      await sleep(T.jobPollMs);
    }
    const m = await call(`/subs/${enc(key)}`);
    if (stopped) return;
    const wantModel = model || defaultModel;
    const entry = savedEntries(m.ok && m.json, { from, to }).find((e) => e.backend === backend && (e.model || '') === wantModel);
    if (fresh) for (const c of subCues) c.text = '';           // the new file replaces whatever was on screen
    const n = entry ? await loadSaved(entry) : 0;
    if (stopped) return;
    saved = n > 0;
    state.phase = saved ? 'saved' : 'failed';
    state.done = state.total;
    say(n ? t('trReady') : t('trNotLoaded'));
  }

  function failure(r) {
    errors++;
    retryAt = Date.now() + Math.min(T.maxRetryMs, T.retryMs * 2 ** (errors - 1));     // back off, and keep trying: the bridge may come back
    if (errors === T.notifyAfterErrors) say(t('trPaused', (r && (r.error || r.status)) || t('noAnswer')));
  }

  // A slow translation is answered with a ticket (202 { pending }) that is asked about until the lines are ready, as long as
  // this request is still the one in flight.
  async function follow(r, mine) {
    while (r.ok && r.status === 202 && r.json && r.json.pending && !stopped && flight === mine) {
      r = await call(`/line/${enc(r.json.pending)}`);
    }
    return r;
  }

  function tick() {
    if (stopped) return;
    if (saved) { clearInterval(timer); return; }                  // nothing left to do for this title
    if (Date.now() < retryAt) return;
    const now = Date.now(), at = getTime();
    // A seek moves the playhead further than the time that passed (a hidden tab's timer runs late, so allow for that).
    const elapsed = lastWall === null ? 0 : (now - lastWall) / 1000;
    if (lastT !== null && Math.abs(at - lastT) > T.jumpSeconds + 2 * elapsed) gen++;
    lastT = at; lastWall = now;
    if (flight && flight.gen === gen) return;                    // already working on this position
    const idx = Math.max(0, cueIndexAt(cues, at));
    const batch = nextBatch(subCues, idx, backendInfo(backend).liveWindow, failed);
    if (!batch.length) {
      if (!flight) saveWhole();                                  // lines that translate to nothing (punctuation) do not block this
      return;
    }
    const mine = { gen };
    flight = mine;
    // The cues just before the window, so the model sees how the scene was going (read-only context, not translated).
    const context = cues.slice(Math.max(0, batch[0] - T.contextLines), batch[0]).map((c) => c.text);
    call('/line', withModel({ backend, from, to, client, gen, context, texts: batch.map((i) => cues[i].text) }))
      .then((r) => follow(r, mine))
      .then((r) => {
        if (stopped || r.status === 202) return;                 // replaced by a newer request (a seek): not a failure
        if (!r.ok || !r.json || !Array.isArray(r.json.texts)) return failure(r);
        if (errors >= T.notifyAfterErrors) say(t('trLive'));
        errors = 0;
        batch.forEach((i, j) => {
          const text = r.json.texts[j];
          if (typeof text === 'string' && text) subCues[i].text = text;
          else if (!r.json.stale) failed.add(i);                 // a cut-short request is retried, not given up on
        });
      })
      .catch((e) => failure({ error: e && e.message }))
      .finally(() => { if (flight === mine) flight = null; });
  }

  return {
    prepare,
    // Translating ahead (another episode): send the whole title as a job and leave it to the bridge; job() asks how it is going.
    queue: () => call('/jobs', jobBody(false)),
    job: async () => { const r = await call(jobUrl()); return r.ok && r.json ? r.json : { state: 'none' }; },
    // { backend, phase: 'idle' | 'live' | 'job' | 'saved' | 'failed', done, total }, for the quick menu
    status: () => ({ ...state }),
    start() {
      if (saved || mode === 'off' || !backend) return;
      if (mode === 'process') { runProcess().catch((e) => { state.phase = 'failed'; say(t('trFailed', e.message)); }); return; }
      state.phase = 'live';
      say(t('trLive'));
      timer = setInterval(tick, T.tickMs);
      tick();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Lines this player no longer needs must not hold the queue that live lines share with the other players.
      if (flight) call('/line/cancel', { client }).catch(() => {});
    },
    _tick: tick,                                    // for tests
  };
}
