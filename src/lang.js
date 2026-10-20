// Language codes: Jellyfin reports ISO 639-2 ("jpn", "kor"), files use 639-1 ("ja", "ko"). Normalise both to 639-1.
// Each row: the 639-1 code, then its ISO 639-2/T code, then other aliases (639-2/B, older or common codes).
import { uiLanguage } from './i18n.js';

const TABLE = [
  ['en', 'eng'], ['ja', 'jpn', 'jp'], ['ko', 'kor'], ['zh', 'zho', 'chi', 'cmn'],
  ['es', 'spa'], ['fr', 'fra', 'fre'], ['de', 'deu', 'ger'], ['it', 'ita'], ['pt', 'por'],
  ['ru', 'rus'], ['vi', 'vie'], ['th', 'tha'], ['id', 'ind'], ['ar', 'ara'], ['hi', 'hin'],
  ['tr', 'tur'], ['pl', 'pol'], ['nl', 'nld', 'dut'], ['sv', 'swe'], ['uk', 'ukr'],
  ['he', 'heb', 'iw'], ['ms', 'msa', 'may'], ['fa', 'fas', 'per'],
];

const MAP = new Map();
for (const [code, ...aliases] of TABLE) {
  MAP.set(code, code);
  for (const a of aliases) MAP.set(a, code);
}

export const LANGUAGES = TABLE.map(([code]) => code);

// Language names in the UI's own language (English outside the browser, which is what the bridge's prompts need).
const NAMES = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([uiLanguage(), 'en'], { type: 'language' }) : null;

// "ja" -> "Japanese". Anything the browser cannot name is shown as its code.
export function langLabel(code) {
  try { return (NAMES && NAMES.of(code)) || String(code); } catch { return String(code); }
}

export function normLang(tag) {
  if (!tag) return '';
  const t = String(tag).toLowerCase().split(/[-_]/)[0];
  return MAP.get(t) || t;
}

// "ja" or "jpn" -> "jpn" (ISO 639-2/T, what Jellyfin's own client sends); '' for a language not in the table.
export const iso6392 = (tag) => (TABLE.find(([code]) => code === normLang(tag)) || [])[1] || '';
