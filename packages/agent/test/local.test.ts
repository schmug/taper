// Local plumbing: paths, the versioned SQLite ledger, config, repo identity, workspace trust.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, readConfig, writeConfig } from '../src/config.ts';
import { MIGRATIONS, openDb } from '../src/db.ts';
import { resolvePaths } from '../src/paths.ts';
import { findRepo, normalizeRemote } from '../src/repo.ts';
import { readTrust } from '../src/trust.ts';
import { sandbox, tempDir, writeJson } from './helpers.ts';

describe('resolvePaths', () => {
  it('puts state under $HOME/.taper and honors CLAUDE_CONFIG_DIR', () => {
    const p = resolvePaths({ HOME: '/h' });
    expect(p).toMatchObject({
      taperDir: '/h/.taper',
      db: '/h/.taper/state.db',
      config: '/h/.taper/config.json',
      claudeDir: '/h/.claude',
      userSettings: '/h/.claude/settings.json',
      claudeJson: '/h/.claude.json',
    });
    const q = resolvePaths({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
    expect(q.userSettings).toBe('/c/settings.json');
    expect(q.claudeJson).toBe('/c/.claude.json');
  });

  it('refuses to run without HOME', () => {
    expect(() => resolvePaths({})).toThrow(/HOME/);
  });
});

describe('openDb', () => {
  it('creates the ledger with every migration, private, and reopens idempotently', () => {
    const dir = tempDir();
    const path = join(dir, '.taper', 'state.db');
    const db = openDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'events',
        'knob_changes',
        'knobs',
        'members',
        'sessions',
        'signals',
        'snapshots',
        'ticks',
        'transitions',
      ]),
    );
    db.close();
    expect(statSync(join(dir, '.taper')).mode & 0o777).toBe(0o700);
    const again = openDb(path);
    expect(again.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    again.close();
  });

  it('keeps transitions idempotent on (member, from, to, tick), including a null from', () => {
    const db = openDb(join(tempDir(), 'state.db'));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO transitions
         (member_id, knob_id, from_state, to_state, at, reason, actor, shadow, tick_id, evidence)
       VALUES (?, 'k', ?, ?, 1, 'declared', 'system', 1, ?, '{}')`,
    );
    insert.run('m', null, 'active', 't1');
    insert.run('m', null, 'active', 't1');
    insert.run('m', 'active', 'stale_candidate', 't1');
    insert.run('m', 'active', 'stale_candidate', 't1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM transitions').get()).toEqual({ n: 2 });
    db.close();
  });
});

describe('config', () => {
  it('round-trips, is private, and rejects unknown keys', () => {
    const path = join(tempDir(), '.taper', 'config.json');
    const cfg = defaultConfig({ deviceId: 'dev-1', salt: 'a'.repeat(64), now: 5 });
    writeConfig(path, cfg);
    expect(readConfig(path)).toEqual(cfg);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, JSON.stringify({ ...cfg, surprise: 1 }));
    expect(() => readConfig(path)).toThrow();
    expect(readConfig(join(tempDir(), 'missing.json'))).toBeNull();
  });

  it('defaults to raw_retention_hours 0 and protected Read rules', () => {
    const cfg = defaultConfig({ deviceId: 'd', salt: 'b'.repeat(64), now: 0 });
    expect(cfg.raw_retention_hours).toBe(0);
    expect(cfg.protect_read_rules).toBe(true);
  });
});

describe('findRepo / normalizeRemote', () => {
  it.each([
    ['git@github.com:Example/Demo.git', 'github.com/Example/Demo'],
    ['https://github.com/example/demo.git', 'github.com/example/demo'],
    ['https://user:secret@GitHub.com/example/demo/', 'github.com/example/demo'],
    ['ssh://git@gitlab.example.com:2222/group/sub/proj.git', 'gitlab.example.com/group/sub/proj'],
    ['/srv/git/demo.git', '/srv/git/demo'],
  ])('%s → %s', (url, id) => {
    expect(normalizeRemote(url)).toBe(id);
  });

  it('finds the git root from a subdirectory and names it by its origin', () => {
    const s = sandbox();
    mkdirSync(join(s.repo, 'src', 'deep'), { recursive: true });
    expect(findRepo(join(s.repo, 'src', 'deep'))).toEqual({
      root: s.repo,
      repoId: 'github.com/example/demo',
    });
  });

  it('falls back to a path id without a remote, and to null outside git', () => {
    const s = sandbox({ git: false });
    mkdirSync(join(s.repo, '.git'));
    writeFileSync(join(s.repo, '.git', 'config'), '[core]\n\tbare = false\n');
    expect(findRepo(s.repo)).toEqual({ root: s.repo, repoId: `path:${s.repo}` });
    expect(findRepo(s.home)).toBeNull();
  });

  it('reads the common config of a worktree', () => {
    const s = sandbox();
    const wt = join(s.root, 'wt');
    const gitdir = join(s.repo, '.git', 'worktrees', 'wt');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(findRepo(wt)).toEqual({ root: wt, repoId: 'github.com/example/demo' });
  });
});

describe('readTrust (ADR-0002 row 1)', () => {
  it('reads projects[<path>].hasTrustDialogAccepted and nothing else', () => {
    const s = sandbox();
    const file = join(s.home, '.claude.json');
    writeJson(file, {
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: {
        [s.repo]: { hasTrustDialogAccepted: true, history: ['secret prompt'] },
        '/untrusted': { hasTrustDialogAccepted: false },
      },
    });
    expect(readTrust(file, [s.repo])).toBe(true);
    expect(readTrust(file, ['/untrusted'])).toBe(false);
    expect(readTrust(file, ['/never-seen'])).toBe('unknown');
    expect(readTrust(file, ['/untrusted', s.repo])).toBe(true);
  });

  it('is unknown when the file is missing or unreadable (over-refresh is the safe side)', () => {
    const dir = tempDir();
    expect(readTrust(join(dir, 'missing.json'), ['/x'])).toBe('unknown');
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readTrust(join(dir, 'bad.json'), ['/x'])).toBe('unknown');
    writeJson(join(dir, 'odd.json'), { projects: { '/x': { hasTrustDialogAccepted: 'yes' } } });
    expect(readTrust(join(dir, 'odd.json'), ['/x'])).toBe('unknown');
    expect(readFileSync(join(dir, 'bad.json'), 'utf8')).toBe('{not json');
  });
});
