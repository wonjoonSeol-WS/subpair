// Navigation over the main subtitle track (previous / repeat / next) and auto-pause bookkeeping.
const EPS = 0.05;

export class Timeline {
  // cues: sorted by start time; their times never change afterwards (a translation only fills in text).
  constructor(cues) {
    this.cues = cues;
    // reach[i]: the latest end among cues 0..i, so a lookup can stop at the first earlier cue that cannot still be on screen.
    this.reach = [];
    let latest = -Infinity;
    for (const c of cues) this.reach.push((latest = Math.max(latest, c.end)));
  }

  // Indexes of every cue active at time t (overlaps happen with signs/songs and two speakers), ascending.
  // Called every frame, so it searches instead of scanning the whole list.
  activeIndices(t) {
    let lo = 0, hi = this.cues.length;               // first cue starting after t
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start > t) hi = mid; else lo = mid + 1;
    }
    const out = [];
    for (let i = lo - 1; i >= 0 && this.reach[i] > t; i--) if (t < this.cues[i].end) out.push(i);
    return out.reverse();
  }

  // The "primary" active cue (the one that started first, usually the dialogue), or -1.
  // Navigation and auto-pause follow this one; the display can show all of activeIndices().
  activeIndex(t) {
    const all = this.activeIndices(t);
    return all.length ? all[0] : -1;
  }

  // Index of the cue active at t, else the last one that started before t, else -1.
  currentIndex(t) {
    const a = this.activeIndex(t);
    if (a >= 0) return a;
    let last = -1;
    for (let i = 0; i < this.cues.length && this.cues[i].start <= t; i++) last = i;
    return last;
  }

  // Start time to seek to for "repeat": the active cue, or the most recent one.
  repeatTarget(t) {
    const i = this.currentIndex(t);
    return i < 0 ? null : this.cues[i].start;
  }

  nextTarget(t) {
    const c = this.cues.find((x) => x.start > t + EPS);
    return c ? c.start : null;
  }

  prevTarget(t) {
    const i = this.currentIndex(t);
    if (i < 0) return null;
    // Inside cue i: go to the cue before it. In a gap after cue i: go back to cue i.
    const inside = this.activeIndex(t) === i;
    const target = inside ? i - 1 : i;
    return target < 0 ? null : this.cues[target].start;
  }
}

// Auto-pause: pause once per cue just before it ends.
export class AutoPause {
  constructor() {
    this.pausedFor = -1;
  }

  reset() {
    this.pausedFor = -1;
  }

  // Returns true if playback should be paused now.
  shouldPause(timeline, t) {
    const i = timeline.activeIndex(t);
    if (i < 0) return false;
    if (i !== this.pausedFor && t >= timeline.cues[i].end - 0.1) {
      this.pausedFor = i;
      return true;
    }
    return false;
  }
}
