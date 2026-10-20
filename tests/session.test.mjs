import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSession } from '../src/session.js';
import { newProfile } from '../src/profile.js';

// A fake site: tracks in the common shape, cue text keyed by track id, and a record of what was fetched.
function fakeAdapter({ tracks, cues = {}, key = 'k1', title = 'A Show', failing = [] }) {
  const fetched = [];
  return {
    name: 'fake',
    fetched,
    async open() {
      return {
        key, title, tracks,
        fetchCues: async (track) => {
          fetched.push(track.id);
          if (failing.includes(track.id)) throw new Error(`track ${track.id} broke`);
          return (cues[track.id] || []).map((c) => ({ ...c }));
        },
      };
    },
  };
}

const t = (id, lang, extra = {}) => ({ id, lang, label: `${lang}${id}`, forced: false, extra: false, rank: 0, ...extra });
const cue = (start, text) => ({ start, end: start + 1, text });
const profile = (main, sub, extra = {}) => ({ ...newProfile('p', 'P', main, sub), ...extra });

// A translator that is ready (or not) and records how it was built.
function fakeTranslators(ready = { ok: true }) {
  const built = [];
  const makeTranslator = (opts) => {
    const tr = { opts, prepare: async () => ready, start() {}, stop() {} };
    built.push(tr);
    return tr;
  };
  return { built, makeTranslator };
}

const log = [];
const run = (adapter, prof, extra = {}) => loadSession({ adapter, itemId: 'i1', hint: 'h', profile: prof, log: (...a) => log.push(a.join(' ')), ...extra });

test('a real track in the first wanted second language is used, and nothing is translated', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(2, 'kor'), t(3, 'eng')], cues: { 1: [cue(0, '今日は')], 2: [cue(0, '안녕')], 3: [cue(0, 'hi')] } });
  const { built, makeTranslator } = fakeTranslators();
  const s = await run(a, profile(['ja'], ['ko', 'en']), { makeTranslator });
  assert.equal(s.subKind, 'track');
  assert.deepEqual([s.mainLang, s.subLang], ['ja', 'ko']);
  assert.equal(s.mainCues[0].text, '今日は');
  assert.equal(s.subCues[0].text, '안녕');
  assert.deepEqual(s.trackLangs, ['ja', 'ko', 'en']);
  assert.equal(built.length, 0);
  assert.equal(s.translator, null);
  assert.deepEqual(a.fetched.sort(), [1, 2]);                       // the English track was never downloaded
});

test('no track in the wanted language: the second line is translated, with blank cues on the main line\'s timing', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(3, 'eng')], cues: { 1: [cue(0, 'a'), cue(5, 'b')] }, key: 'jf-9', title: 'Show S1E1' });
  const { built, makeTranslator } = fakeTranslators();
  const prof = profile(['ja'], ['ko', 'en'], { translate: { backend: 'claude', mode: 'live', bridge: 'http://127.0.0.1:8765' } });
  const s = await run(a, prof, { makeTranslator, getTime: () => 42 });
  assert.equal(s.subKind, 'translated');
  assert.equal(s.subLang, 'ko');
  assert.deepEqual(s.subCues, [{ start: 0, end: 1, text: '' }, { start: 5, end: 6, text: '' }]);
  assert.equal(s.translator, built[0]);
  const o = built[0].opts;
  assert.deepEqual([o.key, o.title, o.from, o.to, o.backend, o.mode], ['jf-9', 'Show S1E1', 'ja', 'ko', 'claude', 'live']);
  assert.equal(o.cues, s.mainCues);                                  // translates exactly the cues that are shown
  assert.equal(o.subCues, s.subCues);                                // and fills exactly the cues that are shown
  assert.equal(o.getTime(), 42);
  assert.deepEqual(a.fetched, [1]);                                  // English was not needed
});

test('translation progress goes to the sink once the UI sets one', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn')], cues: { 1: [cue(0, 'a')] } });
  const { built, makeTranslator } = fakeTranslators();
  const s = await run(a, profile(['ja'], ['ko']), { makeTranslator });
  built[0].opts.onStatus('before the UI');                           // nobody listening yet: must not throw
  const seen = [];
  s.setStatusSink((x) => seen.push(x));
  built[0].opts.onStatus('Translating 3/10');
  assert.deepEqual(seen, ['Translating 3/10']);
});

test('translation unavailable: the next wanted language with a real track is used, and the reason is kept', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(3, 'eng')], cues: { 1: [cue(0, 'a')], 3: [cue(0, 'hello')] } });
  const { makeTranslator } = fakeTranslators({ ok: false, reason: 'bridge is not running' });
  const s = await run(a, profile(['ja'], ['ko', 'en']), { makeTranslator });
  assert.equal(s.subKind, 'track');
  assert.deepEqual([s.subLang, s.subCues[0].text], ['en', 'hello']);
  assert.equal(s.note, 'bridge is not running');
  assert.equal(s.translator, null);
});

test('translation unavailable and no other track: the second line is off', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn')], cues: { 1: [cue(0, 'a')] } });
  const { makeTranslator } = fakeTranslators({ ok: false, reason: 'nope' });
  const s = await run(a, profile(['ja'], ['ko', 'en']), { makeTranslator });
  assert.equal(s.subKind, 'off');
  assert.deepEqual(s.subCues, []);
  assert.equal(s.note, 'nope');
});

test('translation switched off: no translator is even built, the fallback track is used', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(3, 'eng')], cues: { 1: [cue(0, 'a')], 3: [cue(0, 'hello')] } });
  const { built, makeTranslator } = fakeTranslators();
  const s = await run(a, profile(['ja'], ['ko', 'en'], { translate: { backend: 'eztrans', mode: 'off', bridge: 'http://127.0.0.1:8765' } }), { makeTranslator });
  assert.equal(built.length, 0);
  assert.deepEqual([s.subKind, s.subLang], ['track', 'en']);
});

test('a wanted second language equal to the main language is never translated', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn')], cues: { 1: [cue(0, 'a')] } });
  const { built, makeTranslator } = fakeTranslators();
  const s = await run(a, profile(['ja'], ['ja']), { makeTranslator });
  assert.equal(built.length, 0);
  assert.equal(s.subKind, 'off');
});

test('the main track is never also chosen as the second line', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(2, 'jpn', { extra: true })], cues: { 1: [cue(0, 'full')], 2: [cue(0, 'signs')] } });
  const s = await run(a, profile(['ja'], ['ja']));
  assert.equal(s.mainCues[0].text, 'full');
  assert.equal(s.subCues[0].text, 'signs');                          // the other Japanese track, not the same one twice
  assert.equal(s.subKind, 'track');
});

test('no track in any main language gives nothing to show, and the log says what the video does have', async () => {
  log.length = 0;
  const a = fakeAdapter({ tracks: [t(3, 'eng'), t(4, 'fre')] });
  assert.equal(await run(a, profile(['ja', 'ko'], ['en'])), null);
  assert.match(log.join('\n'), /no fake subtitle track for ja,ko \(available: en,fr\)/);
  assert.deepEqual(a.fetched, []);
});

test('a main track with no cues gives nothing to show', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn')], cues: { 1: [] } });
  assert.equal(await run(a, profile(['ja'], ['ko'])), null);
});

test('a second track that fails to download does not take the main line down', async () => {
  log.length = 0;
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(2, 'kor')], cues: { 1: [cue(0, 'a')], 2: [cue(0, 'x')] }, failing: [2] });
  const s = await run(a, profile(['ja'], ['ko']));
  assert.equal(s.mainCues.length, 1);
  assert.deepEqual(s.subCues, []);
  assert.match(log.join('\n'), /sub track failed to load/);
});

test('a failing main track is an error for the caller (the poll loop retries later)', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn')], failing: [1] });
  await assert.rejects(run(a, profile(['ja'], ['ko'])), /track 1 broke/);
});

test('cue text is cleaned per the profile: line breaks joined for Japanese, speaker tags dropped when asked', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn')], cues: { 1: [cue(0, '（魔王）こんにちは\n世界')] } });
  const joined = await run(a, profile(['ja'], [], { joinLines: true, hideSpeaker: true }));
  assert.equal(joined.mainCues[0].text, 'こんにちは世界');
  const kept = await run(a, profile(['ja'], [], { joinLines: false, hideSpeaker: false }));
  assert.equal(kept.mainCues[0].text, '（魔王）こんにちは\n世界');
});

test('the fallback list is walked in order and skips languages without a track', async () => {
  const a = fakeAdapter({ tracks: [t(1, 'jpn'), t(5, 'spa'), t(6, 'eng')], cues: { 1: [cue(0, 'a')], 5: [cue(0, 'es')], 6: [cue(0, 'en')] } });
  const { makeTranslator } = fakeTranslators({ ok: false, reason: 'off line' });
  const s = await run(a, profile(['ja'], ['ko', 'fr', 'es', 'en']), { makeTranslator });
  assert.equal(s.subLang, 'es');
  assert.equal(s.subCues[0].text, 'es');
});

test('a wanted track that fails to load counts as missing: translated when possible, else the next language, never the broken one again', async () => {
  const tracks = [t(1, 'jpn'), t(2, 'kor'), t(3, 'eng')];
  const cues = { 1: [cue(0, 'a')], 2: [cue(0, 'ko')], 3: [cue(0, 'en')] };
  const offline = fakeTranslators({ ok: false, reason: 'off line' });
  const a = fakeAdapter({ tracks, cues, failing: [2] });
  const s = await run(a, profile(['ja'], ['ko', 'en']), { makeTranslator: offline.makeTranslator });
  assert.equal(s.subKind, 'track');
  assert.equal(s.subLang, 'en');
  assert.equal(s.subCues[0].text, 'en');
  assert.deepEqual(a.fetched.filter((id) => id === 2), [2]);                    // tried once, not again as a fallback

  const online = fakeTranslators();
  const b = fakeAdapter({ tracks, cues, failing: [2] });
  const u = await run(b, profile(['ja'], ['ko', 'en']), { makeTranslator: online.makeTranslator });
  assert.equal(u.subKind, 'translated');
  assert.equal(u.subLang, 'ko');
  assert.equal(u.hasWantedTrack, false);
});

test('translating instead of a real track: asked for per title, and the track comes back when translation cannot start', async () => {
  const tracks = [t(1, 'jpn'), t(2, 'kor')];
  const cues = { 1: [cue(0, 'a')], 2: [cue(0, 'ko')] };
  const asked = [];
  const wishes = async (key) => { asked.push(key); return { preferTranslation: true }; };
  const online = fakeTranslators();
  const s = await run(fakeAdapter({ tracks, cues, key: 'jf-1' }), profile(['ja'], ['ko']), { makeTranslator: online.makeTranslator, wishes });
  assert.deepEqual(asked, ['jf-1']);
  assert.equal(s.subKind, 'translated');
  assert.equal(s.hasWantedTrack, true);
  assert.equal(s.preferTranslation, true);

  const offline = fakeTranslators({ ok: false, reason: 'off line' });
  const u = await run(fakeAdapter({ tracks, cues }), profile(['ja'], ['ko']), { makeTranslator: offline.makeTranslator, wishes });
  assert.equal(u.subKind, 'track');
  assert.equal(u.subCues[0].text, 'ko');
  assert.equal(u.note, 'off line');
});

test('translate again reaches the translator as fresh, with the profile\'s translator and models', async () => {
  const online = fakeTranslators();
  const p = profile(['ja'], ['ko']);
  p.translate = { ...p.translate, backend: 'claude', models: { claude: 'sonnet', api: '', openai: '' } };
  await run(fakeAdapter({ tracks: [t(1, 'jpn')], cues: { 1: [cue(0, 'a')] } }), p, { makeTranslator: online.makeTranslator, wishes: async () => ({ fresh: true }) });
  const o = online.built[0].opts;
  assert.equal(o.fresh, true);
  assert.equal(o.backend, 'claude');
  assert.deepEqual(o.models, { claude: 'sonnet', api: '', openai: '' });
});
