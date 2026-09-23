// Settings loader (HANDOFF §5.2, ADR-0007). The only module in this package that touches the
// host. It reads and never writes (invariant 3; test/boundary.test.ts and test/loader.test.ts
// enforce it). Not read: MDM plists, the Windows registry, server-managed settings (M6).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Scope } from './policy.ts';
import {
  findSettingsRefs,
  invokesClaudeCode,
  parseSettingsText,
  type SettingsSnapshot,
  SettingsSnapshotSchema,
} from './settings.ts';

export type Platform = 'darwin' | 'linux' | 'win32';

export interface LoaderOptions {
  readonly deviceId: string;
  readonly repoId?: string;
  /** Absolute path of the repository root (the main checkout's root for worktrees). */
  readonly repoRoot?: string;
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR`; defaults to `<home>/.claude`. */
  readonly configDir?: string;
  readonly platform?: Platform;
  /** Overrides the per-OS managed-settings directory. */
  readonly managedDir?: string;
  readonly takenAt: number;
}

export interface LoadError {
  readonly scope: Scope;
  readonly path: string;
  readonly message: string;
}

export interface LoadResult {
  readonly snapshots: SettingsSnapshot[];
  readonly errors: LoadError[];
  /** Workflow paths (repo-relative) that invoke Claude Code: C3 shadow-only subjects. */
  readonly claudeWorkflows: string[];
}

/** facts doc B3 'Managed file paths'. */
export function managedSettingsDir(platform: Platform): string {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode';
    case 'linux':
      return '/etc/claude-code';
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode';
  }
}

/** `--settings` files larger than this are ignored by Claude Code (facts doc B3). */
const MAX_CLI_SETTINGS_BYTES = 2 * 1024 * 1024;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** File text, or null when the path does not exist. Other errors propagate. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw e;
  }
}

function platformOf(p: string): Platform {
  return p === 'darwin' || p === 'win32' ? p : 'linux';
}

export function loadSettings(opts: LoaderOptions): LoadResult {
  const platform = opts.platform ?? platformOf(process.platform);
  const path = platform === 'win32' ? win32 : posix;
  const snapshots: SettingsSnapshot[] = [];
  const errors: LoadError[] = [];
  const claudeWorkflows: string[] = [];
  const base = { device_id: opts.deviceId, taken_at: opts.takenAt };
  const repo = opts.repoId === undefined ? {} : { repo_id: opts.repoId };

  const add = (
    scope: Scope,
    file: string,
    text: string,
    extra: Partial<SettingsSnapshot> = {},
  ): void => {
    const parsed = parseSettingsText(text);
    if (!parsed.ok) {
      errors.push({ scope, path: file, message: parsed.error });
      return;
    }
    snapshots.push(
      SettingsSnapshotSchema.parse({
        ...base,
        ...(scope === 'user' || scope === 'managed' ? {} : repo),
        ...extra,
        scope,
        path: file,
        content_hash: sha256(text),
        arrays: {
          allow: [...parsed.settings.arrays.allow],
          ask: [...parsed.settings.arrays.ask],
          deny: [...parsed.settings.arrays.deny],
        },
        hooks_present: parsed.settings.hooksPresent,
      }),
    );
  };
  /** A missing fixed-path file is an empty file: its rules vanished, so its members retire. */
  const fixed = (scope: Scope, file: string): void => {
    try {
      add(scope, file, readText(file) ?? '');
    } catch (e) {
      errors.push({ scope, path: file, message: (e as Error).message });
    }
  };

  // managed: managed-settings.json, then managed-settings.d/*.json alphabetically (facts doc B3).
  const managedDir = opts.managedDir ?? managedSettingsDir(platform);
  fixed('managed', path.join(managedDir, 'managed-settings.json'));
  const dropIns = path.join(managedDir, 'managed-settings.d');
  for (const name of listDir(dropIns)) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const file = path.join(dropIns, name);
    try {
      const text = readText(file);
      if (text !== null) add('managed', file, text);
    } catch (e) {
      errors.push({ scope: 'managed', path: file, message: (e as Error).message });
    }
  }

  if (opts.repoRoot !== undefined && opts.repoId !== undefined) {
    const root = opts.repoRoot;
    // cli: --settings files referenced by CI workflows; pipeline = workflow path.
    const workflows = path.join(root, '.github', 'workflows');
    for (const name of listDir(workflows)) {
      if (!/\.ya?ml$/.test(name)) continue;
      const file = path.join(workflows, name);
      const pipeline = `.github/workflows/${name}`;
      let text: string | null;
      try {
        text = readText(file);
      } catch (e) {
        errors.push({ scope: 'cli', path: file, message: (e as Error).message });
        continue;
      }
      if (text === null) continue;
      if (invokesClaudeCode(text)) claudeWorkflows.push(pipeline);
      findSettingsRefs(text).forEach((ref, n) => {
        const cli = { pipeline_id: pipeline };
        if (ref.kind === 'unresolved') {
          errors.push({
            scope: 'cli',
            path: file,
            message: `unresolvable --settings argument: ${ref.token}`,
          });
        } else if (ref.kind === 'inline') {
          add('cli', `${file}#settings[${n}]`, ref.json, { ...cli, inline: true });
        } else {
          const target = path.resolve(root, ref.path);
          try {
            const body = readText(target);
            if (body === null)
              errors.push({
                scope: 'cli',
                path: target,
                message: 'referenced --settings file not found',
              });
            else if (Buffer.byteLength(body) > MAX_CLI_SETTINGS_BYTES)
              errors.push({
                scope: 'cli',
                path: target,
                message: '--settings file over 2 MiB is ignored',
              });
            else add('cli', target, body, cli);
          } catch (e) {
            errors.push({ scope: 'cli', path: target, message: (e as Error).message });
          }
        }
      });
    }
    fixed('local', path.join(root, '.claude', 'settings.local.json'));
    fixed('project', path.join(root, '.claude', 'settings.json'));
  }

  fixed('user', path.join(opts.configDir ?? path.join(opts.home, '.claude'), 'settings.json'));
  return { snapshots, errors, claudeWorkflows };
}
