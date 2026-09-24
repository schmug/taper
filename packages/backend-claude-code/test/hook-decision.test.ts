// Hook enforcement (HANDOFF §5.4A, ADR-0011): PreToolUse returns `ask` for a matched
// pending_removal member, `deny` for a matched removed member that the call needs, otherwise
// nothing. Shadow knobs never yield a decision (invariant 7).

import {
  type Config,
  DAY_MS,
  DEFAULT_THRESHOLDS,
  type Knob,
  type Member,
  type MemberState,
  memberIdFor,
} from '@taper/core';
import { describe, expect, it } from 'vitest';
import type { PermissionMode } from '../src/event.ts';
import {
  askReason,
  denyReason,
  hookDecision,
  hookOutput,
  removedAskReason,
} from '../src/hook-decision.ts';
import type { ToolCall } from '../src/match.ts';
import { buildPolicy } from '../src/policy.ts';

const config: Config = { thresholds: DEFAULT_THRESHOLDS };
const NOW = 100 * DAY_MS;
const K = 'local:dev:repo:allow';

const knob = (mode: Knob['mode'] = 'automatic', over: Partial<Knob> = {}): Knob => ({
  id: K,
  mode,
  protected: false,
  clock: 'wall',
  ...over,
});

const member = (rule: string, state: MemberState, over: Partial<Member> = {}): Member => ({
  id: memberIdFor(K, rule),
  knobId: K,
  rule,
  declaredAt: 0,
  firstSeenAt: null,
  lastSeenAt: 10 * DAY_MS,
  lastRestoredAt: null,
  state,
  stateSince: 70 * DAY_MS,
  cooldownUntil: null,
  restoredCount: 0,
  protected: false,
  retiredFrom: null,
  ...over,
});

const policy = (allow: string[], extra: { ask?: string[]; deny?: string[] } = {}) =>
  buildPolicy({
    home: '/home/u',
    workspaceTrusted: true,
    sources: [
      {
        scope: 'local',
        path: '/repo/.claude/settings.local.json',
        arrays: { allow, ask: extra.ask ?? [], deny: extra.deny ?? [] },
        knobIds: { allow: K, ask: 'local:dev:repo:ask', deny: 'local:dev:repo:deny' },
      },
    ],
  });

const bash = (command: string, cwd = '/repo'): ToolCall => ({
  tool: 'Bash',
  input: { command },
  cwd,
});

const decide = (
  allow: string[],
  members: Member[],
  calls: ToolCall[],
  opts: { knobs?: Knob[]; deny?: string[]; mode?: PermissionMode } = {},
) =>
  hookDecision({
    policy: policy(allow, opts.deny ? { deny: opts.deny } : {}),
    calls,
    knobs: opts.knobs ?? [knob()],
    members,
    config,
    now: NOW,
    permissionMode: opts.mode ?? 'default',
  });

describe('hookDecision', () => {
  it('asks for a matched pending_removal member, with the §5.4A reason', () => {
    const m = member('Bash(npm run lint)', 'pending_removal');
    const d = decide(['Bash(npm run lint)'], [m], [bash('npm run lint')]);
    expect(d).toEqual({
      permissionDecision: 'ask',
      reason:
        'taper: "Bash(npm run lint)" unused for 90 days; approving restores it (cooldown 14d). ' +
        "Run `taper explain 'Bash(npm run lint)'` for details.",
      memberIds: [m.id],
    });
  });

  it('denies a matched removed member when no other allow rule covers the call', () => {
    const m = member('Bash(npm run lint)', 'removed');
    const d = decide(['Bash(npm run lint)'], [m], [bash('npm run lint')]);
    expect(d).toEqual({
      permissionDecision: 'deny',
      reason:
        'taper: "Bash(npm run lint)" removed after 60 days unused. ' +
        "Re-grant: `taper regrant 'Bash(npm run lint)'` or the dashboard.",
      memberIds: [m.id],
    });
  });

  it('passes through a removed member when another in-force allow member matches', () => {
    for (const other of ['active', 'stale_candidate'] as const) {
      const removed = member('Bash(npm run lint)', 'removed');
      const broad = member('Bash(npm *)', other);
      expect(
        decide(['Bash(npm run lint)', 'Bash(npm *)'], [removed, broad], [bash('npm run lint')]),
      ).toBeNull();
    }
  });

  it('asks rather than denies when a pending member still covers the call', () => {
    const removed = member('Bash(npm run lint)', 'removed');
    const pending = member('Bash(npm *)', 'pending_removal');
    const d = decide(
      ['Bash(npm run lint)', 'Bash(npm *)'],
      [removed, pending],
      [bash('npm run lint')],
    );
    expect(d?.permissionDecision).toBe('ask');
    expect(d?.memberIds).toEqual([pending.id]);
  });

  it('denies when a compound command needs the removed member for one part', () => {
    const removed = member('Bash(git push *)', 'removed');
    const active = member('Bash(npm test)', 'active');
    const d = decide(
      ['Bash(git push *)', 'Bash(npm test)'],
      [removed, active],
      [bash('npm test && git push origin main')],
    );
    expect(d?.permissionDecision).toBe('deny');
    expect(d?.memberIds).toEqual([removed.id]);
  });

  it('passes through when the call needs no rule (read-only built-in)', () => {
    const removed = member('Bash(ls *)', 'removed');
    expect(decide(['Bash(ls *)'], [removed], [bash('ls -la')])).toBeNull();
  });

  it('passes through when Claude Code would prompt or deny anyway', () => {
    const removed = member('Bash(./build.sh *)', 'removed');
    expect(decide(['Bash(./build.sh *)'], [removed], [bash('./build.sh > out.txt')])).toBeNull();
    expect(
      decide(['Bash(./build.sh *)'], [removed], [bash('./build.sh x')], {
        deny: ['Bash(./build.sh x)'],
      }),
    ).toBeNull();
  });

  it('never decides for a shadow knob (invariant 7)', () => {
    for (const state of ['pending_removal', 'removed'] as const) {
      const m = member('Bash(npm run lint)', state);
      expect(
        decide(['Bash(npm run lint)'], [m], [bash('npm run lint')], { knobs: [knob('shadow')] }),
      ).toBeNull();
    }
  });

  it('does nothing for active, stale, retired or unmatched members', () => {
    for (const state of ['active', 'stale_candidate', 'retired'] as const) {
      const m = member('Bash(npm run lint)', state);
      expect(decide(['Bash(npm run lint)'], [m], [bash('npm run lint')])).toBeNull();
    }
    const m = member('Bash(npm run lint)', 'removed');
    expect(decide(['Bash(npm run lint)'], [m], [bash('npm test')])).toBeNull();
  });

  it('takes the least restrictive decision across working directories', () => {
    // Relative path rule: matches under the session's start cwd, not under a subdirectory.
    const removed = member('Edit(docs/**)', 'removed');
    const call = (cwd: string): ToolCall => ({
      tool: 'Edit',
      input: { file_path: '/repo/docs/a.md' },
      cwd,
    });
    expect(decide(['Edit(docs/**)'], [removed], [call('/repo')])?.permissionDecision).toBe('deny');
    expect(decide(['Edit(docs/**)'], [removed], [call('/repo'), call('/repo/docs')])).toBeNull();
  });

  it('uses the knob cooldown override in the ask reason', () => {
    const m = member('Bash(npm run lint)', 'pending_removal');
    const d = decide(['Bash(npm run lint)'], [m], [bash('npm run lint')], {
      knobs: [knob('automatic', { thresholds: { cooldownDays: 3 } })],
    });
    expect(d?.reason).toContain('(cooldown 3d)');
  });

  it('renders the PreToolUse stdout shape (facts doc A2 Hook I/O)', () => {
    expect(hookOutput({ permissionDecision: 'ask', reason: 'r', memberIds: [] })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'r',
      },
    });
  });

  it('single-quotes the suggested command so a rule never expands in the shell', () => {
    expect(askReason('Bash(echo "hi")', 3, 14)).toContain('`taper explain \'Bash(echo "hi")\'`');
    expect(askReason("Bash(echo 'x' $(id) `w` $HOME !1)", 3, 14)).toContain(
      "`taper explain 'Bash(echo '\\''x'\\'' $(id) `w` $HOME !1)'`",
    );
    expect(denyReason('Bash(x)', 61)).toBe(
      'taper: "Bash(x)" removed after 61 days unused. Re-grant: `taper regrant \'Bash(x)\'` or the dashboard.',
    );
  });

  describe('permission modes (ADR-0011): never block what deleting the rule would allow', () => {
    const removed = member('Bash(npm test)', 'removed');
    const pending = member('Bash(npm test)', 'pending_removal');

    it('bypassPermissions: no decision, the rule changes nothing there', () => {
      for (const m of [removed, pending])
        expect(
          decide(['Bash(npm test)'], [m], [bash('npm test')], { mode: 'bypassPermissions' }),
        ).toBeNull();
    });

    it('acceptEdits: no decision for what the mode approves on its own', () => {
      const edit = member('Edit(src/**)', 'removed');
      const call: ToolCall = { tool: 'Edit', input: { file_path: '/repo/src/a.ts' }, cwd: '/repo' };
      expect(decide(['Edit(src/**)'], [edit], [call], { mode: 'acceptEdits' })).toBeNull();
      expect(decide(['Edit(src/**)'], [edit], [call])?.permissionDecision).toBe('deny');
      const mkdir = member('Bash(mkdir *)', 'removed');
      expect(
        decide(['Bash(mkdir *)'], [mkdir], [bash('mkdir -p out')], { mode: 'acceptEdits' }),
      ).toBeNull();
      // A compound whose other part is allowed by a live rule: mkdir needs no rule in acceptEdits.
      const test = member('Bash(npm test)', 'active');
      expect(
        decide(
          ['Bash(mkdir *)', 'Bash(npm test)'],
          [mkdir, test],
          [bash('mkdir out && npm test')],
          {
            mode: 'acceptEdits',
          },
        ),
      ).toBeNull();
      // The mode's own approvals count on the "with the rule" side too: here only curl needs a rule.
      const curl = member('Bash(curl *)', 'removed');
      expect(
        decide(['Bash(curl *)'], [curl], [bash('mkdir out && curl x.example')], {
          mode: 'acceptEdits',
        })?.permissionDecision,
      ).toBe('deny');
      // Commands acceptEdits does not approve still need the rule.
      expect(
        decide(['Bash(npm test)'], [removed], [bash('npm test')], { mode: 'acceptEdits' })
          ?.permissionDecision,
      ).toBe('deny');
    });

    it('auto and unknown: a removed rule asks instead of denying (the classifier might allow it)', () => {
      for (const mode of ['auto', 'unknown'] as const) {
        const d = decide(['Bash(npm test)'], [removed], [bash('npm test')], { mode });
        expect(d).toEqual({
          permissionDecision: 'ask',
          reason: removedAskReason('Bash(npm test)', 60),
          memberIds: [removed.id],
        });
        expect(
          decide(['Bash(npm test)'], [pending], [bash('npm test')], { mode })?.permissionDecision,
        ).toBe('ask');
      }
      expect(removedAskReason('Bash(x)', 60)).toBe(
        'taper: "Bash(x)" removed after 60 days unused; approving allows this call only. Re-grant: `taper regrant \'Bash(x)\'`.',
      );
    });

    it('default, plan and dontAsk keep §5.4A as is', () => {
      for (const mode of ['default', 'plan', 'dontAsk'] as const)
        expect(
          decide(['Bash(npm test)'], [removed], [bash('npm test')], { mode })?.permissionDecision,
        ).toBe('deny');
    });
  });
});
