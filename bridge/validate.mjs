// Turns request bodies and URL parts into checked values, or throws a 400 that says what is wrong.
import { normLang } from '../src/lang.js';
import { BridgeError } from './errors.mjs';
import { KEY_MAX, TITLE_MAX } from './store.mjs';

const KEY_RE = new RegExp(`^[A-Za-z0-9_-]{1,${KEY_MAX}}$`);   // a title id: Netflix digits, or "jf-" plus a Jellyfin item id
const LANG_RE = /^[a-z]{2,3}$/;
const BACKEND_RE = /^[a-z0-9-]{1,32}$/;
const MODEL_RE = /^[\w.:/-]{1,100}$/;
const CLIENT_MAX = 64;

const bad = (code, ...params) => { throw new BridgeError(400, code, ...params); };
const absent = (v) => v === undefined || v === null || v === '';
const isSeconds = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function createValidators(cfg, backends) {
  const L = cfg.limits;

  const lang = (v, what) => {
    const code = typeof v === 'string' ? normLang(v) : '';
    if (!LANG_RE.test(code)) bad('bad_language', what);
    return code;
  };

  // `to` is always named by the caller; a missing `from` is the configured source language.
  const pairOf = (from, to) => {
    if (absent(to)) bad('to_required');
    return { from: absent(from) ? cfg.from : lang(from, 'from'), to: lang(to, 'to') };
  };
  const backendOf = (name) => {
    if (typeof name !== 'string' || !Object.hasOwn(backends, name)) bad('unknown_backend');
    return name;
  };
  const backendNameOf = (name) => {
    if (!BACKEND_RE.test(name)) bad('bad_backend_name');
    return name;
  };
  // A model named by the request (used instead of the configured one), or undefined.
  const modelOf = (v) => {
    if (absent(v)) return undefined;
    if (typeof v !== 'string' || !MODEL_RE.test(v)) bad('bad_model');
    return v;
  };
  const keyOf = (v) => {
    if (typeof v !== 'string' || !KEY_RE.test(v)) bad('bad_key', KEY_MAX);
    return v;
  };
  const strings = (v, what, max) => {
    if (!Array.isArray(v) || v.length > max || v.some((t) => typeof t !== 'string' || t.length > L.maxText)) {
      bad('bad_texts', what, max, L.maxText);
    }
    return v;
  };
  const cuesOf = (v) => {
    if (!Array.isArray(v) || !v.length || v.length > L.maxCues) bad('bad_cues', L.maxCues);
    return v.map((c) => {
      if (!c || typeof c.text !== 'string' || c.text.length > L.maxText || !isSeconds(c.start) || !isSeconds(c.end) || c.end < c.start) {
        bad('bad_cue');
      }
      return { start: c.start, end: c.end, text: c.text };
    });
  };
  const clientOf = (v) => (typeof v === 'string' && v ? v.slice(0, CLIENT_MAX) : 'anon');

  return {
    keyOf, clientOf,
    lineRequest: (b) => ({
      backend: backendOf(b.backend),
      model: modelOf(b.model),
      texts: strings(b.texts, 'texts', L.maxLines),
      context: b.context === undefined ? [] : strings(b.context, 'context', L.maxContext),
      pair: pairOf(b.from, b.to),
      client: clientOf(b.client),
      gen: Number.isFinite(b.gen) ? b.gen : null,
    }),
    jobRequest: (b) => ({
      key: keyOf(b.key),
      backend: backendOf(b.backend),
      model: modelOf(b.model),
      pair: pairOf(b.from, b.to),
      cues: cuesOf(b.cues),
      title: typeof b.title === 'string' ? b.title.slice(0, TITLE_MAX) : '',
      fresh: b.fresh === true,
    }),
    // GET /jobs/:key and its cancel: from, backend and model default like a new job's (no backend: the latest job).
    jobLookup: (q) => ({
      ...pairOf(q.get('from'), q.get('to')),
      backend: absent(q.get('backend')) ? undefined : backendOf(q.get('backend')),
      model: modelOf(q.get('model')),
    }),
    // GET /subs/:key/:to/:backend: from and model narrow the saved entries down when given.
    subsLookup: (to, backend, q) => ({
      to: lang(to, 'to'),
      backend: backendNameOf(backend),
      from: absent(q.get('from')) ? undefined : lang(q.get('from'), 'from'),
      model: modelOf(q.get('model')),
    }),
  };
}
