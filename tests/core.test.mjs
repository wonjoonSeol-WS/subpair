import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normLang, iso6392, LANGUAGES } from '../src/lang.js';
import { parseSrt, toSrt } from '../src/srt.js';
import { pickTrack } from '../src/tracks.js';
import { textTracks } from '../src/jellyfin.js';
import { Timeline, AutoPause } from '../src/timeline.js';

test('normLang maps 639-2 and 639-1 to the same code', () => {
  assert.equal(normLang('jpn'), 'ja');
  assert.equal(normLang('JA'), 'ja');
  assert.equal(normLang('kor'), 'ko');
  assert.equal(normLang('ko-KR'), 'ko');
  assert.equal(normLang('fre'), 'fr');
  assert.equal(normLang(''), '');
  assert.equal(normLang('xyz'), 'xyz');
});

test('parseSrt: times, tags, duplicates, BOM, ordering', () => {
  const srt = '﻿1\n00:00:01,500 --> 00:00:03,000\n<i>Hello</i> {\\an8}there\n\n' +
    '2\n00:00:01,500 --> 00:00:03,000\n<i>Hello</i> {\\an8}there\n\n' +
    '3\n00:01:00,000 --> 00:01:02,250\nlate\n\n' +
    '4\n00:00:10,000 --> 00:00:11,000\nline one\nline two\n\n' +
    '5\n00:00:20,000 --> 00:00:21,000\n{\\blur3}\n';
  const cues = parseSrt(srt);
  assert.equal(cues.length, 3);                       // dup removed, empty-after-strip removed
  assert.deepEqual(cues[0], { start: 1.5, end: 3, text: 'Hello there' });
  assert.equal(cues[1].text, 'line one\nline two');   // line break kept
  assert.equal(cues[2].start, 60);                    // sorted by start
});

test('normLang: Cantonese stays apart from Chinese, "kr" (Kanuri) is not Korean, old Hebrew "iw" is Hebrew', () => {
  assert.equal(normLang('yue'), 'yue');
  assert.equal(normLang('zh-HK'), 'zh');
  assert.equal(normLang('cmn'), 'zh');
  assert.equal(normLang('kr'), 'kr');
  assert.equal(normLang('iw'), 'he');
  assert.equal(normLang('per'), 'fa');
  assert.equal(normLang('may'), 'ms');
});

test('iso6392 gives the ISO 639-2/T code from any alias; unknown languages give nothing', () => {
  assert.equal(iso6392('ja'), 'jpn');
  assert.equal(iso6392('fre'), 'fra');                // a 639-2/B alias still gives the /T code
  assert.equal(iso6392('ger'), 'deu');
  assert.equal(iso6392('ko-KR'), 'kor');
  assert.equal(iso6392('xx'), '');
  assert.equal(iso6392(''), '');
  for (const code of LANGUAGES) assert.match(iso6392(code), /^[a-z]{3}$/, code);
});

test('parseSrt keeps text that only looks like markup; strips ASS overrides and SRT/WebVTT tags', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n{laughs} a < b > c\n\n2\n00:00:03,000 --> 00:00:04,000\n{\\i1}<b>bold</b> <font color="red">red</font>\n';
  assert.deepEqual(parseSrt(srt).map((c) => c.text), ['{laughs} a < b > c', 'bold red']);
  const vtt = 'WEBVTT\n\nNOTE not a cue\n\nintro\n00:01.000 --> 00:02.000 align:start\n<v Bob>Hi</v> <c.yellow>there</c> <00:01.500>now\n\n' +
    '00:03.000 --> 00:04.000\n<ruby>漢字<rt>かんじ</rt></ruby>\n';
  assert.deepEqual(parseSrt(vtt).map((c) => c.text), ['Hi there now', '漢字']);
});

test('parseSrt: a blank line inside a cue, and a cue that runs into the next number, keep their text', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nline one\n\nline two\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond\n3\n00:00:05,000 --> 00:00:06,000\nthird\n\n4\n\n';
  assert.deepEqual(parseSrt(srt).map((c) => [c.start, c.text]), [[1, 'line one\nline two'], [3, 'second'], [5, 'third']]);
});

test('parseSrt: exact duplicates are shown once, wherever they are; exact keeps every cue with its number', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nsame\n\n2\n00:00:05,000 --> 00:00:06,000\nother\n\n7\n00:00:01,000 --> 00:00:02,000\nsame\n';
  assert.deepEqual(parseSrt(srt).map((c) => c.text), ['same', 'other']);
  assert.deepEqual(parseSrt(srt, { exact: true }).map((c) => [c.n, c.text]), [[1, 'same'], [7, 'same'], [2, 'other']]);
});

test('toSrt keeps a cue\'s own number and numbers the rest by position; parseSrt reads it back', () => {
  const srt = toSrt([{ start: 1, end: 2, text: 'a', n: 7 }, { start: 3, end: 4, text: 'b' }, { start: 5, end: 6, text: 'c', n: 0 }]);
  assert.deepEqual(parseSrt(srt, { exact: true }).map((c) => [c.n, c.start, c.text]), [[7, 1, 'a'], [2, 3, 'b'], [3, 5, 'c']]);
});

test('parseSrt handles CRLF and WebVTT short timestamps', () => {
  const vtt = 'WEBVTT\r\n\r\n00:05.000 --> 00:07.500\r\nHi\r\n\r\n';
  const cues = parseSrt(vtt);
  assert.deepEqual(cues, [{ start: 5, end: 7.5, text: 'Hi' }]);
});

// The same Jellyfin streams as before, now through the adapter's normalisation into the common track shape.
const streams = [
  { Index: 2, Type: 'Subtitle', Language: 'jpn', Codec: 'ass', IsForced: false, Title: 'Signs & Songs' },
  { Index: 3, Type: 'Subtitle', Language: 'jpn', Codec: 'subrip', IsForced: false, Title: 'Full' },
  { Index: 4, Type: 'Subtitle', Language: 'eng', Codec: 'subrip', IsForced: false },
  { Index: 5, Type: 'Subtitle', Language: 'kor', Codec: 'hdmv_pgs_subtitle', IsTextSubtitleStream: false },
  { Index: 6, Type: 'Subtitle', Language: 'eng', Codec: 'subrip', IsForced: true },
  { Index: 1, Type: 'Audio', Language: 'jpn' },
];
const tracks = textTracks(streams);

test('pickTrack prefers full over signs, skips image tracks, honours fallback order', () => {
  assert.equal(pickTrack(tracks, ['ja']).id, 3);
  assert.equal(pickTrack(tracks, ['en']).id, 4);              // not the forced one
  assert.equal(pickTrack(tracks, ['ko', 'en']).id, 4);        // ko is image-only -> falls back to en
  assert.equal(pickTrack(tracks, ['ko']), null);
  assert.equal(pickTrack(tracks, ['ja'], 3).id, 2);           // exclude main track
});

const cues = [
  { start: 10, end: 12, text: 'a' },
  { start: 14, end: 16, text: 'b' },
  { start: 16, end: 18, text: 'c' },
];
const tl = new Timeline(cues);

test('Timeline navigation', () => {
  assert.equal(tl.activeIndex(11), 0);
  assert.equal(tl.activeIndex(13), -1);
  assert.equal(tl.currentIndex(13), 0);                 // gap after a
  assert.equal(tl.repeatTarget(11), 10);
  assert.equal(tl.repeatTarget(13), 10);                // gap -> repeat the one just heard
  assert.equal(tl.repeatTarget(5), null);
  assert.equal(tl.nextTarget(11), 14);
  assert.equal(tl.nextTarget(14), 16);                  // standing on b -> next is c, not b again
  assert.equal(tl.nextTarget(17), null);
  assert.equal(tl.prevTarget(15), 10);                  // inside b -> a
  assert.equal(tl.prevTarget(13), 10);                  // gap after a -> a itself
  assert.equal(tl.prevTarget(11), null);                // first cue has no previous
});

test('overlapping cues: all are active, the earliest-started one is primary', () => {
  const o = new Timeline([
    { start: 10, end: 14, text: 'dialogue' },
    { start: 12, end: 13, text: 'sign' },
    { start: 12, end: 15, text: 'other speaker' },
  ]);
  assert.deepEqual(o.activeIndices(12.5), [0, 1, 2]);
  assert.equal(o.activeIndex(12.5), 0);                 // dialogue stays primary while the sign is on screen
  assert.deepEqual(o.activeIndices(13.5), [0, 2]);
  assert.equal(o.activeIndex(14.5), 2);
  const ap = new AutoPause();
  assert.equal(ap.shouldPause(o, 12.95), false);        // sign ends at 13 but the dialogue (primary) has not
  assert.equal(ap.shouldPause(o, 13.95), true);         // pauses at the end of the dialogue
});

test('AutoPause pauses once per cue and re-arms after reset', () => {
  const ap = new AutoPause();
  assert.equal(ap.shouldPause(tl, 11.0), false);        // early in cue
  assert.equal(ap.shouldPause(tl, 11.95), true);        // near end of a
  assert.equal(ap.shouldPause(tl, 11.96), false);       // already paused for a
  assert.equal(ap.shouldPause(tl, 15.95), true);        // end of b
  ap.reset();                                           // user hit repeat
  assert.equal(ap.shouldPause(tl, 15.95), true);
  assert.equal(ap.shouldPause(tl, 13.0), false);        // gap: never pauses
});

test('activeIndices finds the same cues as a full scan, including a long cue that started far back', () => {
  const scan = (cues, t) => cues.map((c, i) => (c.start <= t && t < c.end ? i : -1)).filter((i) => i >= 0);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const cues = [{ start: 1, end: 500, text: 'song title on screen the whole time' }];
  for (let s = 2; s < 400; s += rnd() * 4) cues.push({ start: s, end: s + 0.5 + rnd() * 6, text: 'x' });
  cues.sort((a, b) => a.start - b.start);
  const timeline = new Timeline(cues);
  for (let t = 0; t < 520; t += 0.37) assert.deepEqual(timeline.activeIndices(t), scan(cues, t), `t=${t}`);
  assert.deepEqual(timeline.activeIndices(450), [0]);                       // only the long cue is still on screen
  assert.deepEqual(new Timeline([]).activeIndices(3), []);
});
