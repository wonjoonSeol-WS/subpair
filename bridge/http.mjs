// The HTTP side of the bridge: who may call, routing, JSON bodies and replies. Routes are { method, path, body?, handle }:
// path segments starting with ':' are parameters, body is the size limit of a JSON body to read, and
// handle({ params, query, body }) returns { status, body, type? }.
import http from 'node:http';
import { BridgeError, errorBody } from './errors.mjs';

const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[A-Za-z0-9-]+$/;

const send = (res, status, body, type = 'application/json', extra = {}) => {
  // One request per connection: a local client gains nothing from keep-alive, and a pooled connection that outlives a
  // restarted bridge is a request that fails for no reason.
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', connection: 'close', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// Reads a JSON object body, decoded as UTF-8 over the whole stream (a character split across two network chunks survives).
// Beyond `limit` bytes the rest is ignored and the request answered with a 413.
const readJson = (req, limit) => new Promise((resolve, reject) => {
  if (Number(req.headers['content-length']) > limit) return reject(new BridgeError(413, 'body_too_large'));
  let s = '', bytes = 0;
  req.setEncoding('utf8');
  const onData = (d) => {
    bytes += Buffer.byteLength(d);
    if (bytes <= limit) { s += d; return; }
    req.off('data', onData);
    req.resume();                                  // keep draining so the 413 can be written; the connection closes after it
    reject(new BridgeError(413, 'body_too_large'));
  };
  req.on('data', onData);
  req.on('end', () => {
    try {
      const v = JSON.parse(s || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      resolve(v);
    } catch { reject(new BridgeError(400, 'body_not_json')); }
  });
  req.on('error', reject);
});

// A web page that rebinds its own DNS name to 127.0.0.1 is same-origin with the bridge and sends no Origin on GET, so the
// Host header is what tells it apart from the extension.
const loopbackHost = (req) => {
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(req.headers.host || '');
  return !!m && (!m[2] || Number(m[2]) === req.socket.localPort);
};

const decode = (v) => { try { return decodeURIComponent(v); } catch { throw new BridgeError(400, 'bad_url_escape'); } };

function match(route, parts) {
  const want = route.path.split('/');
  if (want.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = parts[i];
    else if (want[i] !== parts[i]) return null;
  }
  return params;
}

// allowedOrigins: exact extension origins; empty allows any extension (and always a client that sends no Origin, like curl).
export function createHttpServer({ routes, allowedOrigins = [] }) {
  const originAllowed = (o) => (allowedOrigins.length ? allowedOrigins.includes(o) : EXTENSION_ORIGIN.test(o));

  return http.createServer(async (req, res) => {
    try {
      if (!loopbackHost(req)) return send(res, 403, errorBody(new BridgeError(403, 'forbidden_host')));
      // Any web page can reach 127.0.0.1, and a job can spend API credit: only the extension may call from a browser.
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin)) return send(res, 403, errorBody(new BridgeError(403, 'forbidden_origin')));
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST');
        res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { throw new BridgeError(400, 'bad_request_target'); }
      const parts = url.pathname.split('/').filter(Boolean).map(decode);
      const found = routes.map((r) => ({ r, params: match(r, parts) })).filter((x) => x.params);
      const hit = found.find((x) => x.r.method === req.method);
      if (!hit) {
        if (!found.length) return send(res, 404, errorBody(new BridgeError(404, 'not_found')));
        return send(res, 405, errorBody(new BridgeError(405, 'method_not_allowed')), 'application/json', { allow: [...new Set(found.map((x) => x.r.method))].join(', ') });
      }
      const body = hit.r.body ? await readJson(req, hit.r.body) : undefined;
      const out = await hit.r.handle({ params: hit.params, query: url.searchParams, body });
      return send(res, out.status, out.body, out.type);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (!(e instanceof BridgeError)) console.error('bridge: request failed:', e);
      return send(res, e instanceof BridgeError ? e.status : 500, errorBody(e));
    }
  });
}
