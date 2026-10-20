// What Subpair draws on the page: the two lines (in a bottom bar or on the video), the buttons, the transcript panel, the
// quick settings menu, and the small notices shown instead of all that. Layout arithmetic is in src/ui-layout.js, the
// stylesheet in src/ui-style.js, the panel and the menu in their own files.
import { normLang } from './lang.js';
import { BACKGROUNDS } from './profile.js';
import { PANEL_W, LINE_H, WINDOW_MARGIN, CLUSTER_TOP, PICTURE_ALIGN_PCT, pictureBottom, textTop, textSides, barHeight, layoutRule } from './ui-layout.js';
import { CSS, hideRule } from './ui-style.js';
import { renderLine } from './ui-words.js';
import { createPanel } from './ui-panel.js';
import { createMenu } from './ui-menu.js';
import { TUNING } from './tuning.js';
import { t } from './i18n.js';

const PILL_OPACITY = 0.6;
const RESIZE_DELAY_MS = 60;          // after a layout change, so the new rule is in place when the site measures

// The notices shown instead of the subtitles: Subpair is turned off, a Jellyfin-looking server waits to be allowed, or no
// languages are chosen yet.
export const NOTICES = {
  off: { label: t('noticeOff'), title: t('noticeOffTitle') },
  setup: { label: t('noticeSetup'), title: t('noticeSetupTitle') },
};

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // Plain-http Jellyfin servers are not a secure context, so the async clipboard API is unavailable.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy refused'));
}

// Only the fullscreen element and its children are drawn in fullscreen. Jellyfin goes fullscreen on the whole page,
// Netflix on its player container, so our elements go inside the fullscreen element when it is neither the page nor the
// body (and a <video> cannot hold children, so they go beside it).
function mountPoint() {
  const f = document.fullscreenElement;
  if (!f || f === document.documentElement || f === document.body) return document.body;
  return f.tagName === 'VIDEO' ? f.parentElement || document.body : f;
}

// A notice sits top-right, where the buttons sit on the video, clear of the sites' own controls at the bottom, and follows
// the page into and out of fullscreen.
export function createPill(kind, onClick) {
  const b = document.createElement('button');
  b.id = 'subpair-pill';
  b.type = 'button';
  b.textContent = NOTICES[kind].label;
  b.title = NOTICES[kind].title;
  b.setAttribute('aria-label', b.title);
  b.style.cssText = `position:fixed;right:12px;top:${CLUSTER_TOP}px;z-index:2147483000;padding:6px 12px;border:0;border-radius:6px;` +
    `background:#2a2a31;color:#e8e8ee;font:13px system-ui;opacity:${PILL_OPACITY};cursor:pointer`;
  b.onmouseenter = () => { b.style.opacity = '1'; };
  b.onmouseleave = () => { b.style.opacity = String(PILL_OPACITY); };
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  const mount = () => mountPoint().appendChild(b);
  mount();
  document.addEventListener('fullscreenchange', mount);
  return { kind, destroy: () => { document.removeEventListener('fullscreenchange', mount); b.remove(); } };
}

// DOM building without innerHTML: el(tag, attributes, ...children), where a child is an element or text.
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...children);
  return n;
}
const actButton = (act, content) => el('button', { type: 'button', 'data-act': act }, content);

function powerIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const d of ['M12 3v8', 'M6.3 6.6a8 8 0 1 0 11.4 0']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// actions: { layout (from the adapter), video, quick (the menu's model), prev, repeat, next, autopause, seek(time),
//            openSettings, disable, setPanel(on), setFullscreenPanel(on) }
export function createUI(actions) {
  const layout = { player: [], fullscreen: [], osd: [], hide: [], ...actions.layout };
  const video = actions.video;
  const style = document.createElement('style');
  style.id = 'subpair-style';
  style.textContent = CSS + hideRule(layout.hide);
  const root = el('div', { id: 'subpair-root' },
    el('div', { id: 'subpair-panel' }),
    el('div', { id: 'subpair-bar' },
      el('div', { class: 'subpair-side' }, actButton('prev', '◀'), actButton('next', '▶'), actButton('repeat', '↻')),
      el('div', { class: 'subpair-text' },
        el('div', { class: 'subpair-line subpair-main' }, el('span', { class: 'subpair-inner' })),
        el('div', { class: 'subpair-line subpair-sub' }, el('span', { class: 'subpair-inner' }))),
      el('div', { class: 'subpair-side' }, actButton('panel', '▤'), actButton('ap', 'AP'), actButton('settings', '⚙'), actButton('off', powerIcon()))),
    el('div', { id: 'subpair-toast', role: 'status' }));
  document.head.appendChild(style);
  mountPoint().appendChild(root);                 // already in fullscreen (Netflix started the next episode there)? go inside it

  const $ = (sel) => root.querySelector(sel);
  const mainEl = $('.subpair-main'), subEl = $('.subpair-sub'), textEl = $('.subpair-text'), toast = $('#subpair-toast');
  const segmenters = new Map();     // lang -> text => [{ text, word, cat?, base? }] (e.g. the Japanese analyzer)
  let profile = null, mainLang = '', subLang = '', onVideo = false, fsPanel = false;
  let shown = { main: null, sub: null }, lastLines = [null, null, -1], toastTimer = 0;

  const panelOn = () => (document.fullscreenElement ? fsPanel : profile.panel);
  function togglePanel() {
    if (document.fullscreenElement) { fsPanel = !fsPanel; actions.setFullscreenPanel(fsPanel); applyLayout(); } else actions.setPanel(!profile.panel);
  }
  const panel = createPanel($('#subpair-panel'), { onSeek: (time) => actions.seek(time) });
  const menu = createMenu(root, { quick: actions.quick, panelOn, togglePanel, openSettings: actions.openSettings });

  const KEY_NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Comma: ',' };
  const keyName = (k) => KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
  // Tooltips (and the names screen readers use) carry the profile's own shortcuts, e.g. "Previous line (A)".
  function labelButtons() {
    const tips = {
      prev: [t('btnPrev'), 'prev'], repeat: [t('btnRepeat'), 'repeat'], next: [t('btnNext'), 'next'], ap: [t('btnAutoPause'), 'autopause'],
      panel: [t('btnPanel')], settings: [t('btnSettings')], off: [t('btnOff')],
    };
    for (const [btn, [text, act]] of Object.entries(tips)) {
      const keys = act ? (profile.keys[act] || []).map(keyName) : [];
      const b = $(`button[data-act="${btn}"]`);
      b.title = keys.length ? t('withKeys', text, keys.join(', ')) : text;
      b.setAttribute('aria-label', b.title);
    }
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), TUNING.session.toastMs);
  }
  const copy = (text, label) => copyText(text).then(() => showToast(label || t('copied')), () => showToast(t('copyFailed')));

  // Keep clicks inside our UI from reaching the site's player controls (a click on the bar would pause the video).
  for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup']) root.addEventListener(ev, (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const a = btn.dataset.act;
      if (a === 'prev' || a === 'repeat' || a === 'next') actions[a]();
      else if (a === 'ap') actions.autopause();
      else if (a === 'settings') menu.toggle();
      else if (a === 'off') actions.disable();
      else if (a === 'panel') togglePanel();
      return;
    }
    const line = e.target.closest('.subpair-line');
    if (!line) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && line.contains(sel.anchorNode)) return;          // the user is selecting text here (e.g. for Yomitan)
    if (e.altKey) { copy(line.textContent.trim(), t('lineCopied')); return; }
    const w = e.target.closest('.subpair-w');
    if (!w) return;
    if (e.ctrlKey && w.dataset.base) copy(w.dataset.base, t('dictCopied'));
    else copy(w.textContent);
  });

  const placement = () => (document.fullscreenElement ? 'overlay' : profile.textPlacement);
  // On the video the text goes under the picture when there is room, else just inside its bottom edge (src/ui-layout.js).
  function positionText() {
    if (!profile) return;
    if (placement() === 'bar' || !video.videoWidth) { textEl.style.cssText = ''; return; }
    const sides = textSides(window.innerWidth, panelOn() ? PANEL_W : 0);
    textEl.style.cssText = `position:fixed;left:${sides.left}px;right:${sides.right}px;flex:none;`;
    const y = getComputedStyle(video).objectPosition.split(' ')[1] || '';
    textEl.style.top = `${textTop({
      pictureBottom: pictureBottom(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, y.endsWith('%') ? parseFloat(y) : 50),
      lowest: window.innerHeight - WINDOW_MARGIN,
      height: textEl.offsetHeight,
      gap: profile.subtitleGap,
      oneLineEach: (profile.hideMain ? 0 : profile.mainFont * LINE_H + profile.lineGap) + profile.subFont * LINE_H,
    })}px`;
  }
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => positionText()) : null;
  if (resizeObserver) resizeObserver.observe(video);
  window.addEventListener('resize', positionText);
  for (const ev of ['loadedmetadata', 'resize']) video.addEventListener(ev, positionText);    // 'resize': the stream's size changed

  const onFullscreen = () => {
    const host = mountPoint();
    if (root.parentNode !== host) host.appendChild(root);
    applyLayout();
  };
  document.addEventListener('fullscreenchange', onFullscreen);

  let lastBox = '';                                 // the space last reserved for the bar and the panel
  function applyLayout() {
    onVideo = placement() === 'overlay';
    root.classList.toggle('subpair-overlay', onVideo);
    for (const b of BACKGROUNDS) root.classList.toggle(`subpair-bg-${b}`, b === profile.subtitleBackground);
    root.classList.toggle('subpair-color', !!profile.colorize);
    root.classList.toggle('subpair-main-hidden', !!profile.hideMain);
    for (const [cat, color] of Object.entries(profile.colors || {})) root.style.setProperty(`--subpair-c-${cat}`, color);
    const barH = barHeight(profile), pw = panelOn() ? PANEL_W : 0;
    const bar = onVideo ? 0 : barH;                 // text on the video: nothing reserved at the bottom
    $('button[data-act="panel"]').classList.toggle('on', panelOn());
    const r = document.documentElement.style;
    r.setProperty('--subpair-bar', `${bar}px`);
    r.setProperty('--subpair-bar-h', `${barH}px`);
    r.setProperty('--subpair-panel', `${pw}px`);
    r.setProperty('--subpair-panel-display', pw ? 'block' : 'none');
    r.setProperty('--subpair-line-gap', `${profile.lineGap}px`);
    let rule = document.getElementById('subpair-layout');
    if (!rule) { rule = document.createElement('style'); rule.id = 'subpair-layout'; document.head.appendChild(rule); }
    const fullscreen = !!document.fullscreenElement;
    rule.textContent = layoutRule(layout, { bar, panel: pw, align: onVideo ? 50 : PICTURE_ALIGN_PCT[profile.pictureAlign], fullscreen });
    // Sites size their video from the window's resize events, and a changed stylesheet fires none: without one the picture
    // keeps its old size and the bottom of it ends up behind the bar (Netflix does exactly this).
    const box = `${bar}x${pw}${fullscreen ? 'f' : ''}`;
    if (box !== lastBox) { lastBox = box; setTimeout(() => window.dispatchEvent(new Event('resize')), RESIZE_DELAY_MS); }
    shown = { main: null, sub: null };              // sizes changed: re-render the current lines
    redraw();
  }

  function draw(main, sub, index) {
    lastLines = [main, sub, index];
    const mt = main ? main.text : '', st = sub ? sub.text : '';
    const changed = mt !== shown.main || st !== shown.sub;
    if (mt !== shown.main) { shown.main = mt; renderLine(mainEl, mt, { lang: mainLang, fontPx: profile.mainFont, lines: profile.mainLines, onVideo, segment: segmenters.get(mainLang) }); }
    if (st !== shown.sub) { shown.sub = st; renderLine(subEl, st, { lang: subLang, fontPx: profile.subFont, lines: profile.subLines, onVideo, segment: segmenters.get(subLang) }); }
    if (changed && onVideo) positionText();         // on the video the text block is as tall as the current lines
    panel.setActive(index);
  }
  const redraw = () => { draw(...lastLines); positionText(); };

  return {
    // langs: the languages of the tracks actually loaded; fsPanel: the panel in fullscreen (src/prefs.js).
    setProfile(p, { fsPanel: fs = false, main = '', sub = '' } = {}) {
      profile = p;
      mainLang = main || normLang(p.main[0]);
      subLang = sub || normLang(p.sub[0]);
      fsPanel = fs;
      labelButtons();
      $('button[data-act="ap"]').classList.toggle('on', !!p.autoPause);
      applyLayout();
    },
    setAutoPause(on) { $('button[data-act="ap"]').classList.toggle('on', !!on); },
    setCues(mainCues) {
      panel.setCues(mainCues, { times: profile.panelTimes });
      const segment = segmenters.get(mainLang);
      if (segment && profile.colorize) panel.colorize(segment);
    },
    // A better word splitter for a language has loaded: re-render the current lines and color the panel with it.
    setSegmenter(lang, fn) {
      segmenters.set(lang, fn);
      shown = { main: null, sub: null };
      redraw();
      if (lang === mainLang && profile.colorize) panel.colorize(fn);
    },
    // main/sub: cue objects or null; index: main cue index for the panel highlight. Re-renders only on change.
    update: draw,
    toast: showToast,
    refreshMenu: () => menu.refresh(),
    // The profile's look changed (size, position, panel, colors): redraw with it, keeping everything else as it is.
    updateProfile(p) {
      const recolor = p.colorize !== profile.colorize;
      profile = p;
      applyLayout();
      const segment = segmenters.get(mainLang);
      if (recolor && segment && p.colorize) panel.colorize(segment);
    },
    destroy() {
      menu.destroy();
      panel.destroy();
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('resize', positionText);
      for (const ev of ['loadedmetadata', 'resize']) video.removeEventListener(ev, positionText);
      if (resizeObserver) resizeObserver.disconnect();
      clearTimeout(toastTimer);
      root.remove();
      style.remove();
      document.getElementById('subpair-layout')?.remove();
      const r = document.documentElement.style;
      for (const v of ['--subpair-bar', '--subpair-bar-h', '--subpair-panel', '--subpair-panel-display', '--subpair-line-gap']) r.removeProperty(v);
      // The site's player gets its whole window back, and like any layout change it only notices on a resize event.
      if (lastBox && lastBox !== '0x0') setTimeout(() => window.dispatchEvent(new Event('resize')), RESIZE_DELAY_MS);
    },
  };
}
