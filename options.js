import { loadSettings, saveSettings } from './src/storage.js';
import { sanitizeSettings, newProfile, newProfileId, isConfigured, keyToken, listOf, LIMITS, DEFAULT_BRIDGE } from './src/profile.js';
import { LANGUAGES, langLabel, normLang } from './src/lang.js';
import { BACKENDS, AUTO } from './src/backends.js';
import { allowedSites, forgetSite, onSitesChanged } from './src/prefs.js';
import { callBridge } from './src/bridge.js';
import { t, uiLanguage } from './src/i18n.js';

const $ = (id) => document.getElementById(id);
let settings;
let dirty = false;                       // edited here since the last load or save

// Language pickers: first choice + two fallbacks, as dropdowns.
const SLOTS = [t('optSlotFirst'), t('optSlotFallback'), t('optSlotFallback2')];
const named = (code) => `${langLabel(code)} (${code})`;
const browserLang = () => normLang(navigator.language || '');

function buildLangSelects(container, id) {
  container.innerHTML = '';
  SLOTS.forEach((slot, i) => {
    const s = document.createElement('select');
    s.id = `${id}${i}`;
    s.setAttribute('aria-label', `${id === 'main' ? t('optMainLine') : t('optSecondLine')}: ${slot}`);
    const none = document.createElement('option');
    none.value = ''; none.textContent = i === 0 && id === 'main' ? t('optChooseLanguage') : t('optNoLanguage');
    s.appendChild(none);
    for (const code of LANGUAGES) {
      const o = document.createElement('option');
      o.value = code; o.textContent = named(code);
      s.appendChild(o);
    }
    container.appendChild(s);
  });
}

function setLangs(id, codes) {
  for (let i = 0; i < SLOTS.length; i++) {
    const s = $(`${id}${i}`);
    const code = codes[i] || '';
    if (code && ![...s.options].some((o) => o.value === code)) {   // a code from an imported profile that is not in the list
      const o = document.createElement('option');
      o.value = code; o.textContent = code;
      s.appendChild(o);
    }
    s.value = code;
  }
}

const getLangs = (id) => [...new Set(SLOTS.map((_, i) => $(`${id}${i}`).value).filter(Boolean))];
const current = () => settings.profiles.find((p) => p.id === settings.activeProfile);

function buildTranslatorControls() {
  const sel = $('trBackend');
  for (const [value, label] of [[AUTO, t('automaticFirstReady')], ...BACKENDS.map((b) => [b.id, b.label])]) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  }
  $('trBridge').placeholder = DEFAULT_BRIDGE;
  for (const b of BACKENDS.filter((x) => x.model)) {
    const div = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.htmlFor = input.id = `model-${b.id}`;
    label.textContent = t('optModelFor', b.name);
    input.type = 'text';
    input.dataset.model = b.id;
    input.placeholder = b.model;
    div.append(label, input);
    $('models').appendChild(div);
  }
}

// The bridge's own model for each translator, as the placeholder of an empty model box.
async function showBridgeModels(bridge) {
  const h = await callBridge(bridge, '/health');
  const models = (h.ok && h.json && h.json.models) || {};
  for (const el of document.querySelectorAll('[data-model]')) {
    const own = models[el.dataset.model];
    el.placeholder = own ? t('optBridgeDefault', own) : BACKENDS.find((b) => b.id === el.dataset.model).model;
  }
}

function setLimits() {
  const range = { mainFont: LIMITS.font, subFont: LIMITS.font, mainLines: LIMITS.lines, subLines: LIMITS.lines, subtitleGap: LIMITS.gap, lineGap: LIMITS.lineGap };
  for (const [id, [lo, hi]] of Object.entries(range)) { $(id).min = lo; $(id).max = hi; }
}

const NUMBERS = ['mainFont', 'subFont', 'mainLines', 'subLines', 'subtitleGap', 'lineGap'];
const CHECKS = ['panel', 'joinLines', 'panelTimes', 'hideSpeaker', 'autoPause', 'colorize'];
const CHOICES = ['pictureAlign', 'textPlacement', 'subtitleBackground'];

function fill() {
  const p = current();
  $('profile').innerHTML = '';
  for (const x of settings.profiles) {
    const o = document.createElement('option');
    o.value = x.id; o.textContent = x.name; o.selected = x.id === p.id;
    $('profile').appendChild(o);
  }
  $('name').value = p.name;
  // First run: nothing chosen yet. The second line suggests the browser's own language; nothing is saved until Save.
  const firstRun = !isConfigured(p);
  $('firstRun').hidden = !firstRun;
  setLangs('main', p.main);
  setLangs('sub', firstRun && !p.sub.length && LANGUAGES.includes(browserLang()) ? [browserLang()] : p.sub);
  for (const f of NUMBERS) $(f).value = p[f];
  for (const f of CHECKS) $(f).checked = p[f];
  for (const f of CHOICES) $(f).value = p[f];
  $('trBackend').value = p.translate.backend;
  $('trMode').value = p.translate.mode;
  $('trBridge').value = p.translate.bridge;
  for (const el of document.querySelectorAll('[data-model]')) el.value = p.translate.models[el.dataset.model] || '';
  for (const el of document.querySelectorAll('[data-color]')) el.value = p.colors[el.dataset.color];
  for (const el of document.querySelectorAll('[data-key]')) el.value = (p.keys[el.dataset.key] || []).join(', ');
  $('changedElsewhere').hidden = true;
  dirty = false;
}

function collect() {
  const p = current();
  p.name = $('name').value.trim() || 'Profile';
  p.main = getLangs('main');
  p.sub = getLangs('sub');
  const num = (id) => ($(id).value.trim() === '' ? NaN : Number($(id).value));       // an empty box is "empty", not 0
  for (const f of NUMBERS) p[f] = num(f);
  for (const f of CHECKS) p[f] = $(f).checked;
  for (const f of CHOICES) p[f] = $(f).value;
  const models = {};
  for (const el of document.querySelectorAll('[data-model]')) models[el.dataset.model] = el.value.trim();
  p.translate = { backend: $('trBackend').value, mode: $('trMode').value, bridge: $('trBridge').value.trim(), models };
  for (const el of document.querySelectorAll('[data-color]')) p.colors[el.dataset.color] = el.value;
  for (const el of document.querySelectorAll('[data-key]')) p.keys[el.dataset.key] = listOf(el.value, []).map(keyToken);
}

// A key bound to two actions would only ever do the first.
const KEY_LABELS = { prev: t('optKeyPrev'), repeat: t('optKeyRepeat'), next: t('optKeyNext'), autopause: t('optKeyAutoPause') };
function keyClash(p) {
  const seen = new Map();
  for (const [act, keys] of Object.entries(p.keys)) {
    for (const k of keys) {
      if (seen.has(k) && seen.get(k) !== act) return t('optKeyClash', k, KEY_LABELS[seen.get(k)], KEY_LABELS[act]);
      seen.set(k, act);
    }
  }
  return '';
}

let flashTimer = 0;
function flash(msg, error = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', error);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('status').textContent = ''; }, Math.max(2500, msg.length * 90));   // longer messages stay longer
}

async function save() {
  collect();
  const requested = structuredClone(current());
  const clash = keyClash(requested);
  if (clash) return flash(t('optNotSaved', clash), true);
  try {
    const where = await saveSettings(settings);
    settings = await loadSettings();               // shows the values as they were validated (clamped, cleaned)
    fill();
    const notes = [];
    const LABELS = { mainFont: t('optMainFont'), subFont: t('optSubFont'), mainLines: t('optMainLines'), subLines: t('optSubLines'), subtitleGap: t('optGap'), lineGap: t('optLineGap') };
    for (const [k, label] of Object.entries(LABELS)) {
      const got = current()[k];
      if (requested[k] !== got) notes.push(t('optNotAllowed', label, Number.isFinite(requested[k]) ? requested[k] : t('optWasEmpty'), got));
    }
    if (where === 'local') notes.push(t('optLocalOnly'));
    if (!requested.main.length) notes.push(t('optNoMain'));
    if (requested.translate.bridge.replace(/\/+$/, '') !== current().translate.bridge) notes.push(t('optBadBridge'));
    for (const [id, m] of Object.entries(requested.translate.models)) if (m !== current().translate.models[id]) notes.push(t('optBadModel', m, id));
    flash(notes.length ? t('optSavedWith', notes.join('; ')) : t('optSaved'));
    showBridgeModels(current().translate.bridge);
  } catch (e) {
    flash(t('optNotSaved', e.message), true);
  }
}

async function showSites() {
  const list = $('sites');
  list.textContent = '';
  const sites = await allowedSites();
  if (!sites.length) { const li = document.createElement('li'); li.textContent = t('optServersNone'); list.appendChild(li); return; }
  for (const origin of sites) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = origin;
    const b = document.createElement('button');
    b.textContent = t('optRemove');
    b.onclick = () => forgetSite(origin);
    li.append(code, b);
    list.appendChild(li);
  }
}

async function init() {
  document.documentElement.lang = uiLanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  buildLangSelects($('mainLangs'), 'main');
  buildLangSelects($('subLangs'), 'sub');
  buildTranslatorControls();
  setLimits();
  settings = await loadSettings();
  fill();
  showBridgeModels(current().translate.bridge);
  showSites();
  onSitesChanged(showSites);

  document.addEventListener('input', () => { dirty = true; });
  document.addEventListener('change', () => { dirty = true; });
  // Changes made in the player (the quick menu) while this page is open: shown at once unless there are edits here.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if ((area !== 'sync' && area !== 'local') || !changes.settings) return;
    if (dirty) { $('changedElsewhere').hidden = false; return; }
    settings = await loadSettings();
    fill();
  });
  $('reload').onclick = async () => { settings = await loadSettings(); fill(); };

  $('profile').onchange = () => { collect(); settings.activeProfile = $('profile').value; fill(); dirty = true; };
  $('add').onclick = () => {
    collect();
    const p = newProfile(newProfileId(), t('optNewProfileName'));
    settings.profiles.push(p);
    settings.activeProfile = p.id;
    fill();
    dirty = true;
  };
  $('dup').onclick = () => {
    collect();
    const copy = structuredClone(current());
    copy.id = newProfileId();
    copy.name = t('optCopySuffix', copy.name);
    settings.profiles.push(copy);
    settings.activeProfile = copy.id;
    fill();
    dirty = true;
  };
  $('del').onclick = () => {
    if (settings.profiles.length < 2) return flash(t('optKeepOne'), true);
    settings.profiles = settings.profiles.filter((p) => p.id !== settings.activeProfile);
    settings.activeProfile = settings.profiles[0].id;
    fill();
    dirty = true;
  };
  $('save').onclick = save;
  $('export').onclick = () => {
    collect();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }));
    a.download = 'subpair-profiles.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  $('import').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const file = $('file').files[0];
    $('file').value = '';                              // so choosing the same file again fires this again
    if (!file) return;
    try {
      const data = sanitizeSettings(JSON.parse(await file.text()));
      if (!data) throw new Error(t('optImportNoProfiles'));
      if (!window.confirm(t('optImportConfirm', settings.profiles.length, data.profiles.length))) return;
      await saveSettings(data);
      settings = await loadSettings();
      fill();
      flash(t('optImported'));
    } catch (e) {
      flash(t('optImportFailed', e.message), true);
    }
  };

  // Click a key box and press a key to add it; Backspace removes the last one; Tab moves on as usual.
  for (const el of document.querySelectorAll('[data-key]')) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      // A modifier on its own, or a key pressed with one, is never a shortcut: the player leaves those to the page.
      if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Escape'].includes(e.key) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const keys = listOf(el.value, []);
      if (e.key === 'Backspace') keys.pop();
      else if (!keys.includes(keyToken(e.key))) keys.push(keyToken(e.key));
      el.value = keys.join(', ');
      dirty = true;
    });
  }
}

init();
