// Installing taper's hooks is the one write taper makes to a settings file: under `hooks` only,
// idempotent, removable, and never touching a `permissions` array (invariant 3).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPermissionsUnchanged,
  commandPrefix,
  HOOK_EVENTS,
  installHooks,
  removeHooks,
  shellQuote,
  withHooks,
  withoutHooks,
} from '../src/hooks-config.ts';
import { tempDir } from './helpers.ts';

const PREFIX = commandPrefix(['/usr/bin/node', '/opt/taper/taper.mjs']);

const human = {
  permissions: {
    allow: ['Bash(npm run lint)', 'Bash(git status)'],
    deny: ['Read(./.env)'],
    defaultMode: 'default',
  },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard.sh' }] }],
  },
  model: 'opus',
};
const humanText = `${JSON.stringify(human, null, 2)}\n`;
const permissionsBlock = (text: string) => {
  const start = text.indexOf('"permissions"');
  return text.slice(start, text.indexOf('},', start) + 1);
};

describe('shellQuote / commandPrefix', () => {
  it('single-quotes paths, including spaces and quotes', () => {
    expect(shellQuote("/Users/a b/it's")).toBe(`'/Users/a b/it'\\''s'`);
    expect(PREFIX).toBe(`'/usr/bin/node' '/opt/taper/taper.mjs'`);
  });
});

describe('withHooks', () => {
  it('creates a hooks block for every event in a missing file', () => {
    const { text, changed } = withHooks(null, PREFIX);
    expect(changed).toBe(true);
    const parsed = JSON.parse(text) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(parsed.hooks)).toEqual([...HOOK_EVENTS]);
    expect(parsed.hooks.PreToolUse).toEqual([
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `${PREFIX} hook PreToolUse`, timeout: 10 }],
      },
    ]);
    expect(parsed.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: `${PREFIX} hook SessionStart`, timeout: 10 }] },
    ]);
    expect(parsed.hooks.SessionEnd).toEqual([
      { hooks: [{ type: 'command', command: `${PREFIX} hook SessionEnd` }] },
    ]);
  });

  it('leaves permissions byte-identical and keeps other hooks and keys (invariant 3)', () => {
    const { text } = withHooks(humanText, PREFIX);
    const parsed = JSON.parse(text) as typeof human & { hooks: Record<string, unknown[]> };
    expect(parsed.permissions).toEqual(human.permissions);
    expect(permissionsBlock(text)).toBe(permissionsBlock(humanText));
    expect(parsed.model).toBe('opus');
    expect(parsed.hooks.PreToolUse?.[0]).toEqual(human.hooks.PreToolUse[0]);
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('is idempotent', () => {
    const once = withHooks(humanText, PREFIX).text;
    const twice = withHooks(once, PREFIX);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });

  it('refuses invalid JSON or a non-object hooks value', () => {
    expect(() => withHooks('{nope', PREFIX)).toThrow(/not valid JSON/);
    expect(() => withHooks('{"hooks": []}', PREFIX)).toThrow(/hooks/);
    expect(() => withHooks('[]', PREFIX)).toThrow(/object/);
  });
});

describe('withoutHooks', () => {
  it('removes exactly taper entries and restores the original file', () => {
    const installed = withHooks(humanText, PREFIX).text;
    const { text, removed } = withoutHooks(installed, [PREFIX]);
    expect(removed).toBe(HOOK_EVENTS.length);
    expect(text).toBe(humanText);
  });

  it('drops a hooks key it emptied, and is a no-op when nothing is installed', () => {
    const installed = withHooks('{}\n', PREFIX).text;
    expect(withoutHooks(installed, [PREFIX]).text).toBe('{}\n');
    expect(withoutHooks(humanText, [PREFIX])).toEqual({
      text: humanText,
      changed: false,
      removed: 0,
    });
    expect(withoutHooks(null, [PREFIX])).toEqual({ text: null, changed: false, removed: 0 });
  });
});

describe('assertPermissionsUnchanged', () => {
  it('throws if a rewrite would change any permissions value', () => {
    expect(() => assertPermissionsUnchanged(human, human)).not.toThrow();
    const edited = { ...human, permissions: { ...human.permissions, allow: ['Bash(git status)'] } };
    expect(() => assertPermissionsUnchanged(human, edited)).toThrow(/invariant 3/);
  });
});

describe('installHooks / removeHooks (files)', () => {
  it('writes atomically, keeps the file mode, and removes cleanly', () => {
    const file = join(tempDir(), '.claude', 'settings.json');
    expect(installHooks(file, PREFIX)).toBe(true);
    expect(installHooks(file, PREFIX)).toBe(false);
    expect(removeHooks(file, [PREFIX])).toBe(HOOK_EVENTS.length);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
  });

  it('leaves an unparseable file untouched', () => {
    const file = join(tempDir(), 'settings.json');
    writeFileSync(file, '{broken');
    expect(() => installHooks(file, PREFIX)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
});
