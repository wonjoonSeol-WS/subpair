// The bridge's one list of translators, all behind one shape so the rest of the bridge needs no per-backend code:
//   chunk, concurrency, context   cues per call, calls at once, earlier cues sent along
//   model                         null, or { default: the configured model, shipped: the one in config.defaults.json }
//   ready()                       false | true | [pairs], what /health reports; setup is the error code when it is false
//   supports(pair)                can it do this language pair? limit is [name, pairs], shown when it cannot
//   translate(texts, before, pair, model) -> translated strings, same length and order ('' for a line it gave up on)
//   close?()                      stops anything it started
import { EzTrans, EZTRANS_PAIRS } from './eztrans.mjs';
import { translateChunk } from './llm.mjs';
import { askClaude, claudeProbe } from './claude.mjs';
import { askApi } from './api.mjs';
import { askOpenai, openaiReady } from './openai.mjs';
import { loadDefaults } from '../config.mjs';

// The name of the line cache (and saved file) for a backend and model. The shipped default model keeps the plain backend
// name, so caches and titles saved before models were part of the name stay in use.
export function cacheIdFor(name, model, shippedModel) {
  if (!model || model === shippedModel) return name;
  return `${name}-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;
}

export function createBackends(cfg, { ez = new EzTrans(cfg.eztrans), defaults = loadDefaults() } = {}) {
  const llm = (name, ask, ready, setup) => {
    const sub = cfg[name];
    return {
      chunk: sub.batch, concurrency: sub.concurrency, context: sub.context, ready, setup,
      model: { default: sub.model, shipped: defaults[name].model },
      supports: () => true,
      translate: (texts, before, pair, model) => translateChunk((system, user) => ask({ ...sub, model }, system, user, cfg.llm), texts, before, pair,
        { attempts: cfg.llm.attempts, context: sub.context, splitDepth: cfg.llm.splitDepth }),
    };
  };
  return {
    eztrans: {
      chunk: cfg.eztrans.chunk, concurrency: 1, context: 0, model: null,
      ready: () => (EzTrans.available(cfg.eztrans) ? EZTRANS_PAIRS : false),
      setup: 'eztrans_not_configured',
      supports: EzTrans.supports, limit: ['ezTrans', EZTRANS_PAIRS.map((p) => p.replace('-', ' -> ')).join(', ')],
      translate: (texts) => ez.translateAll(texts),
      close: () => ez.close(),
    },
    claude: llm('claude', askClaude, claudeProbe(cfg.claude), 'claude_missing'),
    api: llm('api', askApi, () => !!cfg.api.key, 'api_key_missing'),
    openai: llm('openai', askOpenai, () => openaiReady(cfg.openai), 'openai_not_configured'),
  };
}

export function closeBackends(backends) {
  for (const b of Object.values(backends)) if (typeof b.close === 'function') b.close();
}
