// Gitignore-style path matching for Read/Edit rules (facts doc B2, ADR-0006). Pure, POSIX paths
// only (Windows `/c/...` normalization is not modeled). Symlinks are not resolved: the matcher
// sees the path Claude Code reports, which is absolute for Read/Write/Edit.

import type { Polarity } from './rule.ts';

export interface PathContext {
  readonly cwd: string;
  readonly home: string;
  /** Where `/path` patterns anchor (policy.ts); null = the session cwd. */
  readonly anchorDir: string | null;
}

/** Absolute, normalized path: resolves `~`, relative segments, `.`, `..`, and duplicate `/`. */
export function normalizePath(path: string, cwd: string, home: string): string {
  const abs =
    path === '~'
      ? home
      : path.startsWith('~/')
        ? `${home}${path.slice(1)}`
        : path.startsWith('/')
          ? path
          : `${cwd}/${path}`;
  const out: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

export function isInside(path: string, dir: string): boolean {
  return dir === '/' || path === dir || path.startsWith(`${dir}/`);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One path segment: `*` and `?` stay inside the segment, `[...]` is a class, `\x` is literal. */
function segmentRegExp(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === '\\' && i + 1 < seg.length) out += escapeRegExp(seg[++i] as string);
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else {
        const body = seg.slice(i + 1, end).replace(/[\\\]^]/g, '\\$&');
        out += body.startsWith('!') ? `[^${body.slice(1)}]` : `[${body}]`;
        i = end;
      }
    } else out += escapeRegExp(c);
  }
  return out;
}

/** Regex body for a relative glob; `**` spans segments and a trailing `/**` covers the dir too. */
function globRegExp(glob: string): string {
  const segs = glob.split('/');
  let re = '';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') {
      if (last) re += i === 0 ? '.*' : '(?:/.*)?';
      else re += i === 0 ? '(?:.*/)?' : '/(?:.*/)?';
      return;
    }
    if (i > 0 && segs[i - 1] !== '**') re += '/';
    re += segmentRegExp(seg);
  });
  return re;
}

export function matchPathPattern(
  pattern: string,
  polarity: Polarity,
  ctx: PathContext,
  path: string,
): boolean {
  let base: string;
  let glob: string;
  let floating = false;
  if (pattern.startsWith('//')) {
    base = '/';
    glob = pattern.slice(2);
  } else if (pattern === '~' || pattern.startsWith('~/')) {
    base = ctx.home;
    glob = pattern.slice(2);
  } else if (pattern.startsWith('/')) {
    base = ctx.anchorDir ?? ctx.cwd;
    glob = pattern.slice(1);
  } else if (pattern.startsWith('./')) {
    base = ctx.cwd;
    glob = pattern.slice(2);
  } else {
    base = ctx.cwd;
    glob = pattern;
    const inner = glob.replace(/\/+$/, '');
    // A bare name matches at any depth; a single-segment dir (`src/**`) does so only for
    // deny/ask (facts doc B2).
    floating = !inner.includes('/') || (polarity !== 'allow' && /^[^/]+\/\*\*$/.test(inner));
  }
  glob = glob.replace(/\/+$/, '');
  const root = normalizePath(base, ctx.cwd, ctx.home);
  const target = normalizePath(path, ctx.cwd, ctx.home);
  if (glob === '') return isInside(target, root);
  const prefix = root === '/' ? '' : escapeRegExp(root);
  const depth = floating ? '(?:.*/)?' : '';
  // A pattern that matches a directory also covers everything under it (gitignore).
  return new RegExp(`^${prefix}/${depth}${globRegExp(glob)}(?:/.*)?$`, 's').test(target);
}
