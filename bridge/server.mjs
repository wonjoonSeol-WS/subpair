// Local translation bridge for the browser extension. Listens on 127.0.0.1 only.
//   GET  /health                   { ok, backends: which are usable, models: each backend's configured model }
//   POST /line {backend, texts, to, from?, model?, context?, client?, gen?}
//        translate a few lines now (live mode). 200 {texts, stale} when done within limits.lineWaitMs, else 202 {pending: id}.
//        gen is a seek counter compared only with earlier requests of the same client: older work stops between chunks.
//   GET  /line/:id                 the same answer for a pending request (202 again while it runs, 404 once gone)
//   POST /line/cancel {client}     stop that client's unfinished requests
//   POST /jobs {key, title, backend, cues, to, from?, model?, fresh?}   translate a whole title in the background, then save it
//   GET  /jobs/:key?to=&from=&backend=&model=          {state, done, total, error, backend, model, from, to, fresh, skipped}
//   POST /jobs/:key/cancel?to=&from=&backend=&model=
//   GET  /subs/:key                what is saved for a title: { title, entries: { id: { file, from, to, backend, model, ... } } }
//   GET  /subs/:key/:file          a saved .srt listed in those entries
//   GET  /subs/:key/:to/:backend?from=&model=           the saved .srt for a target language and backend
// A missing `from` is config "from"; a missing `model` is the backend's configured model. Live lines and jobs share one
// queue (live first) and one line cache per pair, backend and model.
// Requests must carry a loopback Host and either no Origin (curl) or an allowed extension Origin; see http.mjs.
// Exit code: 0 when stopped on purpose (a signal), 1 when it cannot start or listen.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadDefaults, defaultStoreDir, LEGACY_STORE_DIR } from './config.mjs';
import { BridgeError, errorBody, messageOf } from './errors.mjs';
import { Store, migrateLegacyStore } from './store.mjs';
import { createBackends, closeBackends } from './backends/index.mjs';
import { EZTRANS_ENGINE, findEztransDir, isEztransDir } from './backends/eztrans.mjs';
import { WorkQueue } from './queue.mjs';
import { createTranslator } from './translate.mjs';
import { createLineRequests } from './lines.mjs';
import { createJobs } from './jobs.mjs';
import { createValidators } from './validate.mjs';
import { createHttpServer } from './http.mjs';

const ok = (body) => ({ status: 200, body });
const srtOr404 = (srt) => (srt ? { status: 200, body: srt, type: 'text/plain' } : { status: 404, body: errorBody(new BridgeError(404, 'not_saved')) });

// overrides.backends replaces the real translators (tests).
export function createBridge(cfg = loadConfig(), overrides = {}) {
  const backends = overrides.backends || createBackends(cfg);
  const withModel = Object.entries(backends).filter(([, b]) => b.model);
  // Each config section with a model, as shipped: the model of titles saved before the model was recorded.
  const shippedModels = Object.fromEntries(Object.entries(loadDefaults())
    .filter(([, s]) => s && typeof s === 'object' && typeof s.model === 'string').map(([name, s]) => [name, s.model]));
  const store = new Store(cfg.storeDir, { defaultFrom: cfg.from, shippedModels });
  const queue = new WorkQueue((key) => (backends[key] ? backends[key].concurrency : 1));
  const translator = createTranslator({ store, backends, queue });
  const lines = createLineRequests({ translator, limits: cfg.limits });
  const jobs = createJobs({ translator, store, limits: cfg.limits });
  const v = createValidators(cfg, backends);
  const L = cfg.limits;

  const health = () => ok({
    ok: true,
    backends: Object.fromEntries(Object.entries(backends).map(([name, b]) => [name, b.ready()])),
    models: Object.fromEntries(withModel.map(([name, b]) => [name, b.model.default || ''])),
  });

  const routes = [
    { method: 'GET', path: 'health', handle: health },
    { method: 'POST', path: 'line', body: L.bodyBytesLine, handle: ({ body }) => lines.start(v.lineRequest(body)) },
    { method: 'POST', path: 'line/cancel', body: L.bodyBytesLine, handle: ({ body }) => ok(lines.cancel(v.clientOf(body.client))) },
    { method: 'GET', path: 'line/:id', handle: ({ params }) => lines.poll(params.id) },
    { method: 'POST', path: 'jobs', body: L.bodyBytesJobs, handle: ({ body }) => ok(jobs.start(v.jobRequest(body))) },
    { method: 'GET', path: 'jobs/:key', handle: ({ params, query }) => ok(jobs.get(v.keyOf(params.key), v.jobLookup(query))) },
    { method: 'POST', path: 'jobs/:key/cancel', handle: ({ params, query }) => ok(jobs.cancel(v.keyOf(params.key), v.jobLookup(query))) },
    { method: 'GET', path: 'subs/:key', handle: ({ params }) => ok(store.meta(v.keyOf(params.key)) || { entries: {} }) },
    { method: 'GET', path: 'subs/:key/:file', handle: ({ params }) => srtOr404(store.loadFile(v.keyOf(params.key), params.file)) },
    {
      method: 'GET', path: 'subs/:key/:to/:backend',
      handle: ({ params, query }) => {
        const want = v.subsLookup(params.to, params.backend, query);
        const b = backends[want.backend];
        return srtOr404(store.loadSubtitle(v.keyOf(params.key), want, b && b.model ? b.model.default : ''));
      },
    },
  ];
  const server = createHttpServer({ routes, allowedOrigins: cfg.allowedOrigins });

  return {
    server, store, cfg, queue,
    closeBackends: () => closeBackends(backends),
    close() { closeBackends(backends); server.closeAllConnections(); server.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let b;
  try {
    const cfg = loadConfig();
    if (cfg.storeDir === defaultStoreDir()) cfg.storeDir = migrateLegacyStore(LEGACY_STORE_DIR, cfg.storeDir);
    if (process.platform === 'win32' && !cfg.eztrans.dir) cfg.eztrans.dir = findEztransDir();
    b = createBridge(cfg);
  } catch (e) { console.error(`bridge: ${messageOf(e)}`); process.exit(1); }
  b.server.on('error', (e) => { console.error(`bridge: cannot listen on 127.0.0.1:${b.cfg.port}: ${messageOf(e)}`); b.close(); process.exit(1); });
  b.server.listen(b.cfg.port, '127.0.0.1', () => {
    console.log(`bridge on http://127.0.0.1:${b.cfg.port}, saving to ${b.cfg.storeDir}`);
    const ez = b.cfg.eztrans.dir;
    if (process.platform === 'win32') {
      console.log(isEztransDir(ez) ? `bridge: ezTrans XP in ${ez}`
        : ez ? `bridge: no ezTrans XP engine (${EZTRANS_ENGINE}) in ${ez}; check eztrans.dir in bridge/config.json`
          : 'bridge: ezTrans XP not found; set eztrans.dir in bridge/config.json if it is installed');
    }
    if (!b.cfg.allowedOrigins.length) console.log('bridge: any browser extension may call this bridge; set allowedOrigins in bridge/config.json (see config.example.json)');
  });
  const shutdown = () => { b.close(); process.exit(0); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);
  process.on('exit', () => b.closeBackends());                       // never leave the 32-bit ezTrans helper running
  // One failed request must not take live translation down for every open player.
  process.on('unhandledRejection', (e) => console.error('bridge: unhandled rejection:', e));
}
