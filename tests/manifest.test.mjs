import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const chrome = read('manifest.json'), firefox = read('manifest.firefox.json');

test('both manifests describe the same extension', () => {
  for (const k of ['manifest_version', 'name', 'version', 'description', 'permissions', 'host_permissions', 'options_ui', 'web_accessible_resources']) {
    assert.deepEqual(firefox[k], chrome[k], k);
  }
});

test('content scripts match on the same pages and run the same code (Firefox adds only the shim)', () => {
  assert.equal(firefox.content_scripts.length, chrome.content_scripts.length);
  chrome.content_scripts.forEach((cs, i) => {
    const ff = firefox.content_scripts[i];
    assert.deepEqual(ff.matches, cs.matches);
    assert.equal(ff.run_at, cs.run_at);
    assert.equal(ff.world, cs.world);
    assert.deepEqual(ff.js.filter((f) => f !== 'shim.js'), cs.js);
  });
});

test('Firefox: event-page background with the shim first, an add-on id and a minimum version that has world MAIN', () => {
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.background.scripts, ['shim.js', 'background.js']);
  assert.equal(chrome.background.service_worker, 'background.js');
  assert.ok(firefox.browser_specific_settings.gecko.id.includes('@'));
  assert.ok(parseFloat(firefox.browser_specific_settings.gecko.strict_min_version) >= 128);   // content script "world": "MAIN"
  assert.equal(firefox.content_scripts[0].js[0], 'shim.js');
});

test('every file a manifest names exists', () => {
  for (const m of [chrome, firefox]) {
    const files = [...m.content_scripts.flatMap((c) => c.js), m.options_ui.page, ...(m.background.scripts || [m.background.service_worker])];
    for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

// Builds into a fresh temporary folder (never the repo's dist/, which a loaded temporary add-on may be using).
async function build() {
  const { buildFirefox } = await import('../scripts/build-firefox.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'subpair-firefox-'));
  return { out: buildFirefox(out), done: () => fs.rmSync(out, { recursive: true, force: true }) };
}

test('build:firefox copies what the extension loads, uses the Firefox manifest and leaves out tests, bridge and Chrome manifest', async () => {
  const { out, done } = await build();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(m, firefox);
    for (const f of ['shim.js', 'content.js', 'background.js', 'options.html', 'options.js', 'src/main.js', 'src/netflix-page.js', 'LICENSE',
      'vendor/kuromoji/kuromoji.js', 'vendor/kuromoji/dict/base.dat.gz', 'vendor/kuromoji/LICENSE-2.0.txt']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    for (const f of ['tests', 'bridge', 'node_modules', 'scripts', 'dist', 'manifest.firefox.json', 'package.json']) assert.ok(!fs.existsSync(path.join(out, f)), f);
    assert.equal(fs.readFileSync(path.join(out, 'src/main.js'), 'utf8'), fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'));
  } finally { done(); }
});

test('build:firefox: every file the built manifest, its pages and its modules refer to is in the build', async () => {
  const { out, done } = await build();
  try {
    const exists = (f) => assert.ok(fs.existsSync(path.join(out, f)), `missing in the build: ${f}`);
    const icons = (v) => (typeof v === 'string' ? [v] : Object.values(v || {}));
    for (const f of [...firefox.background.scripts, ...firefox.content_scripts.flatMap((c) => c.js), firefox.options_ui.page,
      ...icons(firefox.icons), ...icons(firefox.action && firefox.action.default_icon)]) exists(f);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    for (const file of walk(out).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}vendor${path.sep}`))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [, ref] of text.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]|\bimport\(\s*['"](\.[^'"]+)['"]/g)) {
        if (ref) assert.ok(fs.existsSync(path.resolve(path.dirname(file), ref)), `${path.relative(out, file)} imports ${ref}`);
      }
      for (const [, ref] of text.matchAll(/\bgetURL\(\s*['"]([^'"]+)['"]/g)) exists(ref);
    }
  } finally { done(); }
});

test('build:firefox refuses to build into the source folder', async () => {
  const { buildFirefox } = await import('../scripts/build-firefox.mjs');
  assert.throws(() => buildFirefox(root), /refusing/);
  assert.throws(() => buildFirefox(path.dirname(root)), /refusing/);
});
