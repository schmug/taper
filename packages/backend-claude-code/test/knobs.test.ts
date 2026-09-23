// Settings snapshots → core knobs, members and attribution (HANDOFF §3.1, §5.2; C1–C3, C5).

import { memberIdFor } from '@taper/core';
import { describe, expect, it } from 'vitest';
import {
  applySettingsSnapshots,
  attribute,
  isProtectedByDefault,
  knobIdFor,
  planKnobs,
  policyFromSnapshots,
} from '../src/knobs.ts';
import type { SettingsSnapshot } from '../src/settings.ts';

const H = 'a'.repeat(64);
const snap = (
  scope: SettingsSnapshot['scope'],
  path: string,
  arrays: Partial<SettingsSnapshot['arrays']>,
  extra: Partial<SettingsSnapshot> = {},
): SettingsSnapshot => ({
  device_id: 'dev1',
  scope,
  path,
  taken_at: 100,
  content_hash: H,
  arrays: { allow: [], ask: [], deny: [], ...arrays },
  hooks_present: false,
  ...(scope === 'user' || scope === 'managed' ? {} : { repo_id: 'github.com/o/r' }),
  ...(scope === 'cli' ? { pipeline_id: '.github/workflows/ci.yml' } : {}),
  ...extra,
});
const OPTS = { managedSubject: 'org1' };

describe('knobIdFor', () => {
  it('derives one knob per scope, subject and array', () => {
    expect([
      knobIdFor(snap('user', '/h/.claude/settings.json', {}), 'allow', OPTS),
      knobIdFor(snap('project', '/r/.claude/settings.json', {}), 'deny', OPTS),
      knobIdFor(snap('local', '/r/.claude/settings.local.json', {}), 'allow', OPTS),
      knobIdFor(snap('managed', '/m/managed-settings.json', {}), 'ask', OPTS),
      knobIdFor(snap('cli', '/r/ci.json', {}), 'allow', OPTS),
    ]).toEqual([
      'user:dev1:allow',
      'project:github.com%2Fo%2Fr:deny',
      'local:dev1:github.com%2Fo%2Fr:allow',
      'managed:org1:ask',
      'cli:github.com%2Fo%2Fr:.github%2Fworkflows%2Fci.yml:allow',
    ]);
  });
});

describe('isProtectedByDefault', () => {
  it.each<[string, SettingsSnapshot['scope'], 'allow' | 'ask' | 'deny', boolean]>([
    ['Bash(git *)', 'local', 'allow', false],
    ['Bash(git *)', 'local', 'deny', true],
    ['Bash(git *)', 'project', 'ask', true],
    ['Bash(git *)', 'managed', 'allow', true],
    ['Read(src/**)', 'project', 'allow', true],
    ['Read', 'user', 'allow', true],
    ['Edit(src/**)', 'project', 'allow', false],
    ['Write(out/**)', 'local', 'allow', true],
    ['mcp__*', 'local', 'allow', true],
    ['Bash(', 'local', 'allow', true],
  ])('%j in %s.%s → %s', (rule, scope, polarity, expected) => {
    expect(isProtectedByDefault(rule, scope, polarity, true)).toBe(expected);
  });

  it('lets Read(...) rules decay when the C2 flag is off', () => {
    expect(isProtectedByDefault('Read(src/**)', 'project', 'allow', false)).toBe(false);
  });
});

describe('planKnobs', () => {
  it('defaults: shadow everywhere, deny/ask and managed protected, cli shadow-only', () => {
    const plans = planKnobs(
      [
        snap('local', '/r/.claude/settings.local.json', { allow: ['Bash(x)'], deny: ['Bash(y)'] }),
        snap('managed', '/m/managed-settings.json', { allow: ['Edit'] }),
        snap('cli', '/r/ci.json', { allow: ['Bash(npm test)'] }),
      ],
      OPTS,
    );
    const cli = 'cli:github.com%2Fo%2Fr:.github%2Fworkflows%2Fci.yml';
    const local = 'local:dev1:github.com%2Fo%2Fr';
    expect(plans.map((p) => [p.knob.id, p.kind, p.knob.mode, p.knob.protected])).toEqual([
      ['managed:org1:allow', 'managed', 'shadow', true],
      ['managed:org1:ask', 'managed', 'shadow', true],
      ['managed:org1:deny', 'managed', 'shadow', true],
      [`${cli}:allow`, 'cli', 'shadow', false],
      [`${cli}:ask`, 'cli', 'shadow', true],
      [`${cli}:deny`, 'cli', 'shadow', true],
      [`${local}:allow`, 'local', 'shadow', false],
      [`${local}:ask`, 'local', 'shadow', true],
      [`${local}:deny`, 'local', 'shadow', true],
    ]);
    expect(plans.every((p) => p.knob.clock === 'wall')).toBe(true);
  });

  it('unions managed files into one knob and skips taper’s own 50-taper.json', () => {
    const plans = planKnobs(
      [
        snap('managed', '/m/managed-settings.json', { deny: ['Bash(rm *)'] }, { taken_at: 50 }),
        snap('managed', '/m/managed-settings.d/10-a.json', {
          deny: [' Bash(curl *) ', 'Bash(rm *)'],
        }),
        snap('managed', '/m/managed-settings.d/50-taper.json', {
          ask: ['Bash(git *)'],
          deny: ['X'],
        }),
      ],
      OPTS,
    );
    expect(plans.map((p) => [p.knob.id, p.snapshot.rules, p.snapshot.takenAt])).toEqual([
      ['managed:org1:allow', [], 100],
      ['managed:org1:ask', [], 100],
      ['managed:org1:deny', ['Bash(rm *)', 'Bash(curl *)'], 100],
    ]);
  });

  it('emits a plan per array even when it is empty, so vanished rules retire', () => {
    const plans = planKnobs([snap('user', '/h/.claude/settings.json', { allow: ['  '] })], OPTS);
    expect(plans.map((p) => [p.knob.id, p.snapshot.rules])).toEqual([
      ['user:dev1:allow', []],
      ['user:dev1:ask', []],
      ['user:dev1:deny', []],
    ]);
  });
});

describe('applySettingsSnapshots', () => {
  it('declares, protects and retires members through core.applySnapshot', () => {
    const first = applySettingsSnapshots(
      [],
      [
        snap('project', '/r/.claude/settings.json', {
          allow: ['Bash(git *)', 'Read(src/**)'],
          deny: ['Read(.env)'],
        }),
      ],
      { ...OPTS, knobs: [], tickId: 't1' },
    );
    expect(
      first.members.map((m) => [m.knobId, m.rule, m.state, m.protected, m.declaredAt]),
    ).toEqual([
      ['project:github.com%2Fo%2Fr:allow', 'Bash(git *)', 'active', false, 100],
      ['project:github.com%2Fo%2Fr:allow', 'Read(src/**)', 'active', true, 100],
      ['project:github.com%2Fo%2Fr:deny', 'Read(.env)', 'active', true, 100],
    ]);
    expect(first.knobs.map((k) => [k.id, k.protected])).toEqual([
      ['project:github.com%2Fo%2Fr:allow', false],
      ['project:github.com%2Fo%2Fr:ask', true],
      ['project:github.com%2Fo%2Fr:deny', true],
    ]);

    const automatic = first.knobs.map((k) => ({ ...k, mode: 'automatic' as const }));
    const second = applySettingsSnapshots(
      first.members,
      [
        snap(
          'project',
          '/r/.claude/settings.json',
          { allow: ['Read(src/**)'], deny: ['Read(.env)'] },
          { taken_at: 200 },
        ),
      ],
      { ...OPTS, knobs: automatic, tickId: 't2' },
    );
    expect(second.knobs).toEqual(automatic);
    expect(second.transitions.map((t) => [t.memberId, t.from, t.to, t.reason, t.shadow])).toEqual([
      [
        memberIdFor('project:github.com%2Fo%2Fr:allow', 'Bash(git *)'),
        'active',
        'retired',
        'vanished',
        false,
      ],
    ]);
  });
});

describe('policyFromSnapshots + attribute', () => {
  const snapshots = [
    snap('local', '/r/.claude/settings.local.json', { allow: ['Bash(git *)', 'Bash(git status)'] }),
    snap('project', '/r/.claude/settings.json', {
      allow: ['Bash(git *)'],
      deny: ['Bash(git push *)'],
    }),
    snap('managed', '/m/managed-settings.d/50-taper.json', { ask: ['Bash(git *)'] }),
  ];
  const policy = policyFromSnapshots(snapshots, { ...OPTS, home: '/h', workspaceTrusted: true });
  const bash = (command: string) => ({ tool: 'Bash', input: { command }, cwd: '/r' });

  it('returns member ids of every matching allow rule (C5) and the decisive set', () => {
    const local = 'local:dev1:github.com%2Fo%2Fr:allow';
    const project = 'project:github.com%2Fo%2Fr:allow';
    expect(attribute(policy, bash('git status'))).toEqual({
      outcome: 'ask',
      basis: 'rule',
      matchedMemberIds: [
        memberIdFor(local, 'Bash(git *)'),
        memberIdFor(local, 'Bash(git status)'),
        memberIdFor(project, 'Bash(git *)'),
      ],
      // The decisive rule is taper's own ask: machine-owned, so it is not a member.
      decisiveMemberIds: [],
    });
  });

  it('includes taper-owned rules in the policy so outcomes are right', () => {
    expect(attribute(policy, bash('git push origin'))).toMatchObject({
      outcome: 'deny',
      decisiveMemberIds: [memberIdFor('project:github.com%2Fo%2Fr:deny', 'Bash(git push *)')],
    });
  });
});
