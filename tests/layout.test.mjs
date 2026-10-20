import test from 'node:test';
import assert from 'node:assert/strict';
import { pictureBottom, textTop } from '../src/ui-layout.js';

const box = { top: 0, width: 1280, height: 900 };

test('the picture bottom follows the vertical object-position of a letterboxed video', () => {
  assert.equal(pictureBottom(box, 1280, 720, 50), 810);          // 90 px bands above and below
  assert.equal(pictureBottom(box, 1280, 720, 0), 720);           // picture at the top
  assert.equal(pictureBottom(box, 1280, 720, 100), 900);         // picture at the bottom
  assert.equal(pictureBottom({ top: 40, width: 1280, height: 720 }, 1280, 720, 50), 760);   // no band: the box edge
});

const base = { lowest: 896, gap: 12, oneLineEach: 72 };

test('text goes under the picture when a line of each fits in the band', () => {
  assert.equal(textTop({ ...base, pictureBottom: 810, height: 72 }), 822);
});

test('text stays just inside the picture when the band is too thin', () => {
  assert.equal(textTop({ ...base, pictureBottom: 830, height: 72 }), 830 - 12 - 72);
});

test('the choice depends on one line each, not on the current cue, so a long cue does not jump into the picture', () => {
  const short = textTop({ ...base, pictureBottom: 810, height: 72 });
  const long = textTop({ ...base, pictureBottom: 810, height: 110 });
  assert.equal(short, 822);
  assert.equal(long, 896 - 110);                                  // still in the band, pushed up only as far as the window needs
  assert.ok(long < short);
});

test('the block never leaves the window', () => {
  assert.equal(textTop({ ...base, pictureBottom: 40, height: 72 }), 40 + 12);
  assert.equal(textTop({ ...base, pictureBottom: 60, lowest: 100, height: 200 }), 0);   // taller than the window: pinned to the top
});

import { textSides, barHeight, layoutRule, TEXT_SIDE, MIN_TEXT_W, BAR_MIN, PANEL_W } from '../src/ui-layout.js';

test('text on the video keeps its side margins, and on a narrow window the margins give way before the text does', () => {
  assert.deepEqual(textSides(1920, 0), { left: TEXT_SIDE, right: TEXT_SIDE });
  assert.deepEqual(textSides(1920, PANEL_W), { left: TEXT_SIDE, right: PANEL_W + TEXT_SIDE });
  const narrow = textSides(MIN_TEXT_W + 40 + PANEL_W, PANEL_W);                       // 20 px of margin left on each side
  assert.deepEqual(narrow, { left: 20, right: PANEL_W + 20 });
  const tiny = textSides(PANEL_W + 100, PANEL_W);                                     // narrower than the text: no margins, never negative
  assert.deepEqual(tiny, { left: 0, right: PANEL_W });
});

test('the bar fits the reserved lines, and never gets too short for two rows of buttons', () => {
  const p = { mainLines: 2, mainFont: 28, subLines: 2, subFont: 22, lineGap: 4 };
  assert.equal(barHeight(p), Math.round(2 * 28 * 1.35 + 2 * 22 * 1.35 + 4 + 24));
  assert.equal(barHeight({ mainLines: 1, mainFont: 12, subLines: 1, subFont: 12, lineGap: 0 }), BAR_MIN);
});

test('with only the second line shown, the bar keeps no room for the main line or the gap between them', () => {
  const p = { mainLines: 2, mainFont: 28, subLines: 3, subFont: 40, lineGap: 10 };
  assert.equal(barHeight({ ...p, hideMain: true }), Math.round(3 * 40 * 1.35 + 24));
  assert.equal(barHeight(p), Math.round(2 * 28 * 1.35 + 10 + 3 * 40 * 1.35 + 24));
});

test('the layout rule shrinks the player boxes, only lifts the controls, and aligns the picture', () => {
  const rule = layoutRule({ player: ['.box'], osd: ['.osd'] }, { bar: 120, panel: 340, align: 0 });
  assert.match(rule, /\.box\{bottom:120px !important;right:340px !important;height:auto !important;width:auto !important;\}/);
  assert.match(rule, /\.osd\{bottom:120px !important;right:340px !important;\}/);
  assert.match(rule, /\.box video\{object-position:50% 0% !important;\}/);
  assert.equal(layoutRule({ player: [], osd: [] }, { bar: 0, panel: 0, align: 50 }), '');
});

test('in fullscreen a site that names an inner box gets that box shrunk instead (the fullscreen element cannot be)', () => {
  const layout = { player: ['.outer'], fullscreen: ['.inner'], osd: [] };
  const fs = layoutRule(layout, { bar: 0, panel: 340, align: 50, fullscreen: true });
  assert.match(fs, /^\.inner\{position:absolute !important;top:0 !important;left:0 !important;bottom:0px !important;right:340px !important;/);
  assert.ok(!fs.includes('.outer'));
  assert.match(layoutRule(layout, { bar: 0, panel: 340, align: 50, fullscreen: false }), /^\.outer\{bottom/);
  assert.match(layoutRule({ player: ['.page'], osd: [] }, { bar: 0, panel: 340, align: 50, fullscreen: true }), /^\.page\{bottom/);   // whole-page fullscreen
});
