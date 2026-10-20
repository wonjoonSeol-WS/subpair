// Drawing one subtitle line as words that can be clicked (and colored by part of speech when an analyzer is loaded).
import { LINE_H } from './ui-layout.js';

const MIN_SHRINK = 0.7;              // a line that does not fit its room shrinks down to this share of its font size

// Plain word splitting for a language, until (or unless) a better splitter is registered. One Intl.Segmenter per language.
const segmenters = new Map();
function plainSegmenter(lang) {
  if (!segmenters.has(lang)) {
    let s = null;
    try { if (typeof Intl !== 'undefined' && Intl.Segmenter) s = new Intl.Segmenter(lang || undefined, { granularity: 'word' }); } catch { s = null; }  // a bad tag: split on spaces
    segmenters.set(lang, s);
  }
  return segmenters.get(lang);
}

export function segmentWords(text, lang) {
  const s = plainSegmenter(lang);
  if (s) return [...s.segment(text)].map((x) => ({ text: x.segment, word: !!x.isWordLike }));
  return text.split(/(\s+)/).filter(Boolean).map((part) => ({ text: part, word: /\S/.test(part) }));
}

// Fills line `el` (whose first child is the text span) with `text`. In the bar each line keeps `lines` lines of room so
// nothing jumps; on the video a line is only as tall as its text, up to that room. A line that still does not fit shrinks.
//   segment: the language's own splitter (text => [{ text, word, cat?, base? }]) or null for plain splitting
export function renderLine(el, text, { lang, fontPx, lines, onVideo, segment }) {
  const inner = el.firstElementChild;
  inner.textContent = '';
  const room = `${Math.round(lines * fontPx * LINE_H)}px`;
  el.style.height = onVideo ? '' : room;
  el.style.maxHeight = onVideo ? room : '';
  inner.style.fontSize = `${fontPx}px`;
  if (lang) inner.lang = lang; else inner.removeAttribute('lang');        // CJK glyph forms, and what screen readers speak
  if (!text) return;
  for (const seg of segment ? segment(text) : segmentWords(text, lang)) {
    if (seg.word) {
      const w = document.createElement('span');
      w.className = seg.cat ? `subpair-w subpair-c-${seg.cat}` : 'subpair-w';
      w.textContent = seg.text;
      if (seg.base && seg.base !== seg.text) w.dataset.base = seg.base;
      inner.appendChild(w);
    } else {
      inner.appendChild(document.createTextNode(seg.text));
    }
  }
  const overflows = () => el.scrollHeight > el.clientHeight + 1;
  if (!overflows()) return;
  let lo = Math.ceil(fontPx * MIN_SHRINK), hi = fontPx - 1;      // the largest size that fits, found in a few reflows
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    inner.style.fontSize = `${mid}px`;
    if (overflows()) hi = mid - 1; else lo = mid;
  }
  inner.style.fontSize = `${lo}px`;
}
