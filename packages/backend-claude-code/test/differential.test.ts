// Differential job (HANDOFF §9 M2, ADR-0008): every `diff: true` fixture case, run through a real
// `claude -p` session, must be decided the way the matcher predicts.
//
// SPENDS MODEL TOKENS (metered). Off unless CLAUDE_CODE_DIFF_TESTS=1:
//   CLAUDE_CODE_DIFF_TESTS=1 pnpm --filter @taper/backend-claude-code exec vitest run test/differential.test.ts
// Optional: TAPER_DIFF_MODEL (default haiku), TAPER_DIFF_WORKDIR (default ~/.cache/taper-diff),
// TAPER_DIFF_ONLY=<fixture-stem,...>. The sanitized report (`report.json`) and each session's
// sanitized stream (`streams/<stem>.stream.jsonl`) land in the workdir; copy them to
// fixtures/differential/<date>/ to keep them (a rerun overwrites the workdir).
//
// The observation parser below is always tested against the recorded M0 streams, so the part
// that reads Claude Code's decisions is verified without spending tokens.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
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
  sanitizeEvidence,
  saveReport,
  saveStream,
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

describe('evidence (no model call)', () => {
  const ctx = { home: '/Users/someone', workdir: '/Users/someone/.cache/taper-diff', host: 'box7' };
  const on = { CLAUDE_CODE_DIFF_TESTS: '1' };
  const stream = [
    {
      type: 'system',
      subtype: 'init',
      cwd: '/Users/someone/.cache/taper-diff/12-x/repo',
      memory_paths: {
        auto: '/Users/someone/.claude/projects/-Users-someone--cache-taper-diff-12-x-repo/memory/',
      },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '', signature: 'RXhhbXBsZQ==' }] },
    },
    { type: 'result', result: 'mail someone@corp.example from box7' },
  ];

  it('scrubs home, workdir, slugs, host, email and thinking signatures', () => {
    const out = JSON.stringify(sanitizeEvidence(stream, ctx));
    expect(out).not.toMatch(/someone|box7|RXhhbXBsZQ/);
    expect(out).toContain('"cwd":"/workdir/12-x/repo"');
    expect(out).toContain('/home/user/.claude/projects/-workdir-12-x-repo/memory/');
    expect(out).toContain('"signature":"redacted-signature"');
    expect(out).toContain('mail user@example.com from probe-host');
  });

  it('writes streams and the report only when the gate is on', () => {
    const base = mkdtempSync(join(tmpdir(), 'taper-evidence-'));
    expect(saveStream({}, base, '12-x', stream, ctx)).toBeNull();
    expect(saveReport({ CLAUDE_CODE_DIFF_TESTS: 'true' }, base, { a: 1 }, ctx)).toBeNull();
    expect(readdirSync(base)).toEqual([]);

    const streamFile = saveStream(on, base, '12-x', stream, ctx);
    const reportFile = saveReport(on, base, { '12-x': { stderr: `${ctx.home}/x` } }, ctx);
    expect(streamFile).toBe(join(base, 'streams', '12-x.stream.jsonl'));
    expect(reportFile).toBe(join(base, 'report.json'));
    const lines = readFileSync(join(base, 'streams', '12-x.stream.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(base, 'report.json'), 'utf8'))).toEqual({
      '12-x': { stderr: '/home/user/x' },
    });
    expect(() => saveStream(on, base, '../../escape', stream, ctx)).toThrow(/refusing/);
    expect(existsSync(join(base, '..', 'escape.stream.jsonl'))).toBe(false);
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
      const scrub = { home: homedir(), workdir: WORKDIR, host: hostname() };
      saveStream(process.env, WORKDIR, stem, run.stream, scrub);
      saveReport(process.env, WORKDIR, report, scrub);
      expect(rows.filter((r) => r.predicted !== r.observed)).toEqual([]);
    },
    SESSION_TIMEOUT_MS + 30_000,
  );
});
