// The logic behind the quick settings menu (the gear), without any DOM so tests can reach it. The menu works like
// Jellyfin's own player menu: rows that open a list with a check mark on the current choice.
import { LANGUAGES, normLang, langLabel } from './lang.js';
import { LIMITS } from './profile.js';
import { BACKENDS, AUTO, backendName } from './backends.js';
import { t } from './i18n.js';

export const OFFSET_STEP = 0.1;                 // seconds per press of the timing buttons
export const OFFSET_MAX = 60;                   // and the furthest a line can be shifted either way
export const FONT_STEP = 2;                     // px per press of the size buttons
export const GAP_STEP = 4;                      // px per press of the space-from-the-picture buttons
export const LINE_GAP_STEP = 2;                 // px per press of the space-between-lines buttons

const unique = (codes) => [...new Set(codes.map((c) => normLang(c)).filter(Boolean))];
const named = (code) => (code ? langLabel(code) : t('none'));

// Languages offered for the main line: those the video has a real subtitle track in (the main line is never translated).
// A selected language the video lacks stays in the list, marked, so the menu never shows a choice that is not there.
export function mainChoices(trackLangs, current) {
  const have = unique(trackLangs);
  const codes = current && !have.includes(current) ? [current, ...have] : have;
  return codes.map((code) => ({ code, label: langLabel(code), note: have.includes(code) ? '' : t('noTrackInVideo') }));
}

// Languages offered for the second line: off, then languages with a real track, then (when translating is allowed) every
// other language it can be translated into. The main line's language is left out: a copy of it is no help.
export function subChoices(trackLangs, current, mainLang, canTranslate) {
  const have = unique(trackLangs).filter((c) => c !== mainLang);
  const out = [{ code: '', label: t('off'), note: '' }];
  for (const code of have) out.push({ code, label: langLabel(code), note: '' });
  if (canTranslate) {
    for (const code of LANGUAGES) if (code !== mainLang && !have.includes(code)) out.push({ code, label: langLabel(code), note: t('translated') });
  }
  if (current && !out.some((c) => c.code === current)) out.splice(1, 0, { code: current, label: langLabel(current), note: canTranslate ? t('translated') : t('noTrackInVideo') });
  return out;
}

// The profile fields that change when `code` is chosen for a role: it goes first, the rest stay as fallbacks.
// For the second line '' means off, which is an empty list.
export function languagePatch(profile, role, code) {
  const rest = (profile[role] || []).filter((c) => normLang(c) !== code);
  if (role === 'sub' && !code) return { sub: [] };
  return { [role]: [code, ...rest] };
}

// The second line as the menu describes it. What the settings ask for can differ from what is on screen (a translation
// that could not start): then it says so, instead of showing "Off" as if that had been chosen.
//   s: { wantedSub, subLang, subKind: 'track' | 'translated' | 'off' }
export function secondLine(s) {
  const missing = !!s.wantedSub && (s.subKind === 'off' || s.subLang !== s.wantedSub);
  const value = missing
    ? (s.subKind === 'off' ? t('langNotAvailable', named(s.wantedSub)) : t('langInsteadOf', named(s.subLang), named(s.wantedSub)))
    : s.subLang ? (s.subKind === 'translated' ? t('langTranslated', named(s.subLang)) : named(s.subLang)) : t('off');
  return { missing, value, checked: missing ? s.wantedSub : s.subLang };      // the check mark follows what is asked for
}

export function stepOffset(current, delta) {
  const next = Math.round((current + delta) * 10) / 10;
  return Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, next));
}

export function formatOffset(seconds) {
  const s = Math.abs(seconds).toFixed(1);
  return t('seconds', seconds > 0 ? `+${s}` : seconds < 0 ? `-${s}` : '0.0');
}

export function stepFont(current, delta) {
  return Math.max(LIMITS.font[0], Math.min(LIMITS.font[1], current + delta));
}

export function stepGap(current, delta, [lo, hi] = LIMITS.gap) {
  return Math.max(lo, Math.min(hi, current + delta));
}

// The translator list: Automatic, each translator, Off.
export const TRANSLATOR_CHOICES = [[AUTO, t('automaticFirstReady')], ...BACKENDS.map((b) => [b.id, b.name]), ['off', t('off')]];
// When to translate. "Whole title" starts the job for this video at once.
export const MODE_CHOICES = [['auto', t('modeAuto')], ['live', t('modeLive')], ['process', t('modeProcess')]];

// Short text for the translator row: what produces the second line and, while it works, how far it is.
//   status: the translator's own report (src/translate.js status()) or null when there is none
export function translatorSummary(kind, backendChoice, mode, status) {
  if (kind === 'track') return t('subtitleTrack');
  if (mode === 'off') return t('off');
  if (!status) return backendName(backendChoice);
  const name = backendName(status.backend);
  if (status.phase === 'job') return status.total ? t('summaryWholeProgress', name, status.done, status.total) : t('summaryWhole', name);
  if (status.phase === 'saved') return t('summarySaved', name);
  if (status.phase === 'failed') return t('summaryFailed', name);
  return t('summaryLive', name);
}

export const PLACEMENT_CHOICES = [['overlay', t('placeOverlay')], ['bar', t('placeBar')]];
export const ALIGN_CHOICES = [['center', t('alignCenter')], ['top', t('alignTop')], ['bottom', t('alignBottom')]];
export const BACKGROUND_CHOICES = [['none', t('bgNone')], ['translucent', t('bgTranslucent')], ['solid', t('bgSolid')]];
export const choiceLabel = (choices, value) => (choices.find(([v]) => v === value) || [value, ''])[1];

export function placementSummary(placement, gap) {
  return placement === 'bar' ? t('placeSummaryBar') : t('placeSummaryOverlay', gap);
}
