import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTtml } from '../src/ttml.js';

const wrap = (body, head = '') => `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000"><head><styling>
<style xml:id="s0" tts:rubyReserve="outside"/><style xml:id="rc" tts:ruby="container"/><style xml:id="rb" tts:ruby="base"/>
<style xml:id="rt" tts:ruby="text" tts:rubyAlign="center"/>${head}</styling></head><body><div>${body}</div></body></tt>`;

test('tick times become seconds', () => {
  const cues = parseTtml(wrap('<p xml:id="a" begin="129712916t" end="159742916t">abc</p>'));
  assert.equal(cues.length, 1);
  assert.ok(Math.abs(cues[0].start - 12.9712916) < 1e-9);
  assert.ok(Math.abs(cues[0].end - 15.9742916) < 1e-9);
});

test('other time forms: seconds, clock, a different tickRate', () => {
  const cues = parseTtml(wrap('<p begin="1.5s" end="00:00:03.250">a</p><p begin="500ms" end="2s">b</p>'));
  assert.deepEqual(cues.map((c) => [c.start, c.end, c.text]), [[0.5, 2, 'b'], [1.5, 3.25, 'a']]);
  const slow = parseTtml('<tt xmlns:ttp="x" ttp:tickRate="1000"><body><p begin="2500t" end="3000t">x</p></body></tt>');
  assert.deepEqual([slow[0].start, slow[0].end], [2.5, 3]);
});

test('<br/> becomes a newline and entities are decoded', () => {
  const [c] = parseTtml(wrap('<p begin="0t" end="10000000t">a &amp; b<br/>c &lt;d&gt; &#x3042;</p>'));
  assert.equal(c.text, 'a & b\nc <d> あ');
});

test('ruby: the reading is dropped, the base text is kept, by style id', () => {
  const body = '<p begin="0t" end="10000000t">x<span style="rc"><span style="rb">BASE1</span><span style="rt">read1</span></span>y' +
    '<span style="rc"><span style="rb">BASE2</span><span style="rt">read2</span></span>z</p>';
  assert.equal(parseTtml(wrap(body))[0].text, 'xBASE1yBASE2z');
});

test('ruby by inline attribute, and non-ruby spans keep their text', () => {
  const body = '<p begin="0t" end="10000000t"><span tts:ruby="container"><span tts:ruby="base">B</span><span tts:ruby="text">r</span></span>' +
    '<span style="plain">kept</span></p>';
  assert.equal(parseTtml(wrap(body))[0].text, 'Bkept');
});

test('cues are sorted, empty cues and exact duplicates are dropped, bad times skipped', () => {
  const body = '<p begin="20000000t" end="30000000t">second</p><p begin="0t" end="10000000t">first</p>' +
    '<p begin="0t" end="10000000t">first</p><p begin="40000000t" end="50000000t"> </p><p begin="oops" end="1s">bad</p>';
  assert.deepEqual(parseTtml(wrap(body)).map((c) => c.text), ['first', 'second']);
});

test('indented source does not leak whitespace into the text', () => {
  const body = '<p begin="0t" end="10000000t">\n    line one<br/>\n    line two\n  </p>';
  assert.equal(parseTtml(wrap(body))[0].text, 'line one\nline two');
});

test('a self-closed <p/> does not swallow the paragraph after it', () => {
  const cues = parseTtml(wrap('<p begin="0t" end="10000000t"/><p begin="20000000t" end="30000000t">kept</p>'));
  assert.deepEqual(cues.map((c) => c.text), ['kept']);
});

test('a numeric entity outside Unicode is left as written instead of aborting the parse', () => {
  const [c] = parseTtml(wrap('<p begin="0t" end="10000000t">a &#x110000; b &#99999999999; c</p>'));
  assert.equal(c.text, 'a &#x110000; b &#99999999999; c');
});

test('a style attribute naming several styles still finds the ruby role', () => {
  const body = '<p begin="0t" end="10000000t"><span style="plain rc"><span style="x rb">BASE</span><span style="rt other">read</span></span></p>';
  assert.equal(parseTtml(wrap(body))[0].text, 'BASE');
});

test('tickRate in single quotes, and elements with a namespace prefix (<tt:p>, <tt:span>, <tt:br/>, <tt:style>)', () => {
  const xml = `<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" ttp:tickRate='1000'><tt:head><tt:styling><tt:style xml:id="r" tts:ruby="text"/></tt:styling></tt:head>` +
    '<tt:body><tt:div><tt:p begin="2500t" end="3000t">a<tt:br/>b<tt:span style="r">reading</tt:span></tt:p></tt:div></tt:body></tt:tt>';
  assert.deepEqual(parseTtml(xml), [{ start: 2.5, end: 3, text: 'a\nb' }]);
});

test('&nbsp; and &#160; are the same character', () => {
  const [c] = parseTtml(wrap('<p begin="0t" end="10000000t">a&nbsp;b&#160;c</p>'));
  assert.equal(c.text, 'a b c');
});

test('ruby fallback delimiters are dropped with the reading', () => {
  const body = '<p begin="0t" end="10000000t"><span tts:ruby="container"><span tts:ruby="base">漢字</span><span tts:ruby="delimiter">(</span>' +
    '<span tts:ruby="text">かんじ</span><span tts:ruby="delimiter">)</span></span>です</p>';
  assert.equal(parseTtml(wrap(body))[0].text, '漢字です');
});

test('dur: the end is begin + dur, and with both end and dur the earlier one wins', () => {
  const cues = parseTtml(wrap('<p begin="1s" dur="2s">dur only</p><p begin="10s" end="20s" dur="3s">dur earlier</p><p begin="30s" end="31s" dur="5s">end earlier</p>'));
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [[1, 3], [10, 13], [30, 31]]);
});

test('times inside a timed <div> are relative to its begin; an untimed <p> there takes the div\'s interval', () => {
  const xml = '<tt><body begin="100s"><div begin="10s" end="15s"><p begin="1s" end="2s">inner</p><p>whole div</p></div>' +
    '<div><p begin="0s" end="1s">body only</p></div></body></tt>';
  assert.deepEqual(parseTtml(xml).map((c) => [c.start, c.end, c.text]), [[100, 101, 'body only'], [110, 115, 'whole div'], [111, 112, 'inner']]);
});

test('a paragraph with a time it cannot read, or no end at all, is skipped', () => {
  const cues = parseTtml(wrap('<p begin="1s" end="2s" dur="oops">bad dur</p><p begin="3s">no end</p><p begin="4s" end="5s">ok</p>'));
  assert.deepEqual(cues.map((c) => c.text), ['ok']);
});
