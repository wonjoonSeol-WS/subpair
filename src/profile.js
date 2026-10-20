// Profile shape, defaults and validation. Pure (no chrome.* calls) so it can be tested in Node.
import { AUTO, BACKEND_IDS, MODEL_RE } from './backends.js';
import { normLang } from './lang.js';

// The arrow keys and S are left free: Netflix and Jellyfin use them to seek, change the volume and skip intros.
export const DEFAULT_KEYS = {
  prev: ['a'],
  repeat: ['r'],
  next: ['d'],
  autopause: ['q'],
};

export const DEFAULT_COLORS = {
  noun: '#8ec5ff', verb: '#ffb86c', adj: '#b5e48c', adv: '#f6a6c8', particle: '#8b93a1',
};

export const LIMITS = { font: [12, 72], lines: [1, 4], gap: [0, 200], lineGap: [0, 60] };
export const LINE_STEP = 0.5;                      // reserved lines may be halves (2.5)
export const PICTURE_ALIGNS = ['top', 'center', 'bottom'];
export const TEXT_PLACEMENTS = ['overlay', 'bar'];   // on the video (no bar), or in a bottom bar with the panel
export const BACKGROUNDS = ['none', 'translucent', 'solid'];   // behind text on the video: plain outlined text, dark, or black
// auto: each translator's own way (`mode` in src/backends.js); live: a few lines ahead; process: the whole title first.
export const TRANSLATE_MODES = ['auto', 'live', 'process', 'off'];
export const MAX_PROFILES = 20;
export const DEFAULT_BRIDGE = 'http://127.0.0.1:8765';
// The bridge is local; never let a hand-edited or imported profile send subtitles to another host.
export const isBridgeUrl = (u) => typeof u === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(u);

// A new profile has no languages: the options page asks for them on first run.
export function newProfile(id, name, main = [], sub = []) {
  return {
    id, name, main, sub,
    autoPause: false,
    panel: true,
    colorize: true,                // color words by part of speech (needs an analyzer: Japanese for now)
    colors: { ...DEFAULT_COLORS },
    pictureAlign: 'center',          // where the picture sits in its box (letterboxed): the video itself does not move
    textPlacement: 'overlay',      // 'overlay': on the video, no bar; 'bar': centered in a bottom bar
    subtitleBackground: 'none',    // what sits behind text on the video (the bar has its own look)
    subtitleGap: 12,               // px between the bottom edge of the picture and the subtitles (on the video)
    lineGap: 4,                    // px between the main and the sub line
    panelTimes: true,              // small timestamps in the transcript panel
    joinLines: true,               // show a cue's line breaks as one line (the bar wraps it to the available width)
    // When a title has no track in the first sub language, the main line is translated by the local bridge. models: the model
    // each translator uses ('' = the bridge's configured default).
    translate: { backend: AUTO, mode: 'auto', bridge: DEFAULT_BRIDGE, models: { claude: '', api: '', openai: '' } },
    hideSpeaker: false,            // drop leading speaker tags such as （田中） or (Alice)
    hideMain: false,               // show only the second line on the video (for viewers who only want their own language)
    mainFont: 28, subFont: 22,     // px at scale 1
    mainLines: 2, subLines: 2,     // lines of room reserved in the bar
    keys: structuredClone(DEFAULT_KEYS),
  };
}

const clamp = (v, [lo, hi], fallback, step = 1) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n / step) * step)) : fallback;
};

// Accepts an array or a comma-separated string; returns a clean list of non-empty strings.
export const listOf = (v, fallback) => {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!items) return fallback;
  return items.map((x) => String(x).trim()).filter(Boolean);
};
const list = listOf;

// A key as a profile stores it: a single character in lower case, Space and Comma by name (a key list is comma-separated
// and trimmed, so ' ' and ',' cannot be written as themselves), any other key by its KeyboardEvent.key name.
export const keyToken = (key) => (key === ' ' ? 'Space' : key === ',' ? 'Comma' : key.length === 1 ? key.toLowerCase() : key);

export const newProfileId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Turns anything (stored, imported or hand-edited) into a complete, valid profile.
export function sanitizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  const id = typeof p.id === 'string' && p.id ? p.id : newProfileId();
  const base = newProfile(id, typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Profile');
  const keys = {};
  for (const act of Object.keys(DEFAULT_KEYS)) keys[act] = list(p.keys && p.keys[act], DEFAULT_KEYS[act]).map(keyToken);
  const colors = {};
  for (const cat of Object.keys(DEFAULT_COLORS)) {
    const c = p.colors && p.colors[cat];
    colors[cat] = typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT_COLORS[cat];
  }
  const tr = p.translate && typeof p.translate === 'object' ? p.translate : {};
  const bridge = typeof tr.bridge === 'string' ? tr.bridge.trim().replace(/\/+$/, '') : '';
  const models = {};
  for (const [backend, fallback] of Object.entries(base.translate.models)) {
    const m = tr.models && typeof tr.models[backend] === 'string' ? tr.models[backend].trim() : '';
    models[backend] = MODEL_RE.test(m) ? m : fallback;
  }
  return {
    ...base,
    translate: {
      backend: tr.backend === AUTO || BACKEND_IDS.includes(tr.backend) ? tr.backend : base.translate.backend,
      mode: TRANSLATE_MODES.includes(tr.mode) ? tr.mode : base.translate.mode,
      bridge: isBridgeUrl(bridge) ? bridge : base.translate.bridge,
      models,
    },
    main: list(p.main, base.main),
    sub: list(p.sub, base.sub),
    autoPause: !!p.autoPause,
    panel: p.panel === undefined ? base.panel : !!p.panel,
    colorize: p.colorize === undefined ? base.colorize : !!p.colorize,
    colors, keys,
    pictureAlign: PICTURE_ALIGNS.includes(p.pictureAlign) ? p.pictureAlign : base.pictureAlign,
    panelTimes: p.panelTimes === undefined ? base.panelTimes : !!p.panelTimes,
    joinLines: p.joinLines === undefined ? base.joinLines : !!p.joinLines,
    hideSpeaker: !!p.hideSpeaker,
    hideMain: !!p.hideMain,
    mainFont: clamp(p.mainFont, LIMITS.font, base.mainFont),
    subFont: clamp(p.subFont, LIMITS.font, base.subFont),
    mainLines: clamp(p.mainLines, LIMITS.lines, base.mainLines, LINE_STEP),
    subLines: clamp(p.subLines, LIMITS.lines, base.subLines, LINE_STEP),
    subtitleGap: clamp(p.subtitleGap, LIMITS.gap, base.subtitleGap),
    lineGap: clamp(p.lineGap, LIMITS.lineGap, base.lineGap),
    textPlacement: TEXT_PLACEMENTS.includes(p.textPlacement) ? p.textPlacement : base.textPlacement,
    subtitleBackground: BACKGROUNDS.includes(p.subtitleBackground) ? p.subtitleBackground : base.subtitleBackground,
  };
}

export const DEFAULTS = {
  activeProfile: 'default',
  profiles: [newProfile('default', 'Default')],
};

// Has a main language been chosen? A new profile has none until the options page asks.
export const isConfigured = (p) => p.main.length > 0;

// The language the second line should be in: the first of the profile's sub languages, '' for none.
export const wantedSub = (p) => (p.sub[0] ? normLang(p.sub[0]) : '');

// Settings that only change how the running session looks. Saving one of them updates the screen at once; any other
// change (a language, the translator...) needs a new session.
export const LOOK_FIELDS = ['mainFont', 'subFont', 'mainLines', 'subLines', 'textPlacement', 'subtitleGap', 'lineGap', 'pictureAlign',
  'subtitleBackground', 'panel', 'colorize', 'colors', 'hideMain'];

// What a session was built from: the whole profile with the look fields blanked. Two profiles with the same key differ
// only in look, so the running session can take the new look without being rebuilt.
export const sessionKey = (p) => JSON.stringify({ ...p, ...Object.fromEntries(LOOK_FIELDS.map((f) => [f, 0])) });

export const lookOf = (p) => Object.fromEntries(LOOK_FIELDS.map((f) => [f, p[f]]));

// Returns valid settings, or null when `raw` has no usable profiles.
export function sanitizeSettings(raw) {
  if (!raw || !Array.isArray(raw.profiles) || !raw.profiles.length) return null;
  const profiles = raw.profiles.slice(0, MAX_PROFILES).map(sanitizeProfile);
  // Two profiles with one id (an import, or two made in the same millisecond) would make the second unreachable.
  const seen = new Set();
  for (const p of profiles) {
    let id = p.id;
    for (let n = 2; seen.has(id); n++) id = `${p.id}-${n}`;
    seen.add(id);
    p.id = id;                                                            // the first profile with an id keeps it
  }
  const active = profiles.some((p) => p.id === raw.activeProfile) ? raw.activeProfile : profiles[0].id;
  return { activeProfile: active, profiles };
}
