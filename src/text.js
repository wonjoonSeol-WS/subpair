// Display-time cleanup of a subtitle cue's text.
const JOIN_WITHOUT_SPACE = new Set(['ja', 'zh']);

// A speaker/sound tag at the start of a line, e.g. （魔王タソガレ） or (Alice). Only removed when text follows it.
const SPEAKER_TAG = /^\s*[（(][^）)\n]{1,24}[）)]\s*(?=\S)/;
const TAG_ONLY = /^\s*[（(][^）)\n]{1,24}[）)]\s*$/;

// opts: { lang, joinLines, hideSpeaker }
export function cleanText(text, { lang = '', joinLines = false, hideSpeaker = false } = {}) {
  let lines = String(text).split('\n');
  if (hideSpeaker) {
    // Drop a tag in front of text, and lines that are only a tag (a speaker label on its own line) when real text remains.
    // A cue that is only a tag, such as a sound effect （破く音）, is left alone.
    const textual = lines.map((l) => l.replace(SPEAKER_TAG, '')).filter((l) => l.trim() && !TAG_ONLY.test(l));
    if (textual.length) lines = textual;
  }
  lines = lines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return String(text).trim();
  return joinLines ? lines.join(JOIN_WITHOUT_SPACE.has(lang) ? '' : ' ') : lines.join('\n');
}
