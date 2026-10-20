// Builds the extension for a browser: its manifest as manifest.json, plus every file the extension can load.
//   node scripts/build-firefox.mjs          -> dist/firefox/ (manifest.firefox.json)
//   node scripts/build-firefox.mjs chrome   -> dist/chrome/  (manifest.json; Chrome can also load the project folder itself)
// The file list is followed from the manifest (scripts, pages, icons), each page's scripts and each script's imports and
// chrome.runtime.getURL() paths, so a new file needs no list here. A vendored package is copied whole (its data and license).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALWAYS = ['LICENSE'];
const VENDOR = 'vendor';

const JS_REFS = [
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,   // import x from '...', export { x } from '...'
  /\bimport\s*['"]([^'"]+)['"]/g,                             // import '...'
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,                      // import('...')
];
const URL_REFS = /\bgetURL\(\s*['"]([^'"]+)['"]\s*\)/g;      // chrome.runtime.getURL('...'): relative to the extension root
const HTML_REFS = /\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/g;

const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
const isUrl = (ref) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);

function manifestFiles(m) {
  const icons = (v) => (typeof v === 'string' ? [v] : Object.values(v || {}));
  return [
    ...((m.background && m.background.scripts) || []),                       // Firefox
    ...(m.background && m.background.service_worker ? [m.background.service_worker] : []),   // Chrome
    ...(m.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...(m.options_ui ? [m.options_ui.page] : []),
    ...icons(m.icons),
    ...icons(m.action && m.action.default_icon),
    ...(m.action && m.action.default_popup ? [m.action.default_popup] : []),
  ];
}

// Relative paths (from the extension root) of every file reachable from `entries`.
export function reachableFiles(entries) {
  const found = new Set();
  const queue = [...entries];
  const add = (p) => {
    const abs = path.resolve(root, p);
    if (!abs.startsWith(root + path.sep)) throw new Error(`${p} is outside the extension folder`);
    if (!fs.existsSync(abs)) throw new Error(`${p} is referenced but does not exist`);
    const r = rel(abs);
    if (r.split('/')[0] === VENDOR) {                               // vendor/<package>/...: the whole package folder
      const pkg = r.split('/').slice(0, 2).join('/');
      if (!found.has(pkg)) found.add(pkg);
      return;
    }
    if (found.has(r)) return;
    found.add(r);
    queue.push(r);
  };
  for (const e of entries) add(e);
  while (queue.length) {
    const file = queue.shift();
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const dir = path.posix.dirname(file);
    if (/\.html?$/i.test(file)) {
      for (const [, ref] of text.matchAll(HTML_REFS)) if (!isUrl(ref)) add(path.posix.join(dir, ref));
    } else if (/\.m?js$/i.test(file)) {
      for (const re of JS_REFS) for (const [, ref] of text.matchAll(re)) if (ref.startsWith('.')) add(path.posix.join(dir, ref));
      for (const [, ref] of text.matchAll(URL_REFS)) add(ref);
    }
  }
  return [...found].sort();
}

const MANIFESTS = { firefox: 'manifest.firefox.json', chrome: 'manifest.json' };

export function buildExtension(browser, out = path.join(root, 'dist', browser)) {
  const manifestFile = MANIFESTS[browser];
  if (!manifestFile) throw new Error(`unknown browser ${browser}`);
  out = path.resolve(out);
  if (out === root || root.startsWith(out + path.sep)) throw new Error(`refusing to build into ${out}: it would delete the sources`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestFile), 'utf8'));
  const locales = manifest.default_locale ? ['_locales'] : [];      // the browser reads every _locales/<lang>/messages.json
  const files = [...reachableFiles(manifestFiles(manifest)), ...locales, ...ALWAYS];
  fs.rmSync(out, { recursive: true, force: true });
  for (const f of files) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
  fs.copyFileSync(path.join(root, manifestFile), path.join(out, 'manifest.json'));
  return out;
}

export const buildFirefox = (out) => buildExtension('firefox', out);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('built', buildExtension(process.argv[2] || 'firefox'));
