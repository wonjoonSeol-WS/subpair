// The three UI languages stay in step: the same keys everywhere, the same $n values in every translation, and every key the
// code asks for exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../src/i18n.js';
import { ERRORS } from '../bridge/errors.mjs';
import { bridgeMessage } from '../src/bridge.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['en', 'ko', 'ja'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(root, '_locales', l, 'messages.json'), 'utf8'))]));
const dollars = (s) => [...s.matchAll(/\$(\d)/g)].map((m) => m[1]).sort().join(',');

test('every language has exactly the keys English has, with valid names and the same $1, $2 values', () => {
  const keys = Object.keys(messages.en).sort();
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(messages[l]).sort(), keys, `${l} keys`);
    for (const [k, v] of Object.entries(messages[l])) {
      assert.match(k, /^[A-Za-z0-9_]+$/, `${l}: ${k}`);
      assert.equal(typeof v.message, 'string', `${l}: ${k}`);
      assert.ok(v.message.length > 0, `${l}: ${k} is empty`);
      assert.doesNotMatch(v.message, /\$(?!\d)/, `${l}: ${k} has a $ that is not $1..$9`);
      assert.equal(dollars(v.message), dollars(messages.en[k].message), `${l}: ${k} values`);
      assert.doesNotMatch(v.message, /[—·]/, `${l}: ${k} uses an em dash or middle dot`);
    }
  }
});

test('every message the code asks for exists, and every message is used somewhere', () => {
  const files = ['background.js', 'options.js', 'options.html', 'manifest.json', 'manifest.firefox.json',
    ...fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`)];
  const used = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
    for (const m of text.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/msg\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
  }
  for (const k of used) assert.ok(messages.en[k], `missing message ${k}`);
  const unused = Object.keys(messages.en).filter((k) => !used.has(k) && !k.startsWith('bridgeErr_'));
  assert.deepEqual(unused, []);
});

test('every bridge error code has a message, and every bridgeErr_ message is a code the bridge sends', () => {
  const keys = Object.keys(messages.en).filter((k) => k.startsWith('bridgeErr_')).map((k) => k.slice('bridgeErr_'.length)).sort();
  assert.deepEqual(keys, Object.keys(ERRORS).sort());
});

test('a bridge error is shown from its code, and from its own text when this version does not know the code', () => {
  assert.equal(bridgeMessage({ error: 'x', code: 'too_many_jobs', params: ['8'] }), '8 titles are already being translated, try again later');
  assert.equal(bridgeMessage({ error: 'something new', code: 'brand_new_code', params: [] }), 'something new');
  assert.equal(bridgeMessage({ error: 'plain' }), 'plain');
  assert.equal(bridgeMessage(null), '');
});

test('outside the browser t() reads the English file, fills in $1.., and names a missing key', () => {
  assert.equal(t('trProgress', 3, 10), 'Translating 3/10');
  assert.equal(t('withKeys', 'Previous line', 'A'), 'Previous line (A)');
  assert.equal(t('noSuchKey'), 'noSuchKey');
});
