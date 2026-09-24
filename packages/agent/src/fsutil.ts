// Small file helpers. Writes are atomic (temp file + rename in the same directory), so a crash
// never leaves a half-written settings or config file.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** File text, or null when it does not exist. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

/** Replaces `path` atomically. Keeps an existing file's permission bits; else uses `mode`. */
export function writeAtomic(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  let keep = mode;
  try {
    keep = statSync(path).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${path}.taper-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: keep });
  renameSync(tmp, path);
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
