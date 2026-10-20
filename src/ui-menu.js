// The quick settings menu (the gear): rows that open lists with a check mark on the current choice, like Jellyfin's own
// player menu. What it shows and what each choice does comes from `quick` (src/main.js); the wording and the choices come
// from src/quickmenu.js; this file only draws. Everything is set with textContent.
import { langLabel } from './lang.js';
import { t } from './i18n.js';
import {
  mainChoices, subChoices, secondLine, formatOffset, translatorSummary, placementSummary, choiceLabel,
  TRANSLATOR_CHOICES, MODE_CHOICES, PLACEMENT_CHOICES, ALIGN_CHOICES, BACKGROUND_CHOICES,
} from './quickmenu.js';

const CONFIRM_MS = 4000;             // a costly row (translate again) runs on a second click within this time

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const button = (cls, text, onClick) => { const b = node('button', cls, text); b.type = 'button'; b.onclick = onClick; return b; };

function row(label, value, onClick, check = null) {
  const b = button('subpair-mrow', '', onClick);
  const left = node('span', 'subpair-mlabel');
  if (check !== null) left.append(node('span', 'subpair-mcheck', check ? '✓' : ''));
  left.append(label);
  b.append(left, node('span', 'subpair-mval', value));
  return b;
}

function stepper(label, value, onMinus, onPlus) {
  const r = node('div', 'subpair-mstep');
  const box = node('span', 'subpair-mbox');
  const minus = button('subpair-sbtn', '−', onMinus), plus = button('subpair-sbtn', '+', onPlus);
  minus.setAttribute('aria-label', t('stepLess', label));
  plus.setAttribute('aria-label', t('stepMore', label));
  box.append(minus, node('span', 'subpair-mnum', value), plus);
  r.append(node('span', '', label), box);
  return r;
}

// opts: { quick, panelOn(), togglePanel(), openSettings() }
export function createMenu(root, { quick, panelOn, togglePanel, openSettings }) {
  const menu = node('div');
  menu.id = 'subpair-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  root.appendChild(menu);
  let view = 'main', armed = { key: '', until: 0 };

  const go = (v) => { view = v; armed = { key: '', until: 0 }; render(); };
  const named = (code) => (code ? langLabel(code) : t('none'));
  const then = (fn) => () => { fn(); render(); };
  // A row for something that costs (a new translation): the first click asks, a second one within CONFIRM_MS runs it.
  const confirmRow = (key, label, note, run) => {
    const isArmed = armed.key === key && Date.now() < armed.until;
    const r = row(label, isArmed ? t('clickAgain') : note, () => {
      if (armed.key === key && Date.now() < armed.until) { armed = { key: '', until: 0 }; run(); return; }
      armed = { key, until: Date.now() + CONFIRM_MS };
      render();
      setTimeout(() => { if (!menu.hidden) render(); }, CONFIRM_MS);
    });
    if (isArmed) r.querySelector('.subpair-mval').classList.add('armed');
    return r;
  };

  function render() {
    const s = quick.get();
    menu.textContent = '';
    const head = (title, back) => {
      const h = node('div', 'subpair-mhead');
      if (back) { const b = button('subpair-mback', '‹', () => go('main')); b.title = t('menuBack'); b.setAttribute('aria-label', b.title); h.append(b); }
      h.append(title);
      menu.append(h);
    };
    const second = secondLine(s);
    if (view === 'main') {
      head(t('extName'));
      menu.append(
        row(t('menuMain'), named(s.mainLang), () => go('main-lang')),
        row(t('menuSecond'), second.value, () => go('sub-lang')),
        row(t('menuTranslator'), translatorSummary(s.subKind, s.backend, s.mode, s.status), () => go('translator')),
        row(t('menuTiming'), `${formatOffset(s.offsets.main)} / ${formatOffset(s.offsets.sub)}`, () => go('timing')),
        row(t('menuSize'), `${s.mainFont} / ${s.subFont}`, () => go('size')),
        row(t('menuPosition'), placementSummary(s.placement, s.gap), () => go('position')),
        row(t('menuBackground'), choiceLabel(BACKGROUND_CHOICES, s.background), () => go('background')),
        row(t('menuAutoPause'), s.autoPause ? t('on') : t('off'), then(quick.toggleAutoPause)),
        row(t('menuPanel'), panelOn() ? t('on') : t('off'), then(togglePanel)),
        row(t('menuMore'), '', () => { close(); openSettings(); }),
      );
    } else if (view === 'main-lang') {
      head(t('menuMain'), true);
      for (const c of mainChoices(s.trackLangs, s.mainLang)) menu.append(row(c.label, c.note, () => quick.setMain(c.code), c.code === s.mainLang));
    } else if (view === 'sub-lang') {
      head(t('menuSecond'), true);
      if (second.missing) {
        menu.append(node('div', 'subpair-mnote', t('wantedMissing', named(s.wantedSub), s.note || t('noTrackNoTranslator'))));
      }
      for (const c of subChoices(s.trackLangs, second.checked, s.mainLang, s.canTranslate)) menu.append(row(c.label, c.note, () => quick.setSub(c.code), c.code === second.checked));
    } else if (view === 'translator') {
      head(t('menuTranslator'), true);
      const current = s.mode === 'off' ? 'off' : s.backend;
      for (const [value, label] of TRANSLATOR_CHOICES) menu.append(row(label, '', () => quick.setTranslator(value), value === current));
      if (s.mode !== 'off') {
        menu.append(node('div', 'subpair-mgroup', t('whenToTranslate')));
        for (const [value, label] of MODE_CHOICES) menu.append(row(label, '', () => quick.setMode(value), value === s.mode));
      }
      // A track in the wanted language can be bad or out of sync: translating the main line instead is remembered per title.
      if (s.hasWantedTrack && s.canTranslate) {
        menu.append(s.overTrack
          ? row(t('useTrackAgain', named(s.wantedSub)), '', () => quick.translateOverTrack(false))
          : row(t('translateInstead'), t('translateInsteadNote'), () => quick.translateOverTrack(true)));
      }
      // A whole season, translated ahead one episode at a time (sites that can list a season: Jellyfin).
      if (s.canSeason && s.mode !== 'off' && s.wantedSub) {
        menu.append(s.season
          ? row(t('seasonStop'), t('seasonProgress', s.season.done, s.season.total), () => { quick.stopSeason(); render(); })
          : confirmRow('season', t('seasonTranslate'), t('seasonTranslateNote'), () => { close(); quick.translateSeason(); }));
      }
      if (s.subKind === 'translated') menu.append(confirmRow('again', t('translateAgain'), t('translateAgainNote'), () => { close(); quick.translateAgain(); }));
    } else if (view === 'timing') {
      head(t('menuTiming'), true);
      menu.append(
        stepper(t('mainLine'), formatOffset(s.offsets.main), then(() => quick.nudge('main', -1)), then(() => quick.nudge('main', 1))),
        stepper(t('secondLine'), formatOffset(s.offsets.sub), then(() => quick.nudge('sub', -1)), then(() => quick.nudge('sub', 1))),
        row(t('reset'), '', then(quick.resetOffsets)),
      );
    } else if (view === 'position') {
      head(t('menuPosition'), true);
      for (const [value, label] of PLACEMENT_CHOICES) menu.append(row(label, '', then(() => quick.setPlacement(value)), value === s.placement));
      menu.append(
        stepper(t('spaceFromPicture'), t('px', s.gap), then(() => quick.nudgeGap(-1)), then(() => quick.nudgeGap(1))),
        stepper(t('spaceBetweenLines'), t('px', s.lineGap), then(() => quick.nudgeLineGap(-1)), then(() => quick.nudgeLineGap(1))),
      );
      if (s.placement === 'bar') {
        menu.append(node('div', 'subpair-mnote', t('pictureAboveBar')));
        for (const [value, label] of ALIGN_CHOICES) menu.append(row(label, '', then(() => quick.setAlign(value)), value === s.align));
      }
    } else if (view === 'background') {
      head(t('menuBackground'), true);
      for (const [value, label] of BACKGROUND_CHOICES) menu.append(row(label, '', then(() => quick.setBackground(value)), value === s.background));
      menu.append(node('div', 'subpair-mnote', t('backgroundNote')));
    } else if (view === 'size') {
      head(t('menuSize'), true);
      menu.append(
        stepper(t('mainLine'), t('px', s.mainFont), then(() => quick.resize('main', -1)), then(() => quick.resize('main', 1))),
        stepper(t('secondLine'), t('px', s.subFont), then(() => quick.resize('sub', -1)), then(() => quick.resize('sub', 1))),
      );
    }
  }

  function open() { view = 'main'; armed = { key: '', until: 0 }; render(); menu.hidden = false; }
  function close() { menu.hidden = true; }

  // Click anywhere else, or Escape, closes it (the capture phase sees the event before the page's own handlers).
  const onDocDown = (e) => { if (!menu.hidden && !menu.contains(e.target) && !(e.target.closest && e.target.closest('button[data-act="settings"]'))) close(); };
  const onDocKey = (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); e.stopPropagation(); } };
  document.addEventListener('mousedown', onDocDown, true);
  window.addEventListener('keydown', onDocKey, true);

  return {
    toggle() { if (menu.hidden) open(); else close(); },
    refresh() { if (!menu.hidden) render(); },        // the translator's progress changed
    destroy() {
      document.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('keydown', onDocKey, true);
    },
  };
}
