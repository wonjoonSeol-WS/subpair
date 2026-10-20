import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jellyfinLanguage, hasSubtitleIn, toBase64Utf8, uploadBody, makeUploader, makeRemover, storageMarks, createAutoSaver, fingerprint,
} from '../src/jellyfin-translate.js';
import { LANGUAGES } from '../src/lang.js';
import { toSrt } from '../src/srt.js';

const cues = (n, prefix = 'L', offset = 0) => Array.from({ length: n }, (_, i) => ({ start: i * 10 + offset, end: i * 10 + 5 + offset, text: `${prefix}${i}` }));
const srtOf = (n, prefix, offset) => toSrt(cues(n, prefix, offset));
const entry = (to, backend, from = 'ja') => ({ file: `x.${to}.${backend}.srt`, to, backend, from, cues: 10, savedAt: '2026-10-20T00:00:00Z' });
const decode = (upload) => Buffer.from(upload.body.Data, 'base64').toString('utf8');

// A bridge, Jellyfin and clock double. `state.entries` is what GET /subs/<key> lists, `state.srt['ko.claude']` the file text,
// `state.codes` the statuses successive uploads answer (the last one repeats). Sleeping advances the clock.
function setup(options = {}) {
  const state = {
    entries: {}, srt: {}, streams: [], uploads: [], statuses: [], marks: new Map(), clock: 1_000_000, codes: [204], polls: 0, sleeps: 0,
  };
  const call = async (path) => {
    if (/^\/subs\/[^/]+$/.test(path)) { state.polls++; return { ok: true, json: { entries: state.entries } }; }
    const m = /^\/subs\/[^/]+\/x\.([a-z]+)\.([a-z]+)\.srt$/.exec(path);          // savedUrl of an entry with a file name
    const text = m && state.srt[`${m[1]}.${m[2]}`];
    return text !== undefined ? { ok: true, text } : { ok: false, status: 404 };
  };
  const o = {
    call, itemId: 'abc123', key: 'jf-abc123', from: 'ja', to: 'ko', backend: 'claude', cues: cues(10), enabled: true,
    readMediaStreams: async () => state.streams,
    upload: async (id, body) => {
      state.uploads.push({ id, body });
      const status = state.codes.length > 1 ? state.codes.shift() : state.codes[0];
      return { ok: status < 300, status, detail: '' };
    },
    marks: { get: async (k) => state.marks.get(k), set: async (k, t) => { state.marks.set(k, t); } },
    onStatus: (s) => state.statuses.push(s),
    now: () => state.clock,
    sleep: async (ms) => { state.sleeps++; state.clock += ms; },
    lock: (fn) => fn(), alive: () => true, pollMs: 1000, maxWaitMs: 5000, ...options,
  };
  return { state, o, saver: createAutoSaver(o) };
}
const ready = (state, text = srtOf(10), key = 'ko.claude') => {
  const [to, backend] = key.split('.');
  state.entries[key] = entry(to, backend);
  state.srt[key] = text;
};

test('jellyfinLanguage gives the ISO 639-2 code Jellyfin uses, from either form, and nothing for unknown languages', () => {
  assert.equal(jellyfinLanguage('ko'), 'kor');
  assert.equal(jellyfinLanguage('kor'), 'kor');
  assert.equal(jellyfinLanguage('ja-JP'), 'jpn');
  assert.equal(jellyfinLanguage('xx'), '');
  assert.equal(jellyfinLanguage(''), '');
});

test('every language the extension knows has a Jellyfin code (the two tables cannot drift apart)', () => {
  for (const lang of LANGUAGES) assert.notEqual(jellyfinLanguage(lang), '', lang);
});

test('hasSubtitleIn matches by normalised language on full subtitle streams only', () => {
  const streams = [
    { Type: 'Audio', Language: 'kor' }, { Type: 'Subtitle', Language: 'jpn' },
    { Type: 'Subtitle', Language: 'eng', IsTextSubtitleStream: false }, { Type: 'Subtitle', Language: 'zho', IsForced: true },
  ];
  assert.equal(hasSubtitleIn(streams, 'ko'), false);             // a Korean audio track is not a subtitle
  assert.equal(hasSubtitleIn(streams, 'ja'), true);
  assert.equal(hasSubtitleIn(streams, 'en'), true);              // an image-based subtitle still counts: never add a duplicate
  assert.equal(hasSubtitleIn(streams, 'zh'), false);             // a forced-only track (signs) does not make the item subtitled
  assert.equal(hasSubtitleIn(undefined, 'ko'), false);
});

test('toBase64Utf8 round-trips Korean text and text larger than one chunk', () => {
  const text = '안녕하세요 \u2014 世界 😀\n'.repeat(5000);
  assert.ok(new TextEncoder().encode(text).length > 0x8000 * 2);
  assert.equal(Buffer.from(toBase64Utf8(text), 'base64').toString('utf8'), text);
});

test('uploadBody has the fields Jellyfin requires, with the three-letter language', () => {
  const b = uploadBody('ko', '1\n00:00:01,000 --> 00:00:02,000\n안녕\n');
  assert.deepEqual(Object.keys(b).sort(), ['Data', 'Format', 'IsForced', 'IsHearingImpaired', 'Language']);
  assert.equal(b.Language, 'kor');
  assert.equal(b.Format, 'srt');
  assert.equal(b.IsForced, false);
  assert.equal(Buffer.from(b.Data, 'base64').toString('utf8').includes('안녕'), true);
});

test('makeUploader posts JSON to the item with the access token and reports the status', async () => {
  let seen;
  const upload = makeUploader({ base: 'http://jf:8096', token: 'tok', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 204 }; } });
  assert.deepEqual(await upload('abc123', { Language: 'kor' }), { ok: true, status: 204, detail: '' });
  assert.equal(seen.url, 'http://jf:8096/Videos/abc123/Subtitles');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'MediaBrowser Token="tok"');
  assert.deepEqual(JSON.parse(seen.init.body), { Language: 'kor' });
});

test('makeUploader reports why the server refused, when it says, and survives an unreadable body', async () => {
  const refuse = (json) => makeUploader({ base: 'http://jf', token: 't', fetchImpl: async () => ({ ok: false, status: 403, json }) });
  assert.deepEqual(await refuse(async () => ({ title: 'Forbidden' }))('a', {}), { ok: false, status: 403, detail: 'Forbidden' });
  assert.deepEqual(await refuse(async () => { throw new Error('not json'); })('a', {}), { ok: false, status: 403, detail: '' });
  const down = makeUploader({ base: 'http://jf', token: 't', fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(down('a', {}), /offline/);
});

test('an item id is escaped in the upload address', async () => {
  let url;
  await makeUploader({ base: 'http://jf', token: 't', fetchImpl: async (u) => { url = u; return { ok: true, status: 204 }; } })('a/../b', {});
  assert.equal(url, 'http://jf/Videos/a%2F..%2Fb/Subtitles');
});

test('storageMarks stores per key and keeps only the newest 200', async () => {
  const data = {};
  const area = { get: async (k) => ({ [k]: data[k] }), set: async (o) => Object.assign(data, o) };
  const marks = storageMarks(area);
  for (let i = 0; i < 205; i++) await marks.set(`k${i}`, i);
  assert.equal(await marks.get('k204'), 204);
  assert.equal(await marks.get('k0'), undefined);
  assert.equal(Object.keys(data.jellyfinSaved).length, 200);
});

test('a finished translation is uploaded once, as the bridge saved it, and remembered', async () => {
  const { state, saver } = setup();
  ready(state, srtOf(10, 'T'));
  await saver.start();
  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].id, 'abc123');
  assert.equal(state.uploads[0].body.Language, 'kor');
  assert.equal(decode(state.uploads[0]), state.srt['ko.claude']);
  assert.deepEqual(state.statuses, ['Saved the translation to Jellyfin']);
  assert.equal(state.marks.get('jf-abc123.ko').at, state.clock);
});

test('fingerprint ignores how the file is written (line endings, BOM, numbering) but not what it says', () => {
  const srt = srtOf(5, 'T');
  assert.equal(fingerprint(`\uFEFF${srt.replace(/\n/g, '\r\n')}`), fingerprint(srt));
  assert.notEqual(fingerprint(srtOf(5, 'U')), fingerprint(srt));
  assert.notEqual(fingerprint(srtOf(5, 'T', 1)), fingerprint(srt));
});

// Jellyfin double for the replace path: tracks live in `jf.tracks` (path -> text), MediaStreams are rebuilt from them
// with the subtitle indexes after the video and audio streams, so an upload shifts every later index.
function jellyfin(state, tracks) {
  const jf = { tracks: new Map(tracks), removed: [], removeStatus: 204 };
  const streams = () => [{ Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 },
    ...[...jf.tracks.keys()].sort().map((path, i) => ({ Type: 'Subtitle', Language: 'kor', IsExternal: true, Path: path, Index: i + 2 }))];
  const options = {
    replace: true,
    readMediaStreams: async () => streams(),
    readSubtitle: async (s) => jf.tracks.get(s.Path),
    remove: async (id, index) => {
      jf.removed.push(index);
      if (jf.removeStatus < 300) jf.tracks.delete(streams().find((s) => s.Index === index).Path);
      return { ok: jf.removeStatus < 300, status: jf.removeStatus };
    },
    upload: async (id, body) => {
      state.uploads.push({ id, body });
      jf.tracks.set(`/media/Show.kor.${jf.tracks.size}.srt`, Buffer.from(body.Data, 'base64').toString('utf8'));
      return { ok: true, status: 204, detail: '' };
    },
  };
  return { jf, options };
}

test('replace: a regenerated translation replaces the track this browser uploaded, deleted by its index after the upload', async () => {
  const oldText = srtOf(10, 'OLD');
  const { state, o } = setup();
  const { jf, options } = jellyfin(state, [['/media/A.kor.srt', oldText]]);
  Object.assign(o, options);
  o.upload = async (id, body) => {
    state.uploads.push({ id, body });
    jf.tracks.set('/media/0-first.kor.1.srt', Buffer.from(body.Data, 'base64').toString('utf8'));   // sorts first: shifts A's index
    return { ok: true, status: 204, detail: '' };
  };
  state.marks.set('jf-abc123.ko', { at: state.clock - 1000, path: '/media/A.kor.srt', print: fingerprint(oldText) });
  ready(state, srtOf(10, 'NEW'));
  await createAutoSaver(o).start();
  assert.equal(state.uploads.length, 1);
  assert.deepEqual(jf.removed, [3], 'A was index 2 before the upload and 3 after it');
  assert.deepEqual([...jf.tracks.keys()], ['/media/0-first.kor.1.srt']);
  assert.deepEqual(state.statuses, ['Replaced the translation on Jellyfin']);
  assert.equal(state.marks.get('jf-abc123.ko').path, '/media/0-first.kor.1.srt');
  assert.equal(state.marks.get('jf-abc123.ko').print, fingerprint(srtOf(10, 'NEW')));
});

test('replace: waits while the bridge still holds the translation that was uploaded, then replaces it', async () => {
  const oldText = srtOf(10, 'OLD');
  const { state, o } = setup({ maxWaitMs: 60000 });
  const { jf, options } = jellyfin(state, [['/media/A.kor.srt', oldText]]);
  Object.assign(o, options);
  state.marks.set('jf-abc123.ko', { at: state.clock - 1000, path: '/media/A.kor.srt', print: fingerprint(oldText) });
  ready(state, oldText);
  o.sleep = async (ms) => { state.clock += ms; if (++state.sleeps === 3) ready(state, srtOf(10, 'NEW')); };
  await createAutoSaver(o).start();
  assert.equal(state.sleeps, 3);
  assert.equal(state.uploads.length, 1);
  assert.equal(decode(state.uploads[0]), srtOf(10, 'NEW'));
  assert.equal(jf.removed.length, 1);
});

test('replace: a subtitle Subpair did not upload is kept, and nothing is uploaded or deleted', async () => {
  for (const mark of [undefined, { at: 1, path: '/media/Other.kor.srt', print: 'x' }]) {
    const { state, o } = setup();
    const { jf, options } = jellyfin(state, [['/media/Bazarr.ko.srt', srtOf(10, 'MINE')]]);
    Object.assign(o, options);
    if (mark) state.marks.set('jf-abc123.ko', mark);
    ready(state, srtOf(10, 'NEW'));
    await createAutoSaver(o).start();
    assert.equal(state.uploads.length, 0);
    assert.deepEqual(jf.removed, []);
    assert.deepEqual(state.statuses, ['Kept the subtitle that is on Jellyfin: Subpair did not make it']);
  }
});

test('replace: an uploaded track that was edited since (other fingerprint) counts as not ours', async () => {
  const { state, o } = setup();
  const { jf, options } = jellyfin(state, [['/media/A.kor.srt', srtOf(10, 'EDITED')]]);
  Object.assign(o, options);
  state.marks.set('jf-abc123.ko', { at: state.clock - 1000, path: '/media/A.kor.srt', print: fingerprint(srtOf(10, 'OLD')) });
  ready(state, srtOf(10, 'NEW'));
  await createAutoSaver(o).start();
  assert.equal(state.uploads.length, 0);
  assert.deepEqual(jf.removed, []);
});

test('replace: when the old track cannot be deleted the new one is still saved and the user is told why', async () => {
  const oldText = srtOf(10, 'OLD');
  const { state, o } = setup();
  const { jf, options } = jellyfin(state, [['/media/A.kor.srt', oldText]]);
  Object.assign(o, options);
  jf.removeStatus = 403;
  state.marks.set('jf-abc123.ko', { at: state.clock - 1000, path: '/media/A.kor.srt', print: fingerprint(oldText) });
  ready(state, srtOf(10, 'NEW'));
  await createAutoSaver(o).start();
  assert.equal(state.uploads.length, 1);
  assert.equal(jf.tracks.size, 2);
  assert.match(state.statuses[0], /old one could not be removed \(status 403, needs an administrator\)/);
  assert.equal(state.marks.get('jf-abc123.ko').print, fingerprint(srtOf(10, 'NEW')));
});

test('replace needs a way to read and delete tracks', async () => {
  const { o } = setup({ replace: true });
  await assert.rejects(createAutoSaver(o).start(), /readSubtitle and remove/);
});

test('makeRemover sends an authorised DELETE for the track index', async () => {
  let seen;
  const remove = makeRemover({ base: 'http://jf', token: 't0k', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 204 }; } });
  assert.deepEqual(await remove('abc', 3), { ok: true, status: 204, detail: '' });
  assert.equal(seen.url, 'http://jf/Videos/abc/Subtitles/3');
  assert.equal(seen.init.method, 'DELETE');
  assert.equal(seen.init.headers.Authorization, 'MediaBrowser Token="t0k"');
});

test('storageMarks orders old numeric marks and new mark objects together', async () => {
  const data = { jellyfinSaved: { old: 5 } };
  const area = { get: async (k) => ({ [k]: data[k] }), set: async (o) => Object.assign(data, o) };
  const marks = storageMarks(area);
  await marks.set('new', { at: 9, path: 'p', print: 'f' });
  assert.deepEqual(Object.keys(data.jellyfinSaved), ['new', 'old']);
});

test('it keeps polling while the bridge has nothing saved, and uploads when the job finishes', async () => {
  const { state, o } = setup({ maxWaitMs: 60000 });
  o.sleep = async (ms) => { state.clock += ms; if (++state.sleeps === 3) ready(state); };
  await createAutoSaver(o).start();
  assert.equal(state.uploads.length, 1);
  assert.ok(state.polls >= 4, `expected it to ask again after each wait, asked ${state.polls} times`);
});

test('it gives up waiting after maxWaitMs of wall clock, not after a number of polls', async () => {
  const { state, saver } = setup({ maxWaitMs: 4000, pollMs: 1000 });
  await saver.start();
  assert.equal(state.polls, 4);
  assert.equal(state.uploads.length, 0);
  const slow = setup({ maxWaitMs: 4000, pollMs: 1000 });
  slow.o.sleep = async (ms) => { slow.state.clock += ms * 4; };   // a throttled hidden tab: each wait lasts four times longer
  await createAutoSaver(slow.o).start();
  assert.equal(slow.state.polls, 1, 'late timers must shorten the number of polls, not extend the wait');
});

test('nothing is uploaded when the switch is off, or the language has no Jellyfin code', async () => {
  for (const options of [{ enabled: false }, { to: 'xx' }]) {
    const { state, saver } = setup(options);
    ready(state);
    ready(state, srtOf(10), 'xx.claude');
    await saver.start();
    assert.equal(state.uploads.length, 0);
    assert.equal(state.polls, 0, 'it must not even ask the bridge');
  }
});

test('a Korean track that appeared since the video loaded stops the upload (the list is read fresh)', async () => {
  const { state, saver } = setup();
  ready(state);
  state.streams = [{ Type: 'Subtitle', Language: 'kor' }];      // the page loaded with no Korean track; Jellyfin has one now
  await saver.start();
  assert.equal(state.uploads.length, 0);
  assert.deepEqual(state.statuses, []);
});

test('a forced-only Korean track does not stop the upload', async () => {
  const { state, saver } = setup();
  ready(state);
  state.streams = [{ Type: 'Subtitle', Language: 'kor', IsForced: true }];
  await saver.start();
  assert.equal(state.uploads.length, 1);
});

test('the saved translation must cover 95 percent of the lines', async () => {
  for (const [lines, uploads] of [[19, 1], [18, 0]]) {
    const { state, saver } = setup({ cues: cues(20), maxWaitMs: 2000 });
    ready(state, srtOf(lines));
    await saver.start();
    assert.equal(state.uploads.length, uploads, `${lines} of 20 lines`);
  }
});

test('a translation whose cue times do not match the item (another source track) is not uploaded', async () => {
  const { state, saver } = setup({ maxWaitMs: 2000 });
  ready(state, srtOf(10, 'T', 1));                               // every cue starts one second late
  await saver.start();
  assert.equal(state.uploads.length, 0);
});

test('a saved file with no cues in it is never uploaded, even for an item without cues', async () => {
  const { state, saver } = setup({ cues: [], maxWaitMs: 2000 });
  ready(state, 'this is not a subtitle file');
  await saver.start();
  assert.equal(state.uploads.length, 0);
});

test('only entries for the wanted target language count', async () => {
  const { state, saver } = setup({ maxWaitMs: 2000 });
  ready(state, srtOf(10, 'EN'), 'en.claude');                    // the only saved translation is English
  await saver.start();
  assert.equal(state.uploads.length, 0);
});

test('a translation made from another source language is skipped even when it is from the chosen backend', async () => {
  const { state, saver } = setup();
  state.entries = { 'ko.claude': entry('ko', 'claude', 'en'), 'ko.eztrans': entry('ko', 'eztrans', 'ja') };
  state.srt = { 'ko.claude': srtOf(10, 'C'), 'ko.eztrans': srtOf(10, 'E') };
  await saver.start();
  assert.equal(state.uploads.length, 1);
  assert.equal(decode(state.uploads[0]), state.srt['ko.eztrans']);
});

test('the chosen backend is preferred, and another complete one is used when the chosen one is incomplete', async () => {
  const both = setup();
  both.state.entries = { 'ko.eztrans': entry('ko', 'eztrans'), 'ko.claude': entry('ko', 'claude') };
  both.state.srt = { 'ko.eztrans': srtOf(10, 'E'), 'ko.claude': srtOf(10, 'C') };
  await both.saver.start();
  assert.equal(decode(both.state.uploads[0]), both.state.srt['ko.claude']);

  const fallback = setup();
  fallback.state.entries = { 'ko.eztrans': entry('ko', 'eztrans'), 'ko.claude': entry('ko', 'claude') };
  fallback.state.srt = { 'ko.eztrans': srtOf(10, 'E'), 'ko.claude': srtOf(4, 'C') };     // claude is still running, eztrans is done
  await fallback.saver.start();
  assert.equal(decode(fallback.state.uploads[0]), fallback.state.srt['ko.eztrans']);
});

test('a recent upload mark prevents another upload, an old one does not, and a mark from the future is ignored', async () => {
  for (const [age, uploads] of [[3600 * 1000, 0], [25 * 3600 * 1000, 1], [-3600 * 1000, 1]]) {
    const { state, saver } = setup();
    ready(state);
    state.marks.set('jf-abc123.ko', state.clock - age);
    await saver.start();
    assert.equal(state.uploads.length, uploads, `mark made ${age / 3600000} hours ago`);
  }
});

test('no permission (401 or 403) is reported once and not retried', async () => {
  for (const code of [401, 403]) {
    const { state, saver } = setup();
    state.codes = [code];
    ready(state);
    await saver.start();
    assert.equal(state.uploads.length, 1);
    assert.equal(state.statuses.length, 1);
    assert.match(state.statuses[0], /not allowed to manage subtitles/);
    assert.equal(state.marks.size, 0, 'a failed upload is not remembered as done');
  }
});

test('a request the server refuses outright (400, 404, 413) is not retried', async () => {
  for (const code of [400, 404, 413]) {
    const { state, saver } = setup();
    state.codes = [code];
    ready(state);
    await saver.start();
    assert.equal(state.uploads.length, 1, `status ${code}`);
    assert.deepEqual(state.statuses, [`Could not save to Jellyfin (status ${code})`]);
  }
});

test('a failing server is retried a few times, then given up with one message', async () => {
  const { state, saver } = setup({ maxWaitMs: 60000 });
  state.codes = [500];
  ready(state);
  await saver.start();
  assert.equal(state.uploads.length, 3);
  assert.deepEqual(state.statuses, ['Could not save to Jellyfin (status 500)']);
  assert.equal(state.marks.size, 0);
});

test('a server that recovers on the second try gets the upload and the success message', async () => {
  const { state, saver } = setup({ maxWaitMs: 60000 });
  state.codes = [503, 204];
  ready(state);
  await saver.start();
  assert.equal(state.uploads.length, 2);
  assert.deepEqual(state.statuses, ['Saved the translation to Jellyfin']);
});

test('a network error from the upload counts as a failed try', async () => {
  const { state, saver } = setup({ maxWaitMs: 60000, upload: async () => { throw new Error('offline'); } });
  ready(state);
  await saver.start();
  assert.deepEqual(state.statuses, ['Could not save to Jellyfin (status no answer)']);
});

test('an error while reading the item is retried, then reported with its message', async () => {
  const { state, saver } = setup({ maxWaitMs: 60000, readMediaStreams: async () => { throw new Error('Jellyfin 401 for /Users'); } });
  ready(state);
  await saver.start();
  assert.equal(state.uploads.length, 0);
  assert.deepEqual(state.statuses, ['Could not save to Jellyfin: Jellyfin 401 for /Users']);
});

test('a storage failure after a successful upload does not cause a second upload or hide the success', async () => {
  const { state, saver } = setup({ maxWaitMs: 60000, marks: { get: async () => undefined, set: async () => { throw new Error('quota'); } } });
  ready(state);
  await saver.start();
  assert.equal(state.uploads.length, 1);
  assert.deepEqual(state.statuses, ['Saved the translation to Jellyfin']);
});

test('after the extension was reloaded it says so and stops without touching anything', async () => {
  const { state, saver } = setup({ alive: () => false });
  ready(state);
  await saver.start();
  assert.deepEqual(state.statuses, ['Stopped saving: the extension was reloaded']);
  assert.equal(state.polls, 0);
  assert.equal(state.uploads.length, 0);
});

test('two tabs playing the same item upload once, because the save runs under a shared lock', async () => {
  const shared = new Map();
  const marks = { get: async (k) => shared.get(k), set: async (k, t) => { await Promise.resolve(); shared.set(k, t); } };
  let tail = Promise.resolve();
  const lock = (fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };    // what navigator.locks does across tabs
  const slowStreams = async () => { await new Promise((r) => setTimeout(r, 5)); return []; };
  const a = setup({ marks, lock, readMediaStreams: slowStreams });
  const b = setup({ marks, lock, readMediaStreams: slowStreams });
  for (const t of [a, b]) ready(t.state);
  await Promise.all([a.saver.start(), b.saver.start()]);
  assert.equal(a.state.uploads.length + b.state.uploads.length, 1);
});

test('without a lock the same two tabs would both upload (this is why the lock exists)', async () => {
  const shared = new Map();
  const marks = { get: async (k) => shared.get(k), set: async (k, t) => { shared.set(k, t); } };
  const slowStreams = async () => { await new Promise((r) => setTimeout(r, 5)); return []; };
  const a = setup({ marks, readMediaStreams: slowStreams });
  const b = setup({ marks, readMediaStreams: slowStreams });
  for (const t of [a, b]) ready(t.state);
  await Promise.all([a.saver.start(), b.saver.start()]);
  assert.equal(a.state.uploads.length + b.state.uploads.length, 2);
});

test('stop() before the upload prevents it and silences the status', async () => {
  const { state, o } = setup();
  ready(state);
  let release;
  const gate = new Promise((r) => { release = r; });
  o.readMediaStreams = async () => { await gate; return []; };          // pause inside the save, as a page change would
  const held = createAutoSaver(o);
  const done = held.start();
  await new Promise((r) => setTimeout(r, 10));
  held.stop();
  release();
  await done;
  assert.equal(state.uploads.length, 0);
  assert.deepEqual(state.statuses, []);
});

test('an upload that finishes after stop() is still remembered but not announced', async () => {
  const { state, o } = setup();
  ready(state);
  let release;
  const gate = new Promise((r) => { release = r; });
  const held = createAutoSaver({ ...o, upload: async (id, body) => { state.uploads.push({ id, body }); await gate; return { ok: true, status: 204, detail: '' }; } });
  const done = held.start();
  await new Promise((r) => setTimeout(r, 10));
  held.stop();
  release();
  await done;
  assert.equal(state.uploads.length, 1);
  assert.equal(state.marks.size, 1);
  assert.deepEqual(state.statuses, []);
});

test('a saver serves one playback: start() twice runs one loop, and start() after stop() does nothing', async () => {
  const twice = setup();
  ready(twice.state);
  await Promise.all([twice.saver.start(), twice.saver.start()]);
  assert.equal(twice.state.uploads.length, 1);

  const stopped = setup();
  ready(stopped.state);
  stopped.saver.stop();
  await stopped.saver.start();
  assert.equal(stopped.state.uploads.length, 0);
  assert.equal(stopped.state.polls, 0);
});
