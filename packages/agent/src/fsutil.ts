// Small file helpers. Writes are atomic (temp file + rename in the same directory), so a crash
// never leaves a half-written settings or config file.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/** The file a path finally names: every symlink hop is followed, even to a missing target. */
function resolveTarget(path: string): string {
  let p = path;
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try {
      if (!lstatSync(p).isSymbolicLink()) return p;
      link = readlinkSync(p);
    } catch {
      return p; // does not exist yet: this is the file to create
    }
    p = resolve(dirname(p), link);
  }
  throw new Error(`refusing to write ${path}: symlink loop`);
}

/**
 * Replaces the file atomically. A symlinked path (dotfiles) is written through: the link stays
 * and its target is replaced. Keeps an existing file's permission bits; else uses `mode`.
 */
export function writeAtomic(link: string, text: string, mode = 0o644): void {
  const path = resolveTarget(link);
  mkdirSync(dirname(path), { recursive: true });
  let keep = mode;
  try {
    keep = statSync(path).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${path}.taper-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: keep });
  chmodSync(tmp, keep); // writeFileSync's mode is filtered by the umask
  renameSync(tmp, path);
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
