// Matcher behavior not tied to one rule form. Rule forms themselves live in fixtures/settings.

import { describe, expect, it } from 'vitest';
import { buildPolicy, MAX_COMMAND_LENGTH, match, type PolicySource } from '../src/index.ts';

const CWD = '/w/repo';
const policyOf = (arrays: Partial<PolicySource['arrays']>) =>
  buildPolicy({
    home: '/h',
    workspaceTrusted: true,
    sources: [
      {
        scope: 'local',
        path: `${CWD}/.claude/settings.local.json`,
        arrays: { allow: [], ask: [], deny: [], ...arrays },
      },
    ],
  });
const bash = (command: string) => ({ tool: 'Bash', input: { command }, cwd: CWD });

describe('match', () => {
  it('prompts for commands over 10,000 characters even when a rule allows them', () => {
    const r = match(policyOf({ allow: ['Bash'] }), bash(`echo ${'a'.repeat(MAX_COMMAND_LENGTH)}`));
    expect(r.outcome).toBe('ask');
    expect(r.basis).toBe('too_long');
    expect(r.decisiveRules).toEqual([]);
    expect(r.allMatchingAllowRules.map((x) => x.rule)).toEqual(['Bash']);
  });

  it('still denies an over-long command that a deny rule matches', () => {
    const r = match(policyOf({ deny: ['Bash(echo *)'] }), bash(`echo ${'a'.repeat(10_001)}`));
    expect(r.outcome).toBe('deny');
  });

  it('treats an empty command as unmatched', () => {
    expect(match(policyOf({ allow: ['Bash(x *)'] }), bash('')).outcome).toBe('none');
  });

  it('treats a missing or non-string command as empty', () => {
    const r = match(policyOf({ allow: ['Bash'] }), { tool: 'Bash', input: {}, cwd: CWD });
    expect(r.outcome).toBe('allow');
  });

  it('resolves relative file paths against cwd', () => {
    const policy = policyOf({ deny: ['Read(secret/**)'] });
    const r = match(policy, { tool: 'Read', input: { file_path: 'secret/k' }, cwd: CWD });
    expect(r.outcome).toBe('deny');
  });

  it('treats a path that escapes cwd through .. as outside', () => {
    const r = match(policyOf({}), { tool: 'Read', input: { file_path: `${CWD}/../x` }, cwd: CWD });
    expect(r).toMatchObject({ outcome: 'none', basis: 'no_match' });
  });

  it('uses cwd as the path for Grep and Glob calls without one', () => {
    const r = match(policyOf({ deny: ['Read(//w/repo/**)'] }), {
      tool: 'Grep',
      input: { pattern: 'x' },
      cwd: CWD,
    });
    expect(r.outcome).toBe('deny');
  });

  it('matches domain rules only against parseable http(s) URLs', () => {
    const policy = policyOf({ allow: ['WebFetch(domain:*)'] });
    const call = (url: unknown) => ({ tool: 'WebFetch', input: { url }, cwd: CWD });
    expect(match(policy, call('https://a.test/')).outcome).toBe('allow');
    expect(match(policy, call('not a url')).outcome).toBe('none');
    expect(match(policy, call(42)).outcome).toBe('none');
  });

  it('returns none for a tool no rule names', () => {
    expect(match(policyOf({ allow: ['Bash'] }), { tool: 'Foo', input: {}, cwd: CWD })).toEqual({
      outcome: 'none',
      basis: 'no_match',
      decisiveRules: [],
      allMatchingAllowRules: [],
    });
  });

  it('does not mutate its inputs and is deterministic', () => {
    const policy = policyOf({ allow: ['Bash(a *)', 'Bash(b *)'], deny: ['Bash(c *)'] });
    const call = Object.freeze({
      tool: 'Bash',
      input: Object.freeze({ command: 'a 1 && b 2' }),
      cwd: CWD,
    });
    expect(match(policy, call)).toEqual(match(policy, call));
  });
});
