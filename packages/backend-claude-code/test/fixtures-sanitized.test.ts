// Committed fixtures are public. Thinking-block `signature` values are opaque base64 that decode
// to text containing the account's organization UUID, so every one must be redacted
// (scripts/probe-claude-code.ts REDACT_KEYS, differential stream saver).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures');
const REDACTED = 'redacted-signature';

const files = readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' }).filter((f) =>
  /\.(jsonl?|json)$/.test(f),
);

describe('committed fixtures', () => {
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s carries no unredacted signature', (file) => {
    const text = readFileSync(join(FIXTURES, file), 'utf8');
    const values = [...text.matchAll(/"signature"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(values.filter((v) => v !== REDACTED)).toEqual([]);
  });
});
