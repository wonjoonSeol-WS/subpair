// Disk store. Layout under storeDir:
//   subs/<key>.<from>-<to>.<cacheId>.srt   finished translation of a title (timings copied from the source cues)
//   subs/<key>.json                        { title, entries: { "<from>-<to>.<cacheId>": { file, from, to, backend, model,
//                                            numbering, count, sourceHash, cues, savedAt } } }
//     numbering "source": each SRT number is the cue's position in the source cues, which were count cues with texts
//     fingerprinted by sourceHash (src/hash.js). Older files have none of these and are numbered 1, 2, 3.
//   lines.<from>-<to>.<cacheId>.jsonl      append-only cache of translated lines: {"s": source, "t": translation}
// cacheId is the backend name, plus the model when it is not the shipped default (backends/index.mjs cacheIdFor).
// The line cache is keyed by the exact source text, so a changed prompt does not refresh old lines: delete the lines file
// to translate them again. Titles saved before the source language and model were recorded are read as defaultFrom and the
// backend's shipped model.
import fs from 'node:fs';
import path from 'node:path';
import { toSrt } from '../src/srt.js';

export const KEY_MAX = 80;
export const TITLE_MAX = 200;
export const FILE_RE = /^[A-Za-z0-9_-]{1,80}(\.[a-z0-9-]{1,100}){2,3}\.srt$/;
const BACKEND_RE = /^[a-z0-9-]{1,32}$/;
const CACHE_RE = /^[a-z0-9-]{1,100}$/;
const LANG_RE = /^[a-z]{2,3}$/;
const OLD_ID_RE = /^[a-z]{2,3}\.[a-z0-9-]+$/;          // "<to>.<backend>", before the source language was in the name
// A cache file with this many more records than distinct lines (or with broken lines) is rewritten when it is loaded.
const COMPACT_SLACK = 1000;
const RENAME_TRIES = 5, RENAME_WAIT_MS = 50;

const safeKey = (k) => String(k).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, KEY_MAX);
// toSrt numbers cues 1, 2, 3; a saved title numbers each cue by its position in the source cues (c.number), so a cue left
// out leaves a gap instead of moving the ones after it.
const numberedSrt = (cues) => cues.map((c) => toSrt([c]).replace(/^1\n/, `${c.number}\n`)).join('\n');
const pairName = ({ from, to }) => {
  if (!LANG_RE.test(from) || !LANG_RE.test(to)) throw new Error(`bad language pair ${from}-${to}`);
  return `${from}-${to}`;
};
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows refuses a rename for a moment while a virus scanner or the search indexer has the file open.
function renameSync(from, to) {
  for (let i = 1; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= RENAME_TRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      pauseSync(RENAME_WAIT_MS * i);
    }
  }
}

// A crash half way through a write must not leave a torn file: write beside it, then rename over it.
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, file);
}

// The store used to live in bridge/store. When the new folder does not exist yet, the old one is moved there once.
// -> the folder to use: the new one, or the old one when it could not be moved (nothing is lost either way).
export function migrateLegacyStore(legacyDir, dir, log = console.log) {
  if (fs.existsSync(dir) || !fs.existsSync(legacyDir) || !fs.readdirSync(legacyDir).length) return dir;
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try { fs.renameSync(legacyDir, dir); } catch (e) {
      if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const partial = `${dir}.partial`;                                 // another drive or a locked folder: copy, then switch over
      fs.rmSync(partial, { recursive: true, force: true });
      fs.cpSync(legacyDir, partial, { recursive: true });
      fs.renameSync(partial, dir);
      try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch (err) { log(`bridge: copied, but could not remove ${legacyDir}: ${err.message}`); }
    }
  } catch (e) {
    log(`bridge: could not move saved translations from ${legacyDir} to ${dir} (${e.message}); using ${legacyDir}`);
    return legacyDir;
  }
  log(`bridge: moved saved translations from ${legacyDir} to ${dir}`);
  return dir;
}

export class Store {
  // shippedModels: backend -> its default model in config.defaults.json, the model of titles saved without one.
  constructor(dir, { defaultFrom = 'ja', shippedModels = {} } = {}) {
    this.dir = dir;
    this.subs = path.join(dir, 'subs');
    this.defaultFrom = defaultFrom;
    this.shippedModels = shippedModels;
    fs.mkdirSync(this.subs, { recursive: true });
    this.lines = new Map();            // cache file -> { map: Map(source -> translation), tornTail: bool }
  }

  #metaPath(key) { return path.join(this.subs, `${safeKey(key)}.json`); }

  // -> { meta, damaged }. meta is null when nothing is saved or the file cannot be read as metadata. Entries saved under
  // older names are returned under the current ones, with their source language and model filled in.
  #readMeta(key) {
    const file = this.#metaPath(key);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') console.error(`store: cannot read ${file}: ${e.message}`);
      return { meta: null, damaged: false };
    }
    let m;
    try { m = JSON.parse(text); } catch { m = null; }
    if (!m || typeof m !== 'object' || !m.entries || typeof m.entries !== 'object') {
      console.error(`store: ${file} is damaged; it is set aside the next time this title is saved`);
      return { meta: null, damaged: true };
    }
    const entries = {};
    for (const [id, e] of Object.entries(m.entries)) {
      if (!e || typeof e.file !== 'string' || !LANG_RE.test(e.to) || !BACKEND_RE.test(e.backend)) continue;
      const from = LANG_RE.test(e.from) ? e.from : this.defaultFrom;
      const model = typeof e.model === 'string' ? e.model : this.shippedModels[e.backend] || '';
      entries[OLD_ID_RE.test(id) ? `${from}-${id}` : id] = { ...e, from, model };
    }
    return { meta: { ...m, entries }, damaged: false };
  }

  meta(key) { return this.#readMeta(key).meta; }

  // The saved entry for a title, target language and backend; `from` and `model` narrow it down. When several are left, the
  // default source language and then `preferModel` win, then the newest.
  entry(key, { from, to, backend, model }, preferModel) {
    const all = Object.values((this.meta(key) || { entries: {} }).entries)
      .filter((e) => e.to === to && e.backend === backend && (!from || e.from === from) && (!model || e.model === model));
    const score = (e) => (e.from === this.defaultFrom ? 2 : 0) + (e.model === preferModel ? 1 : 0);
    return all.sort((a, b) => score(b) - score(a) || String(b.savedAt).localeCompare(String(a.savedAt)))[0] || null;
  }

  #read(file) {
    const full = path.join(this.subs, path.basename(file));          // a name from disk never leaves the subs folder
    try { return fs.readFileSync(full, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') console.error(`store: cannot read ${full}: ${err.message}`);
      return null;
    }
  }

  loadSubtitle(key, want, preferModel) {
    const e = this.entry(key, want, preferModel);
    return e ? this.#read(e.file) : null;
  }

  // A saved file by name, only when the title's metadata lists it.
  loadFile(key, file) {
    if (!FILE_RE.test(file)) return null;
    const listed = Object.values((this.meta(key) || { entries: {} }).entries).some((e) => e.file === file);
    return listed ? this.#read(file) : null;
  }

  // cues: [{number, start, end, text}] translated from pair.from into pair.to by `backend` with `model` (cache name cacheId);
  // number is the cue's 1-based position in the source cues. source: { count, sourceHash } of those source cues.
  saveSubtitle(key, title, pair, { backend, model = '', cacheId = backend }, cues, { count, sourceHash } = {}) {
    if (!BACKEND_RE.test(backend)) throw new Error(`bad backend name ${backend}`);
    if (!CACHE_RE.test(cacheId)) throw new Error(`bad cache name ${cacheId}`);
    if (!cues.every((c, i) => Number.isInteger(c.number) && c.number >= 1 && (i === 0 || c.number > cues[i - 1].number))) {
      throw new Error('cue numbers must be increasing whole numbers from 1');
    }
    const id = `${pairName(pair)}.${cacheId}`;
    fs.mkdirSync(this.subs, { recursive: true });
    const file = `${safeKey(key)}.${id}.srt`;
    writeAtomic(path.join(this.subs, file), numberedSrt(cues));
    const { meta: old, damaged } = this.#readMeta(key);
    if (damaged) {
      const aside = `${this.#metaPath(key)}.corrupt-${Date.now()}`;
      renameSync(this.#metaPath(key), aside);                              // kept for a person to look at, never overwritten
      console.error(`store: damaged ${this.#metaPath(key)} moved to ${aside}`);
    }
    const meta = old || { title: '', entries: {} };
    if (title) meta.title = String(title).slice(0, TITLE_MAX);
    meta.entries[id] = { file, from: pair.from, to: pair.to, backend, model, numbering: 'source', count, sourceHash, cues: cues.length, savedAt: new Date().toISOString() };
    writeAtomic(this.#metaPath(key), JSON.stringify(meta, null, 2));
    return meta.entries[id];
  }

  #lineFile(pair, cacheId) {
    if (!CACHE_RE.test(cacheId)) throw new Error(`bad cache name ${cacheId}`);
    return path.join(this.dir, `lines.${pairName(pair)}.${cacheId}.jsonl`);
  }

  #cache(pair, cacheId) {
    const file = this.#lineFile(pair, cacheId);
    let c = this.lines.get(file);
    if (c) return c;
    c = { map: new Map(), tornTail: false };
    let records = 0, broken = 0, text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') console.error(`store: cannot read ${file}: ${e.message}`);
    }
    for (const l of text.split('\n')) {
      if (!l) continue;
      try { const o = JSON.parse(l); c.map.set(o.s, o.t); records++; } catch { broken++; }
    }
    c.tornTail = text.length > 0 && !text.endsWith('\n');            // the last write was cut off
    if (broken || records - c.map.size > COMPACT_SLACK) {
      try {
        writeAtomic(file, [...c.map].map(([s, t]) => JSON.stringify({ s, t }) + '\n').join(''));
        c.tornTail = false;
      } catch (e) { console.error(`store: cannot rewrite ${file}: ${e.message}`); }
    }
    this.lines.set(file, c);
    return c;
  }

  getLine(pair, cacheId, source) { return this.#cache(pair, cacheId).map.get(source); }

  // A new translation of a line already cached replaces it (the file keeps both; the last one wins when it is read).
  putLines(pair, cacheId, entries) {
    const c = this.#cache(pair, cacheId);
    const out = [];
    for (const [s, t] of entries) {
      if (!t || c.map.get(s) === t) continue;
      c.map.set(s, t);
      out.push(JSON.stringify({ s, t }));
    }
    if (!out.length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    // After a cut-off last line, start on a fresh line so the first new record is not glued onto the broken one.
    fs.appendFileSync(this.#lineFile(pair, cacheId), (c.tornTail ? '\n' : '') + out.join('\n') + '\n', 'utf8');
    c.tornTail = false;
  }
}
