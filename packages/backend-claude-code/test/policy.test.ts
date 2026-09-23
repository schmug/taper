import { describe, expect, it } from 'vitest';
import { buildPolicy, type PolicySource } from '../src/index.ts';

const src = (
  scope: PolicySource['scope'],
  path: string,
  arrays: Partial<PolicySource['arrays']>,
): PolicySource => ({
  scope,
  path,
  arrays: { allow: [], ask: [], deny: [], ...arrays },
});

describe('buildPolicy', () => {
  it('orders rules by scope precedence, then source order, then array index', () => {
    const policy = buildPolicy({
      home: '/h',
      workspaceTrusted: true,
      sources: [
        src('user', '/h/.claude/settings.json', { allow: ['u0'] }),
        src('managed', '/m/managed-settings.json', { allow: ['m0', 'm1'] }),
        src('managed', '/m/managed-settings.d/10-a.json', { deny: ['d0'] }),
        src('local', '/r/.claude/settings.local.json', { ask: ['l0'] }),
      ],
    });
    expect(policy.rules.map((r) => [r.rule, r.scope, r.polarity, r.index])).toEqual([
      ['m0', 'managed', 'allow', 0],
      ['m1', 'managed', 'allow', 1],
      ['d0', 'managed', 'deny', 0],
      ['l0', 'local', 'ask', 0],
      ['u0', 'user', 'allow', 0],
    ]);
    expect(policy.rules.map((r) => r.rank)).toEqual([0, 1, 2, 3, 4]);
  });

  it('trims rules, skips blank entries, and keeps the original array index', () => {
    const policy = buildPolicy({
      home: '/h',
      workspaceTrusted: true,
      sources: [src('local', '/r/.claude/settings.local.json', { allow: ['  ', ' Bash(x) '] })],
    });
    expect(policy.rules.map((r) => [r.rule, r.index])).toEqual([['Bash(x)', 1]]);
  });

  it('drops project allow rules only when the workspace is untrusted', () => {
    const sources = [
      src('project', '/r/.claude/settings.json', { allow: ['pa'], ask: ['pq'], deny: ['pd'] }),
      src('local', '/r/.claude/settings.local.json', { allow: ['la'] }),
    ];
    const rules = (workspaceTrusted: boolean | 'unknown') =>
      buildPolicy({ home: '/h', workspaceTrusted, sources }).rules.map((r) => r.rule);
    expect(rules(false)).toEqual(['la', 'pq', 'pd']);
    expect(rules('unknown')).toEqual(['la', 'pa', 'pq', 'pd']);
    expect(rules(true)).toEqual(['la', 'pa', 'pq', 'pd']);
  });

  it('anchors /path rules per settings source', () => {
    const policy = buildPolicy({
      home: '/h',
      workspaceTrusted: true,
      sources: [
        src('managed', '/m/managed-settings.json', { allow: ['a'] }),
        src('cli', '/ci/claude.json', { allow: ['a'] }),
        { ...src('cli', '.github/workflows/x.yml#settings[0]', { allow: ['a'] }), inline: true },
        src('local', '/r/.claude/settings.local.json', { allow: ['a'] }),
        src('project', '/r/.claude/settings.json', { allow: ['a'] }),
        src('user', '/h/.claude/settings.json', { allow: ['a'] }),
      ],
    });
    // Inline --settings JSON has no file; like CLI rules it anchors at the session cwd (null).
    expect(policy.rules.map((r) => r.anchorDir)).toEqual([
      '/m',
      '/ci',
      null,
      '/r',
      '/r',
      '/h/.claude',
    ]);
  });

  it('attaches knob ids per array when the source carries them', () => {
    const policy = buildPolicy({
      home: '/h',
      workspaceTrusted: true,
      sources: [
        {
          ...src('local', '/r/.claude/settings.local.json', { allow: ['a'], deny: ['d'] }),
          knobIds: { allow: 'k-allow' },
        },
      ],
    });
    expect(policy.rules.map((r) => [r.rule, r.knobId])).toEqual([
      ['a', 'k-allow'],
      ['d', undefined],
    ]);
  });
});
