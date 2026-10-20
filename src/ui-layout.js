// Where things go on the page: the sizes of the bar, the panel and the buttons, and the arithmetic that places the text on
// the video. Pure (no DOM) so tests can reach it.
export const PANEL_W = 340;          // px, the transcript panel
export const LINE_H = 1.35;          // line height, in ems
export const TEXT_SIDE = 64;         // px kept free left and right of text on the video
export const MIN_TEXT_W = 240;       // px; on a narrow window the side margins give way before the text gets narrower
export const WINDOW_MARGIN = 4;      // px text on the video keeps from the window's bottom edge
export const BUTTON = 30, BUTTON_GAP = 6;
export const BAR_PAD = 24;           // px above and below the two lines in the bar
export const BAR_MIN = 2 * BUTTON + BUTTON_GAP + 12;      // the bar always fits two rows of buttons
export const CLUSTER_TOP = 60;       // px from the top for the buttons on the video and the notices (below the sites' top bars)
export const PICTURE_ALIGN_PCT = { top: 0, center: 50, bottom: 100 };

// Bottom edge of the picture inside a letterboxed <video> box (object-fit: contain), `alignPct` its vertical object-position.
export function pictureBottom(box, videoWidth, videoHeight, alignPct) {
  const shownH = Math.min(box.height, (box.width * videoHeight) / videoWidth);
  return box.top + ((box.height - shownH) * alignPct) / 100 + shownH;
}

// Top of the text block on the video: below the picture when a line of each fits above `lowest`, else just inside its bottom edge.
export function textTop({ pictureBottom: edge, lowest, height, gap, oneLineEach }) {
  const top = lowest - edge >= gap + oneLineEach ? edge + gap : edge - gap - height;
  return Math.max(0, Math.min(top, lowest - height));
}

// Left and right insets of the text on the video, for a window `windowWidth` wide with `panelPx` taken by the panel.
export function textSides(windowWidth, panelPx) {
  const side = Math.max(0, Math.min(TEXT_SIDE, (windowWidth - panelPx - MIN_TEXT_W) / 2));
  return { left: side, right: panelPx + side };
}

// Height of the bottom bar: the reserved lines of both languages, the space between them, and room for the buttons.
export function barHeight(p) {
  const main = p.hideMain ? 0 : p.mainLines * p.mainFont * LINE_H + p.lineGap;
  return Math.max(BAR_MIN, Math.round(main + p.subLines * p.subFont * LINE_H + BAR_PAD));
}

// The stylesheet that shrinks the site's player to the area the bar and the panel leave free, from the adapter's selectors:
// layout.player boxes get new edges (and lose any explicit size, which would otherwise win over the edges), layout.osd
// controls at the window's bottom are only lifted. `align` is where the picture sits inside its letterboxed box (percent).
// In fullscreen a site whose player box is itself the fullscreen element names a box inside it (layout.fullscreen): the
// browser's own :fullscreen rule pins the fullscreen element to the whole screen and wins over any page style.
export function layoutRule(layout, { bar, panel, align, fullscreen = false }) {
  const inner = fullscreen && layout.fullscreen && layout.fullscreen.length > 0;
  const boxes = inner ? layout.fullscreen : layout.player;
  const edges = `bottom:${bar}px !important;right:${panel}px !important;`;
  const place = inner ? 'position:absolute !important;top:0 !important;left:0 !important;' : '';
  return [
    ...boxes.map((s) => `${s}{${place}${edges}height:auto !important;width:auto !important;}`),
    ...layout.osd.map((s) => `${s}{${edges}}`),
    ...(boxes.length ? [`${boxes[0]} video{object-position:50% ${align}% !important;}`] : []),
  ].join('\n');
}
