import { describe, expect, it } from 'vitest';
import { canonicalTool, normalizeRule, type Polarity, parseRule } from '../src/rule.ts';

describe('normalizeRule', () => {
  it('trims whitespace and keeps case and specifier untouched', () => {
    expect(normalizeRule('  Bash(Git  *)\n')).toBe('Bash(Git  *)');
  });
});

describe('canonicalTool', () => {
  it.each([
    ['Task', 'Agent'],
    ['Agent', 'Agent'],
    ['Bash', 'Bash'],
    ['mcp__s__t', 'mcp__s__t'],
  ])('%s → %s', (name, canonical) => {
    expect(canonicalTool(name)).toBe(canonical);
  });
});

describe('parseRule', () => {
  it.each<[string, Polarity, string]>([
    ['Bash', 'allow', 'tools'],
    ['Bash(*)', 'allow', 'tools'],
    ['Read(*)', 'deny', 'tools'],
    ['Bash(git *)', 'allow', 'command'],
    ['Bash(git:*)', 'allow', 'command'],
    ['Bash(git:* push)', 'allow', 'inert'],
    ['Bash(git:* push)', 'deny', 'inert'],
    ['Monitor(tail *)', 'allow', 'command'],
    ['Read(src/**)', 'allow', 'path'],
    ['Edit(//etc/**)', 'deny', 'path'],
    ['Read(!x/**)', 'deny', 'path'],
    ['Read(!x/**)', 'allow', 'inert'],
    ['Write(out/**)', 'allow', 'inert'],
    ['NotebookEdit(x)', 'allow', 'inert'],
    ['MultiEdit(x)', 'allow', 'inert'],
    ['Glob(x)', 'allow', 'inert'],
    ['Grep(x)', 'allow', 'inert'],
    ['LSP(x)', 'allow', 'inert'],
    ['WebFetch(domain:x.com)', 'allow', 'domain'],
    ['WebFetch(url:x)', 'allow', 'inert'],
    ['WebSearch(x)', 'allow', 'tools'],
    ['WebSearch(x)', 'deny', 'tools'],
    ['*', 'deny', 'tool_glob'],
    ['*', 'allow', 'inert'],
    ['B*', 'ask', 'tool_glob'],
    ['B*', 'allow', 'inert'],
    ['mcp__*', 'allow', 'inert'],
    ['mcp__*', 'deny', 'tool_glob'],
    ['mcp__s', 'allow', 'tool_glob'],
    ['mcp__s__*', 'allow', 'tool_glob'],
    ['mcp__s__get_*', 'allow', 'tool_glob'],
    ['mcp__s__t', 'allow', 'tools'],
    ['mcp__s(x)', 'deny', 'inert'],
    ['Agent(Explore)', 'deny', 'agent'],
    ['Task(Plan)', 'deny', 'agent'],
    ['Agent(plugin:reviewer)', 'allow', 'agent'],
    ['Agent(model:opus)', 'ask', 'param'],
    ['Agent(model:opus)', 'allow', 'inert'],
    ['Bash(run_in_background:true)', 'deny', 'param'],
    ['Bash(timeout:*)', 'deny', 'either'],
    ['Bash(timeout:*)', 'allow', 'command'],
    ['Bash(command:rm *)', 'ask', 'inert'],
    ['Skill(commit)', 'allow', 'skill'],
    ['PowerShell(Get-Item *)', 'allow', 'inert'],
    ['Cd(/tmp)', 'allow', 'inert'],
    ['Foo(bar)', 'allow', 'inert'],
    ['Foo', 'allow', 'tools'],
    ['', 'allow', 'inert'],
    ['(git status)', 'allow', 'inert'],
    ['Bash(', 'allow', 'inert'],
    ['Bash()', 'allow', 'inert'],
    ['git status', 'allow', 'inert'],
    ['Bash(x) trailing', 'allow', 'inert'],
  ])('%j in %s → %s', (rule, polarity, kind) => {
    expect(parseRule(rule, polarity).kind).toBe(kind);
  });

  it('rewrites the legacy :* suffix to a trailing space-wildcard', () => {
    expect(parseRule('Bash(git:*)', 'allow')).toEqual({ kind: 'command', pattern: 'git *' });
    expect(parseRule('Monitor(tail:*)', 'allow')).toEqual({ kind: 'command', pattern: 'tail *' });
  });

  it('treats :* before more text as not understood (2026-09-23 run, ADR-0009)', () => {
    expect(parseRule('Bash(git:* push)', 'allow')).toMatchObject({ kind: 'inert' });
    expect(parseRule('Bash(a:*:*)', 'allow')).toMatchObject({ kind: 'inert' });
  });

  it('reads WebSearch with any specifier as bare WebSearch (2026-09-23 run, ADR-0009)', () => {
    expect(parseRule('WebSearch(anything)', 'allow')).toEqual(parseRule('WebSearch', 'allow'));
  });

  it('expands bare-name aliases', () => {
    const tools = (rule: string, polarity: Polarity) => {
      const p = parseRule(rule, polarity);
      return p.kind === 'tools' ? [...p.tools].sort() : [];
    };
    expect(tools('Edit', 'allow')).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    expect(tools('Read', 'allow')).toEqual(['Glob', 'Grep', 'LSP', 'Read']);
    expect(tools('Read', 'deny')).toEqual([
      'Edit',
      'Glob',
      'Grep',
      'LSP',
      'MultiEdit',
      'NotebookEdit',
      'Read',
      'Write',
    ]);
    expect(tools('Bash', 'allow')).toEqual(['Bash', 'Monitor']);
    expect(tools('Task', 'deny')).toEqual(['Agent']);
    expect(tools('Write', 'deny')).toEqual(['Write']);
  });

  it('is deterministic and returns fresh objects', () => {
    expect(parseRule('Bash(git *)', 'allow')).toEqual(parseRule('Bash(git *)', 'allow'));
  });
});
