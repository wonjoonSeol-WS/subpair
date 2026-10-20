// Translating ahead of the viewer: the next episode once the current one is done, or a whole season on request. Each title
// becomes a whole-title job at the bridge and is saved like any other, so opening it later finds the second line ready.
// An adapter offers what its site allows: nextItem(id), ready(id) (can open(id) list the tracks now?) and seasonItems(id).
import { pickTrack } from './tracks.js';
import { normLang } from './lang.js';
import { wantedSub } from './profile.js';
import { tidy } from './session.js';
import { createTranslator } from './translate.js';
import { callBridge } from './bridge.js';
import { TUNING } from './tuning.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Queues the translation of one title, unless nothing is needed. Resolves one of
//   { state: 'queued', translator }   a job was sent to the bridge
//   { state: 'done' }                 nothing to do: a real track in the wanted language, a saved translation, or no wish to translate
//   { state: 'skipped', reason }      it cannot be done: no main track, or no translator for the pair
export async function translateTitle({ adapter, itemId, profile, makeTranslator = createTranslator }) {
  const wanted = wantedSub(profile);
  if (!wanted || profile.translate.mode === 'off') return { state: 'done' };
  const site = await adapter.open(itemId);
  const main = pickTrack(site.tracks, profile.main);
  if (!main) return { state: 'skipped', reason: 'no main track' };
  const mainLang = normLang(main.lang) || normLang(profile.main[0]);
  if (wanted === mainLang || pickTrack(site.tracks, [wanted], main.id)) return { state: 'done' };
  const cues = tidy(await site.fetchCues(main), mainLang, profile);
  if (!cues.length) return { state: 'skipped', reason: 'no main cues' };
  const call = (path, body) => callBridge(profile.translate.bridge, path, body);
  const translator = makeTranslator({
    call, key: site.key, title: site.title, from: mainLang, to: wanted,
    backend: profile.translate.backend, models: profile.translate.models, mode: 'process',
    cues, subCues: cues.map((c) => ({ start: c.start, end: c.end, text: '' })), getTime: () => 0,
  });
  const ready = await translator.prepare();
  if (!ready.ok) return { state: 'skipped', reason: ready.reason };
  const keep = () => keepOnSite(adapter, { itemId, key: site.key, from: mainLang, to: wanted, backend: profile.translate.backend, cues, call });
  if (ready.saved) { keep(); return { state: 'done' }; }
  const r = await translator.queue();
  if (!r.ok) return { state: 'skipped', reason: r.error };
  keep();
  return { state: 'queued', translator };
}

// Has the site keep the title's translation once the bridge has finished it, where the site can (Jellyfin: as a subtitle
// track every app lists). The saver waits for the bridge by itself and ends on its own.
function keepOnSite(adapter, options) {
  if (adapter.saveTranslation) adapter.saveTranslation(options).start();
}

// Waits for a queued title's job to end. -> true when it finished, false when it failed, was cancelled or was forgotten.
export async function settled(translator, { stopped = () => false, pollMs = TUNING.ahead.jobPollMs, lostAfter = TUNING.translate.lostAfterPolls } = {}) {
  let lost = 0;
  while (!stopped()) {
    const job = await translator.job();
    if (job.state === 'done') return true;
    if (job.state === 'error' || job.state === 'cancelled') return false;
    if (job.state === 'none' && ++lost >= lostAfter) return false;
    await sleep(pollMs);
  }
  return false;
}

// The next episode, once the site can list its tracks (Netflix loads them only near the end of this one). Runs until it
// has queued it, found nothing to do, or `stopped()` says the viewer moved on.
export async function translateNext({ adapter, itemId, profile, stopped, log = () => {}, makeTranslator, pollMs = TUNING.ahead.readyPollMs }) {
  if (!adapter.nextItem) return null;
  const next = await adapter.nextItem(itemId);
  if (!next) return null;
  while (!stopped() && !(await adapter.ready(next.id))) await sleep(pollMs);
  if (stopped()) return null;
  const r = await translateTitle({ adapter, itemId: next.id, profile, makeTranslator });
  log(`next episode ${next.id}: ${r.state}${r.reason ? ` (${r.reason})` : ''}`);
  return r;
}

// Every episode of the season, one job at a time (the bridge caps how many run at once, and one after the other is no
// slower: they share the same translator). onProgress(done, total) after each title.
export async function translateSeason({ adapter, itemId, profile, stopped, onProgress = () => {}, makeTranslator, log = () => {} }) {
  const items = await adapter.seasonItems(itemId);
  let done = 0, failed = 0;
  onProgress(done, items.length);
  for (const item of items) {
    if (stopped()) break;
    try {
      const r = await translateTitle({ adapter, itemId: item.id, profile, makeTranslator });
      if (r.state === 'queued' && !(await settled(r.translator, { stopped }))) failed++;
      if (r.state === 'skipped') { failed++; log(`season: ${item.id} skipped (${r.reason})`); }
    } catch (e) {
      failed++;
      log(`season: ${item.id} failed`, e);
    }
    done++;
    onProgress(done, items.length);
  }
  return { done, failed, total: items.length };
}
