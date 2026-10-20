// Lazy loader for the Japanese morphological analyzer (kuromoji + IPADIC, ~17 MB). Only used when a profile's
// main or sub language is Japanese; until it is ready the UI falls back to the browser's Intl.Segmenter.
import { chunkTokens } from './ja.js';

let loading = null;

export function loadJapanese() {
  if (!loading) {
    loading = (async () => {
      await import(chrome.runtime.getURL('vendor/kuromoji/kuromoji.js'));
      const kuromoji = globalThis.kuromoji;
      if (!kuromoji) throw new Error('kuromoji did not initialise');
      return new Promise((resolve, reject) => {
        kuromoji.builder({ dicPath: chrome.runtime.getURL('vendor/kuromoji/dict/') })
          .build((err, tokenizer) => (err ? reject(err) : resolve(tokenizer)));
      });
    })();
    loading.catch(() => { loading = null; });   // allow a retry after a failure
  }
  return loading;
}

// Returns a function text -> [{ text, word, cat, base }] for the UI.
export function japaneseSegmenter(tokenizer) {
  return (text) => chunkTokens(tokenizer.tokenize(text));
}
