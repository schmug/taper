// `taper hook <event>` end to end, in process, with the recorded hook payloads re-pointed at a temp
// repo (HANDOFF §5.3, §5.4A). Covers invariants 3, 5, 7 and 8 on the hook path.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberIdFor } from '@taper/core';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.ts';
import { run } from '../src/cli.ts';
import { DAY, type Sandbox, sandbox, T0, writeJson } from './helpers.ts';

const HOOKS = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'hooks');

/** A recorded payload with its cwd moved to `cwd` and (optionally) its command replaced. */
function payload(
  scenario: string,
  event: string,
  cwd: string,
  over: Record<string, unknown> = {},
): string {
  const file = readdirSync(join(HOOKS, scenario)).find((f) => f.endsWith(`-${event}.json`));
  const p = JSON.parse(readFileSync(join(HOOKS, scenario, file as string), 'utf8')) as Record<
    string,
    unknown
  >;
  return JSON.stringify({ ...p, cwd, ...over });
}

const PROJECT_RULES = ['Bash(./probe.sh b-pass)', 'Bash(npm run lint)', 'Read(./docs/**)'];

function setup(opts: { local?: string[] } = {}): Sandbox {
  const s = sandbox();
  writeJson(join(s.repo, '.claude', 'settings.json'), { permissions: { allow: PROJECT_RULES } });
  if (opts.local)
    writeJson(join(s.repo, '.claude', 'settings.local.json'), {
      permissions: { allow: opts.local },
    });
  writeJson(join(s.home, '.claude.json'), {
    projects: { [s.repo]: { hasTrustDialogAccepted: true } },
  });
  expect(run(['init', '--yes'], s.deps())).toBe(0);
  return s;
}

const hook = (s: Sandbox, event: string, stdin: string, now = T0) => {
  const d = s.deps({ stdin: () => stdin, now: () => now });
  const code = run(['hook', event], d);
  return { code, out: d.output.join(''), errors: d.errors };
};

const projectKnob = 'project:github.com%2Fexample%2Fdemo:allow';
const member = (s: Sandbox, rule: string, knob = projectKnob) => {
  const a = Agent.open(s.deps());
  const m = a.store.members({ ids: [memberIdFor(knob, rule)] })[0];
  a.close();
  return m;
};

/** Puts a member straight into a decayed state: last used `unusedDays` ago, since yesterday. */
function force(
  s: Sandbox,
  rule: string,
  state: 'pending_removal' | 'removed',
  mode = 'automatic',
  unusedDays = state === 'removed' ? 61 : 50,
) {
  const a = Agent.open(s.deps());
  const m = a.store.members({ ids: [memberIdFor(projectKnob, rule)] })[0];
  if (m === undefined) throw new Error(`no member ${rule}`);
  a.store.saveMembers([
    {
      ...m,
      state,
      stateSince: T0 - DAY,
      declaredAt: T0 - 90 * DAY,
      lastSeenAt: T0 - unusedDays * DAY,
    },
  ]);
  a.store.db.prepare('UPDATE knobs SET mode = ? WHERE id = ?').run(mode, projectKnob);
  a.close();
}

describe('taper hook', () => {
  it('records a session, snapshots, and passes through in shadow mode', () => {
    const s = setup();
    expect(hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo))).toEqual(
      { code: 0, out: '', errors: [] },
    );
    const a = Agent.open(s.deps());
    expect(a.store.session('62b7b0c8-993c-4a03-8827-f5432084a355')).toMatchObject({
      cwd: s.repo,
      cwdBasis: 'session_start',
      repoId: 'github.com/example/demo',
      trust: true,
    });
    a.close();
    const pre = hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PreToolUse', s.repo));
    expect(pre).toEqual({ code: 0, out: '', errors: [] });
  });

  it('counts PostToolUse as usage and stores no raw arguments (invariant 8)', () => {
    const s = setup();
    const secret = './probe.sh b-pass --token=sk-live-SECRET123';
    hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo));
    hook(
      s,
      'PostToolUse',
      payload('b0-hook-passthrough', 'PostToolUse', s.repo, {
        tool_input: { command: secret, description: 'x' },
        tool_use_id: 'toolu_secret',
      }),
      T0 + 1000,
    );
    // `Bash(./probe.sh b-pass)` does not match the longer command; use the exact one too.
    hook(s, 'PostToolUse', payload('b0-hook-passthrough', 'PostToolUse', s.repo), T0 + 2000);
    expect(member(s, 'Bash(./probe.sh b-pass)')).toMatchObject({ lastSeenAt: T0 + 2000 });
    const a = Agent.open(s.deps());
    a.store.db.pragma('wal_checkpoint(TRUNCATE)');
    a.close();
    const bytes = readFileSync(join(s.home, '.taper', 'state.db')).toString('latin1');
    expect(bytes).not.toContain('SECRET123');
    expect(bytes).not.toContain('Run probe.sh with b-pass');
  });

  it('asks for a pending_removal member, and approval restores it with a cooldown', () => {
    const s = setup();
    hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo));
    force(s, 'Bash(./probe.sh b-pass)', 'pending_removal');
    const pre = hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PreToolUse', s.repo));
    expect(JSON.parse(pre.out)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          'taper: "Bash(./probe.sh b-pass)" unused for 50 days; approving restores it ' +
          '(cooldown 14d). Run `taper explain "Bash(./probe.sh b-pass)"` for details.',
      },
    });
    hook(s, 'PostToolUse', payload('b0-hook-passthrough', 'PostToolUse', s.repo), T0 + 5000);
    expect(member(s, 'Bash(./probe.sh b-pass)')).toMatchObject({
      state: 'active',
      lastSeenAt: T0 + 5000,
      cooldownUntil: T0 + 5000 + 14 * DAY,
      restoredCount: 1,
    });
  });

  it('denies a removed member, and use never restores it (invariant 5)', () => {
    const s = setup();
    hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo));
    force(s, 'Bash(./probe.sh b-pass)', 'removed');
    const pre = hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PreToolUse', s.repo));
    const out = JSON.parse(pre.out) as { hookSpecificOutput: Record<string, string> };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
      'taper: "Bash(./probe.sh b-pass)" removed after 60 days unused. ' +
        'Re-grant: `taper regrant "Bash(./probe.sh b-pass)"` or the dashboard.',
    );
    hook(s, 'PostToolUse', payload('b0-hook-passthrough', 'PostToolUse', s.repo), T0 + 5000);
    expect(member(s, 'Bash(./probe.sh b-pass)')?.state).toBe('removed');
  });

  it('never decides for a shadow knob, whatever the state (invariant 7)', () => {
    const s = setup();
    hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo));
    for (const state of ['pending_removal', 'removed'] as const) {
      force(s, 'Bash(./probe.sh b-pass)', state, 'shadow');
      expect(hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PreToolUse', s.repo)).out).toBe(
        '',
      );
    }
  });

  it('re-snapshots after PermissionRequest → PostToolUse so a "don\'t ask again" rule is declared and used', () => {
    const s = setup();
    hook(s, 'SessionStart', payload('c0-dont-ask-again', 'SessionStart', s.repo));
    hook(s, 'PreToolUse', payload('c0-dont-ask-again', 'PreToolUse', s.repo), T0 + 1000);
    hook(
      s,
      'PermissionRequest',
      payload('c0-dont-ask-again', 'PermissionRequest', s.repo),
      T0 + 2000,
    );
    // Claude Code writes the rule when the user picks option 2 (facts doc A1 c0).
    writeJson(join(s.repo, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(./probe.sh c *)'] },
    });
    hook(s, 'PostToolUse', payload('c0-dont-ask-again', 'PostToolUse', s.repo), T0 + 3000);
    const local = 'local:0000000000000000000000000000000' + '1:github.com%2Fexample%2Fdemo:allow';
    expect(member(s, 'Bash(./probe.sh c *)', local)).toMatchObject({
      state: 'active',
      declaredAt: T0 + 3000,
      lastSeenAt: T0 + 3000,
    });
  });

  it('anchors matching at the session start directory, least restrictive when cwd moved', () => {
    const s = setup();
    hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo));
    force(s, 'Bash(./probe.sh b-pass)', 'removed');
    const moved = hook(
      s,
      'PreToolUse',
      payload('b0-hook-passthrough', 'PreToolUse', join(s.repo, 'sub')),
    );
    // Bash rules do not depend on cwd, so both readings agree on deny.
    expect(moved.out).toContain('"deny"');
  });

  it('fails open on a malformed payload and logs no payload text', () => {
    const s = setup();
    const r = hook(s, 'PreToolUse', '{"session_id": "x", "tool_input": "sk-live-SECRET"');
    expect(r).toMatchObject({ code: 0, out: '' });
    const log = readFileSync(join(s.home, '.taper', 'errors.log'), 'utf8');
    expect(log).toContain('hook PreToolUse');
    expect(log).not.toContain('SECRET');
  });

  it('ignores a payload whose hook_event_name disagrees with the argument', () => {
    const s = setup();
    const r = hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PostToolUse', s.repo));
    expect(r).toMatchObject({ code: 0, out: '' });
  });

  it('runs one evaluate tick per minute however many hooks fire (idempotent tick id)', () => {
    const s = setup();
    for (let i = 0; i < 3; i++)
      hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PreToolUse', s.repo), T0 + i * 1000);
    const a = Agent.open(s.deps());
    const ticks = a.store.db.prepare('SELECT tick_id FROM ticks').all();
    a.close();
    expect(ticks).toEqual([{ tick_id: 'tick:2026-09-23T12:00' }]);
  });

  it('does nothing before init', () => {
    const s = sandbox();
    const d = s.deps({ stdin: () => payload('b0-hook-passthrough', 'PreToolUse', s.repo) });
    expect(run(['hook', 'PreToolUse'], d)).toBe(0);
    expect(d.output).toEqual([]);
  });

  it('never writes a settings permissions array (invariant 3)', () => {
    const s = setup({ local: ['Bash(./probe.sh u *)'] });
    const files = [
      join(s.repo, '.claude', 'settings.json'),
      join(s.repo, '.claude', 'settings.local.json'),
    ];
    const before = files.map((f) => readFileSync(f, 'utf8'));
    force(s, 'Bash(./probe.sh b-pass)', 'removed');
    hook(s, 'SessionStart', payload('b0-hook-passthrough', 'SessionStart', s.repo));
    hook(s, 'PreToolUse', payload('b0-hook-passthrough', 'PreToolUse', s.repo));
    hook(s, 'Stop', payload('b0-hook-passthrough', 'Stop', s.repo));
    hook(s, 'SessionEnd', payload('b0-hook-passthrough', 'SessionEnd', s.repo));
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before);
  });
});
