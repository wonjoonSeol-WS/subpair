// The part of starting a playback session that is the same on every site, written once. A site adapter (src/jellyfin.js,
// src/netflix.js) lists its subtitle tracks in the common shape and fetches one; this decides what the two lines will be:
//   main line   the first profile language that has a track
//   second line a real track in the first wanted language (one that fails to load counts as missing); else machine
//               translation of the main line by the bridge; if the bridge cannot do it, the next wanted language that has
//               a track (for example English); else nothing
import { pickTrack } from './tracks.js';
import { normLang } from './lang.js';
import { cleanText } from './text.js';
import { createTranslator, wantsTranslation } from './translate.js';
import { callBridge } from './bridge.js';
import { wantedSub } from './profile.js';

// Cue text cleaned per the profile (line breaks joined, speaker names dropped), the same for every line Subpair shows.
export const tidy = (cues, lang, profile) =>
  cues.map((c) => ({ ...c, text: cleanText(c.text, { lang, joinLines: profile.joinLines, hideSpeaker: profile.hideSpeaker }) }));

// The translator for the second line, or { note } saying why there is none (bridge not running, wrong language pair, backend
// not set up). The second line's cues share the main cues' timing; only their text is filled in.
async function prepareTranslation({ key, title, profile, mainCues, mainLang, to, fresh, getTime, log, makeTranslator }) {
  const subCues = mainCues.map((c) => ({ start: c.start, end: c.end, text: '' }));
  let sink = null;
  const translator = makeTranslator({
    call: (path, body) => callBridge(profile.translate.bridge, path, body),
    key, title, from: mainLang, to, fresh,
    backend: profile.translate.backend, models: profile.translate.models, mode: profile.translate.mode,
    cues: mainCues, subCues, getTime,
    onStatus: (s, meta) => { log(s, meta); if (sink) sink(s, meta); },
  });
  const ready = await translator.prepare();
  if (!ready.ok) { log('translation unavailable:', ready.reason); return { note: ready.reason }; }
  return { translator, subCues, setStatusSink: (fn) => { sink = fn; } };      // progress goes to the UI once the UI exists
}

// -> null when there is nothing to show (no track in the main language, or it has no cues), else
//    { mainCues, subCues, mainLang, subLang, subKind: 'track' | 'translated' | 'off', trackLangs, hasWantedTrack, translator,
//      setStatusSink, note, site }   (`site` is what the adapter's open() returned: key, title, tracks, fetchCues)
// wishes(key) -> { preferTranslation, fresh } for this title: preferTranslation translates the main line even when the video
// has a track in the wanted language (a bad or out-of-sync file); fresh translates the whole title again instead of
// using a saved translation.
export async function loadSession({ adapter, itemId, hint, profile, wishes = async () => ({}), getTime = () => 0, log = () => {}, makeTranslator = createTranslator }) {
  const site = await adapter.open(itemId, hint);
  const { preferTranslation = false, fresh = false } = await wishes(site.key);
  const trackLangs = [...new Set(site.tracks.map((t) => normLang(t.lang)).filter(Boolean))];

  const mainTrack = pickTrack(site.tracks, profile.main);
  if (!mainTrack) { log(`no ${adapter.name} subtitle track for ${profile.main.join(',')} (available: ${trackLangs.join(',') || 'none'})`); return null; }
  const mainLang = normLang(mainTrack.lang) || normLang(profile.main[0]);
  const wanted = wantedSub(profile);
  const first = wanted ? pickTrack(site.tracks, [wanted], mainTrack.id) : null;

  const load = (track, lang) => site.fetchCues(track).then((cues) => tidy(cues, lang, profile));
  // A second track is optional: if only it fails to load, the main line still shows.
  const optional = (track, lang) => load(track, lang).catch((e) => { log('sub track failed to load', e); return []; });
  const [mainCues, firstCues] = await Promise.all([load(mainTrack, mainLang), first ? optional(first, normLang(first.lang) || wanted) : null]);
  if (!mainCues.length) { log(`${adapter.name}: the ${mainLang} track has no cues`); return null; }

  const usable = first && firstCues.length ? first : null;           // a wanted track that loaded and has cues
  const useTrack = usable && !preferTranslation && !fresh;
  let subTrack = useTrack ? usable : null, subCues = useTrack ? firstCues : [], translation = null, note = '';
  if (wantsTranslation(profile, mainLang, !!useTrack)) {
    const t = await prepareTranslation({ key: site.key, title: site.title, profile, mainCues, mainLang, to: wanted, fresh, getTime, log, makeTranslator });
    if (t.translator) { translation = t; subCues = t.subCues; } else note = t.note;
  }
  if (!subTrack && !translation) {
    if (usable) { subTrack = usable; subCues = firstCues; }          // translation was asked for instead but cannot start
    else {
      const others = first ? site.tracks.filter((t) => t.id !== first.id) : site.tracks;      // never the one that just failed
      subTrack = pickTrack(others, profile.sub, mainTrack.id);
      if (subTrack) subCues = await optional(subTrack, normLang(subTrack.lang) || wanted);
      if (!subCues.length) subTrack = null;
    }
  }

  const subKind = translation ? 'translated' : subTrack ? 'track' : 'off';
  const subLang = (subTrack && normLang(subTrack.lang)) || wanted;
  const subText = subKind === 'track' ? `${subTrack.lang} track` : subKind === 'translated' ? `translated ${wanted}` : 'none';
  log(`${adapter.name} main: ${mainTrack.lang} (${mainCues.length} cues), sub: ${subText}`);
  return {
    mainCues, subCues, mainLang, subLang, subKind, trackLangs, note, site,
    hasWantedTrack: !!usable, preferTranslation,
    translator: translation ? translation.translator : null,
    setStatusSink: translation ? translation.setStatusSink : () => {},
  };
}
