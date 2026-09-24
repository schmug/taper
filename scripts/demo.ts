// End-to-end demo with a compressed clock (HANDOFF §9 M3). `node scripts/demo.ts --solo`.
//
// A temp $HOME and git repo are enrolled with `taper init`; the recorded hook payloads
// (fixtures/hooks) and OTLP streams (fixtures/otel) are replayed over 47 simulated days through
// the real CLI, in process. The "don't ask again" rule written on day 0 is never used again, so
// it walks active → stale_candidate → pending_removal in its automatic local knob. On day 47 the
// PreToolUse hook asks; the simulated approval (PostToolUse) restores it with a cooldown.
// Everything is deterministic: fixed clock, fixed ids, no network, no model.
// `runSoloDemo` is asserted by packages/agent/test/demo.test.ts. `--org` arrives at M6.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../packages/agent/src/agent.ts';
import { run } from '../packages/agent/src/cli.ts';
import type { Deps } from '../packages/agent/src/deps.ts';
import { ingestOtlp, rebaseOtlp } from '../packages/agent/src/otel.ts';
import { DAY_MS, type Explanation, explain, memberIdFor } from '../packages/core/src/index.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIX = join(REPO_ROOT, 'fixtures');
/** Day 0 of the demo: 2026-10-01T00:00Z. */
export const DEMO_T0 = Date.UTC(2026, 9, 1);
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The rule Claude Code writes on day 0 ("Yes, and don't ask again", facts doc A1 c0). */
export const DEMO_RULE = 'Bash(./probe.sh c *)';

export interface WalkStep {
  readonly day: number;
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
  readonly actor: string;
  readonly tickId: string;
}

export interface SoloDemoResult {
  /** Everything the CLI printed, with the temp directory replaced by `<root>`. */
  readonly transcript: readonly string[];
  /** The demo rule's ledger, in order. */
  readonly walk: readonly WalkStep[];
  /** State of the demo rule just before the day-47 PreToolUse. */
  readonly before: { readonly state: string; readonly mode: string };
  /** The day-47 PreToolUse stdout, parsed. */
  readonly decision: unknown;
  /** The demo rule after the simulated approval. */
  readonly after: {
    readonly state: string;
    readonly lastSeenDay: number | null;
    readonly cooldownUntilDay: number | null;
    readonly restoredCount: number;
  };
  /** ADR-0005 deferral: the same member under `active_days` at the day-46 tick. */
  readonly activeDays: { readonly wallStaleDays: number; readonly sessionStaleDays: number };
}

const dayOf = (t: number | null) =>
  t === null ? null : Math.round(((t - DEMO_T0) / DAY_MS) * 1000) / 1000;

export function runSoloDemo(root: string, log: (line: string) => void = () => {}): SoloDemoResult {
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const managed = join(root, 'managed');
  const transcript: string[] = [];
  const say = (line: string) => {
    const clean = line.split(root).join('<root>');
    transcript.push(clean);
    log(clean);
  };
  let now = DEMO_T0;
  let ids = 0;
  const deps = (stdin = ''): Deps => ({
    env: { HOME: home },
    cwd: repo,
    now: () => now,
    randomHex: (bytes) => (++ids).toString(16).padStart(bytes * 2, '0'),
    stdin: () => stdin,
    out: say,
    write: say,
    err: (l) => say(`! ${l}`),
    isTTY: false,
    confirm: () => false,
    managedDir: managed,
    entry: [process.execPath, join(REPO_ROOT, 'packages', 'agent', 'src', 'bin.ts')],
  });
  const taper = (...argv: string[]) => {
    say(`$ taper ${argv.join(' ')}`);
    const code = run(argv, deps());
    if (code !== 0) throw new Error(`taper ${argv[0]} exited ${code}`);
  };
  const json = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };

  // ---- a developer's machine: user rules, a repo with project rules, trusted ----
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(managed, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/taper-demo.git'], {
    cwd: repo,
  });
  json(join(home, '.claude', 'settings.json'), {
    permissions: { allow: ['Bash(./probe.sh u *)'] },
  });
  json(join(repo, '.claude', 'settings.json'), {
    permissions: {
      allow: ['Bash(./probe.sh a)', 'Bash(./probe.sh b-pass)', 'Read(./docs/**)'],
      deny: ['Bash(./probe.sh hook-deny)'],
    },
  });
  json(join(home, '.claude.json'), { projects: { [repo]: { hasTrustDialogAccepted: true } } });

  // ---- replay helpers ----
  const hookPayloads = (scenario: string) =>
    readdirSync(join(FIX, 'hooks', scenario))
      .filter((f) => f.endsWith('.json') && !f.endsWith('.out.json'))
      .sort()
      .map((f) => ({
        event: f.replace(/^\d+-/, '').replace(/\.json$/, ''),
        body: JSON.parse(readFileSync(join(FIX, 'hooks', scenario, f), 'utf8')) as Record<
          string,
          unknown
        >,
      }));
  /** Replays one recorded session's hooks, one minute apart, under fresh ids. */
  const hooks = (
    scenario: string,
    start: number,
    suffix: string,
    only?: string[],
    between?: (event: string) => void,
  ) => {
    let i = 0;
    for (const { event, body } of hookPayloads(scenario)) {
      if (only !== undefined && !only.includes(event)) continue;
      now = start + i++ * MINUTE;
      between?.(event);
      const input = {
        ...body,
        cwd: repo,
        session_id: `${String(body.session_id)}${suffix}`,
        ...(typeof body.tool_use_id === 'string'
          ? { tool_use_id: `${body.tool_use_id}${suffix}` }
          : {}),
      };
      const d = deps(JSON.stringify(input));
      run(['hook', event], d);
    }
  };
  const otelBodies = (name: string) =>
    readFileSync(join(FIX, 'otel', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { body: unknown }).body);
  const firstMs = (bodies: unknown[]) => {
    const times = [...JSON.stringify(bodies).matchAll(/"timeUnixNano":"(\d+)"/g)].map((m) =>
      Number(BigInt(m[1] as string) / 1_000_000n),
    );
    return Math.min(...times);
  };
  /** Replays one recorded OTLP stream so it starts at `start`, then runs the evaluate tick. */
  const otel = (name: string, start: number, suffix: string) => {
    const bodies = otelBodies(name);
    const offset = start - firstMs(bodies);
    const a = Agent.open(deps());
    let tools = 0;
    for (const b of bodies)
      tools += ingestOtlp(a, rebaseOtlp(b, { offsetMs: offset, suffix }), () => repo).tools;
    now = start + 5 * MINUTE;
    a.tick(now);
    a.close();
    return tools;
  };

  // ---- day 0: enroll, then "Yes, and don't ask again" writes a local rule ----
  taper('init', '--yes');
  say('# day 0: Claude Code asks to run ./probe.sh c; the user picks "Yes, and don\'t ask again".');
  hooks('c0-dont-ask-again', DEMO_T0 + 9 * HOUR, '-d0', undefined, (event) => {
    // The demo plays Claude Code here: Claude Code itself writes this rule when the user picks
    // option 2, before the tool runs (facts doc A1 c0). taper never writes a permissions array.
    if (event === 'PostToolUse')
      json(join(repo, '.claude', 'settings.local.json'), { permissions: { allow: [DEMO_RULE] } });
  });
  const c0Tools = otel('c0-dont-ask-again.jsonl', DEMO_T0 + 9 * HOUR, '-d0');
  say(
    `# day 0: the same session's OTLP stream: ${c0Tools} tool events. Its tool_result has the ` +
      "hook's PostToolUse event id (the tool_use_id), so that use counts once.",
  );
  now = DEMO_T0 + 10 * HOUR;
  taper('mode', 'local', 'automatic', '--yes');

  // ---- days 1–12: the other recorded OTLP streams, one per day ----
  const streams = readdirSync(join(FIX, 'otel'))
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('c0-'))
    .sort();
  streams.forEach((f, i) => {
    const n = otel(f, DEMO_T0 + (i + 1) * DAY_MS + 10 * HOUR, `-d${i + 1}`);
    say(`# day ${i + 1}: replayed ${f} (${n} tool events)`);
  });

  // ---- days 2–46, every other day: a session that uses ./probe.sh b-pass only ----
  for (let day = 2; day <= 46; day += 2)
    hooks('b0-hook-passthrough', DEMO_T0 + day * DAY_MS + 12 * HOUR, `-d${day}`);
  say('# days 2-46: a session every other day (fixtures/hooks/b0), never touching ./probe.sh c.');

  // ---- day 46: where things stand ----
  now = DEMO_T0 + 46 * DAY_MS + 13 * HOUR;
  taper('status');
  const a = Agent.open(deps());
  const localKnob = `local:${encodeURIComponent(a.deviceId)}:${encodeURIComponent('github.com/example/taper-demo')}:allow`;
  const id = memberIdFor(localKnob, DEMO_RULE);
  const knobs = a.store.knobs();
  const knob = knobs.find((k) => k.id === localKnob);
  const member = a.store.members({ ids: [id] })[0];
  if (knob === undefined || member === undefined) throw new Error('demo member missing');
  const input = {
    knobs,
    members: a.store.members(),
    now,
    config: a.core,
    memberId: id,
    ledger: a.store.ledger([id]),
  };
  const wall = explain({ ...input, coverage: a.coverage(knobs) }) as Explanation;
  const asActiveDays = knobs.map((k) =>
    k.id === localKnob ? { ...k, clock: 'active_days' as const } : k,
  );
  const sessionDays = explain({
    ...input,
    knobs: asActiveDays,
    coverage: a.coverage(asActiveDays),
  }) as Explanation;
  const before = { state: member.state, mode: knob.mode };
  a.close();

  // ---- day 47: Claude Code wants ./probe.sh c again ----
  say("# day 47: Claude Code runs ./probe.sh c again. taper's PreToolUse hook answers:");
  const pre: string[] = [];
  now = DEMO_T0 + 47 * DAY_MS + 12 * HOUR;
  const [preBody] = hookPayloads('c0-dont-ask-again').filter((p) => p.event === 'PreToolUse');
  run(['hook', 'PreToolUse'], {
    ...deps(
      JSON.stringify({
        ...preBody?.body,
        cwd: repo,
        session_id: 'demo-d47',
        tool_use_id: 'toolu_demo_d47',
      }),
    ),
    write: (t) => {
      pre.push(t);
      say(t);
    },
  });
  say('# the user approves the prompt; the tool runs, so PostToolUse reports the use:');
  now += MINUTE;
  const [postBody] = hookPayloads('c0-dont-ask-again').filter((p) => p.event === 'PostToolUse');
  run(
    ['hook', 'PostToolUse'],
    deps(
      JSON.stringify({
        ...postBody?.body,
        cwd: repo,
        session_id: 'demo-d47',
        tool_use_id: 'toolu_demo_d47',
      }),
    ),
  );
  taper('explain', DEMO_RULE);

  const b = Agent.open(deps());
  const restored = b.store.members({ ids: [id] })[0];
  const walk = b.store.ledger([id]).map((t) => ({
    day: Math.floor((t.at - DEMO_T0) / DAY_MS),
    from: t.from,
    to: t.to,
    reason: t.reason,
    actor: t.actor,
    tickId: t.tickId,
  }));
  b.close();
  if (restored === undefined) throw new Error('demo member vanished');
  return {
    transcript,
    walk,
    before,
    decision: pre.length === 1 ? JSON.parse(pre[0] as string) : null,
    after: {
      state: restored.state,
      lastSeenDay: dayOf(restored.lastSeenAt),
      cooldownUntilDay: dayOf(restored.cooldownUntil),
      restoredCount: restored.restoredCount,
    },
    activeDays: {
      wallStaleDays: Math.round(wall.clock.staleDays * 10) / 10,
      sessionStaleDays: sessionDays.clock.staleDays,
    },
  };
}

const main =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  if (!process.argv.includes('--solo')) {
    process.stderr.write('usage: node scripts/demo.ts --solo   (--org arrives at M6)\n');
    process.exit(2);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'taper-demo-')));
  try {
    const r = runSoloDemo(root, (l) => process.stdout.write(`${l}\n`));
    process.stdout.write(
      `\n# walk of ${JSON.stringify(DEMO_RULE)}:\n${r.walk.map((w) => `#   day ${w.day}: ${w.from ?? '(new)'} → ${w.to} (${w.reason}, ${w.actor})`).join('\n')}\n` +
        `# after approval: ${r.after.state}, cooldown until day ${r.after.cooldownUntilDay}\n` +
        `# active_days evidence at day 46: wall ${r.activeDays.wallStaleDays} stale days vs ${r.activeDays.sessionStaleDays} session days\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
