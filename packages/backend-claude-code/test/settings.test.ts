import { describe, expect, it } from 'vitest';
import {
  findSettingsRefs,
  invokesClaudeCode,
  parseSettingsText,
  SettingsSnapshotSchema,
} from '../src/settings.ts';

describe('parseSettingsText', () => {
  it('extracts the three permission arrays and whether hooks are configured', () => {
    const text = JSON.stringify({
      permissions: { allow: ['Bash(git *)'], ask: [], deny: ['Read(.env)'], defaultMode: 'plan' },
      hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] },
      env: { X: '1' },
    });
    expect(parseSettingsText(text)).toEqual({
      ok: true,
      settings: {
        arrays: { allow: ['Bash(git *)'], ask: [], deny: ['Read(.env)'] },
        hooksPresent: true,
      },
    });
  });

  it('keeps malformed rule strings (they are in the file) but drops non-strings', () => {
    const text = JSON.stringify({ permissions: { allow: ['Bash(', 42, null, 'Read'] } });
    expect(parseSettingsText(text)).toMatchObject({
      ok: true,
      settings: { arrays: { allow: ['Bash(', 'Read'], ask: [], deny: [] } },
    });
  });

  it('treats missing or non-object permissions and non-array lists as empty', () => {
    for (const permissions of [undefined, 'x', [], { allow: 'Bash' }]) {
      expect(parseSettingsText(JSON.stringify({ permissions }))).toEqual({
        ok: true,
        settings: { arrays: { allow: [], ask: [], deny: [] }, hooksPresent: false },
      });
    }
  });

  it('reads an empty file as {}', () => {
    expect(parseSettingsText('  \n')).toMatchObject({ ok: true });
  });

  it('reports hooks absent when no event has a handler group', () => {
    const text = JSON.stringify({ hooks: { PreToolUse: [] } });
    expect(parseSettingsText(text)).toMatchObject({ ok: true, settings: { hooksPresent: false } });
  });

  it('rejects invalid JSON and non-object roots, as Claude Code rejects the whole file', () => {
    expect(parseSettingsText('{"permissions": ')).toMatchObject({ ok: false });
    expect(parseSettingsText('[]')).toMatchObject({ ok: false });
    expect(parseSettingsText('null')).toMatchObject({ ok: false });
  });
});

describe('findSettingsRefs', () => {
  it('finds file, inline and unresolvable --settings arguments', () => {
    const yml = [
      'jobs:',
      '  review:',
      '    steps:',
      '      - run: claude -p "review" --settings .claude/ci.json --max-turns 3',
      '      - run: claude -p x --settings=ci/strict.json',
      `      - run: claude -p x --settings '{"permissions":{"deny":["Bash(rm *)"]}}'`,
      '      - uses: anthropics/claude-code-action@v1',
      '        with:',
      '          claude_args: |',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      '            --settings ${{ inputs.settings }}',
      '            --settings "./quoted path.json"',
    ].join('\n');
    expect(findSettingsRefs(yml)).toEqual([
      { kind: 'file', path: '.claude/ci.json' },
      { kind: 'file', path: 'ci/strict.json' },
      { kind: 'inline', json: '{"permissions":{"deny":["Bash(rm *)"]}}' },
      { kind: 'unresolved', token: '${{' },
      { kind: 'file', path: './quoted path.json' },
    ]);
  });

  it('finds nothing in a workflow without --settings', () => {
    expect(findSettingsRefs('run: npm test')).toEqual([]);
  });
});

describe('invokesClaudeCode', () => {
  it.each([
    ['uses: anthropics/claude-code-action@v1', true],
    ['uses: anthropics/claude-code-base-action@beta', true],
    ['run: claude -p "x"', true],
    ['run: npx @anthropic-ai/claude-code --print x', true],
    ['run: npm test', false],
    ['name: claude-ish docs', false],
  ])('%j → %s', (text, expected) => {
    expect(invokesClaudeCode(text)).toBe(expected);
  });
});

describe('SettingsSnapshotSchema', () => {
  const base = {
    device_id: 'dev1',
    scope: 'user',
    path: '/h/.claude/settings.json',
    taken_at: 1,
    content_hash: 'a'.repeat(64),
    arrays: { allow: [], ask: [], deny: [] },
    hooks_present: false,
  };

  it('accepts a user snapshot', () => {
    expect(SettingsSnapshotSchema.parse(base)).toEqual(base);
  });

  it('requires repo_id for repo scopes and pipeline_id for cli', () => {
    expect(SettingsSnapshotSchema.safeParse({ ...base, scope: 'project' }).success).toBe(false);
    expect(
      SettingsSnapshotSchema.safeParse({ ...base, scope: 'local', repo_id: 'r' }).success,
    ).toBe(true);
    expect(SettingsSnapshotSchema.safeParse({ ...base, scope: 'cli', repo_id: 'r' }).success).toBe(
      false,
    );
    expect(
      SettingsSnapshotSchema.safeParse({ ...base, scope: 'cli', repo_id: 'r', pipeline_id: 'p' })
        .success,
    ).toBe(true);
  });

  it('rejects unknown keys and malformed hashes', () => {
    expect(SettingsSnapshotSchema.safeParse({ ...base, raw: 'x' }).success).toBe(false);
    expect(SettingsSnapshotSchema.safeParse({ ...base, content_hash: 'xyz' }).success).toBe(false);
  });
});
