// The translators the bridge offers, as the extension knows them: the one list the profile, the options page, the quick
// menu and the live translator read. The bridge's own list is bridge/backends/index.mjs.
//   mode:       when to translate under "Automatic": live (a few lines ahead) for a fast local engine, else the whole title first
//   liveWindow: cues per live request
//   model:      a hint for the options page's model box, or null when the translator has no model to choose
import { t } from './i18n.js';

export const BACKENDS = Object.freeze([
  { id: 'eztrans', name: 'ezTrans', label: t('backendEztrans'), mode: 'live', liveWindow: 8, model: null },
  { id: 'claude', name: 'Claude', label: t('backendClaude'), mode: 'process', liveWindow: 30, model: t('modelHintClaude') },
  { id: 'api', name: 'Anthropic API', label: t('backendApi'), mode: 'process', liveWindow: 30, model: t('modelHintApi') },
  { id: 'openai', name: t('nameOpenai'), label: t('backendOpenai'), mode: 'process', liveWindow: 30, model: t('modelHintOpenai') },
].map(Object.freeze));

// The profile's backend may also be 'auto': the first of BACKENDS the bridge reports ready for the language pair.
export const AUTO = 'auto';
export const BACKEND_IDS = BACKENDS.map((b) => b.id);
export const backendInfo = (id) => BACKENDS.find((b) => b.id === id) || null;
export const backendName = (id) => (id === AUTO ? t('automatic') : backendInfo(id)?.name || id);

// A model name the bridge will accept (it checks the same pattern); '' means the bridge's configured default.
export const MODEL_RE = /^[\w.:/-]{1,100}$/;

// Can the bridge translate from -> to with this translator? Its /health answer lists each one as true/false or as the
// pairs it can do ("ja-ko"), and each model-based one's configured model: one with no model needs the profile to name one.
export function canTranslate(health, id, from, to, model = '') {
  const can = health && health.backends ? health.backends[id] : false;
  const ready = Array.isArray(can) ? can.includes(`${from}-${to}`) : can === true;
  const models = (health && health.models) || {};
  return ready && !(Object.hasOwn(models, id) && !models[id] && !model);
}

// The translator to use: the chosen one, or under 'auto' the first ready for the pair; null when none is.
//   models: the profile's model per translator ({ claude: 'sonnet' })
export function pickBackend(choice, health, from, to, models = {}) {
  const ok = (id) => canTranslate(health, id, from, to, models[id] || '');
  if (choice !== AUTO) return ok(choice) ? choice : null;
  return BACKEND_IDS.find(ok) || null;
}
