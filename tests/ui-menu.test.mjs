import test from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../src/i18n.js';

// Just enough of the DOM for src/ui-menu.js: it only builds nodes, sets text and reads one class back.
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this.text = '';
    this.hidden = false;
    this.classList = { add: (c) => { this.className = `${this.className} ${c}`.trim(); } };
  }
  set textContent(v) { this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  setAttribute() {}
  contains() { return false; }
  querySelector(sel) { return this.all().find((n) => n.className.split(' ').includes(sel.slice(1))) || null; }
  all() { return this.children.filter((c) => typeof c !== 'string').flatMap((c) => [c, ...c.all()]); }
}
globalThis.document = { createElement: (tag) => new FakeNode(tag), addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { createMenu } = await import('../src/ui-menu.js');

const state = (over = {}) => ({
  mainLang: 'ja', subLang: 'ko', wantedSub: 'ko', subKind: 'track', trackLangs: ['ja', 'ko'],
  hasWantedTrack: true, canTranslate: true, overTrack: false, backend: 'auto', mode: 'auto', status: null,
  canSeason: false, season: null, offsets: { main: 0, sub: 0 }, mainFont: 32, subFont: 26, placement: 'overlay', gap: 40,
  lineGap: 4, align: 'center', background: 'shadow', autoPause: false, ...over,
});

// Opens the menu on `s`, goes to the row labelled `view`, and returns that view's rows by label.
function openView(s, view) {
  const calls = [];
  const quick = { get: () => s, translateOverTrack: (on) => calls.push(on) };
  const root = new FakeNode('div');
  createMenu(root, { quick, panelOn: () => false, togglePanel() {}, openSettings() {} }).toggle();
  const menu = root.children[0];
  const rows = () => menu.all().filter((n) => n.className === 'subpair-mrow');
  const label = (r) => r.children[0].textContent.replace('✓', '');
  rows().find((r) => label(r) === view).onclick();
  return { labels: rows().map(label), rowNamed: (l) => rows().find((r) => label(r) === l), calls };
}

test('menu: "translate the main line instead" is under Translator, not under Second subtitle', () => {
  const tr = openView(state(), t('menuTranslator'));
  assert.ok(tr.labels.includes(t('translateInstead')));
  tr.rowNamed(t('translateInstead')).onclick();
  assert.deepEqual(tr.calls, [true]);
  assert.ok(!openView(state(), t('menuSecond')).labels.includes(t('translateInstead')));
});

test('menu: once switched, Translator offers the subtitle track again, named by its language', () => {
  const tr = openView(state({ overTrack: true, subKind: 'translated' }), t('menuTranslator'));
  const back = t('useTrackAgain', 'Korean');
  assert.ok(tr.labels.includes(back));
  assert.ok(!tr.labels.includes(t('translateInstead')));
  tr.rowNamed(back).onclick();
  assert.deepEqual(tr.calls, [false]);
});

test('menu: no switch without a real track in the wanted language, or with the translator off', () => {
  // A track Subpair uploaded itself is not a real wanted track (src/session.js), so hasWantedTrack is false.
  assert.ok(!openView(state({ hasWantedTrack: false, subKind: 'translated' }), t('menuTranslator')).labels.includes(t('translateInstead')));
  assert.ok(!openView(state({ canTranslate: false, mode: 'off' }), t('menuTranslator')).labels.includes(t('translateInstead')));
});
