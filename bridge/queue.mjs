// The one work queue behind every translation, live lines and whole-title jobs alike. Each task belongs to a backend
// (`key`), and a backend runs at most `limitFor(key)` tasks at once (ezTrans is a single engine, the LLM backends can
// overlap a few calls). Among waiting tasks the lowest `priority` number goes first, first come first served within it,
// so a viewer who just seeked is never stuck behind a background job. A running task is never interrupted.
export const LIVE = 0;
export const JOB = 1;

export class WorkQueue {
  #lists = new Map();                    // key -> Map(priority -> waiting tasks, oldest first)
  #running = new Map();                  // key -> number of tasks running
  #waiting = 0;
  #seq = 0;

  constructor(limitFor = () => 1) {
    this.limitFor = limitFor;
  }

  // run: async () => value. skip: () => bool, checked just before starting; a skipped task resolves with `undefined`.
  add({ key, priority = LIVE, run, skip = () => false }) {
    return new Promise((resolve, reject) => {
      if (!this.#lists.has(key)) this.#lists.set(key, new Map());
      const byPriority = this.#lists.get(key);
      if (!byPriority.has(priority)) byPriority.set(priority, []);
      byPriority.get(priority).push({ key, priority, seq: this.#seq++, run, skip, resolve, reject });
      this.#waiting++;
      this.#pump();
    });
  }

  get pending() { return this.#waiting; }

  get size() {
    return this.#waiting + [...this.#running.values()].reduce((a, b) => a + b, 0);
  }

  // The next task to start: the oldest of the most urgent priority, among backends with a free slot.
  #next() {
    let best = null;
    for (const [key, byPriority] of this.#lists) {
      if ((this.#running.get(key) || 0) >= this.limitFor(key)) continue;
      for (const list of byPriority.values()) {
        const t = list[0];
        if (t && (!best || t.priority < best.priority || (t.priority === best.priority && t.seq < best.seq))) best = t;
      }
    }
    if (best) { this.#lists.get(best.key).get(best.priority).shift(); this.#waiting--; }
    return best;
  }

  #pump() {
    for (let task = this.#next(); task; task = this.#next()) {
      let skipped;
      try { skipped = task.skip(); } catch (e) { task.reject(e); continue; }       // a broken skip() fails its own task only
      if (skipped) { task.resolve(undefined); continue; }
      this.#running.set(task.key, (this.#running.get(task.key) || 0) + 1);
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
        this.#running.set(task.key, this.#running.get(task.key) - 1);
        this.#pump();
      });
    }
  }
}
