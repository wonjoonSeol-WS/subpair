// A short fingerprint of a list of subtitle texts (cyrb53), shared by the extension and the bridge: a saved translation
// records the fingerprint of the lines it was made from, so a player can tell whether its main track is still the same one.
// Not cryptographic; it only has to tell two subtitle files apart.
export function textsHash(texts) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const s = texts.join('\n');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
