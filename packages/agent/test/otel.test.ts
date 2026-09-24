// Replaying recorded OTLP streams through the same attribution and usage path as the hooks
// (HANDOFF §5.3: both paths converge). Session → directory mapping is the caller's.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memberIdFor } from '@taper/core';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.ts';
import { run } from '../src/cli.ts';
import { ingestOtlp, rebaseOtlp } from '../src/otel.ts';
import { DAY, sandbox, T0, writeJson } from './helpers.ts';

const OTEL = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'otel');
const bodies = (name: string): unknown[] =>
  readFileSync(join(OTEL, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { body: unknown }).body);

const PROJECT = 'project:github.com%2Fexample%2Fdemo:allow';

function setup() {
  const s = sandbox();
  writeJson(join(s.repo, '.claude', 'settings.json'), {
    permissions: { allow: ['Bash(./probe.sh a)'] },
  });
  run(['init', '--yes'], s.deps());
  return s;
}

describe('ingestOtlp', () => {
  it('attributes an accepted decision and its result to the matching member, once', () => {
    const s = setup();
    const a = Agent.open(s.deps());
    const report = bodies('a0-allow-control').map((b) => ingestOtlp(a, b, () => s.repo));
    expect(report.reduce((n, r) => n + r.tools, 0)).toBe(2);
    const m = a.store.members({ ids: [memberIdFor(PROJECT, 'Bash(./probe.sh a)')] })[0];
    expect(m?.lastSeenAt).toBe(1790113393892);
    expect(a.store.eventCounts(memberIdFor(PROJECT, 'Bash(./probe.sh a)'))).toEqual({
      matched: 2,
      decisive: 2,
    });
    // Replaying the same stream again changes nothing (event ids are tool_use ids).
    for (const b of bodies('a0-allow-control')) ingestOtlp(a, b, () => s.repo);
    expect(a.store.eventCounts(memberIdFor(PROJECT, 'Bash(./probe.sh a)')).matched).toBe(2);
    a.close();
  });

  it('skips sessions it cannot place in a directory', () => {
    const s = setup();
    const a = Agent.open(s.deps());
    const r = bodies('a0-allow-control').map((b) => ingestOtlp(a, b, () => null));
    expect(r.every((x) => x.tools === 0 && x.skipped >= 0)).toBe(true);
    a.close();
  });

  it('re-snapshots on user_permanent only when the local file changed (ADR-0002 row 2)', () => {
    const s = setup();
    writeJson(join(s.repo, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(./probe.sh c *)'] },
    });
    const a = Agent.open(s.deps());
    const local = `local:${a.deviceId}:github.com%2Fexample%2Fdemo:allow`;
    for (const b of bodies('c0-dont-ask-again')) ingestOtlp(a, b, () => s.repo);
    expect(a.store.members({ ids: [memberIdFor(local, 'Bash(./probe.sh c *)')] })[0]).toMatchObject(
      { state: 'active', lastSeenAt: 1790113577227 },
    );
    expect(
      a.resnapshotIfLocalChanged({ root: s.repo, repoId: 'github.com/example/demo' }, T0),
    ).toBe(false);
    a.close();
  });

  it('rebases a stream in time and makes its ids unique', () => {
    const [body] = bodies('a0-allow-control');
    const moved = rebaseOtlp(body, { offsetMs: DAY, suffix: '-d1' }) as {
      resourceLogs: {
        scopeLogs: {
          logRecords: {
            timeUnixNano: string;
            attributes: { key: string; value: { stringValue?: string } }[];
          }[];
        }[];
      }[];
    };
    const rec = moved.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    expect(rec?.timeUnixNano).toBe(String((1790113383129n + BigInt(DAY)) * 1_000_000n));
    const session = rec?.attributes.find((x) => x.key === 'session.id')?.value.stringValue;
    expect(session).toBe('6d0d1764-20b3-425e-826e-b46d9af7ddd5-d1');
  });
});
