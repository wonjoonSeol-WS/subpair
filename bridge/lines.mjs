// Live /line requests. A request answers with the translation when it is done within lineWaitMs, else with a ticket the
// extension polls (a Chrome extension worker is stopped when one fetch waits 30 s). Work stops between chunks when the
// player seeked since (a newer gen from the same client), cancelled it, or stopped asking for it for lineAbandonMs.
import { randomBytes } from 'node:crypto';
import { BridgeError } from './errors.mjs';

export const LINE_ID_RE = /^[a-z0-9]{8,32}$/;

export function createLineRequests({ translator, limits }) {
  const latestGen = new Map();                 // client id -> newest seek counter seen from that client
  const records = new Map();                   // id -> one request, until its result is fetched or expires

  const noteGen = (client, gen) => {
    const next = Math.max(latestGen.get(client) ?? 0, gen);
    latestGen.delete(client);                  // re-insert so the least recently active client is the one evicted
    latestGen.set(client, next);
    if (latestGen.size > limits.maxClients) latestGen.delete(latestGen.keys().next().value);
  };
  const isStale = (client, gen) => gen !== null && gen < (latestGen.get(client) ?? -Infinity);
  const abandoned = (r) => r.waiters === 0 && Date.now() - r.lastSeen > limits.lineAbandonMs;
  const finished = (r) => r.finishedAt !== null;

  // Drops expired results; when full, the oldest finished results make room. Throws when everything is still running.
  function makeRoom() {
    for (const [id, r] of records) if (finished(r) && Date.now() - r.finishedAt > limits.lineResultTtlMs) records.delete(id);
    for (const [id, r] of records) {
      if (records.size < limits.maxPendingLines) return;
      if (finished(r)) records.delete(id);
    }
    if (records.size >= limits.maxPendingLines) throw new BridgeError(503, 'too_many_requests');
  }

  async function wait(r) {
    r.waiters++;
    r.lastSeen = Date.now();
    let timer;
    await Promise.race([r.done, new Promise((resolve) => { timer = setTimeout(resolve, limits.lineWaitMs); })]);
    clearTimeout(timer);
    r.waiters--;
    r.lastSeen = Date.now();
    if (!finished(r)) return { status: 202, body: { pending: r.id } };
    records.delete(r.id);
    if (r.error) throw r.error;
    return { status: 200, body: { texts: r.texts, stale: r.stale } };
  }

  async function start({ backend, model, pair, texts, context, client, gen }) {
    if (gen !== null) noteGen(client, gen);
    if (isStale(client, gen)) return { status: 200, body: { texts: texts.map(() => ''), stale: true } };
    translator.check(backend, pair, model);
    makeRoom();
    const r = { id: randomBytes(8).toString('hex'), client, waiters: 0, lastSeen: Date.now(), finishedAt: null, stopped: false, texts: null, stale: false, error: null };
    const stale = () => isStale(client, gen);
    r.done = translator.translateTexts(backend, pair, texts, { model, context, shouldStop: () => r.stopped || stale() || abandoned(r) })
      .then((out) => { r.texts = out.texts; r.stale = stale(); }, (e) => { r.error = e; })
      .finally(() => { r.finishedAt = Date.now(); });
    records.set(r.id, r);
    return wait(r);
  }

  function poll(id) {
    const r = LINE_ID_RE.test(id) ? records.get(id) : undefined;
    if (!r || (finished(r) && Date.now() - r.finishedAt > limits.lineResultTtlMs)) {
      records.delete(id);
      throw new BridgeError(404, 'line_not_found');
    }
    return wait(r);
  }

  function cancel(client) {
    let cancelled = 0;
    for (const r of records.values()) if (r.client === client && !finished(r) && !r.stopped) { r.stopped = true; cancelled++; }
    return { cancelled };
  }

  return { start, poll, cancel };
}
