import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeProfile, sanitizeSettings, isConfigured, wantedSub, DEFAULTS, DEFAULT_KEYS, LIMITS, MAX_PROFILES } from '../src/profile.js';

test('numbers are clamped, junk falls back to defaults', () => {
  const p = sanitizeProfile({ id: 'x', name: 'n', main: ['ja'], mainFont: 900, subFont: -5, mainLines: -3, subLines: 'abc' });
  assert.equal(p.mainFont, LIMITS.font[1]);
  assert.equal(p.subFont, LIMITS.font[0]);
  assert.equal(p.mainLines, LIMITS.lines[0]);
  assert.equal(p.subLines, 2);                         // not a number -> default
});

test('reserved lines accept halves (2.5), round to the nearest half, and the gap is clamped', () => {
  assert.equal(sanitizeProfile({ mainLines: 2.5 }).mainLines, 2.5);
  assert.equal(sanitizeProfile({ mainLines: 2.3 }).mainLines, 2.5);
  assert.equal(sanitizeProfile({ mainLines: 2.2 }).mainLines, 2);
  assert.equal(sanitizeProfile({ subLines: 9 }).subLines, 4);
  assert.equal(sanitizeProfile({ subtitleGap: 9999 }).subtitleGap, 200);
  assert.equal(sanitizeProfile({ subtitleGap: -4 }).subtitleGap, 0);
  assert.equal(sanitizeProfile({ subtitleGap: 'x' }).subtitleGap, 12);
});

test('the space between the two lines defaults small and is clamped to its own range', () => {
  assert.equal(sanitizeProfile({}).lineGap, 4);
  assert.equal(sanitizeProfile({ lineGap: 10 }).lineGap, 10);
  assert.equal(sanitizeProfile({ lineGap: 500 }).lineGap, 60);
  assert.equal(sanitizeProfile({ lineGap: -1 }).lineGap, 0);
  assert.equal(sanitizeProfile({ lineGap: 'x' }).lineGap, 4);
});

test('textPlacement accepts overlay or bar only; the old "picture" value falls back to overlay', () => {
  assert.equal(sanitizeProfile({}).textPlacement, 'overlay');
  assert.equal(sanitizeProfile({ textPlacement: 'bar' }).textPlacement, 'bar');
  assert.equal(sanitizeProfile({ textPlacement: 'picture' }).textPlacement, 'overlay');
  assert.equal(sanitizeProfile({ textPlacement: 'middle' }).textPlacement, 'overlay');
});

test('languages: strings and arrays are cleaned; none chosen stays none, so the options page asks', () => {
  assert.deepEqual(sanitizeProfile({ main: ' ja , ko ,, ', sub: ['en', ' ', 3] }).main, ['ja', 'ko']);
  assert.deepEqual(sanitizeProfile({ main: ' ja , ko ,, ', sub: ['en', ' ', 3] }).sub, ['en', '3']);
  assert.deepEqual(sanitizeProfile({ main: [] }).main, []);
  assert.deepEqual(sanitizeProfile({ main: 42 }).main, []);
  assert.equal(isConfigured(sanitizeProfile({})), false);
  assert.equal(isConfigured(sanitizeProfile({ main: ['ja'] })), true);
  const fresh = sanitizeSettings(DEFAULTS).profiles[0];                       // a new install hard-codes no language
  assert.deepEqual([fresh.main, fresh.sub], [[], []]);
  assert.equal(wantedSub(sanitizeProfile({ sub: ['kor', 'en'] })), 'ko');
});

test('default keys leave the sites\' own seek, volume and skip-intro keys alone', () => {
  const all = Object.values(DEFAULT_KEYS).flat();
  for (const taken of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 's', ' ', 'f', 'm']) assert.ok(!all.includes(taken), taken);
});

test('keys and colors are validated per field', () => {
  const p = sanitizeProfile({ keys: { prev: 'z, ArrowUp', next: 7 }, colors: { noun: '#ABCDEF', verb: 'red', adj: '#12345' } });
  assert.deepEqual(p.keys.prev, ['z', 'ArrowUp']);
  assert.deepEqual(p.keys.repeat, DEFAULT_KEYS.repeat);   // missing -> default
  assert.deepEqual(p.keys.next, DEFAULT_KEYS.next);       // a number is not a key list -> default
  assert.equal(p.colors.noun, '#ABCDEF');
  assert.notEqual(p.colors.verb, 'red');                  // invalid color replaced by the default
  assert.notEqual(p.colors.adj, '#12345');
});

test('pictureAlign accepts only top/center/bottom', () => {
  assert.equal(sanitizeProfile({}).pictureAlign, 'center');
  assert.equal(sanitizeProfile({ pictureAlign: 'top' }).pictureAlign, 'top');
  assert.equal(sanitizeProfile({ pictureAlign: 'left' }).pictureAlign, 'center');
  assert.equal(sanitizeProfile({ videoAlign: 'bottom' }).pictureAlign, 'center');   // the old stored key is ignored
});

test('sanitizeSettings rejects garbage and keeps a valid active profile', () => {
  assert.equal(sanitizeSettings(null), null);
  assert.equal(sanitizeSettings({ profiles: [] }), null);
  assert.equal(sanitizeSettings({ profiles: 'x' }), null);
  const s = sanitizeSettings({ activeProfile: 'gone', profiles: [{ id: 'a', name: 'A', main: 'ja' }, { id: 'b', main: ['ko'] }] });
  assert.equal(s.activeProfile, 'a');                     // unknown active id -> first profile
  assert.equal(s.profiles.length, 2);
  assert.deepEqual(s.profiles[0].main, ['ja']);           // string main from a hand-edited import is accepted
});

test('profiles with the same id get distinct ids and the active one stays the first of them', () => {
  const s = sanitizeSettings({ activeProfile: 'a', profiles: [{ id: 'a', name: 'one' }, { id: 'a', name: 'two' }, { id: 'a', name: 'three' }, { id: 'b', name: 'four' }] });
  assert.deepEqual(s.profiles.map((p) => p.id), ['a', 'a-2', 'a-3', 'b']);
  assert.equal(s.activeProfile, 'a');
  assert.equal(s.profiles.find((p) => p.id === s.activeProfile).name, 'one');
});

test('only the first MAX_PROFILES profiles are kept', () => {
  const many = Array.from({ length: MAX_PROFILES + 3 }, (_, i) => ({ id: `p${i}` }));
  assert.equal(sanitizeSettings({ profiles: many }).profiles.length, MAX_PROFILES);
});

test('translate settings: unknown backend or mode fall back, only a local bridge address is kept, a trailing slash is tolerated', () => {
  const t = (translate) => sanitizeSettings({ profiles: [{ id: 'x', translate }] }).profiles[0].translate;
  const models = { claude: '', api: '', openai: '' };
  assert.deepEqual(t({ backend: 'x', mode: 'y', bridge: 'http://evil.com' }), { backend: 'auto', mode: 'auto', bridge: 'http://127.0.0.1:8765', models });
  assert.equal(t({ backend: 'openai', mode: 'live', bridge: 'http://localhost:9000/' }).bridge, 'http://localhost:9000');
  assert.equal(t({ bridge: ' http://127.0.0.1:8777 ' }).bridge, 'http://127.0.0.1:8777');
  assert.equal(t({ bridge: 'https://127.0.0.1:8765' }).bridge, 'http://127.0.0.1:8765');      // https is refused: the bridge speaks plain http
  assert.equal(t({ bridge: 'http://127.0.0.1:8765.evil.com' }).bridge, 'http://127.0.0.1:8765');
  assert.equal(t({ bridge: 42 }).bridge, 'http://127.0.0.1:8765');
  assert.equal(t({ backend: 'openai' }).backend, 'openai');
  assert.equal(t({ backend: 'eztrans' }).backend, 'eztrans');
});

test('translator models: a name the bridge accepts is kept per translator, anything else is the bridge default', () => {
  const m = (models) => sanitizeSettings({ profiles: [{ id: 'x', translate: { models } }] }).profiles[0].translate.models;
  assert.deepEqual(m({ claude: ' sonnet ', api: 'claude-haiku-5-5', openai: 'org/model:7b' }), { claude: 'sonnet', api: 'claude-haiku-5-5', openai: 'org/model:7b' });
  assert.deepEqual(m({ claude: 'bad model; rm', api: 7, eztrans: 'x' }), { claude: '', api: '', openai: '' });      // eztrans has no model
  assert.deepEqual(m(undefined), { claude: '', api: '', openai: '' });
});
