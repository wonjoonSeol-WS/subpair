// The stylesheet of everything Subpair draws on the page. Sizes come from src/ui-layout.js.
import { LINE_H, BUTTON, BUTTON_GAP, CLUSTER_TOP } from './ui-layout.js';

const FONTS = 'system-ui, "Noto Sans CJK JP", "Noto Sans KR", sans-serif';
const ACCENT = '#3b5bdb';

export const CSS = `
#subpair-root, #subpair-root * { box-sizing: border-box; }
#subpair-bar { position: fixed; left: 0; right: 0; bottom: 0; height: var(--subpair-bar-h, 120px); justify-content: space-between;
  background: #0b0b0d; color: #fff; z-index: 2147483000; display: flex; align-items: stretch; font-family: ${FONTS}; }
#subpair-bar .subpair-side { flex: 0 0 auto; display: grid; grid-template-columns: repeat(2, ${BUTTON}px); align-content: center; gap: ${BUTTON_GAP}px; padding: 0 10px; }
#subpair-bar .subpair-side [data-act="repeat"] { grid-column: span 2; justify-self: center; }
#subpair-bar .subpair-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 6px 4px; text-align: center; gap: var(--subpair-line-gap, 0px); }
#subpair-bar .subpair-line { width: 100%; overflow: hidden; display: flex; align-items: center; justify-content: center; line-height: ${LINE_H};
  user-select: text; -webkit-user-select: text; cursor: text; }
#subpair-bar .subpair-line > span.subpair-inner { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
#subpair-bar .subpair-main .subpair-inner { background: #1c1c20; border-radius: 6px; padding: 2px 10px; }
#subpair-bar .subpair-sub { color: #b9b9c2; }
#subpair-bar .subpair-w:hover { background: ${ACCENT}; border-radius: 3px; }
#subpair-bar button { all: unset; cursor: pointer; width: ${BUTTON}px; height: ${BUTTON}px; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; color: #cfcfd8; font-size: 16px; }
#subpair-bar button:hover { background: #2a2a31; color: #fff; }
#subpair-bar button:focus-visible, #subpair-menu button:focus-visible, #subpair-panel .subpair-cue:focus-visible { outline: 2px solid #6c8cff; outline-offset: 1px; }
#subpair-bar button.on { background: ${ACCENT}; color: #fff; }
#subpair-toast { position: fixed; bottom: calc(var(--subpair-bar, 120px) + 10px); left: 50%; transform: translateX(-50%); background: ${ACCENT}; color: #fff;
  padding: 4px 12px; border-radius: 6px; font: 13px system-ui; z-index: 2147483001; opacity: 0; transition: opacity .2s; pointer-events: none; }
#subpair-toast.show { opacity: 1; }
#subpair-panel { position: fixed; top: 0; right: 0; bottom: var(--subpair-bar, 120px); width: var(--subpair-panel, 0px); background: #0f0f12; color: #e8e8ee;
  z-index: 2147483000; overflow-y: auto; font: 14px/1.4 ${FONTS}; display: var(--subpair-panel-display, block); }
#subpair-panel .subpair-cue { padding: 8px 12px; margin: 4px 6px; background: #1a1a1f; border-radius: 4px; cursor: pointer; }
#subpair-panel .subpair-cue:hover { background: #24242b; }
#subpair-panel .subpair-cue.active { background: #26305c; }
#subpair-panel .subpair-time { color: #7f8796; font-size: 11px; margin-right: 8px; font-variant-numeric: tabular-nums; }
/* Part-of-speech colors (Japanese analyzer); the palette comes from the profile via --subpair-c-* variables. */
#subpair-root.subpair-color .subpair-c-noun { color: var(--subpair-c-noun); }
#subpair-root.subpair-color .subpair-c-verb { color: var(--subpair-c-verb); }
#subpair-root.subpair-color .subpair-c-adj { color: var(--subpair-c-adj); }
#subpair-root.subpair-color .subpair-c-adv { color: var(--subpair-c-adv); }
#subpair-root.subpair-color .subpair-c-particle { color: var(--subpair-c-particle); }
/* Text on the video: no bar, the lines sit on the picture and the buttons become a faint cluster in the top-right. */
#subpair-root.subpair-overlay #subpair-bar { right: var(--subpair-panel, 0px); bottom: 5%; height: auto; background: transparent; pointer-events: none; }
#subpair-root.subpair-overlay .subpair-text { padding: 0; }
/* Only the words take the mouse: as full-width boxes the lines would cover the site's own buttons. */
#subpair-root.subpair-overlay .subpair-line { pointer-events: none; }
#subpair-root.subpair-overlay .subpair-line .subpair-inner { pointer-events: auto; }
#subpair-root.subpair-overlay .subpair-main .subpair-inner { background: rgba(0,0,0,.65); }
#subpair-root.subpair-overlay .subpair-sub .subpair-inner { background: rgba(0,0,0,.5); border-radius: 6px; padding: 2px 10px; color: #fff; }
/* The background behind text on the video (a setting): none is plain text with an outline, like the sites' own captions. */
#subpair-root.subpair-overlay.subpair-bg-none .subpair-inner { background: transparent; color: #fff;
  text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px rgba(0,0,0,.85); }
#subpair-root.subpair-overlay.subpair-bg-solid .subpair-inner { background: #000; }
#subpair-root.subpair-overlay .subpair-side { position: fixed; top: ${CLUSTER_TOP}px; right: calc(var(--subpair-panel, 0px) + 10px); display: flex; flex-direction: row; gap: 4px;
  padding: 4px; background: rgba(0,0,0,.55); border-radius: 8px; opacity: .4; pointer-events: auto; z-index: 2147483001; }
#subpair-root.subpair-overlay .subpair-side:first-child { right: calc(var(--subpair-panel, 0px) + ${4 * BUTTON + 5 * 4 + 30}px); }
#subpair-root.subpair-overlay .subpair-side:hover, #subpair-root.subpair-overlay .subpair-side:focus-within { opacity: 1; }
/* A line with no text draws nothing: its box has padding and a background, which would show as a small dark dash. */
#subpair-root .subpair-inner:empty { display: none; }
/* Quick settings menu (the gear): a dark list in the style of Jellyfin's own player menu. */
#subpair-menu { position: fixed; right: calc(var(--subpair-panel, 0px) + 10px); bottom: calc(var(--subpair-bar, 120px) + 10px); width: 330px; max-height: 70vh; overflow-y: auto;
  background: #1c1c20; color: #e8e8ee; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.6); z-index: 2147483002; padding: 6px 0; font: 14px/1.3 ${FONTS}; }
#subpair-menu[hidden] { display: none; }
#subpair-root.subpair-overlay #subpair-menu { bottom: auto; top: ${CLUSTER_TOP + 50}px; }
#subpair-menu button { all: unset; box-sizing: border-box; cursor: pointer; }
#subpair-menu .subpair-mhead { display: flex; align-items: center; gap: 6px; padding: 4px 12px 8px; font-weight: 600; border-bottom: 1px solid #2c2c33; margin-bottom: 4px; }
#subpair-menu .subpair-mback { padding: 0 10px; border-radius: 6px; font-size: 20px; line-height: 26px; }
#subpair-menu .subpair-mback:hover, #subpair-menu .subpair-mrow:hover { background: #2a2a31; }
#subpair-menu .subpair-mrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 9px 14px; }
#subpair-menu .subpair-mlabel { display: flex; align-items: center; min-width: 0; }
#subpair-menu .subpair-mcheck { display: inline-block; width: 20px; color: #6c8cff; }
#subpair-menu .subpair-mval { color: #9a9aa6; font-size: 13px; text-align: right; }
#subpair-menu .subpair-mval.armed { color: #e0b050; }
#subpair-menu .subpair-mstep { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 14px; }
#subpair-menu .subpair-mnote { padding: 6px 14px 8px; color: #e0b050; font-size: 12.5px; line-height: 1.4; }
#subpair-menu .subpair-mgroup { padding: 8px 14px 2px; color: #9a9aa6; font-size: 12px; border-top: 1px solid #2c2c33; margin-top: 4px; }
#subpair-menu .subpair-mbox { display: flex; align-items: center; gap: 8px; }
#subpair-menu .subpair-mnum { min-width: 70px; text-align: center; font-variant-numeric: tabular-nums; }
#subpair-menu .subpair-sbtn { width: 28px; height: 28px; border-radius: 6px; background: #2a2a31; text-align: center; line-height: 28px; font-size: 16px; }
#subpair-menu .subpair-sbtn:hover { background: ${ACCENT}; }
/* The browser's own rendering of a <track> the site may have turned on. */
video::cue { visibility: hidden; }
`;

// Hides the site's own subtitle renderers (from the adapter) while Subpair shows the lines.
export const hideRule = (selectors) => (selectors.length ? `${selectors.join(', ')} { display: none !important; }\n` : '');

