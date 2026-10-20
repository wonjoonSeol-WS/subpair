import test from 'node:test';
import assert from 'node:assert/strict';
import { mainChoices, subChoices, languagePatch, stepOffset, formatOffset, stepFont, stepGap, translatorSummary, secondLine, placementSummary, choiceLabel,
  TRANSLATOR_CHOICES, MODE_CHOICES, PLACEMENT_CHOICES, ALIGN_CHOICES, BACKGROUND_CHOICES, OFFSET_MAX } from '../src/quickmenu.js';
import { LANGUAGES, langLabel } from '../src/lang.js';
import { LIMITS, LOOK_FIELDS, sessionKey, lookOf, newProfile, TEXT_PLACEMENTS, PICTURE_ALIGNS, BACKGROUNDS, TRANSLATE_MODES } from '../src/profile.js';
import { BACKENDS } from '../src/backends.js';

const codes = (list) => list.map((c) => c.code);

test('langLabel names a language and falls back to the code', () => {
  assert.equal(langLabel('ja'), 'Japanese');
  assert.equal(langLabel('ko'), 'Korean');
  assert.equal(langLabel('???'), '???');
  assert.equal(langLabel(''), '');
});

test('main line choices are the video\'s real track languages, normalised and without repeats', () => {
  assert.deepEqual(codes(mainChoices(['jpn', 'en', 'ja', 'eng', 'kor'], 'ja')), ['ja', 'en', 'ko']);
  assert.deepEqual(mainChoices(['ja'], 'ja')[0], { code: 'ja', label: 'Japanese', note: '' });
});

test('main line choices keep a selected language the video does not have, first and marked', () => {
  const list = mainChoices(['en', 'ko'], 'ja');
  assert.deepEqual(codes(list), ['ja', 'en', 'ko']);
  assert.equal(list[0].note, 'no track in this video');
  assert.equal(list[1].note, '');
});

test('second line choices: Off, real tracks, then every other language to translate into; never the main language', () => {
  const list = subChoices(['ja', 'en'], 'ko', 'ja', true);
  assert.equal(list[0].code, '');
  assert.equal(list[1].code, 'en');                                       // the one real track other than the main language
  assert.deepEqual(list.slice(0, 3).map((c) => c.note), ['', '', 'translated']);
  assert.ok(!codes(list).includes('ja'));
  assert.deepEqual(codes(list).filter(Boolean).sort(), LANGUAGES.filter((c) => c !== 'ja').sort());      // all languages, once each
  assert.equal(list.find((c) => c.code === 'ko').note, 'translated');
  assert.equal(list.find((c) => c.code === 'en').note, '');              // a real track is not "translated"
});

test('second line choices without translation are only the real tracks', () => {
  const list = subChoices(['ja', 'ko', 'en'], 'ko', 'ja', false);
  assert.deepEqual(codes(list), ['', 'ko', 'en']);
  assert.deepEqual(codes(subChoices([], '', 'ja', false)), ['']);
});

test('a selected second language outside the list is still shown', () => {
  const list = subChoices(['ja'], 'xx', 'ja', false);
  assert.deepEqual(codes(list), ['', 'xx']);
  assert.equal(list[1].note, 'no track in this video');
  assert.equal(subChoices(['ja'], 'xx', 'ja', true)[1].note, 'translated');
});

test('choosing a language puts it first and keeps the others as fallbacks, once each', () => {
  const profile = { main: ['ja'], sub: ['ko', 'en'] };
  assert.deepEqual(languagePatch(profile, 'sub', 'en'), { sub: ['en', 'ko'] });
  assert.deepEqual(languagePatch(profile, 'sub', 'ko'), { sub: ['ko', 'en'] });
  assert.deepEqual(languagePatch(profile, 'sub', 'fr'), { sub: ['fr', 'ko', 'en'] });
  assert.deepEqual(languagePatch(profile, 'sub', ''), { sub: [] });                      // off
  assert.deepEqual(languagePatch(profile, 'main', 'en'), { main: ['en', 'ja'] });
  assert.deepEqual(languagePatch({ main: ['jpn', 'en'], sub: [] }, 'main', 'ja'), { main: ['ja', 'en'] });   // 639-2 duplicate removed
  assert.deepEqual(languagePatch({ main: ['ja'] }, 'sub', 'ko'), { sub: ['ko'] });         // a profile without the field
});

test('timing steps are tenths of a second, never drift, and stay inside the limit', () => {
  let v = 0;
  for (let i = 0; i < 10; i++) v = stepOffset(v, 0.1);
  assert.equal(v, 1);                                                     // not 0.9999999999999999
  assert.equal(stepOffset(0.3, -0.5), -0.2);
  assert.equal(stepOffset(OFFSET_MAX, 5), OFFSET_MAX);
  assert.equal(stepOffset(-OFFSET_MAX, -5), -OFFSET_MAX);
});

test('offsets are shown with a sign', () => {
  assert.equal(formatOffset(0), '0.0 s');
  assert.equal(formatOffset(0.5), '+0.5 s');
  assert.equal(formatOffset(-1.25), '-1.3 s');
  assert.equal(formatOffset(-0), '0.0 s');
});

test('text size steps stay inside the profile limits', () => {
  assert.equal(stepFont(28, 2), 30);
  assert.equal(stepFont(LIMITS.font[1], 2), LIMITS.font[1]);
  assert.equal(stepFont(LIMITS.font[0], -2), LIMITS.font[0]);
});

test('translator summary: the track, off, the chosen translator, then what it is doing and how far it got', () => {
  assert.equal(translatorSummary('track', 'eztrans', 'auto', null), 'subtitle track');
  assert.equal(translatorSummary('translated', 'claude', 'off', null), 'Off');
  assert.equal(translatorSummary('off', 'auto', 'auto', null), 'Automatic');                  // asked for, but nothing could start
  assert.equal(translatorSummary('translated', 'auto', 'auto', { backend: 'eztrans', phase: 'live' }), 'ezTrans, live');
  assert.equal(translatorSummary('translated', 'claude', 'process', { backend: 'claude', phase: 'job', done: 120, total: 840 }), 'Claude, whole title 120/840');
  assert.equal(translatorSummary('translated', 'auto', 'auto', { backend: 'api', phase: 'saved' }), 'Anthropic API, saved translation');
});

test('the translator list is Automatic, every registered translator, then Off; the mode list matches the profile', () => {
  assert.deepEqual(TRANSLATOR_CHOICES.map(([v]) => v), ['auto', ...BACKENDS.map((b) => b.id), 'off']);
  assert.deepEqual(MODE_CHOICES.map(([v]) => v), TRANSLATE_MODES.filter((m) => m !== 'off'));
});

test('second line as the menu shows it: what is on screen, or what was asked for and why it is missing', () => {
  assert.deepEqual(secondLine({ wantedSub: 'ko', subLang: 'ko', subKind: 'translated' }), { missing: false, value: 'Korean (translated)', checked: 'ko' });
  assert.deepEqual(secondLine({ wantedSub: 'ko', subLang: 'en', subKind: 'track' }), { missing: true, value: 'English instead of Korean', checked: 'ko' });
  assert.deepEqual(secondLine({ wantedSub: 'ko', subLang: '', subKind: 'off' }), { missing: true, value: 'Korean (not available)', checked: 'ko' });
  assert.deepEqual(secondLine({ wantedSub: '', subLang: '', subKind: 'off' }), { missing: false, value: 'Off', checked: '' });
});

test('look fields are real profile fields, and the menu offers exactly what the profile accepts', () => {
  const p = newProfile('x', 'X', ['ja'], ['ko']);
  for (const f of LOOK_FIELDS) assert.ok(f in p, f);
  assert.deepEqual(Object.keys(lookOf(p)).sort(), [...LOOK_FIELDS].sort());
  assert.deepEqual(PLACEMENT_CHOICES.map(([v]) => v).sort(), [...TEXT_PLACEMENTS].sort());
  assert.deepEqual(ALIGN_CHOICES.map(([v]) => v).sort(), [...PICTURE_ALIGNS].sort());
  assert.deepEqual(BACKGROUND_CHOICES.map(([v]) => v).sort(), [...BACKGROUNDS].sort());
});

test('session key: a look change keeps it, any other change breaks it', () => {
  const p = newProfile('x', 'X', ['ja'], ['ko']);
  const key = sessionKey(p);
  for (const patch of [{ mainFont: 40 }, { subFont: 30 }, { mainLines: 3 }, { textPlacement: 'bar' }, { subtitleGap: 80 }, { lineGap: 20 }, { pictureAlign: 'top' },
    { subtitleBackground: 'solid' }, { panel: false }, { colorize: false }, { colors: { ...p.colors, noun: '#000000' } }]) {
    assert.equal(sessionKey({ ...p, ...patch }), key, JSON.stringify(patch));
  }
  for (const patch of [{ sub: ['en'] }, { main: ['ko'] }, { translate: { ...p.translate, backend: 'claude' } }, { translate: { ...p.translate, mode: 'off' } },
    { translate: { ...p.translate, models: { ...p.translate.models, claude: 'sonnet' } } },
    { autoPause: true }, { joinLines: false }, { panelTimes: false }, { keys: { ...p.keys, prev: ['z'] } }, { id: 'y' }]) {
    assert.notEqual(sessionKey({ ...p, ...patch }), key, JSON.stringify(patch));
  }
});

test('gap steps stay inside the limits they are given', () => {
  assert.equal(stepGap(12, 4), 16);
  assert.equal(stepGap(2, -4), 0);
  assert.equal(stepGap(LIMITS.gap[1], 4), LIMITS.gap[1]);
  assert.equal(stepGap(LIMITS.lineGap[1], 2, LIMITS.lineGap), LIMITS.lineGap[1]);   // the line gap has its own, lower cap
  assert.ok(LIMITS.lineGap[1] < LIMITS.gap[1]);
});

test('position summary and choice labels', () => {
  assert.equal(placementSummary('overlay', 12), 'On the video, 12 px from the picture');
  assert.equal(placementSummary('bar', 12), 'Bottom bar');
  assert.equal(choiceLabel(BACKGROUND_CHOICES, 'solid'), 'Solid black');
  assert.equal(choiceLabel(BACKGROUND_CHOICES, 'odd'), '');
});
