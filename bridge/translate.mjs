// Translating a list of texts with one backend and model: cached lines are reused (unless `fresh`), the rest is cut into
// chunks that go through the one work queue, and every new line is cached.
import { BridgeError, CodedError, messageOf } from './errors.mjs';
import { LIVE } from './queue.mjs';
import { cacheIdFor } from './backends/index.mjs';

export function createTranslator({ store, backends, queue }) {
  // The model a request ends up with ('' for a backend without models) and the name of its line cache.
  function resolve(backend, requested) {
    const b = backends[backend];
    if (!b.model) return { model: '', cacheId: backend };
    const model = requested || b.model.default;
    if (!model) throw new BridgeError(400, 'needs_model', backend);
    return { model, cacheId: cacheIdFor(backend, model, b.model.shipped) };
  }

  // Throws the answer for a request this backend cannot do now: 400 for an impossible one, 503 for one not set up.
  function check(backend, pair, requestedModel) {
    const b = backends[backend];
    if (pair.from === pair.to) throw new BridgeError(400, 'same_language');
    if (!b.supports(pair)) throw new BridgeError(400, 'pair_unsupported', ...b.limit, pair.from, pair.to);
    if (!b.ready()) throw b.setup ? new BridgeError(503, b.setup) : new BridgeError(503, 'backend_not_ready', backend);
    return resolve(backend, requestedModel);
  }

  // `context` is source lines that precede texts[0]. Each distinct text is translated once. shouldStop() is checked before
  // each chunk starts: lines not reached come back as '', and so do lines the backend gave up on. With `fresh` every line is
  // translated again (the new translations replace the cached ones) and only this run's translations come back.
  async function translateTexts(backend, pair, texts, { model: requested, fresh = false, priority = LIVE, context = [], onProgress = () => {}, shouldStop = () => false } = {}) {
    const { model, cacheId } = check(backend, pair, requested);
    const b = backends[backend];
    const cached = (t) => store.getLine(pair, cacheId, t) !== undefined;
    const got = new Map();                     // text -> translation made by this run
    const firstAt = new Map();                 // distinct text still to translate -> index of its first occurrence
    texts.forEach((t, i) => { if (t.trim() && (fresh || !cached(t)) && !firstAt.has(t)) firstAt.set(t, i); });
    const todo = [...firstAt].map(([text, index]) => ({ text, index }));
    const lines = [...context, ...texts];
    const base = texts.length - todo.length;
    let finished = 0, aborted = false;
    const tasks = [];
    for (let k = 0; k < todo.length; k += b.chunk) {
      const part = todo.slice(k, k + b.chunk);
      const at = context.length + part[0].index;
      const before = lines.slice(Math.max(0, at - b.context), at);
      tasks.push(queue.add({
        key: backend, priority, skip: () => aborted || shouldStop(),
        run: async () => {
          const need = fresh ? part : part.filter((p) => !cached(p.text));   // another request may have done some meanwhile
          if (need.length) {
            let out;
            try { out = await b.translate(need.map((p) => p.text), before, pair, model); } catch (e) {
              aborted = true;                                                 // a failed chunk cancels the chunks still waiting
              throw e instanceof CodedError ? new BridgeError(502, e.code, backend, ...e.params) : new BridgeError(502, 'backend_failed', backend, messageOf(e));
            }
            need.forEach((p, i) => got.set(p.text, out[i] || ''));
            store.putLines(pair, cacheId, need.map((p, i) => [p.text, out[i]]));
          }
          finished += part.length;
          onProgress(base + finished);
        },
      }));
    }
    try { await Promise.all(tasks); } catch (e) { aborted = true; throw e; }
    const final = (t) => (fresh ? got.get(t) : store.getLine(pair, cacheId, t)) ?? '';
    return { texts: texts.map((t) => (t.trim() ? final(t) : '')), model, cacheId };
  }

  return { resolve, check, translateTexts };
}
