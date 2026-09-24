// The built binary (ADR-0012), spawned the way Claude Code runs a command hook: `sh -c <command>`
// with the payload on stdin. HOME is a temp dir; nothing inherits the real one.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberIdFor } from '@taper/core';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.ts';
import { sandbox, writeJson } from './helpers.ts';

const PKG = join(import.meta.dirname, '..');
const BIN = join(PKG, 'dist', 'taper.mjs');

beforeAll(() => {
  buildSync({
    entryPoints: [join(PKG, 'src', 'bin.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3'],
    outfile: BIN,
    logLevel: 'warning',
  });
});

const PAYLOAD = (cwd: string) =>
  JSON.stringify({
    session_id: 'e2e-session',
    transcript_path: '/dev/null',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm run lint' },
    tool_use_id: 'toolu_e2e',
  });

describe('dist/taper.mjs', () => {
  it('installs a hook command that Claude Code can run, and it denies a removed rule', () => {
    const s = sandbox();
    writeJson(join(s.repo, '.claude', 'settings.json'), {
      permissions: { allow: ['Bash(npm run lint)'] },
    });
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home };
    execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd: s.repo, env });

    const settings = JSON.parse(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8'));
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toBe(`'${process.execPath}' '${BIN}' hook PreToolUse`);

    // Force the member to removed in an automatic knob (normally weeks of ticks).
    const a = Agent.open({ ...s.deps(), env: { HOME: s.home } });
    const knob = 'project:github.com%2Fexample%2Fdemo:allow';
    const m = a.store.members({ ids: [memberIdFor(knob, 'Bash(npm run lint)')] })[0];
    if (m === undefined) throw new Error('member missing');
    const t = Date.now();
    a.store.saveMembers([
      { ...m, state: 'removed', stateSince: t - 86_400_000, declaredAt: t - 90 * 86_400_000 },
    ]);
    a.store.db.prepare("UPDATE knobs SET mode = 'automatic' WHERE id = ?").run(knob);
    a.close();

    const r = spawnSync('/bin/sh', ['-c', command], {
      cwd: s.repo,
      env,
      input: PAYLOAD(s.repo),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.endsWith('}')).toBe(true);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('fails open: bad stdin exits 0 with no output', () => {
    const s = sandbox();
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: s.home };
    execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd: s.repo, env });
    const r = spawnSync(process.execPath, [BIN, 'hook', 'PreToolUse'], {
      cwd: s.repo,
      env,
      input: 'not json',
      encoding: 'utf8',
    });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });
});
