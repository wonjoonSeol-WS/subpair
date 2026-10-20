// What the HTTP backends (Anthropic API, OpenAI-compatible) share: a POST that retries what is worth retrying.
// Retried: 408, 409, 429, every 5xx (529 is Anthropic's "overloaded"), network errors and timeouts. A retry waits for the
// server's retry-after if it sent one, else retryBaseMs doubling each time; never longer than retryMaxMs.
import { CodedError, backendError, backendMessage } from '../errors.mjs';

const EXCERPT = 300;                                 // characters of an error reply worth showing

export const excerpt = (text) => String(text).slice(0, EXCERPT);

// A reply with an error status. Its code is upstream_rate_limited for a 429, else upstream_error.
export class HttpStatusError extends CodedError {
  constructor(service, status, body) {
    const code = status === 429 ? 'upstream_rate_limited' : 'upstream_error', params = [service, status, excerpt(body)];
    super(code, params, backendMessage(code, params));
    this.status = status;
  }
}

const RETRY_STATUS = (s) => s === 408 || s === 409 || s === 429 || s >= 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seconds or an HTTP date -> milliseconds from now; null when absent or unreadable.
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// -> the parsed JSON reply. retry: { retries, retryBaseMs, retryMaxMs }; wait is replaceable for tests.
export async function postJson(service, url, { headers, body, timeoutMs }, retry, fetchImpl = fetch, wait = sleep) {
  for (let attempt = 0; ; attempt++) {
    let delay;
    try {
      const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return await r.json();
      const err = new HttpStatusError(service, r.status, await r.text());
      if (!RETRY_STATUS(r.status) || attempt >= retry.retries) throw err;
      delay = retryAfterMs(r.headers && r.headers.get ? r.headers.get('retry-after') : null);
    } catch (e) {
      if (e instanceof HttpStatusError) throw e;
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      if (attempt >= retry.retries) throw timedOut ? backendError('timeout', service, timeoutMs) : e;
    }
    await wait(Math.min(retry.retryMaxMs, delay ?? retry.retryBaseMs * 2 ** attempt));
  }
}
