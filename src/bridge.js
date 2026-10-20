// Client for the local translation bridge (bridge/server.mjs). Requests go through the extension's background worker
// (background.js), which is allowed to call localhost; a page script's own fetch would be blocked by the page's CORS rules.
import { TUNING } from './tuning.js';
import { t } from './i18n.js';

// A /line request (or the poll of one) waits on the bridge for up to its lineWaitMs; everything else is answered at once.
const LINE = /^\/line(\/[a-z0-9]+)?$/;
const timeoutFor = (path) => (LINE.test(path) ? TUNING.bridge.lineMs : TUNING.bridge.quickMs);

// Resolves { ok, status, json, text, error }; status 0 when the bridge is not running or does not answer in time.
export async function callBridge(base, path, body) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'bridge', base, path, method: body === undefined ? 'GET' : 'POST', body, timeoutMs: timeoutFor(path) });
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message ? e.message : e) };
  }
  if (!res) return { ok: false, status: 0, error: t('noWorkerAnswer') };
  let json = null;
  try { json = res.text ? JSON.parse(res.text) : null; } catch { /* plain text (an .srt) */ }
  return { ok: !!res.ok, status: res.status, json, text: res.text, error: res.error || bridgeMessage(json) };
}

// A bridge error ({ error, code, params }, an HTTP answer or a failed job) in the UI's language. A code this version does not
// know yet keeps the bridge's own English text.
export function bridgeMessage(body) {
  if (!body || typeof body !== 'object') return '';
  if (body.code) {
    const key = `bridgeErr_${body.code}`;
    const text = t(key, ...(Array.isArray(body.params) ? body.params : []));
    if (text !== key) return text;
  }
  return typeof body.error === 'string' ? body.error : '';
}

// The translations saved for a title (GET /subs/<key>) that fit a language pair. An entry without `from` predates the
// field and is taken as made from this source language.
export function savedEntries(meta, { from, to }) {
  return Object.values((meta && meta.entries) || {}).filter((e) => e && e.to === to && (!e.from || e.from === from));
}

// Where one of those entries' .srt is served.
export function savedUrl(key, entry) {
  const k = encodeURIComponent(key);
  if (entry.file) return `/subs/${k}/${encodeURIComponent(entry.file)}`;
  const q = new URLSearchParams();
  if (entry.from) q.set('from', entry.from);
  if (entry.model) q.set('model', entry.model);
  const query = q.toString();
  return `/subs/${k}/${encodeURIComponent(entry.to)}/${encodeURIComponent(entry.backend)}${query ? `?${query}` : ''}`;
}
