// Anthropic Messages API. Key from ANTHROPIC_API_KEY or bridge/config.json (api.key).
import { backendError } from '../errors.mjs';
import { postJson } from './http.mjs';

// cfg: config "api"; retry: config "llm" (retries, retryBaseMs, retryMaxMs).
export async function askApi(cfg, system, user, retry, fetchImpl = fetch) {
  const body = { model: cfg.model, max_tokens: cfg.maxTokens, system, messages: [{ role: 'user', content: user }] };
  // Current models think before answering and the thinking counts against max_tokens; effort sets how much. Older models
  // reject the field, so an empty effort leaves it out.
  if (cfg.effort) body.output_config = { effort: cfg.effort };
  const j = await postJson('Anthropic API', `${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': cfg.version },
    body,
    timeoutMs: cfg.timeoutMs,
  }, retry, fetchImpl);
  // A declined request is not a malformed reply: asking again or in smaller pieces would only be declined again.
  if (j.stop_reason === 'refusal') {
    const category = j.stop_details && j.stop_details.category;
    throw category ? backendError('refused_for', category) : backendError('refused');
  }
  // A reply cut off by the token limit is broken JSON; saying so is more useful than a validation error.
  if (j.stop_reason === 'max_tokens') throw backendError('max_tokens', cfg.maxTokens);
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
