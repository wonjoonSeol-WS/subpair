// Minimal TTML / IMSC parser for Netflix subtitle files. Returns cues sorted by start time: { start, end, text } in seconds.
// No DOMParser, so it also runs in Node tests. Handles what Netflix sends: tick times ("129712916t"), <br/>, nested
// <span>s and ruby (furigana): the reading and its fallback delimiters are dropped and only the base characters are kept.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// Ruby roles whose content is not shown with the base text (TTML2 10.2.35: delimiters generate no areas in ruby presentation).
const HIDDEN_RUBY = new Set(['text', 'textContainer', 'delimiter']);

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;      // anything else is left as written
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

// "129712916t" (ticks), "12.5s", "00:00:12.500", "00:00:12:15" (frames are ignored).
function parseTime(v, tickRate) {
  if (!v) return NaN;
  let m = /^(\d+(?:\.\d+)?)t$/.exec(v);
  if (m) return Number(m[1]) / tickRate;
  m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(v);
  if (m) return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  m = /^(\d+):(\d+):(\d+(?:[.,]\d+)?)/.exec(v);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3].replace(',', '.'));
  return NaN;
}

// An element's interval inside its parent's (TTML2 12.2.4: children of the default par container are timed relative to it).
// With both end and dur the earlier end wins (12.2.2); with neither, the element lasts as long as its parent.
function interval(a, parent, tickRate) {
  const begin = parseTime(a.begin, tickRate), end = parseTime(a.end, tickRate), dur = parseTime(a.dur, tickRate);
  const start = parent.start + (Number.isFinite(begin) ? begin : 0);
  const ends = [Number.isFinite(end) ? parent.start + end : Infinity, Number.isFinite(dur) ? start + dur : Infinity];
  const stop = Math.min(...ends);
  return { start, end: Number.isFinite(stop) ? stop : parent.end };
}

// The text of one <p>: <br/> is a line break, ruby readings are dropped.
function paragraphText(body, roles) {
  let text = '', hidden = 0;
  const stack = [];                                   // per open <span>: did it start a hidden ruby region?
  for (const tm of body.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (tm[5] !== undefined) {                        // text node
      if (!hidden) text += decode(tm[5]).replace(/[ \t\r\n]+/g, ' ');
      continue;
    }
    const [, closing, name, rest, selfClosing] = tm;
    const local = name.replace(/^.*:/, '');
    if (local === 'br') { if (!hidden && !closing) text += '\n'; continue; }
    if (local !== 'span') continue;
    if (closing) {
      if (stack.pop()) hidden--;
    } else if (!selfClosing) {
      const sa = attrs(rest);
      const role = sa['tts:ruby'] || String(sa.style || '').split(/\s+/).map((id) => roles.get(id)).find(Boolean);   // style="a b" names two styles
      const hide = HIDDEN_RUBY.has(role);
      stack.push(hide);
      if (hide) hidden++;
    }
  }
  return text.replace(/ *\n */g, '\n').replace(/^\s+|\s+$/g, '');
}

export function parseTtml(xml) {
  xml = String(xml);
  const tickRate = Number((/ttp:tickRate\s*=\s*["'](\d+)["']/.exec(xml) || [])[1]) || 10000000;

  // style id -> ruby role (container | base | text | delimiter ...)
  const roles = new Map();
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?style\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a['xml:id'] && a['tts:ruby']) roles.set(a['xml:id'], a['tts:ruby']);
  }

  const cues = [];
  const seen = new Set();
  const timed = [{ start: 0, end: Infinity }];          // open <body> / <div> intervals, outermost first
  // Elements may carry a namespace prefix (<tt:p>). A self-closed <p/> has no body and must not run on to the next </p>.
  const TAG = /<(\/?)((?:[\w.-]+:)?)(body|div|p)\b([^>]*?)(\/?)>/g;
  for (let m; (m = TAG.exec(xml));) {
    const [, closing, prefix, local, rest, selfClosing] = m;
    if (local !== 'p') {
      if (closing) { if (timed.length > 1) timed.pop(); } else if (!selfClosing) timed.push(interval(attrs(rest), timed[timed.length - 1], tickRate));
      continue;
    }
    if (closing || selfClosing) continue;
    const close = xml.indexOf(`</${prefix}p>`, TAG.lastIndex);
    if (close < 0) break;
    const body = xml.slice(TAG.lastIndex, close);
    TAG.lastIndex = close + prefix.length + 4;
    const a = attrs(rest);
    if (['begin', 'end', 'dur'].some((k) => a[k] !== undefined && !Number.isFinite(parseTime(a[k], tickRate)))) continue;   // a time it cannot read
    const { start, end } = interval(a, timed[timed.length - 1], tickRate);
    if (!Number.isFinite(end)) continue;                                         // never ends: an untimed paragraph
    const text = paragraphText(body, roles);
    if (!text) continue;
    const key = `${start}|${end}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start || x.end - y.end);
}
