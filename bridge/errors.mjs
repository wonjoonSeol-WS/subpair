// Every error the bridge reports to a client: a stable code, its English text with $1, $2 for the params, and the params.
// Clients show their own translation of the code (the extension's bridgeErr_<code> messages) and fall back to `error`.
// Codes whose text starts with "$1: " are a translator failing; $1 is the backend name.
export const ERRORS = {
  // the request
  forbidden_host: 'forbidden host',
  forbidden_origin: 'forbidden origin',
  not_found: 'not found',
  method_not_allowed: 'method not allowed',
  bad_request_target: 'bad request target',
  bad_url_escape: 'bad URL escape',
  body_too_large: 'request body too large',
  body_not_json: 'body must be a JSON object',
  to_required: 'to (the target language) is required',
  bad_language: '$1 must be a language code such as ja or ko',
  unknown_backend: 'unknown backend',
  bad_backend_name: 'bad backend name',
  bad_model: 'model must be 1 to 100 letters, digits or . : / - _',
  bad_key: 'key must be 1 to $1 letters, digits, - or _',
  bad_texts: '$1 must be an array of at most $2 strings of at most $3 characters',
  bad_cues: 'cues must be an array of 1 to $1 cues',
  bad_cue: 'each cue needs text (a string) and numeric start and end seconds, start <= end',
  // what the request asks for
  same_language: 'source and target language are the same',
  pair_unsupported: '$1 only does $2, not $3 -> $4',
  needs_model: '$1 needs a model: send one with the request or set $1.model in bridge/config.json',
  backend_not_ready: '$1 is not set up',
  eztrans_not_configured: 'ezTrans XP was not found: set eztrans.dir in bridge/config.json to the ezTrans XP folder (Windows only)',
  claude_missing: 'the claude command did not run (install Claude Code and log in, or set claude.command in bridge/config.json)',
  api_key_missing: 'no Anthropic API key (ANTHROPIC_API_KEY or bridge/config.json api.key)',
  openai_not_configured: 'OpenAI-compatible backend is not set up (openai.baseUrl and, for hosted services, OPENAI_API_KEY or openai.key in bridge/config.json)',
  // the bridge is busy, or the thing asked for is gone
  too_many_requests: 'too many translations in progress, try again shortly',
  line_not_found: 'unknown or expired request',
  too_many_jobs: '$1 titles are already being translated, try again later',
  job_running: 'this title is already being translated with this backend and model; try again when it is done',
  lines_failed: '$1 lines could not be translated; the saved translation was kept',
  not_saved: 'not saved',
  // a translator failed ($1 is the backend)
  upstream_rate_limited: '$1: $2 $3: $4',
  upstream_error: '$1: $2 $3: $4',
  timeout: '$1: $2 did not answer within $3 ms',
  refused: '$1: Anthropic API declined to translate this part',
  refused_for: '$1: Anthropic API declined to translate this part ($2)',
  max_tokens: '$1: Anthropic API reply hit max_tokens ($2); raise api.maxTokens or lower api.batch',
  no_content: '$1: OpenAI-compatible API: no message content in the reply',
  claude_failed: '$1: claude exited $2: $3',
  claude_timeout: '$1: claude timed out after $2 ms',
  claude_output_too_big: '$1: claude wrote more than $2 bytes',
  cmd_unsafe: '$1: cannot run $2 safely through cmd.exe (argument $3); use the .exe installer or point the command at an .exe',
  eztrans_start_failed: '$1: eztrans helper could not start: $2',
  eztrans_exited: '$1: eztrans helper exited ($2)',
  eztrans_gone: '$1: eztrans helper exited',
  eztrans_no_pipe: '$1: eztrans helper did not open its pipe',
  eztrans_not_running: '$1: eztrans helper is not running',
  eztrans_pipe_closed: '$1: eztrans helper closed the pipe',
  eztrans_timeout: '$1: eztrans did not answer in time',
  eztrans_bad_reply: '$1: eztrans sent a reply length of $2',
  backend_failed: '$1: $2',
  // anything else (a bug)
  internal_error: '$1',
};

export const fill = (template, params) => template.replace(/\$(\d+)/g, (m, n) => (params[n - 1] === undefined ? m : params[n - 1]));

const templateOf = (code) => {
  if (!Object.hasOwn(ERRORS, code)) throw new Error(`no such error code: ${code}`);
  return ERRORS[code];
};

export class CodedError extends Error {
  constructor(code, params = [], message) {
    const p = params.map(String), template = templateOf(code);
    super(message ?? fill(template, p));
    this.code = code;
    this.params = p;
  }
}

// An error answered with an HTTP status: 4xx for a bad request, 502 when a translator failed, 503 when it is not set up or
// the bridge is busy. Anything else that escapes is a bug and answers 500 internal_error.
export class BridgeError extends CodedError {
  constructor(status, code, ...params) { super(code, params); this.status = status; }
}

// What a backend throws: a translator-failure code and its params without the backend name, which the bridge adds as $1
// when it reports the error. The message is the text without the "<backend>: " part.
export const backendMessage = (code, params) => fill(templateOf(code).replace(/^\$1: /, ''), ['', ...params.map(String)]);
export const backendError = (code, ...params) => new CodedError(code, params, backendMessage(code, params));

// The answer body for an error: { error, code, params }.
export const errorBody = (e) => (e instanceof CodedError
  ? { error: e.message, code: e.code, params: e.params }
  : { error: messageOf(e), code: 'internal_error', params: [messageOf(e)] });

export const messageOf = (e) => String(e && e.message ? e.message : e);
