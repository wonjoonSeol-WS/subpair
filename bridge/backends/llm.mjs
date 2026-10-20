// What the LLM backends (claude -p, Anthropic API, OpenAI-compatible) share: the prompt, the id-keyed JSON reply and its
// validation. Every cue must come back exactly once and non-empty, blank lines inside a translation collapse, and special
// punctuation never reaches the model (see MASKS).
import { langLabel } from '../../src/lang.js';

// Em dash, katakana middle dot, middle dot. Some models restyle these characters, so they are swapped for placeholders
// and restored afterwards.
export const MASKS = [['\u2014', '{{EMDASH}}'], ['\u30fb', '{{MIDDOT}}'], ['\u00b7', '{{DOT}}']];

export const mask = (text) => MASKS.reduce((t, [sym, token]) => t.split(sym).join(token), text);
export const unmask = (text) => MASKS.reduce((t, [sym, token]) => t.split(token).join(sym), text);

const count = (text, token) => text.split(token).length - 1;

// A reply that cannot be used (wrong ids, empty text, lost placeholder, not JSON). Only these are worth another attempt;
// a transport, auth or refusal error is thrown as is and fails the chunk at once.
export class ValidationError extends Error {}

// pair: { from, to } language codes (ISO 639-1), e.g. { from: 'ja', to: 'ko' }.
export function systemPrompt({ from, to }) {
  const [f, t] = [langLabel(from), langLabel(to)];
  return [
    `You translate subtitles from ${f} to ${t} for a language learner. Produce a LITERAL translation that stays as close`,
    `as ${t} grammar allows to the source wording, word order and sentence structure. Do not paraphrase, localize,`,
    'smooth, summarize, explain or add anything. Keep politeness and honorific markers where the target language has an',
    'equivalent. Each cue is its own line: never merge, split, reorder or drop cues, and return exactly one translation',
    'per id. Use context_before only to understand the story; do not translate it. Spell proper names the same way every',
    'time. If a cue is only a sound effect or symbol, translate or copy it as is. Keep line breaks inside a cue where the',
    `source has them. Placeholders such as ${MASKS.map(([, token]) => token).join(', ')} stand for special punctuation:`,
    'copy every placeholder unchanged to the same place in the translation.',
    'Reply with ONLY a JSON object {"translations":[{"id":0,"text":"..."}]}, one entry per id you were given.',
  ].join(' ');
}

// chunk: [{ id, text }] with text already masked; before: earlier source lines, read-only context.
export function buildUser(chunk, before = []) {
  return JSON.stringify({ context_before: before.map((text) => ({ text: mask(text) })), translate: chunk });
}

// Models sometimes quote the ids ("3" for 3); anything else that is not a whole number is no id at all.
const idOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

// Checks a model reply against the chunk that was sent and returns the final texts in chunk order.
// Throws on anything that is not exactly one non-empty translation per id with every placeholder intact.
export function parseTranslations(reply, chunk) {
  const s = String(reply);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new ValidationError('no JSON object in reply');
  let list;
  try { list = JSON.parse(s.slice(a, b + 1)).translations; } catch (e) { throw new ValidationError(`reply is not valid JSON: ${e.message}`); }
  if (!Array.isArray(list)) throw new ValidationError('reply has no translations array');
  const got = new Map();
  for (const t of list) {
    const id = idOf(t && t.id);
    if (got.has(id)) throw new ValidationError(`cue ${id} came back twice`);
    got.set(id, t && t.text);
  }
  const missing = chunk.filter((c) => !got.has(c.id)).map((c) => c.id);
  const extra = [...got.keys()].filter((id) => !chunk.some((c) => c.id === id));
  if (missing.length || extra.length) {
    throw new ValidationError(`id mismatch: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(extra)}`);
  }
  return chunk.map((c) => {
    const text = got.get(c.id);
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError(`empty translation for cue ${c.id}`);
    for (const [, token] of MASKS) {
      if (count(c.text, token) !== count(text, token)) throw new ValidationError(`placeholder ${token} not preserved in cue ${c.id}`);
    }
    return unmask(text).replace(/[\r\n]{2,}/g, '\n').trim();
  });
}

// Translates `texts` (non-empty strings) with one or more calls to `ask(system, user) -> reply text`; `before` is the source
// lines preceding the first text. A chunk that fails validation is tried `attempts` times, then split in half so one stubborn
// cue cannot sink the rest. A single cue (or a part at the split depth limit) that still fails comes back as '' for each of
// its cues; the caller neither caches nor saves those.
export async function translateChunk(ask, texts, before, pair, { attempts, context, splitDepth }) {
  const system = systemPrompt(pair);
  const run = async (lo, hi, depth) => {
    const chunk = texts.slice(lo, hi).map((text, i) => ({ id: lo + i, text: mask(text) }));
    const ctx = context > 0 ? [...before, ...texts.slice(0, lo)].slice(-context) : [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return parseTranslations(await ask(system, buildUser(chunk, ctx)), chunk);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
      }
    }
    if (hi - lo === 1 || depth >= splitDepth) return Array(hi - lo).fill('');
    const mid = (lo + hi) >> 1;
    return [...(await run(lo, mid, depth + 1)), ...(await run(mid, hi, depth + 1))];
  };
  return run(0, texts.length, 0);
}
