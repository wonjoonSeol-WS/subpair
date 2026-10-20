// ezTrans XP through Luna's 32-bit helper (the engine DLL is 32-bit, this process is 64-bit).
// Protocol: start `helper eztrans <pipe> <event> <ezTrans dir>`, connect to the pipe, then per request write an int32le
// length and the UTF-16LE text as two separate writes (the pipe is message mode); the reply has the same shape, length 0
// meaning the engine failed on that line.
// Any problem on the pipe (timeout, closed, nonsense length) kills the helper; the next call starts a fresh one.
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backendError } from '../errors.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The language pairs the engine translates.
export const EZTRANS_PAIRS = ['ja-ko'];

// The engine library the helper loads: a folder without it cannot translate, whatever else it holds.
export const EZTRANS_ENGINE = 'J2KEngine.dll';
export const isEztransDir = (dir) => !!dir && fs.existsSync(path.join(dir, EZTRANS_ENGINE));

// The folder ezTrans XP records for the current user (its installer, or the "path registration" script of a portable copy).
// Read through PowerShell rather than reg.exe, which prints in the console code page and would garble a non-ASCII folder.
export function registeredEztransDir(run = execFileSync) {
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + "(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\ChangShin\\ezTrans' -ErrorAction Stop).FilePath";
  try {
    return String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch { return ''; }
}

// Where ezTrans XP is when no folder is configured: the recorded folder, then the default install folders. '' if none
// of them holds the engine.
export function findEztransDir({ registered = registeredEztransDir, env = process.env } = {}) {
  const installed = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean)
    .map((root) => path.join(root, 'ChangShinSoft', 'ezTrans XP'));
  return [registered(), ...installed].find(isEztransDir) || '';
}

export class EzTrans {
  // cfg: config "eztrans". helperArgs (optional) goes before `eztrans` so tests can run a stand-in script with node.
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.wake = null;
    this.chain = Promise.resolve();      // one request at a time
    this.starting = null;
  }

  static supports({ from, to }) {
    return EZTRANS_PAIRS.includes(`${from}-${to}`);
  }

  // Windows only: the engine is a Windows library and the helper a Windows program.
  static available(cfg, platform = process.platform) {
    return platform === 'win32' && fs.existsSync(cfg.helper) && isEztransDir(cfg.dir);
  }

  start() {
    if (!this.starting) this.starting = this.#start().catch((e) => { this.starting = null; throw e; });
    return this.starting;
  }

  async #start() {
    const pipe = `\\\\.\\pipe\\${randomUUID()}`;
    const args = [...(this.cfg.helperArgs || []), 'eztrans', pipe, randomUUID(), this.cfg.dir];
    const child = spawn(this.cfg.helper, args, { cwd: this.cfg.cwd || undefined, stdio: 'ignore', windowsHide: true });
    this.child = child;
    let failure = null;
    child.on('exit', (code) => { failure = failure || backendError('eztrans_exited', code); if (this.child === child) this.#reset(); });
    child.on('error', (e) => { failure = backendError('eztrans_start_failed', e.message); if (this.child === child) this.#reset(); });
    const deadline = Date.now() + this.cfg.startTimeoutMs;
    let sock = null;
    while (!sock) {
      if (failure) throw failure;
      if (Date.now() > deadline) { this.close(); throw backendError('eztrans_no_pipe'); }
      try {
        sock = await new Promise((res, rej) => { const s = net.connect(pipe); s.once('connect', () => res(s)); s.once('error', rej); });
      } catch { await sleep(this.cfg.connectRetryMs); }
    }
    if (failure || this.child !== child) { sock.destroy(); throw failure || backendError('eztrans_gone'); }
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); if (this.wake) this.wake(); });
    sock.on('close', () => { if (this.sock === sock) this.close(); });     // a pipe that closed under us means a dead helper
    sock.on('error', () => {});
    await sleep(this.cfg.loadMs);          // engine load
  }

  // Waits until n bytes have arrived. Throws if the pipe closes or the deadline passes.
  async #need(n, deadline) {
    while (this.buf.length < n) {
      if (!this.sock) throw backendError('eztrans_pipe_closed');
      const left = deadline - Date.now();
      if (left <= 0) throw backendError('eztrans_timeout');
      await new Promise((r) => {
        const timer = setTimeout(r, left);
        this.wake = () => { clearTimeout(timer); r(); };
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async #one(text) {
    await this.start();
    const sock = this.sock;
    if (!sock) throw backendError('eztrans_not_running');
    const deadline = Date.now() + this.cfg.requestTimeoutMs;
    try {
      const b = Buffer.from(text, 'utf16le');
      const h = Buffer.alloc(4);
      h.writeInt32LE(b.length);
      sock.write(h);
      sock.write(b);
      const n = (await this.#need(4, deadline)).readInt32LE();
      if (n < 0 || n > this.cfg.maxReplyBytes) throw backendError('eztrans_bad_reply', n);
      return n > 0 ? (await this.#need(n, deadline)).toString('utf16le') : '';
    } catch (e) {
      this.close();                        // its state is unknown (half a reply may be pending), so start over next time
      throw e;
    }
  }

  // Cue text -> Korean. Japanese line breaks usually fall mid-sentence, so lines are joined before translating.
  translate(text) {
    const src = String(text).replace(/\s*\n\s*/g, '');
    if (!src.trim()) return Promise.resolve('');
    const run = () => this.#one(src);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  // Lines in order; a line the engine could not translate comes back as '' (the bridge does not cache or save those).
  async translateAll(texts) {
    const out = [];
    for (const t of texts) out.push(await this.translate(t));
    return out;
  }

  #reset() {
    this.child = null; this.sock = null; this.starting = null;
    this.buf = Buffer.alloc(0);
    if (this.wake) this.wake();            // let a request that is waiting for bytes notice and fail
  }

  close() {
    const c = this.child, s = this.sock;
    this.#reset();
    if (s) s.destroy();
    if (c) c.kill();
  }
}
