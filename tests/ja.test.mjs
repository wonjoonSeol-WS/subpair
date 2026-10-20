import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chunkTokens } from '../src/ja.js';

const require = createRequire(import.meta.url);
const DICT = fileURLToPath(new URL('../node_modules/kuromoji/dict/', import.meta.url));      // wherever this is run from
const kuromoji = require('kuromoji');
let tok;

before(() => new Promise((resolve, reject) => {
  kuromoji.builder({ dicPath: DICT }).build((err, t) => (err ? reject(err) : (tok = t, resolve())));
}));

const words = (s) => chunkTokens(tok.tokenize(s)).filter((c) => c.word).map((c) => c.text);
const cats = (s) => Object.fromEntries(chunkTokens(tok.tokenize(s)).filter((c) => c.word).map((c) => [c.text, c.cat]));

test('conjugated verbs and adjectives stay in one piece', () => {
  assert.deepEqual(words('食べたかった'), ['食べたかった']);
  assert.deepEqual(words('見ている'), ['見ている']);
  assert.deepEqual(words('走っていた'), ['走っていた']);
  assert.deepEqual(words('美味しくなかった'), ['美味しくなかった']);
  assert.deepEqual(words('国民よ 顔を上げてくれ！'), ['国民', 'よ', '顔', 'を', '上げてくれ']);
});

test('te-form joins its verb (with or without a helper); conditional ba joins', () => {
  assert.deepEqual(words('返してほしい'), ['返してほしい']);
  assert.deepEqual(words('行かなければ'), ['行かなければ']);
  assert.deepEqual(words('人質だからと言ってこちらを'), ['人質', 'だ', 'から', 'と', '言って', 'こちら', 'を']);
  assert.deepEqual(words('雨で帰る'), ['雨', 'で', '帰る']);       // case particle で after a noun stays separate
});

test('particles stay separate', () => {
  assert.deepEqual(words('その安定を乱す魔王が'), ['その', '安定', 'を', '乱す', '魔王', 'が']);
});

test('noun suffixes attach, plain noun compounds do not', () => {
  assert.deepEqual(words('勇者様 魔王軍は'), ['勇者様', '魔王軍', 'は']);
  assert.deepEqual(words('魔王 タソガレ'), ['魔王', 'タソガレ']);
});

test('categories for coloring', () => {
  const c = cats('強大な魔王を倒す');
  assert.equal(c['魔王'], 'noun');
  assert.equal(c['を'], 'particle');
  assert.equal(c['倒す'], 'verb');
  assert.equal(cats('美味しくなかった')['美味しくなかった'], 'adj');
  assert.equal(cats('必ず来る')['必ず'], 'adv');
});

test('dictionary form: verbs/adjectives only', () => {
  const by = Object.fromEntries(chunkTokens(tok.tokenize('勇者様が食べたかった')).filter((c) => c.word).map((c) => [c.text, c.base]));
  assert.equal(by['食べたかった'], '食べる');
  assert.equal(by['勇者様'], '勇者様');           // not 勇者
});

test('punctuation and spaces are not words', () => {
  const chunks = chunkTokens(tok.tokenize('魔族よ！ 逃げろ…'));
  assert.ok(chunks.some((c) => !c.word));
  assert.ok(chunks.filter((c) => !c.word).every((c) => /^[\s！…]+$/.test(c.text)));
});
