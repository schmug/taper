// The loader against a real temporary directory tree. It must read, never write (invariant 3):
// the last test snapshots every file's bytes and mtime before and after a load.

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSettings, managedSettingsDir } from '../src/loader.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let root: string;
let home: string;
let repo: string;
let managed: string;

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const USER = JSON.stringify({ permissions: { allow: ['Bash(git *)'] }, hooks: { Stop: [{}] } });
const PROJECT = JSON.stringify({ permissions: { allow: ['Read(src/**)'], deny: ['Read(.env)'] } });
const CI_FILE = JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'taper-loader-'));
  home = join(root, 'home');
  repo = join(root, 'repo');
  managed = join(root, 'managed');
  put(join(home, '.claude', 'settings.json'), USER);
  put(join(repo, '.claude', 'settings.json'), PROJECT);
  put(join(repo, '.claude', 'settings.local.json'), '{"permissions": {"allow": [');
  put(
    join(managed, 'managed-settings.json'),
    JSON.stringify({ permissions: { deny: ['WebSearch'] } }),
  );
  put(join(managed, 'managed-settings.d', '20-b.json'), '{"permissions":{"ask":["Bash(rm *)"]}}');
  put(join(managed, 'managed-settings.d', '10-a.json'), '{"permissions":{"allow":["Edit"]}}');
  put(join(managed, 'managed-settings.d', '.hidden.json'), '{"permissions":{"allow":["X"]}}');
  put(join(managed, 'managed-settings.d', 'notes.txt'), 'not json');
  put(join(repo, 'ci', 'claude.json'), CI_FILE);
  put(
    join(repo, '.github', 'workflows', 'review.yml'),
    [
      'jobs:',
      '  r:',
      '    steps:',
      '      - run: claude -p x --settings ci/claude.json',
      `      - run: claude -p x --settings '{"permissions":{"deny":["Bash(curl *)"]}}'`,
      '      - run: claude -p x --settings missing.json',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      '      - run: claude -p x --settings ${{ inputs.s }}',
    ].join('\n'),
  );
  put(join(repo, '.github', 'workflows', 'test.yaml'), 'run: npm test');
});

const load = () =>
  loadSettings({
    deviceId: 'dev1',
    repoId: 'github.com/o/r',
    repoRoot: repo,
    home,
    managedDir: managed,
    takenAt: 1_000,
  });

describe('loadSettings', () => {
  it('snapshots every scope in merge order with hashes and arrays', () => {
    const { snapshots } = load();
    expect(snapshots.map((s) => [s.scope, s.path.replace(root, '')])).toEqual([
      ['managed', '/managed/managed-settings.json'],
      ['managed', '/managed/managed-settings.d/10-a.json'],
      ['managed', '/managed/managed-settings.d/20-b.json'],
      ['cli', '/repo/ci/claude.json'],
      ['cli', '/repo/.github/workflows/review.yml#settings[1]'],
      ['project', '/repo/.claude/settings.json'],
      ['user', '/home/.claude/settings.json'],
    ]);
    const user = snapshots.find((s) => s.scope === 'user');
    expect(user).toEqual({
      device_id: 'dev1',
      scope: 'user',
      path: join(home, '.claude', 'settings.json'),
      taken_at: 1_000,
      content_hash: sha(USER),
      arrays: { allow: ['Bash(git *)'], ask: [], deny: [] },
      hooks_present: true,
    });
    const project = snapshots.find((s) => s.scope === 'project');
    expect(project).toMatchObject({ repo_id: 'github.com/o/r', content_hash: sha(PROJECT) });
  });

  it('ties --settings snapshots to their workflow as the pipeline', () => {
    const cli = load().snapshots.filter((s) => s.scope === 'cli');
    expect(cli.map((s) => [s.pipeline_id, s.inline ?? false, s.arrays])).toEqual([
      ['.github/workflows/review.yml', false, { allow: ['Bash(npm test)'], ask: [], deny: [] }],
      ['.github/workflows/review.yml', true, { allow: [], ask: [], deny: ['Bash(curl *)'] }],
    ]);
  });

  it('reports unparseable, missing and unresolvable files as errors, not empty snapshots', () => {
    const errors = load().errors.map((e) => [e.scope, e.path.replace(root, ''), e.message]);
    expect(errors).toEqual([
      ['cli', '/repo/missing.json', 'referenced --settings file not found'],
      ['cli', '/repo/.github/workflows/review.yml', 'unresolvable --settings argument: ${{'],
      ['local', '/repo/.claude/settings.local.json', expect.stringMatching(/^invalid JSON/)],
    ]);
  });

  it('lists workflows that invoke Claude Code (C3: shadow-only by default)', () => {
    expect(load().claudeWorkflows).toEqual(['.github/workflows/review.yml']);
  });

  it('emits an empty snapshot for an absent fixed-path file so vanished rules retire', () => {
    const { snapshots } = loadSettings({
      deviceId: 'd',
      home: join(root, 'nohome'),
      takenAt: 5,
      managedDir: join(root, 'nomanaged'),
    });
    expect(snapshots.map((s) => [s.scope, s.arrays, s.content_hash])).toEqual([
      ['managed', { allow: [], ask: [], deny: [] }, sha('')],
      ['user', { allow: [], ask: [], deny: [] }, sha('')],
    ]);
  });

  it('honours a relocated config dir', () => {
    const configDir = join(root, 'alt-config');
    put(join(configDir, 'settings.json'), '{"permissions":{"allow":["WebSearch"]}}');
    const { snapshots } = loadSettings({
      deviceId: 'd',
      home,
      configDir,
      takenAt: 1,
      managedDir: managed,
    });
    expect(snapshots.find((s) => s.scope === 'user')?.arrays.allow).toEqual(['WebSearch']);
  });

  it('never writes: every file is byte- and mtime-identical after a load', () => {
    const state = () => {
      const out: Record<string, [string, number]> = {};
      for (const f of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        const p = join(root, f);
        const st = statSync(p);
        out[f] = st.isFile() ? [readFileSync(p, 'utf8'), st.mtimeMs] : ['<dir>', 0];
      }
      return out;
    };
    const before = state();
    load();
    expect(state()).toEqual(before);
  });
});

describe('managedSettingsDir', () => {
  it.each([
    ['darwin', '/Library/Application Support/ClaudeCode'],
    ['linux', '/etc/claude-code'],
    ['win32', 'C:\\Program Files\\ClaudeCode'],
  ] as const)('%s → %s', (platform, dir) => {
    expect(managedSettingsDir(platform)).toBe(dir);
  });
});
