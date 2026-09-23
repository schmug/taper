// Mechanical backstop for CLAUDE.md invariant 1: core imports nothing outside packages/core/src
// and touches no clock, randomness, crypto, timer, network, or host global.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { purityViolations } from './purity.ts';

const SRC = join(import.meta.dirname, '..', 'src');

describe('purityViolations', () => {
  it.each([
    ["import { x } from 'vitest';", 'import:vitest'],
    ["import type { X } from '@taper/shared';", 'import:@taper/shared'],
    ["export * from '../../shared/src/index.ts';", 'import:../../shared/src/index.ts'],
    ["const m = await import('node:fs');", 'import:node:fs'],
    ['const r = Math.random();', 'Math.random'],
    ['const t = Date.now();', 'Date.now'],
    ['const d = new Date();', 'new Date()'],
    ['const u = crypto.randomUUID();', 'crypto'],
    ['const p = performance.now();', 'performance'],
    ['setTimeout(f, 1);', 'setTimeout'],
    ['fetch(url);', 'fetch'],
    ['process.env.X;', 'process'],
    ['globalThis.foo;', 'globalThis'],
    ["require('x');", 'require'],
    ['a.localeCompare(b);', 'localeCompare'],
  ])('flags %s', (source, violation) => {
    expect(purityViolations(source, 'src/x.ts')).toContain(violation);
  });

  it('allows relative imports that stay inside src and ignores comments', () => {
    const source = [
      "import type { Member } from './types.ts';",
      "export { evaluate } from './evaluate.ts';",
      '// Math.random() and Date.now() in a comment are fine',
      '/* new Date() */',
      'const d = new Date(0);',
      "type F = Transition['from'];",
      "const g = (from: Transition['from'], to: Member['state']) => from === 'x';",
    ].join('\n');
    expect(purityViolations(source, 'src/index.ts')).toEqual([]);
  });
});

describe('packages/core/src', () => {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.ts'),
  );

  it('has source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is pure', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8');
    expect(purityViolations(source, join('src', file))).toEqual([]);
  });
});
