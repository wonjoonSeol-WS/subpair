// Whole-title jobs: translate every cue in the background (behind live lines in the queue), then save the title's .srt.
// A job is one title, language pair, backend and model; different backends or models of the same title run side by side.
// Finished jobs are remembered up to maxJobs, the oldest forgotten first.
import { textsHash } from '../src/hash.js';
import { BridgeError, CodedError, errorBody } from './errors.mjs';
import { JOB } from './queue.mjs';

export function createJobs({ translator, store, limits }) {
  const jobs = new Map();                      // "<key>.<from>-<to>.<backend>.<model>" -> job
  const idOf = (key, { from, to }, backend, model) => `${key}.${from}-${to}.${backend}.${model}`;
  const view = (j) => ({ state: j.state, done: j.done, total: j.total, error: j.error, code: j.code, params: j.params, backend: j.backend, model: j.model,
    from: j.from, to: j.to, fresh: j.fresh, skipped: j.skipped });
  const running = () => [...jobs.values()].filter((j) => j.state === 'running').length;

  // fresh: translate every cue again, ignoring the line cache, and replace the saved file only when every cue came back.
  function start({ key, title, backend, model: requested, cues, pair, fresh = false }) {
    const { model, cacheId } = translator.check(backend, pair, requested);
    const id = idOf(key, pair, backend, model);
    const cur = jobs.get(id);
    if (cur && cur.state === 'running') {
      if (fresh) throw new BridgeError(409, 'job_running');
      return view(cur);
    }
    if (running() >= limits.maxRunningJobs) throw new BridgeError(503, 'too_many_jobs', limits.maxRunningJobs);
    const job = { key, state: 'running', done: 0, total: cues.length, error: null, code: null, params: null, backend, model, from: pair.from, to: pair.to, fresh, skipped: 0, cancelled: false };
    jobs.delete(id);
    jobs.set(id, job);
    for (const [k, j] of jobs) {
      if (jobs.size <= limits.maxJobs) break;
      if (j.state !== 'running') jobs.delete(k);
    }
    (async () => {
      try {
        const { texts } = await translator.translateTexts(backend, pair, cues.map((c) => c.text), {
          model, fresh, priority: JOB, shouldStop: () => job.cancelled, onProgress: (n) => { if (job.state === 'running') job.done = n; },
        });
        if (job.cancelled) { job.state = 'cancelled'; return; }
        job.skipped = cues.filter((c, i) => c.text.trim() && !texts[i]).length;           // lines the translator gave up on
        if (fresh && job.skipped) throw new CodedError('lines_failed', [job.skipped]);
        const out = cues.map((c, i) => ({ number: i + 1, start: c.start, end: c.end, text: texts[i] })).filter((c) => c.text);
        store.saveSubtitle(key, title, pair, { backend, model, cacheId }, out, { count: cues.length, sourceHash: textsHash(cues.map((c) => c.text)) });
        job.done = job.total;
        job.state = 'done';
      } catch (e) {
        job.state = 'error';
        ({ error: job.error, code: job.code, params: job.params } = errorBody(e));
      }
    })();
    return view(job);
  }

  // want: { from, to, backend?, model? }. Without a backend, the most recently started job for the title and pair (and model,
  // if given); with one, its model defaults like a new job's.
  function find(key, { from, to, backend, model }) {
    if (backend) return jobs.get(idOf(key, { from, to }, backend, translator.resolve(backend, model).model));
    return [...jobs.values()].reverse().find((j) => j.key === key && j.from === from && j.to === to && (!model || j.model === model));
  }

  const get = (key, want) => { const j = find(key, want); return j ? view(j) : { state: 'none' }; };

  function cancel(key, want) {
    const j = find(key, want);
    if (!j) return { state: 'none' };
    if (j.state === 'running') j.cancelled = true;
    return view(j);
  }

  return { start, get, cancel };
}
