// Differential job (HANDOFF §9 M2, ADR-0008): every `diff: true` fixture case, run through a real
// `claude -p` session, must be decided the way the matcher predicts.
//
// SPENDS MODEL TOKENS (metered). Off unless CLAUDE_CODE_DIFF_TESTS=1:
//   CLAUDE_CODE_DIFF_TESTS=1 pnpm --filter @taper/backend-claude-code exec vitest run test/differential.test.ts
// Optional: TAPER_DIFF_MODEL (default haiku), TAPER_DIFF_WORKDIR (default ~/.cache/taper-diff),
// TAPER_DIFF_ONLY=<fixture-stem,...>. A JSON report lands in the workdir.
//
// The observation parser below is always tested against the recorded M0 streams, so the part
// that reads Claude Code's decisions is verified without spending tokens.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  type DiffCall,
  diffEnabled,
  type Observed,
  observe,
  planCalls,
  prepareSession,
  runSession,
} from './differential-runner.ts';
import { loadFixtures, UNIT_PATHS } from './fixture-harness.ts';

const ENABLED = diffEnabled(process.env);
const MODEL = process.env.TAPER_DIFF_MODEL ?? 'haiku';
const WORKDIR = process.env.TAPER_DIFF_WORKDIR ?? join(homedir(), '.cache', 'taper-diff');
const ONLY = (process.env.TAPER_DIFF_ONLY ?? '').split(',').filter(Boolean);
const SESSION_TIMEOUT_MS = 240_000;

const fixtures = loadFixtures()
  .map(({ file, fixture }) => ({ stem: file.replace(/\.json$/, ''), fixture }))
  .filter(
    ({ stem, fixture }) =>
      fixture.cases.some((c) => c.diff) && (!ONLY.length || ONLY.includes(stem)),
  );

describe('differential gate', () => {
  it('is off unless CLAUDE_CODE_DIFF_TESTS=1', () => {
    expect(diffEnabled({})).toBe(false);
    expect(diffEnabled({ CLAUDE_CODE_DIFF_TESTS: 'true' })).toBe(false);
    expect(diffEnabled({ CLAUDE_CODE_DIFF_TESTS: '1' })).toBe(true);
  });

  it('plans one session per fixture with differential cases', () => {
    const calls = fixtures.flatMap(({ fixture }) => planCalls(fixture, UNIT_PATHS));
    expect(fixtures.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(fixtures.length);
    expect(buildPrompt(calls.slice(0, 1))).toContain('1. tool: ');
  });
});

describe('observe (against the recorded M0 streams)', () => {
  const HEADLESS = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'headless');
  const stream = (name: string) =>
    readFileSync(join(HEADLESS, `${name}.stream.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const call = (command: string): DiffCall => ({
    name: command,
    tool: 'Bash',
    input: { command },
    predicted: 'allow',
  });

  it.each<[string, string, Observed]>([
    ['a0-allow-control', './probe.sh a', 'allow'],
    ['a1-local-ask-over-project-allow', './probe.sh a', 'ask'],
    ['a2-cli-ask-over-project-allow', './probe.sh a', 'ask'],
    ['a3-cli-deny-over-project-allow', './probe.sh a', 'deny'],
    ['e0-headless-unmatched', './probe.sh e', 'none'],
    ['u0-untrusted-project-allow', './probe.sh u', 'none'],
    ['u1-untrusted-local-allow', './probe.sh u', 'allow'],
    ['b1-hook-deny', './probe.sh hook-deny', 'hook'],
    ['b2-hook-ask', './probe.sh hook-ask', 'hook'],
    ['a0-allow-control', './probe.sh other', 'not_attempted'],
  ])('%s: %s → %s', (name, command, expected) => {
    expect(observe(stream(name), [call(command)])).toEqual([expected]);
  });

  it('reads an in-workdir Read as allowed', () => {
    const [use] = stream('r0-read-in-workdir').flatMap((m) => {
      const content = (m.message as { content?: Record<string, unknown>[] } | undefined)?.content;
      return (content ?? []).filter((b) => b.type === 'tool_use');
    });
    const input = use?.input as Record<string, unknown>;
    const read: DiffCall = { name: 'r', tool: 'Read', input, predicted: 'allow' };
    expect(observe(stream('r0-read-in-workdir'), [read])).toEqual(['allow']);
  });
});

describe('prepareSession (no model call)', () => {
  it('writes the fixture settings and call targets only under the scratch dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'taper-diff-'));
    const entry = fixtures.find((f) => f.stem === '14-path-anchor-cli-local');
    if (!entry) throw new Error('fixture 14 missing');
    const p = prepareSession(entry.fixture, base, entry.stem);
    const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as unknown;
    expect(json(join(p.cwd, '.claude', 'settings.local.json'))).toEqual({
      permissions: { allow: ['Edit(/out/**)'], ask: [], deny: [] },
    });
    expect(json(p.cliFile)).toEqual({
      permissions: { allow: ['Read(/shared/**)'], ask: [], deny: [] },
    });
    expect(readFileSync(join(p.root, 'cli', 'shared', 'x.txt'), 'utf8')).toBe('x\n');
    expect(readdirSync(realpathSync(base))).toEqual([entry.stem]);
    expect(() => prepareSession(entry.fixture, base, '../escape')).toThrow(/refusing/);
  });
});

describe.skipIf(!ENABLED)('differential: matcher vs claude', () => {
  it('has a claude binary', () => {
    expect(execFileSync('claude', ['--version'], { encoding: 'utf8' })).toMatch(/\d+\.\d+\.\d+/);
  });

  const report: Record<string, unknown> = {};
  it.each(fixtures)(
    '$stem',
    async ({ stem, fixture }) => {
      const p = prepareSession(fixture, WORKDIR, stem);
      const calls = planCalls(fixture, p);
      const run = await runSession(calls, p, {
        model: MODEL,
        timeoutMs: SESSION_TIMEOUT_MS,
        withCli: fixture.settings.cli !== undefined,
      });
      const observed = observe(run.stream, calls);
      const rows = calls.map((c, i) => ({
        name: c.name,
        predicted: c.predicted,
        observed: observed[i],
      }));
      const result = run.stream.find((m) => m.type === 'result');
      report[stem] = {
        rows,
        usage: result?.usage,
        cost: result?.total_cost_usd,
        timedOut: run.timedOut,
        stderr: run.stderr.slice(0, 2000),
      };
      mkdirSync(WORKDIR, { recursive: true });
      writeFileSync(join(WORKDIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      expect(rows.filter((r) => r.predicted !== r.observed)).toEqual([]);
    },
    SESSION_TIMEOUT_MS + 30_000,
  );
});
