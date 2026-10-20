// `claude -p` headless: uses the user's Claude Code login, no API key. Tools, MCP, skills, settings files (and so their
// hooks and plugins) and session files are off. Claude Code still reads the user's own CLAUDE.md; MASKS in llm.mjs keep
// the punctuation rules people put there from changing the translations.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnPlan } from './command.mjs';
import { excerpt } from './http.mjs';
import { backendError } from '../errors.mjs';

// This backend is "use my Claude login". If an API key is in the bridge's environment (the API backend needs one), the CLI
// can prefer it and bill the API instead, so the child never sees these variables.
const STRIP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (STRIP.includes(k.toUpperCase())) delete out[k];   // Windows env names are case-insensitive
  return out;
}

// Error text goes back to the extension; the user's home folder in it is shortened to ~.
const tidy = (text) => {
  const home = os.homedir();
  return excerpt(home ? String(text).split(home).join('~') : String(text)).trim();
};

const flags = (cfg, promptFile) => ['-p', '--output-format', 'text', '--model', cfg.model, '--tools', '', '--strict-mcp-config',
  '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--system-prompt-file', promptFile];

// Runs `command [commandArgs...] args` with `input` on stdin. -> stdout as text. cfg.commandArgs is for tests (a stand-in script).
function run(cfg, args, input) {
  return new Promise((resolve, reject) => {
    let plan;
    try { plan = spawnPlan(cfg.command, [...(cfg.commandArgs || []), ...args], childEnv()); } catch (e) { reject(e); return; }
    const child = spawn(plan.file, plan.args, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: plan.shell });
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, timedOut = false, tooBig = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, cfg.timeoutMs);
    // Bytes are kept as they arrive and decoded once at the end, so a character split across two reads stays whole.
    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (outBytes > cfg.maxOutputBytes) { tooBig = true; child.kill(); } else out.push(d);
    });
    child.stderr.on('data', (d) => { if (errBytes < cfg.maxOutputBytes) { errBytes += d.length; err.push(d); } });
    // The child can exit before it reads its input (bad flag, not logged in, killed by the timeout). Without a listener
    // the resulting EPIPE is an uncaught exception that takes the whole bridge down; the exit code is reported below.
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) reject(backendError('claude_timeout', cfg.timeoutMs));
      else if (tooBig) reject(backendError('claude_output_too_big', cfg.maxOutputBytes));
      else if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else {
        if (stderr) console.error(`bridge: claude exited ${code}: ${stderr}`);
        reject(backendError('claude_failed', code, tidy(stderr)));
      }
    });
    child.stdin.end(input);
  });
}

export async function askClaude(cfg, system, user) {
  // The system prompt goes in a file: on the command line cmd.exe (an npm-installed claude.cmd) would misread its quotes.
  const promptFile = path.join(os.tmpdir(), `subpair-prompt-${randomUUID()}.txt`);
  fs.writeFileSync(promptFile, system, 'utf8');
  try { return await run(cfg, flags(cfg, promptFile), user); } finally { fs.rmSync(promptFile, { force: true }); }
}

// Whether `claude --version` runs. Checked once, and again at most every recheckMs while it fails (installed later).
export function claudeProbe(cfg, recheckMs = 60000) {
  let ok = true, checkedAt = -Infinity, running = false;
  const check = () => {
    running = true;
    run({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 30000) }, ['--version'], '')
      .then(() => { ok = true; }, () => { ok = false; })
      .finally(() => { running = false; checkedAt = Date.now(); });
  };
  return () => {
    if (!running && (checkedAt === -Infinity || (!ok && Date.now() - checkedAt > recheckMs))) check();
    return ok;                                                   // optimistic until the first check has finished
  };
}
