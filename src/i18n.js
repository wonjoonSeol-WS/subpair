// User-facing text in the browser's language: the standard extension i18n, one _locales/<lang>/messages.json per language
// (en, ko, ja). Messages use $1, $2... for the values passed in. In Node (the tests) there is no chrome.i18n, so the English
// file is read directly; a key missing everywhere comes back as itself, which makes it easy to spot.
const browserI18n = globalThis.chrome && globalThis.chrome.i18n && typeof globalThis.chrome.i18n.getMessage === 'function' ? globalThis.chrome.i18n : null;

let english = null;
if (!browserI18n && typeof process !== 'undefined' && process.versions && process.versions.node) {
  const { readFileSync } = await import('node:fs');
  english = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
}

const substitute = (text, subs) => text.replace(/\$(\d)/g, (m, n) => (subs[n - 1] === undefined ? m : String(subs[n - 1])));

export function t(key, ...subs) {
  const values = subs.map(String);
  if (browserI18n) return browserI18n.getMessage(key, values) || key;
  const entry = english && english[key];
  return entry ? substitute(entry.message, values) : key;
}

// The language the UI is shown in ("ko", "ja", "en"...), for naming languages and the like.
export const uiLanguage = () => (browserI18n && browserI18n.getUILanguage ? browserI18n.getUILanguage() : 'en');
