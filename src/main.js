// Orchestrates playback sessions: finds what is playing, lets src/session.js decide the two lines per the active profile,
// then drives the UI, keyboard shortcuts, navigation and auto-pause.
// The site is an adapter (src/jellyfin.js or src/netflix.js); nothing in this file knows which one it got.
import { loadSettings, saveSettings, activeProfile, onSettingsChanged } from './storage.js';
import { isEnabled, setEnabled, onEnabledChanged, fullscreenPanel, setFullscreenPanel, translatesOverTrack, setTranslateOverTrack } from './prefs.js';
import { isConfigured, sessionKey, lookOf, wantedSub, keyToken, LIMITS } from './profile.js';
import { Timeline, AutoPause } from './timeline.js';
import { createUI, createPill } from './ui.js';
import { loadJapanese, japaneseSegmenter } from './analyzer.js';
import { loadSession } from './session.js';
import { translateNext, translateSeason } from './ahead.js';
import { languagePatch, stepOffset, stepFont, stepGap, OFFSET_STEP, FONT_STEP, GAP_STEP, LINE_GAP_STEP } from './quickmenu.js';
import { adapter as jellyfin } from './jellyfin.js';
import { adapter as netflix, isNetflix } from './netflix.js';
import { TUNING } from './tuning.js';
import { t } from './i18n.js';

const adapter = isNetflix() ? netflix : jellyfin;
const LOG = (...a) => console.log('[Subpair]', ...a);

let session = null;     // the running session for the current video: { stop() }
let notice = null;      // the small button shown instead of the subtitles (off, ask, setup)
let polling = false;    // a poll is looking up the current item
let current = null;     // item id the last setup was started for
let epoch = 0;          // bumped by every teardown; a setup that finds it changed was overtaken and must not touch the page
let retryAt = 0;
let running = null;     // what the current session was built from, and how to apply a look-only change to it live
let enabled = true;     // the on/off switch (src/prefs.js), mirrored here so the poll does not read storage every second
let once = null;        // { key, fresh } for the next setup of that title only ("Translate again")
// A whole season being translated ahead (src/ahead.js): { done, total, stop() }. It outlives the episode it was started from,
// and the running session shows its progress through onSeasonChange.
let seasonRun = null;
let onSeasonChange = () => {};

function showNotice(kind, onClick) {
  if (notice && notice.kind === kind) return;
  if (notice) { notice.destroy(); notice = null; }
  if (kind) notice = createPill(kind, onClick);
}

function teardown() {
  epoch++;
  running = null;
  if (session) { session.stop(); session = null; }
  showNotice(null);
}

function startSeason(itemId, profile) {
  if (seasonRun || !adapter.seasonItems) return;
  let stop = false;
  const run = { done: 0, total: 0, stop() { stop = true; if (seasonRun === run) seasonRun = null; onSeasonChange(); } };
  seasonRun = run;
  translateSeason({ adapter, itemId, profile, stopped: () => stop, log: LOG, onProgress: (done, total) => { run.done = done; run.total = total; onSeasonChange(); } })
    .then((r) => { if (seasonRun === run) { seasonRun = null; onSeasonChange(t('seasonDone', r.done - r.failed, r.total)); } })
    .catch((e) => { LOG('season failed', e); if (seasonRun === run) { seasonRun = null; onSeasonChange(); } });
}

function reset() {
  teardown();
  current = null;
  adapter.forget();
}

function openOptions() {
  try { Promise.resolve(chrome.runtime.sendMessage({ type: 'open-options' })).catch(() => {}); } catch { /* the extension was reloaded */ }
}

// Saves a change to the profile the session was built from, never to whichever profile happens to be active now.
async function saveProfilePatch(profileId, patch) {
  const settings = await loadSettings();
  const stored = settings.profiles.find((p) => p.id === profileId);
  if (!stored) throw new Error(t('profileGone'));
  Object.assign(stored, patch);
  await saveSettings(settings);
}

// A saved settings change either needs a new session (another language, translator...) or is only about how the text looks
// (size, position), which is applied to the running one on the spot. Comparing what the session was built from with what
// is saved now tells them apart exactly, whoever made the change (the quick menu or the options page).
async function onSettingsSaved() {
  if (!running) return reset();                       // nothing running yet, or still starting: start over with the new settings
  const stored = activeProfile(await loadSettings());
  if (sessionKey(stored) !== running.key) return reset();
  running.applyLook(stored);
}

// Profile keys -> the actions they trigger. A key pressed with a modifier, or while typing in a field, is left to the page.
function bindKeys(keys, handlers) {
  const keyMap = new Map();
  for (const [act, list] of Object.entries(keys)) for (const k of list) keyMap.set(keyToken(k), act);
  const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  const onKey = (e) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    const act = keyMap.get(keyToken(e.key));
    if (!act || !handlers[act]) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    handlers[act]();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

// Draws the lines for the playhead and pauses at the end of a main line when auto-pause is on. Overlapping cues (signs, two
// speakers) are all shown; navigation and auto-pause follow the primary one. Cues whose translation has not arrived yet have
// empty text and are left out. Every animation frame runs it; a background tab or picture-in-picture gets few or no frames,
// so the video's own timeupdate and seeked events run it too, and it runs once at the start for a paused video.
function startRenderLoop({ video, mainCues, subCues, mainTl, subTl, off, ui, ap, autoPauseOn }) {
  const joined = (cues, ids) => {
    const texts = ids.map((i) => cues[i].text).filter(Boolean);
    return texts.length ? { text: texts.join('\n') } : null;
  };
  let raf = 0, failed = false;
  const step = () => {
    try {
      const now = video.currentTime;
      const mIds = mainTl.activeIndices(now - off.main), sIds = subTl.activeIndices(now - off.sub);
      ui.update(joined(mainCues, mIds), joined(subCues, sIds), mIds.length ? mIds[0] : -1);   // re-renders only on change
      if (autoPauseOn() && !video.paused && ap.shouldPause(mainTl, now - off.main)) video.pause();
    } catch (e) {
      if (!failed) { failed = true; LOG('render error', e); }
    }
  };
  const frame = () => {
    raf = requestAnimationFrame(frame);          // re-arm first so one bad frame cannot stop the loop
    step();
  };
  raf = requestAnimationFrame(frame);
  for (const ev of ['timeupdate', 'seeked']) video.addEventListener(ev, step);
  step();
  return () => {
    cancelAnimationFrame(raf);
    for (const ev of ['timeupdate', 'seeked']) video.removeEventListener(ev, step);
  };
}

// Everything that runs while one video plays. Returns { stop, applyLook }.
function startSession(video, itemId, stored, src, fsPanel) {
  let profile = stored;
  const { mainCues, subCues, mainLang, subLang, translator, site } = src;
  const mainTl = new Timeline(mainCues), subTl = new Timeline(subCues);
  const ap = new AutoPause();
  let autoPause = !!profile.autoPause;
  const off = { main: 0, sub: 0 };                    // seconds each line is shifted later (quick menu), for this video only
  let ui = null;

  // Cue times are on the line's own clock; the video is `off.main` later.
  const seek = (cueTime) => {
    if (cueTime == null) return;
    Promise.resolve(adapter.seekTo(video, cueTime + off.main)).catch((e) => LOG('seek failed', e));
    ap.reset();
  };
  const nav = {
    prev: () => seek(mainTl.prevTarget(video.currentTime - off.main)),
    repeat: () => { seek(mainTl.repeatTarget(video.currentTime - off.main)); video.play(); },
    next: () => seek(mainTl.nextTarget(video.currentTime - off.main)),
    autopause: () => { autoPause = !autoPause; ap.reset(); ui.setAutoPause(autoPause); ui.toast(autoPause ? t('autoPauseOn') : t('autoPauseOff')); },
  };

  const persist = async (patch) => {
    try { await saveProfilePatch(profile.id, patch); return true; } catch (e) { ui.toast(t('notSaved', e.message)); return false; }
  };
  // A language or translator choice starts a new session, even when it saves exactly what was saved before: choosing the
  // language you already want is how you retry it after the bridge was down.
  const rebuild = async (patch) => { if (await persist(patch)) reset(); };
  // A look change shows at once and is saved once the clicking stops (storage.sync allows a limited number of writes).
  // Until then the session's own look wins over the settings listener, so a quick run of clicks never jumps back a step.
  let pendingLook = null, lookTimer = 0;
  const flushLook = () => {
    clearTimeout(lookTimer);
    if (!pendingLook) return;
    const patch = pendingLook;
    pendingLook = null;
    persist(patch);
  };
  const look = (patch) => {
    profile = { ...profile, ...patch };
    ui.updateProfile(profile);
    pendingLook = { ...pendingLook, ...patch };
    clearTimeout(lookTimer);
    lookTimer = setTimeout(flushLook, TUNING.session.lookSaveMs);
  };

  const quick = {
    get: () => ({
      mainLang, subLang: src.subKind === 'off' ? '' : subLang, subKind: src.subKind, trackLangs: src.trackLangs,
      wantedSub: wantedSub(profile), note: src.note,         // what is asked for, and why it may not be shown
      hasWantedTrack: src.hasWantedTrack, overTrack: src.preferTranslation,
      canTranslate: profile.translate.mode !== 'off', backend: profile.translate.backend, mode: profile.translate.mode,
      status: translator ? translator.status() : null,
      canSeason: !!adapter.seasonItems, season: seasonRun ? { done: seasonRun.done, total: seasonRun.total } : null,
      offsets: { ...off }, autoPause, mainFont: profile.mainFont, subFont: profile.subFont,
      placement: profile.textPlacement, gap: profile.subtitleGap, lineGap: profile.lineGap, align: profile.pictureAlign,
      background: profile.subtitleBackground,
    }),
    setMain: (code) => rebuild(languagePatch(profile, 'main', code)),
    setSub: (code) => rebuild(languagePatch(profile, 'sub', code)),
    setTranslator: (value) => rebuild({
      translate: value === 'off'
        ? { ...profile.translate, mode: 'off' }
        : { ...profile.translate, backend: value, mode: profile.translate.mode === 'off' ? 'auto' : profile.translate.mode },
    }),
    setMode: (mode) => rebuild({ translate: { ...profile.translate, mode } }),
    translateAgain: () => { once = { key: site.key, fresh: true }; reset(); },
    translateSeason: () => { startSeason(itemId, profile); ui.toast(t('seasonStarted')); },
    stopSeason: () => { if (seasonRun) seasonRun.stop(); },
    translateOverTrack: (on) => setTranslateOverTrack(site.key, on).then(reset),
    nudge: (which, dir) => { off[which] = stepOffset(off[which], dir * OFFSET_STEP); },
    resetOffsets: () => { off.main = 0; off.sub = 0; },
    resize: (which, dir) => look({ [`${which}Font`]: stepFont(profile[`${which}Font`], dir * FONT_STEP) }),
    setPlacement: (value) => look({ textPlacement: value }),
    nudgeGap: (dir) => look({ subtitleGap: stepGap(profile.subtitleGap, dir * GAP_STEP) }),
    nudgeLineGap: (dir) => look({ lineGap: stepGap(profile.lineGap, dir * LINE_GAP_STEP, LIMITS.lineGap) }),
    setAlign: (value) => look({ pictureAlign: value }),
    setBackground: (value) => look({ subtitleBackground: value }),
    toggleAutoPause: nav.autopause,
  };

  ui = createUI({
    layout: adapter.layout, video, quick, ...nav,
    seek: (time) => { seek(time); video.play(); },
    openSettings: openOptions,
    disable: () => setEnabled(false),
    setPanel: (on) => look({ panel: on }),
    setFullscreenPanel,
  });
  ui.setProfile(profile, { fsPanel, main: mainLang, sub: subLang });
  // Better Japanese word splitting + part-of-speech colors once the analyzer has loaded (plain splitting until then).
  let stopped = false;
  if (subCues.length ? [mainLang, subLang].includes('ja') : mainLang === 'ja') {
    loadJapanese()
      .then((tok) => { if (!stopped) ui.setSegmenter('ja', japaneseSegmenter(tok)); })
      .catch((e) => LOG('Japanese analyzer failed', e));
  }
  ui.setCues(mainCues);
  if (src.note) ui.toast(t('noTranslation', src.note));
  // Once this title needs nothing more from the translator, the next episode is translated ahead (unless a season run is
  // already doing that).
  let aheadStarted = false;
  const ahead = () => {
    if (aheadStarted || seasonRun) return;
    aheadStarted = true;
    translateNext({ adapter, itemId, profile, stopped: () => stopped, log: LOG })
      .then((r) => { if (r && r.state === 'queued' && !stopped) ui.toast(t('nextQueued')); })
      .catch((e) => LOG('next episode failed', e));
  };
  onSeasonChange = (note) => { if (note) ui.toast(note); ui.refreshMenu(); };
  if (translator) {
    src.setStatusSink((s) => { ui.toast(s); ui.refreshMenu(); if (translator.status().phase === 'saved') ahead(); });
    translator.start();
  }
  if (!translator || translator.status().phase === 'saved') ahead();
  const unbindKeys = bindKeys(profile.keys, nav);
  const stopRender = startRenderLoop({ video, mainCues, subCues, mainTl, subTl, off, ui, ap, autoPauseOn: () => autoPause });

  return {
    stop() {
      stopped = true;
      onSeasonChange = () => {};
      flushLook();
      stopRender();
      unbindKeys();
      if (translator) translator.stop();
      ui.destroy();
    },
    applyLook(p) {
      if (pendingLook) return;                        // this session's own change is on its way to storage
      profile = { ...profile, ...lookOf(p) };
      ui.updateProfile(profile);
    },
  };
}

async function setup(video, itemId, hint) {
  // Every await below can take seconds (the Netflix manifest, the bridge); if the item changed, the settings changed or the
  // user turned Subpair off meanwhile, this setup is out of date and must not start anything on the page.
  const mine = epoch;
  const overtaken = () => mine !== epoch;
  const profile = activeProfile(await loadSettings());
  if (overtaken()) return;
  if (!isConfigured(profile)) { showNotice('setup', openOptions); return; }

  const wishes = async (key) => {
    const fresh = !!(once && once.key === key && once.fresh);
    if (fresh) once = null;
    return { fresh, preferTranslation: fresh || await translatesOverTrack(key) };
  };
  const src = await loadSession({ adapter, itemId, hint, profile, wishes, getTime: () => video.currentTime, log: LOG });
  if (!src) return;
  const fsPanel = overtaken() ? false : await fullscreenPanel();
  if (overtaken()) { if (src.translator) src.translator.stop(); return; }
  const s = startSession(video, itemId, profile, src, fsPanel);
  session = s;
  running = { key: sessionKey(profile), applyLook: s.applyLook };
}

async function poll() {
  if (polling || Date.now() < retryAt) return;
  polling = true;
  try {
    const video = adapter.findVideo();
    if (!video) { if (current || notice) reset(); return; }
    if (!enabled) {
      if (session) teardown();
      current = null;
      showNotice('off', () => setEnabled(true));
      return;
    }
    const item = await adapter.currentItem(video, current);
    if (!item || item.id === current) return;           // nothing playing yet, or the item already handled
    teardown();                                          // also cancels a setup still running for the previous item
    current = item.id;
    setup(video, item.id, item.hint).catch((e) => {
      LOG('error', e);
      if (current !== item.id) return;
      current = null;                                    // forget the item so a later poll retries (after a pause)
      adapter.forget();
      retryAt = Date.now() + TUNING.session.retryMs;
    });
  } catch (e) {
    LOG('error', e);
    current = null;
    adapter.forget();
    retryAt = Date.now() + TUNING.session.retryMs;
  } finally {
    polling = false;
  }
}

export async function start() {
  LOG('loaded');
  enabled = await isEnabled();
  onEnabledChanged((on) => { enabled = on; if (!on && seasonRun) seasonRun.stop(); reset(); });
  onSettingsChanged(onSettingsSaved);
  const timer = setInterval(() => {
    // After the extension is reloaded or updated this script lives on in the old page, cut off from the extension.
    // It must stop quietly instead of throwing every second for as long as the tab stays open.
    if (!chrome.runtime || !chrome.runtime.id) { clearInterval(timer); teardown(); return; }
    poll();
  }, TUNING.session.pollMs);
}
