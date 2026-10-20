// Any OpenAI-compatible chat endpoint: OpenAI itself, Gemini's compatible endpoint, DeepSeek, OpenRouter, or a local
// server (Ollama, LM Studio, llama.cpp). Set baseUrl (up to and including /v1), model and, for hosted services, the key
// in bridge/config.json (openai.*) or OPENAI_API_KEY. Servers on this computer or the local network usually need no key.
import { backendError } from '../errors.mjs';
import { postJson } from './http.mjs';

const PRIVATE_V4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function isLocal(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host === '[::1]' || host.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.test(host);
  return !host.includes('.') && !host.includes(':');                // a bare machine name such as "ollama"
}

// The bridge shows this backend as usable when it can possibly work: an address, and a key unless the server is local.
// The model may come with each request, so a missing openai.model is reported per request instead.
export const openaiReady = (cfg) => !!(cfg.baseUrl && (cfg.key || isLocal(cfg.baseUrl)));

// The reply text: a plain string, or (some servers) a list of parts whose text parts are joined.
function contentText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
  return null;
}

// cfg: config "openai"; retry: config "llm" (retries, retryBaseMs, retryMaxMs).
export async function askOpenai(cfg, system, user, retry, fetchImpl = fetch) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  const j = await postJson('OpenAI-compatible API', `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    headers,
    body: {
      model: cfg.model,
      // Reasoning models reject any temperature but their default, so it is only sent when one is configured.
      ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    },
    timeoutMs: cfg.timeoutMs,
  }, retry, fetchImpl);
  const text = contentText(j.choices && j.choices[0] && j.choices[0].message);
  if (typeof text !== 'string') throw backendError('no_content');
  return text;
}
