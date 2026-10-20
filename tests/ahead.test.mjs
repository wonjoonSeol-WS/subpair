import test from 'node:test';
import assert from 'node:assert/strict';
import { translateTitle, translateNext, translateSeason, settled } from '../src/ahead.js';
import { newProfile } from '../src/profile.js';

const t = (id, lang) => ({ id, lang, label: lang, forced: false, extra: false, rank: 0 });
const cue = (start, text) => ({ start, end: start + 1, text });

// A fake site: titles by id, each with tracks and cue texts; ready() can hold a title back (Netflix before the credits).
function fakeAdapter(titles, { readyAfter = {} } = {}) {
  const opened = [], asked = {};
  return {
    opened,
    async open(id) {
      opened.push(id);
      const x = titles[id];
      return { key: `k-${id}`, title: `T ${id}`, tracks: x.tracks, fetchCues: async (track) => (x.cues[track.id] || []).map((c) => ({ ...c })) };
    },
    async nextItem(id) { return titles[id] && titles[id].next ? { id: titles[id].next } : null; },
    async ready(id) { asked[id] = (asked[id] || 0) + 1; return asked[id] > (readyAfter[id] || 0); },
    async seasonItems() { return Object.keys(titles).map((id) => ({ id })); },
  };
}

// Translators that answer prepare() and the job as told, and record what they were built with.
function fakeTranslators({ prepare = { ok: true, saved: 0 }, queue = { ok: true }, jobs = () => [{ state: 'done' }] } = {}) {
  const built = [];
  const makeTranslator = (opts) => {
    const states = jobs(opts.key);
    const tr = { opts, queued: false, prepare: async () => prepare, queue: async () => { tr.queued = true; return queue; }, job: async () => states.shift() || { state: 'done' } };
    built.push(tr);
    return tr;
  };
  return { built, makeTranslator };
}

const profile = () => newProfile('p', 'P', ['ja'], ['ko']);
const titles = {
  a: { tracks: [t(1, 'jpn')], cues: { 1: [cue(0, 'あ')] }, next: 'b' },
  b: { tracks: [t(1, 'jpn')], cues: { 1: [cue(0, 'い')] }, next: 'c' },
  c: { tracks: [t(1, 'jpn'), t(2, 'kor')], cues: { 1: [cue(0, 'う')], 2: [cue(0, '우')] } },
};

test('a title is queued only when it needs a translation: not with a real track, a saved one, or nothing wanted', async () => {
  const tr = fakeTranslators();
  assert.equal((await translateTitle({ adapter: fakeAdapter(titles), itemId: 'b', profile: profile(), makeTranslator: tr.makeTranslator })).state, 'queued');
  assert.equal(tr.built[0].opts.key, 'k-b');
  assert.equal(tr.built[0].opts.from, 'ja');
  assert.equal(tr.built[0].opts.to, 'ko');
  assert.equal(tr.built[0].opts.mode, 'process');
  assert.equal(tr.built[0].queued, true);

  assert.equal((await translateTitle({ adapter: fakeAdapter(titles), itemId: 'c', profile: profile(), makeTranslator: tr.makeTranslator })).state, 'done');   // has Korean
  const saved = fakeTranslators({ prepare: { ok: true, saved: 1 } });
  const r = await translateTitle({ adapter: fakeAdapter(titles), itemId: 'b', profile: profile(), makeTranslator: saved.makeTranslator });
  assert.equal(r.state, 'done');
  assert.equal(saved.built[0].queued, false);
  const none = { ...profile(), sub: [] };
  assert.equal((await translateTitle({ adapter: fakeAdapter(titles), itemId: 'b', profile: none, makeTranslator: tr.makeTranslator })).state, 'done');
  const down = fakeTranslators({ prepare: { ok: false, reason: 'bridge down' } });
  assert.deepEqual(await translateTitle({ adapter: fakeAdapter(titles), itemId: 'b', profile: profile(), makeTranslator: down.makeTranslator }), { state: 'skipped', reason: 'bridge down' });
});

test('the next episode waits until the site can list its tracks, then is queued; a viewer who moved on stops it', async () => {
  const tr = fakeTranslators();
  const adapter = fakeAdapter(titles, { readyAfter: { b: 2 } });                   // not ready on the first two looks
  const r = await translateNext({ adapter, itemId: 'a', profile: profile(), stopped: () => false, makeTranslator: tr.makeTranslator, pollMs: 1 });
  assert.equal(r.state, 'queued');
  assert.deepEqual(adapter.opened, ['b']);

  const gone = fakeAdapter(titles, { readyAfter: { b: 1000 } });
  let looks = 0;
  const r2 = await translateNext({ adapter: { ...gone, ready: async () => { looks++; return false; } }, itemId: 'a', profile: profile(), stopped: () => looks >= 3, makeTranslator: tr.makeTranslator, pollMs: 1 });
  assert.equal(r2, null);
  assert.deepEqual(gone.opened, []);

  assert.equal(await translateNext({ adapter: fakeAdapter(titles), itemId: 'c', profile: profile(), stopped: () => false, makeTranslator: tr.makeTranslator }), null);  // last one
  assert.equal(await translateNext({ adapter: { ...fakeAdapter(titles), nextItem: undefined }, itemId: 'a', profile: profile(), stopped: () => false }), null);
});

test('a season runs one title at a time, each waiting for its job, and counts what failed', async () => {
  const order = [];
  const jobs = (key) => (key === 'k-a' ? [{ state: 'running' }, { state: 'running' }, { state: 'done' }] : key === 'k-b' ? [{ state: 'error' }] : []);
  const tr = fakeTranslators({ jobs });
  const adapter = fakeAdapter(titles);
  const progress = [];
  const wrapped = { ...adapter, open: async (id) => { order.push(`open ${id}`); return adapter.open(id); } };
  const make = (opts) => { const x = tr.makeTranslator(opts); const job = x.job; x.job = async () => { order.push(`job ${opts.key}`); return job(); }; return x; };
  const r = await translateSeason({ adapter: wrapped, itemId: 'a', profile: profile(), stopped: () => false, makeTranslator: make, onProgress: (d, n) => progress.push(`${d}/${n}`) });
  assert.deepEqual(r, { done: 3, failed: 1, total: 3 });                         // b's job failed; c has a real track
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
  // a's job is asked about until it is done before b is even opened.
  assert.deepEqual(order.slice(0, 5), ['open a', 'job k-a', 'job k-a', 'job k-a', 'open b']);
});

test('settled: a job that ends, fails, is cancelled or is forgotten by the bridge', async () => {
  const of = (...states) => ({ job: async () => states.shift() || { state: 'none' } });
  assert.equal(await settled(of({ state: 'running' }, { state: 'done' }), { pollMs: 1 }), true);
  assert.equal(await settled(of({ state: 'error' }), { pollMs: 1 }), false);
  assert.equal(await settled(of({ state: 'cancelled' }), { pollMs: 1 }), false);
  assert.equal(await settled(of(), { pollMs: 1, lostAfter: 2 }), false);
  assert.equal(await settled(of({ state: 'running' }), { pollMs: 1, stopped: () => true }), false);
});
