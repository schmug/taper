// Differential job plumbing (HANDOFF §9 M2, ADR-0008): turn the `diff: true` cases of one fixture
// into one headless `claude -p` session, run it, and read back what Claude Code decided per call.
// Test-only code. The session spends model tokens; differential.test.ts gates it.

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { buildPolicy, canonicalTool, match } from '../src/index.ts';
import { type Fixture, fillDeep, type Paths, sourcesFor } from './fixture-harness.ts';

export type Observed = 'allow' | 'ask' | 'deny' | 'none' | 'hook' | 'not_attempted';

export interface DiffCall {
  readonly name: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly predicted: 'allow' | 'ask' | 'deny' | 'none';
}

export const diffEnabled = (env: Record<string, string | undefined>): boolean =>
  env.CLAUDE_CODE_DIFF_TESTS === '1';

export interface ScrubContext {
  readonly home: string;
  /** The job's workdir (TAPER_DIFF_WORKDIR); scratch repos live under it. */
  readonly workdir: string;
  readonly host: string;
}

// Same redactions as the M0 probe (scripts/probe-claude-code.ts), plus `signature`: thinking
// signatures are opaque base64 that embeds the account's organization UUID.
const REDACT_KEYS: Readonly<Record<string, string>> = {
  'user.email': 'user@example.com',
  'user.id': 'redacted-user-id',
  'user.account_uuid': '00000000-0000-0000-0000-000000000001',
  'user.account_id': 'redacted-account-id',
  'organization.id': '00000000-0000-0000-0000-000000000002',
  'host.name': 'probe-host',
  signature: 'redacted-signature',
};

// Transcript dirs embed the cwd as a slug (non-alphanumerics → '-').
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

/** Evidence copy of a report or stream: no home dir, workdir, host name, email or account ids. */
export function sanitizeEvidence(v: unknown, ctx: ScrubContext): unknown {
  if (typeof v === 'string')
    return v
      .replaceAll(slug(ctx.workdir), '-workdir')
      .replaceAll(slug(ctx.home), '-home-user')
      .replaceAll(`/private${ctx.workdir}`, '/workdir')
      .replaceAll(ctx.workdir, '/workdir')
      .replaceAll(ctx.home, '/home/user')
      .replaceAll(ctx.host, 'probe-host')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com');
  if (Array.isArray(v)) return v.map((x) => sanitizeEvidence(x, ctx));
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  // OTLP attribute: { key, value: { stringValue } }
  if (typeof o.key === 'string' && o.key in REDACT_KEYS && typeof o.value === 'object')
    return { key: o.key, value: { stringValue: REDACT_KEYS[o.key] } };
  return Object.fromEntries(
    Object.entries(o).map(([k, x]) => [
      k,
      k in REDACT_KEYS ? REDACT_KEYS[k] : sanitizeEvidence(x, ctx),
    ]),
  );
}

/** `<workdir>/<rel>`, refusing anything that would land outside the workdir. */
function evidencePath(workdir: string, rel: string): string {
  const base = resolve(workdir);
  const target = resolve(base, rel);
  if (!target.startsWith(base + sep)) throw new Error(`refusing to write ${target}`);
  return target;
}

/**
 * Writes one session's raw stream, sanitized, to `<workdir>/streams/<stem>.stream.jsonl`.
 * Refuses (returns null, writes nothing) unless the gate is on, so only the gated run saves.
 */
export function saveStream(
  env: Record<string, string | undefined>,
  workdir: string,
  stem: string,
  stream: readonly unknown[],
  ctx: ScrubContext,
): string | null {
  if (!diffEnabled(env)) return null;
  const file = evidencePath(workdir, join('streams', `${stem}.stream.jsonl`));
  mkdirSync(dirname(file), { recursive: true });
  const lines = stream.map((m) => JSON.stringify(sanitizeEvidence(m, ctx)));
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  return file;
}

/** Writes the sanitized report to `<workdir>/report.json`; gated like `saveStream`. */
export function saveReport(
  env: Record<string, string | undefined>,
  workdir: string,
  report: unknown,
  ctx: ScrubContext,
): string | null {
  if (!diffEnabled(env)) return null;
  const file = evidencePath(workdir, 'report.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sanitizeEvidence(report, ctx), null, 2)}\n`);
  return file;
}

/** The input field that identifies a call in the transcript (the model may add others). */
function keyOf(tool: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => JSON.stringify(keys.map((k) => input[k] ?? null));
  switch (canonicalTool(tool)) {
    case 'Bash':
    case 'Monitor':
      return pick('command', 'run_in_background');
    case 'Read':
    case 'Write':
    case 'Edit':
      return pick('file_path');
    case 'NotebookEdit':
      return pick('notebook_path');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'Agent':
      return pick('subagent_type', 'model');
    default:
      return JSON.stringify(input);
  }
}

/** Matcher predictions for a fixture's differential cases, at the given paths. */
export function planCalls(fx: Fixture, p: Paths): DiffCall[] {
  const policy = buildPolicy({
    sources: sourcesFor(fx, p),
    home: p.home,
    workspaceTrusted: fx.workspaceTrusted,
  });
  return fx.cases
    .filter((c) => c.diff)
    .map((c) => {
      const input = fillDeep(c.input, p) as Record<string, unknown>;
      const predicted = match(policy, { tool: c.tool, input, cwd: p.cwd }).outcome;
      return { name: c.name, tool: c.tool, input, predicted };
    });
}

export function buildPrompt(calls: readonly DiffCall[]): string {
  const lines = calls.map(
    (c, i) => `${i + 1}. tool: ${c.tool}\n   input: ${JSON.stringify(c.input)}`,
  );
  return [
    'You are a permission test harness. Make exactly the tool calls listed below, in order,',
    'one call per turn, waiting for each result before the next. Use exactly the given tool name',
    'and exactly the given JSON input: do not change, fix, re-quote or add to it. Some calls will',
    'be denied or fail; that is expected. Do not retry a call, and go on to the next one. Make no',
    'other tool calls. After the last call, reply with the single word DONE.',
    '',
    ...lines,
  ].join('\n');
}

type Msg = Record<string, unknown>;
interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** Per-call decision read from a `--output-format stream-json` transcript (facts doc A2). */
export function observe(stream: readonly Msg[], calls: readonly DiffCall[]): Observed[] {
  const uses: ToolUse[] = [];
  const denied = new Map<string, string>(); // tool_use_id → decision_reason_type
  const kind = new Map<string, string>(); // tool_use_id → non_execution_kind
  const resultText = new Map<string, string>();
  for (const m of stream) {
    if (m.type === 'system' && m.subtype === 'permission_denied')
      denied.set(String(m.tool_use_id), String(m.decision_reason_type));
    for (const meta of (m.tool_result_meta as Msg[] | undefined) ?? [])
      kind.set(String(meta.id), String(meta.non_execution_kind));
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Msg[]) {
      if (b.type === 'tool_use')
        uses.push({
          id: String(b.id),
          name: String(b.name),
          input: (b.input as Record<string, unknown>) ?? {},
        });
      if (b.type === 'tool_result')
        resultText.set(String(b.tool_use_id), JSON.stringify(b.content ?? ''));
    }
  }
  const taken = new Set<string>();
  return calls.map((c) => {
    const key = keyOf(c.tool, c.input);
    const use = uses.find(
      (u) =>
        !taken.has(u.id) &&
        canonicalTool(u.name) === canonicalTool(c.tool) &&
        keyOf(u.name, u.input) === key,
    );
    if (!use) return 'not_attempted';
    taken.add(use.id);
    if (kind.get(use.id) === 'permission-rule')
      return /hook error/.test(resultText.get(use.id) ?? '') ? 'hook' : 'deny';
    const reason = denied.get(use.id);
    if (reason === undefined) return 'allow';
    return reason === 'rule' ? 'ask' : reason === 'hook' ? 'hook' : 'none';
  });
}

export interface SessionPaths extends Paths {
  readonly cliFile: string;
}

/** Scratch repo for one fixture under `base`; recreated on every run. Writes nothing elsewhere. */
export function prepareSession(fx: Fixture, base: string, stem: string): SessionPaths {
  mkdirSync(base, { recursive: true });
  const realBase = realpathSync(base);
  const root = join(realBase, stem);
  if (!root.startsWith(realBase + sep)) throw new Error(`refusing to touch ${root}`);
  rmSync(root, { recursive: true, force: true });
  const cwd = join(root, 'repo');
  const p: SessionPaths = {
    cwd,
    root,
    home: homedir(),
    cliFile: join(root, 'cli', 'settings.json'),
  };
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'probe.sh'), '#!/bin/sh\necho "taper-diff ran: $*"\n');
  chmodSync(join(cwd, 'probe.sh'), 0o755);
  const settings = (scope: 'local' | 'project' | 'cli', file: string) => {
    const s = sourcesFor(fx, p).find((x) => x.scope === scope);
    if (!s) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ permissions: s.arrays }, null, 2));
  };
  settings('local', join(cwd, '.claude', 'settings.local.json'));
  settings('project', join(cwd, '.claude', 'settings.json'));
  settings('cli', p.cliFile);
  // Files the calls read exist; parents of files the calls write exist. Only under `root`.
  for (const c of planCalls(fx, p)) {
    const target = c.input.file_path;
    if (typeof target !== 'string' || !target.startsWith(root + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    if (canonicalTool(c.tool) === 'Read') writeFileSync(target, 'x\n');
  }
  return p;
}

export interface SessionRun {
  readonly stream: Msg[];
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

/** One headless session, isolated like the M0 probe (scripts/probe-claude-code.ts). */
export function runSession(
  calls: readonly DiffCall[],
  p: SessionPaths,
  opts: { readonly model: string; readonly timeoutMs: number; readonly withCli: boolean },
): Promise<SessionRun> {
  const tools = [...new Set(calls.map((c) => canonicalTool(c.tool)))].join(',');
  const args = [
    '-p',
    buildPrompt(calls),
    '--model',
    opts.model,
    '--max-turns',
    String(calls.length + 3),
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools',
    tools,
    '--permission-mode',
    'manual',
    ...(opts.withCli ? ['--settings', p.cliFile] : []),
  ];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(CLAUDE|OTEL_)/.test(k) && k !== 'ANTHROPIC_BASE_URL') env[k] = v;
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: p.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const stream = stdout
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Msg);
      resolve({ stream, stderr, code, timedOut });
    });
  });
}
