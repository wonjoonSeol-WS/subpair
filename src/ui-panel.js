// The transcript panel: every main-line cue as a row; click (or Enter) seeks to it, the current one is highlighted and kept
// in view unless the user is scrolling. Words are colored during idle time, a slice at a time, so it never competes with playback.
const SCROLL_PAUSE_MS = 3000;        // after the user scrolls the panel, it is not scrolled for them for this long
const IDLE_TIMEOUT_MS = 600;
const SLICE_ROWS = 40;               // rows colored per slice when the browser has no idle callback

const formatTime = (t) => {
  const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS }) : setTimeout(() => fn(null), 16));

export function createPanel(panel, { onSeek }) {
  let rows = [], texts = [], active = -1, lastUserScroll = 0, token = 0;

  // Only real user input pauses auto-scrolling: our own scrollIntoView also fires 'scroll' events.
  for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) {
    panel.addEventListener(ev, () => { lastUserScroll = Date.now(); }, { passive: true });
  }
  panel.addEventListener('click', (e) => {
    const row = e.target.closest('.subpair-cue');
    if (row) onSeek(Number(row.dataset.t));
  });
  panel.addEventListener('keydown', (e) => {
    const row = e.target.closest('.subpair-cue');
    if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Number(row.dataset.t));
  });

  return {
    setCues(cues, { times }) {
      panel.textContent = '';
      rows = [];
      texts = cues.map((c) => c.text);
      for (const c of cues) {
        const d = document.createElement('div');
        d.className = 'subpair-cue';
        d.dataset.t = c.start;
        d.tabIndex = 0;
        d.setAttribute('role', 'button');
        if (times) {
          const time = document.createElement('span');
          time.className = 'subpair-time';
          time.textContent = formatTime(c.start);
          d.appendChild(time);
        }
        const text = document.createElement('span');
        text.className = 'subpair-ctext';
        text.textContent = c.text;
        d.appendChild(text);
        panel.appendChild(d);
        rows.push(d);
      }
      active = -1;
    },
    // Re-draws the rows' text as colored words with `segment` (text => [{ text, word, cat? }]).
    colorize(segment) {
      const mine = ++token;
      let i = 0;
      const slice = (deadline) => {
        if (mine !== token) return;                     // replaced by a newer run, or the panel was rebuilt
        let budget = SLICE_ROWS;
        while (i < texts.length && (deadline ? deadline.timeRemaining() > 3 : budget-- > 0)) {
          const holder = rows[i] && rows[i].querySelector('.subpair-ctext');
          if (holder) {
            holder.textContent = '';
            for (const seg of segment(texts[i])) {
              if (seg.word && seg.cat) {
                const w = document.createElement('span');
                w.className = `subpair-c-${seg.cat}`;
                w.textContent = seg.text;
                holder.appendChild(w);
              } else {
                holder.appendChild(document.createTextNode(seg.text));
              }
            }
          }
          i++;
        }
        if (i < texts.length) idle(slice);
      };
      idle(slice);
    },
    setActive(index) {
      if (index === active) return;
      if (rows[active]) rows[active].classList.remove('active');
      active = index;
      const el = rows[index];
      if (!el) return;
      el.classList.add('active');
      if (Date.now() - lastUserScroll > SCROLL_PAUSE_MS) el.scrollIntoView({ block: 'center' });
    },
    destroy() { token++; },
  };
}
