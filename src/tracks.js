import { normLang } from './lang.js';

// Best track for the first language in `langs` that has one, or null. `tracks` are in the common shape every site adapter
// produces: { id, lang, label, forced, extra, rank, raw }
//   extra  signs / songs / commentary tracks (never preferred over a full one)
//   rank   the site's own tie-break among otherwise equal tracks (text format, default flag...)
//   raw    the site's original object, for fetching it
// `excludeId` is a track not to pick (the main line's).
export function pickTrack(tracks, langs, excludeId = null) {
  const usable = (tracks || []).filter((t) => t.id !== excludeId);
  for (const lang of langs) {
    const wanted = normLang(lang);
    const cands = usable.filter((t) => normLang(t.lang) === wanted);
    if (!cands.length) continue;
    const score = (t) => (t.forced ? 0 : 8) + (t.extra ? 0 : 4) + (t.rank || 0);
    return cands.sort((a, b) => score(b) - score(a))[0];
  }
  return null;
}
