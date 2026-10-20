import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../src/netflix-page.js', import.meta.url), 'utf8');
const ORIGIN = 'https://www.netflix.com';

// Netflix's page world, reduced to what the script touches: JSON, Response, fetch, postMessage and message listeners.
function page() {
  class Response {
    constructor(body) { this.body = body; }
    json() { return Promise.resolve(JSON.parse(this.body)); }   // the test realm's JSON.parse: not the page's hooked one
  }
  const listeners = [], replies = [];
  const ctx = {
    location: { origin: ORIGIN },
    Response,
    fetch: async (url) => ({ ok: true, status: 200, text: async () => `subtitles from ${url}` }),
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data) => replies.push(data),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const run = () => vm.runInContext(SOURCE, ctx);
  run();
  let seq = 0;
  // Sends one request the way src/netflix.js does and returns the reply (or undefined when the page ignores it).
  const ask = async (msg, { origin = ORIGIN, envelope = { subpair: true, dir: 'req' } } = {}) => {
    const id = `t${++seq}`;
    await Promise.all(listeners.map((fn) => fn({ origin, data: { ...msg, ...envelope, id } })));
    const r = replies.find((x) => x.id === id);
    return r && JSON.parse(JSON.stringify(r));               // a plain object of this realm, so deepEqual compares values
  };
  return { ctx, run, ask, listeners, pageJson: vm.runInContext('JSON', ctx) };
}

const track = (id, lang, downloadables, extra = {}) => ({ id, language: lang, rawTrackType: 'subtitles', downloadables, ...extra });
const manifest = (movieId) => ({
  result: {
    movieId,
    textTracks: [
      track('T1', 'ja', { 'webvtt-lssdh-ios8': { urls: [{ url: 'https://n/ja.vtt' }] }, 'imsc1.1': { urls: [{ url: 'https://n/ja.xml' }] } }),
      track('T2', 'ko', { 'nflx-cmisc': { isImage: true, urls: [{ url: 'https://n/ko.zip' }] } }),     // image only: never offered
      track('T3', '', {}, { isNoneTrack: true }),
    ],
  },
});

test('a manifest parsed with JSON.parse is remembered, with the best text format of each track', async () => {
  const { ask, pageJson } = page();
  pageJson.parse(JSON.stringify(manifest(111)));
  const r = await ask({ op: 'manifest', movieId: '111' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tracks, [{ lang: 'ja', kind: 'subtitles', forced: false, format: 'imsc1.1', url: 'https://n/ja.xml', id: 'T1' }]);
  assert.equal((await ask({ op: 'manifest', movieId: '999' })).tracks, null);
});

test('a manifest read with Response.json() is remembered too', async () => {
  const { ctx, ask } = page();
  await new ctx.Response(JSON.stringify(manifest(222))).json();
  assert.equal((await ask({ op: 'manifest', movieId: 222 })).tracks[0].id, 'T1');
});

test('the page keeps working: parse errors and non-manifest JSON pass through unchanged', async () => {
  const { pageJson } = page();
  assert.throws(() => pageJson.parse('{broken'), { name: 'SyntaxError' });
  assert.equal(JSON.stringify(pageJson.parse('{"a":[1,2]}')), '{"a":[1,2]}');
  assert.equal(pageJson.parse('null'), null);
});

test('only the listed operations run: inherited names are refused', async () => {
  const { ask } = page();
  for (const op of ['constructor', 'toString', '__proto__', 'nope']) {
    const r = await ask({ op });
    assert.equal(r.ok, false, op);
    assert.match(r.error, /unknown operation/);
  }
  const f = await ask({ op: 'fetch', url: 'https://n/x' });
  assert.deepEqual([f.ok, f.text], [true, 'subtitles from https://n/x']);
});

test('messages from another origin, or without the Subpair envelope, get no answer', async () => {
  const { ask } = page();
  assert.equal(await ask({ op: 'manifest', movieId: '1' }, { origin: 'https://evil.example' }), undefined);
  assert.equal(await ask({ op: 'manifest', movieId: '1' }, { envelope: { jds: true, dir: 'req' } }), undefined);
  assert.equal(await ask({ op: 'manifest', movieId: '1' }, { envelope: { subpair: true, dir: 'res' } }), undefined);
});

test('a reply cannot overwrite its envelope', async () => {
  const { ctx, ask } = page();
  ctx.fetch = async () => ({ ok: true, text: async () => 'x' });
  const r = await ask({ op: 'manifest', movieId: '1', id: 'forged', dir: 'evil' });
  assert.equal(r.dir, 'res');
  assert.equal(r.subpair, true);
});

test('only the 20 most recent manifests are kept', async () => {
  const { ask, pageJson } = page();
  for (let id = 1; id <= 21; id++) pageJson.parse(JSON.stringify(manifest(id)));
  assert.equal((await ask({ op: 'manifest', movieId: '1' })).tracks, null);          // the oldest was dropped
  assert.notEqual((await ask({ op: 'manifest', movieId: '2' })).tracks, null);
  assert.notEqual((await ask({ op: 'manifest', movieId: '21' })).tracks, null);
});

test('loading the script twice does not hook twice', () => {
  const { run, listeners, pageJson } = page();
  const parse = pageJson.parse;
  run();
  assert.equal(listeners.length, 1);
  assert.equal(pageJson.parse, parse);
});

test('the episode list a show\'s metadata carries gives each episode the one after it, across seasons', async () => {
  const { ask, pageJson } = page();
  const metadata = { video: { type: 'show', currentEpisode: 102, seasons: [
    { seq: 1, episodes: [{ episodeId: 101 }, { episodeId: 102 }, { episodeId: 103 }] },
    { seq: 2, episodes: [{ id: 201 }, { id: 202 }] },
  ] } };
  pageJson.parse(JSON.stringify(metadata));
  assert.equal((await ask({ op: 'next', movieId: '102' })).next, '103');
  assert.equal((await ask({ op: 'next', movieId: '103' })).next, '201');            // the last of a season leads to the next season
  assert.equal((await ask({ op: 'next', movieId: '202' })).next, null);             // the last episode
  assert.equal((await ask({ op: 'next', movieId: '999' })).next, null);
  pageJson.parse(JSON.stringify({ video: { type: 'movie', seasons: 'none' } }));     // a movie: no list, nothing breaks
  assert.equal((await ask({ op: 'manifest', movieId: '102' })).tracks, null);
});
