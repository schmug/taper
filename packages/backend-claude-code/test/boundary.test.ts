// Mechanical backstops for this package:
// - invariant 3: nothing in src can write a file (the settings loader is read-only);
// - the pure entry point stays Worker-safe and deterministic: only src/loader.ts touches node:
//   or the host, and nothing reads a clock or randomness;
// - invariant 8: nothing turns on prompt logging.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const code = (f: string) =>
  readFileSync(join(SRC, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const WRITE_APIS =
  /\b(?:writeFile|appendFile|mkdir|mkdtemp|rmdir|rm|unlink|rename|copyFile|cp|symlink|link|truncate|chmod|chown|utimes|createWriteStream|open)(?:Sync)?\s*\(/;

describe('packages/backend-claude-code/src', () => {
  it('has the expected modules', () => {
    expect(files).toContain('loader.ts');
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s calls no file-writing API', (f) => {
    expect(code(f)).not.toMatch(WRITE_APIS);
  });

  it.each(files.filter((f) => f !== 'loader.ts'))(
    '%s is pure (no node:, host, clock or randomness)',
    (f) => {
      const src = code(f);
      expect(src).not.toMatch(/from\s+['"]node:/);
      expect(src).not.toMatch(/\bprocess\b/);
      expect(src).not.toMatch(/\bDate\.now\b|\bnew Date\(\s*\)|\bMath\.random\b/);
    },
  );

  it.each(files)('%s never enables OTEL_LOG_USER_PROMPTS', (f) => {
    expect(readFileSync(join(SRC, f), 'utf8')).not.toContain('OTEL_LOG_USER_PROMPTS');
  });

  it('flags a write API when one appears', () => {
    expect("writeFileSync('x', 'y')").toMatch(WRITE_APIS);
    expect('await fs.rm(p)').toMatch(WRITE_APIS);
    expect('readFileSync(p)').not.toMatch(WRITE_APIS);
  });
});
