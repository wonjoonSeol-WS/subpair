// Minimal SRT/WebVTT parser. Returns cues sorted by start time: { start, end, text } in seconds.
// A timing line with or without hours, on its own or after a cue number / WebVTT cue id.
const TIMING = /((?:\d+:)?\d+:\d+[,.]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[,.]\d+)/;
// Markup that is not text: ASS override blocks ({\an8}, {\i1}), the tags SRT and WebVTT use, and WebVTT timestamp tags.
const MARKUP = /\{\\[^}]*\}|<\/?(?:i|b|u|s|font|c|v|lang|ruby|span)(?:[\s.][^>]*)?>|<\d+:\d+(?::\d+)?[.,]\d+>/gi;
const NOT_CUE_TEXT = /^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/;   // WebVTT header and comment / style / region blocks

function seconds(stamp) {
  const parts = stamp.replace(',', '.').split(':');
  const [h, m, s] = parts.length === 3 ? parts : ['0', ...parts];
  const [whole, frac = ''] = s.split('.');
  return Number(h) * 3600 + Number(m) * 60 + Number(whole) + Number(frac.padEnd(3, '0').slice(0, 3)) / 1000;
}

const clean = (lines) => lines.join('\n')
  .replace(/<rt>[\s\S]*?<\/rt>/gi, '')            // WebVTT ruby readings: the base text is kept
  .replace(MARKUP, '')
  .replace(/\\N/g, '\n')
  .replace(/\\h/g, ' ')
  .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

// exact: every cue as written, with its number (n) when the file numbers it; by default exact duplicates (same times and text,
// as ASS layers converted to SRT produce) are shown once.
export function parseSrt(text, { exact = false } = {}) {
  const raw = [];
  for (const block of String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    // Text before a block's first timing line continues the previous cue: a blank line inside a cue's text splits it in two.
    let cue = NOT_CUE_TEXT.test(lines[0]) || /^\d+$/.test(block.trim()) ? null : raw[raw.length - 1] || null;
    lines.forEach((line, i) => {
      const m = TIMING.exec(line);
      if (!m) { if (cue) cue.lines.push(line); return; }
      // The line before a timing line is its cue number, or a WebVTT cue id when it opens the block; otherwise it is text.
      const id = i > 0 ? lines[i - 1].trim() : '';
      const isId = i > 0 && (/^\d+$/.test(id) || i === 1);
      if (isId && cue && cue.lines[cue.lines.length - 1] === lines[i - 1]) cue.lines.pop();
      cue = { start: seconds(m[1]), end: seconds(m[2]), n: isId && /^\d+$/.test(id) ? Number(id) : null, lines: [] };
      raw.push(cue);
    });
  }
  const cues = [];
  const seen = new Set();
  for (const r of raw.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const body = clean(r.lines);
    if (!body) continue;
    if (exact) { cues.push({ start: r.start, end: r.end, text: body, n: r.n }); continue; }
    const key = `${r.start}|${r.end}|${body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cues.push({ start: r.start, end: r.end, text: body });
  }
  return cues;
}

const stamp = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
};

// Inverse of parseSrt: cues -> SRT text. A cue's own number (n, a positive integer) is kept, so a reader can match cues by it.
export function toSrt(cues) {
  return cues.map((c, i) => `${Number.isInteger(c.n) && c.n > 0 ? c.n : i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}
