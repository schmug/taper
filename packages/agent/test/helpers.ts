// Test scaffolding: a throwaway $HOME and repo per test. Nothing here touches the real ~/.claude,
// ~/.taper or ~/.claude.json: every path hangs off a mkdtemp directory, and `env` is built from
// scratch (no inherited HOME or CLAUDE_CONFIG_DIR).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import type { Deps } from '../src/deps.ts';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix = 'taper-test-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export const T0 = Date.UTC(2026, 8, 23, 12);
export const DAY = 86_400_000;

export type TestDeps = Deps & { readonly output: string[]; readonly errors: string[] };

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly repo: string;
  readonly managed: string;
  /** Fresh deps (and fresh output buffers) wired to this sandbox. */
  deps(over?: Partial<Deps>): TestDeps;
}

/** A temp HOME and a git repo with an origin remote. */
export function sandbox(opts: { remote?: string; git?: boolean } = {}): Sandbox {
  const root = tempDir();
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const managed = join(root, 'managed');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(managed, { recursive: true });
  if (opts.git !== false) {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', opts.remote ?? 'git@github.com:example/demo.git'],
      { cwd: repo },
    );
  }
  let ids = 0;
  return {
    root,
    home,
    repo,
    managed,
    deps(over = {}) {
      const output: string[] = [];
      const errors: string[] = [];
      return {
        env: { HOME: home },
        cwd: repo,
        now: () => T0,
        randomHex: (bytes: number) => (++ids).toString(16).padStart(bytes * 2, '0'),
        stdin: () => '',
        out: (s: string) => output.push(s),
        err: (s: string) => errors.push(s),
        isTTY: false,
        confirm: () => false,
        managedDir: managed,
        entry: ['/usr/bin/node', '/opt/taper/taper.mjs'],
        ...over,
        output,
        errors,
      };
    },
  };
}
