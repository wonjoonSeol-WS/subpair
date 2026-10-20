import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanText } from '../src/text.js';

const cue = '（魔王タソガレ）\n姫が一時 脱走したと\nいうのは本当か？';

test('joinLines: Japanese joins without spaces, other languages with a space', () => {
  assert.equal(cleanText(cue, { lang: 'ja', joinLines: true }), '（魔王タソガレ）姫が一時 脱走したというのは本当か？');
  assert.equal(cleanText('Hello\nworld', { lang: 'en', joinLines: true }), 'Hello world');
  assert.equal(cleanText('소리가\n전혀 달라', { lang: 'ko', joinLines: true }), '소리가 전혀 달라');
});

test('without joinLines the original line breaks stay (blank lines dropped)', () => {
  assert.equal(cleanText('a\n\nb', { lang: 'en' }), 'a\nb');
});

test('hideSpeaker removes a leading tag only when text follows it', () => {
  assert.equal(cleanText(cue, { lang: 'ja', joinLines: true, hideSpeaker: true }), '姫が一時 脱走したというのは本当か？');
  assert.equal(cleanText('(Alice) Hi there', { lang: 'en', hideSpeaker: true }), 'Hi there');
  assert.equal(cleanText('（破く音）', { lang: 'ja', hideSpeaker: true }), '（破く音）');   // a pure sound effect is kept
  assert.equal(cleanText('先に（笑い）行く', { lang: 'ja', hideSpeaker: true }), '先に（笑い）行く'); // only at the start of a line
});

test('defaults change nothing but trimming', () => {
  assert.equal(cleanText(' a \n b '), 'a\nb');
});
