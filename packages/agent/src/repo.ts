// Repository identity (HANDOFF §3.1: `repo_id` = normalized git remote URL). Reads `.git` files
// directly instead of spawning git, because it runs on the hook's hot path.
//
// The project root is the git top-level of the session's start directory (or null outside git).
// For a worktree that is the worktree's own checkout; Claude Code writes the local file at the
// main checkout's root (facts doc B6). That split is not modeled (ADR-0010, deferred).

import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readText } from './fsutil.ts';

export interface RepoInfo {
  readonly root: string;
  readonly repoId: string;
}

/** `git@host:a/b.git`, `https://user@host/a/b/`, `ssh://git@host:22/a/b.git` → `host/a/b`. */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[^/@:]+@([^/:]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
    if (m) u = `${m[1]}/${m[2]}`;
  }
  u = u.replace(/\/+$/, '').replace(/\.git$/, '');
  const slash = u.indexOf('/');
  return slash > 0 ? `${u.slice(0, slash).toLowerCase()}${u.slice(slash)}` : u;
}

function remoteUrl(configText: string): string | null {
  const urls = new Map<string, string>();
  let remote: string | null = null;
  for (const line of configText.split('\n')) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (section) {
      remote = section[1] ?? null;
      continue;
    }
    if (/^\s*\[/.test(line)) remote = null;
    const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (remote !== null && kv && !urls.has(remote)) urls.set(remote, kv[1] as string);
  }
  return urls.get('origin') ?? [...urls.values()][0] ?? null;
}

const kindOf = (p: string): 'dir' | 'file' | null => {
  try {
    const s = statSync(p);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
  } catch {
    return null;
  }
};

/** The git config shared by all worktrees of the checkout at `root`. */
function commonConfig(root: string): string | null {
  const dotGit = join(root, '.git');
  if (kindOf(dotGit) === 'dir') return join(dotGit, 'config');
  const text = readText(dotGit);
  const m = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = resolve(root, m[1] as string);
  const common = readText(join(gitdir, 'commondir'))?.trim();
  const base = common ? (isAbsolute(common) ? common : resolve(gitdir, common)) : gitdir;
  return join(base, 'config');
}

export function findRepo(start: string): RepoInfo | null {
  let dir = resolve(start);
  for (;;) {
    if (kindOf(join(dir, '.git')) !== null) {
      const cfg = commonConfig(dir);
      const url = cfg === null ? null : remoteUrl(readText(cfg) ?? '');
      return { root: dir, repoId: url === null ? `path:${dir}` : normalizeRemote(url) };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
