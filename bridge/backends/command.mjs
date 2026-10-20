// Starting a command found on PATH, Windows included. Node starts .exe files directly but refuses .cmd/.bat ones without a
// shell (EINVAL), and an npm-installed `claude` is a .cmd shim. Such a shim runs through cmd.exe, which is only safe when no
// argument contains a character cmd.exe interprets, so those are refused instead of escaped.
import fs from 'node:fs';
import path from 'node:path';
import { backendError } from '../errors.mjs';

const CMD_UNSAFE = /["%^&|<>!\r\n]/;

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// -> the full path of `command` (as given if it names a path), or null. On Windows the PATHEXT extensions are tried.
export function findCommand(command, env = process.env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' && !p.extname(command) ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean) : [''];
  const dirs = command.includes('/') || command.includes('\\') ? [''] : (env.PATH || env.Path || '').split(p.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = dir ? p.join(dir, command + ext) : command + ext;
      if (isFile(full)) return full;
    }
  }
  return null;
}

// -> { file, args, shell } for child_process.spawn; for a .cmd/.bat, file is the whole quoted command line for cmd.exe.
// Throws when such a command line would need an argument cmd.exe could misread.
export function spawnPlan(command, args, env = process.env, platform = process.platform) {
  const file = findCommand(command, env, platform) || command;            // not found: let spawn report ENOENT
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args, shell: false };
  const bad = [file, ...args].find((a) => CMD_UNSAFE.test(a));
  if (bad !== undefined) throw backendError('cmd_unsafe', file, JSON.stringify(bad));
  return { file: [file, ...args].map((a) => `"${a}"`).join(' '), args: [], shell: true };
}
