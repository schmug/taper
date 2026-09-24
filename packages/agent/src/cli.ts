// The `taper` CLI (HANDOFF §6), solo mode: works offline with no Cloudflare account. `run` takes
// every host dependency as `deps`, so tests and the demo drive it in process. Not here yet:
// `enroll`, `sync`, `agent run`, `otel serve` (M6+) and `recommend --format pr` (M7).

import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  isProtectedByDefault,
  knobIdFor,
  normalizeRule,
  parseRule,
} from '@taper/backend-claude-code';
import {
  DAY_MS,
  type Explanation,
  enforcement,
  explain,
  type Member,
  resolveThresholds,
  type Signal,
  simulate,
} from '@taper/core';
import { Agent, NotInitialized } from './agent.ts';
import { readConfig, writeConfig } from './config.ts';
import type { Deps } from './deps.ts';
import { readText } from './fsutil.ts';
import { handleHook } from './hook.ts';
import {
  commandPrefix,
  HOOK_EVENTS,
  installHooks,
  removeHooks,
  withHooks,
} from './hooks-config.ts';
import {
  type AdviceItem,
  fmtDate,
  fmtTime,
  knobLabel,
  type NarrativeProvider,
  templateNarrative,
} from './narrative.ts';
import { resolvePaths } from './paths.ts';
import { unifiedDiff, withoutAllowRules } from './recommend.ts';
import type { StoredKnob } from './store.ts';

class UsageError extends Error {}

const USAGE = `usage: taper <command>

  init [--yes] [--no-hooks]        detect settings, create the ledger, install hooks (asks first)
  status [--json]                  knobs, members, states, next transition
  explain "<rule>"                 why a rule is in its state (ledger + guards)
  regrant "<rule>"                 restore a decayed rule now, with a cooldown (SelfApprove)
  protect <rule|knob>              never decay it (re-grants it first if it already decayed)
  unprotect <rule|knob>            allow decay again (allow rules only)
  mode <knob> shadow|automatic [--yes] [--ci-opt-in]
  recommend [--format text|diff]   advisory cleanup of your settings files (never applied)
  simulate --days N                dry-run the clock forward N days
  snapshot                         re-read the settings files now
  hook <Event>                     Claude Code hook entry point (stdin JSON)
  uninstall [--purge]              remove taper's hooks; --purge also deletes ~/.taper

knob: a knob id from \`taper status\`, or user | project | local | managed (the allow knob
for this device and the current directory's project).`;

const narrative: NarrativeProvider = templateNarrative;

export function run(argv: readonly string[], deps: Deps): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'hook') return cmdHook(rest, deps);
  try {
    switch (cmd) {
      case 'init':
        return cmdInit(rest, deps);
      case 'status':
        return withAgent(deps, (a) => cmdStatus(a, rest));
      case 'explain':
        return withAgent(deps, (a) => cmdExplain(a, rest));
      case 'regrant':
        return withAgent(deps, (a) => cmdRegrant(a, rest));
      case 'protect':
      case 'unprotect':
        return withAgent(deps, (a) => cmdProtect(a, rest, cmd === 'protect'));
      case 'mode':
        return withAgent(deps, (a) => cmdMode(a, rest));
      case 'recommend':
        return withAgent(deps, (a) => cmdRecommend(a, rest));
      case 'simulate':
        return withAgent(deps, (a) => cmdSimulate(a, rest));
      case 'snapshot':
        return withAgent(deps, (a) => cmdSnapshot(a));
      case 'uninstall':
        return cmdUninstall(rest, deps);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        deps.out(USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command: ${cmd}\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof NotInitialized || e instanceof UsageError) {
      deps.err(e.message);
      return e instanceof UsageError ? 2 : 1;
    }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      deps.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

function withAgent(deps: Deps, fn: (a: Agent) => number): number {
  const agent = Agent.open(deps);
  try {
    return fn(agent);
  } finally {
    agent.close();
  }
}

const args = <T extends Record<string, { type: 'boolean' | 'string' }>>(
  argv: readonly string[],
  options: T,
) => parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });

// ---------- hook ----------

/** Never blocks Claude Code on taper's own failure: errors are logged and the call passes. */
function cmdHook(rest: readonly string[], deps: Deps): number {
  const event = rest[0] ?? '';
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) return 0;
  let agent: Agent | null = null;
  try {
    if (!existsSync(resolvePaths(deps.env).config)) return 0;
    agent = Agent.open(deps);
    const out = handleHook(agent, event, deps.stdin(), deps.now());
    if (out !== null) deps.write(out);
  } catch (e) {
    logHookError(deps, event, e);
  } finally {
    agent?.close();
  }
  return 0;
}

/** Error class and code only: messages can quote the payload, which may hold arguments. */
function logHookError(deps: Deps, event: string, e: unknown): void {
  try {
    const err = e as { name?: string; code?: string };
    const kind = `${err.name ?? 'Error'}${err.code === undefined ? '' : ` ${err.code}`}`;
    appendFileSync(
      resolvePaths(deps.env).errorLog,
      `${fmtTime(deps.now())} hook ${event} failed: ${kind}\n`,
      { mode: 0o600 },
    );
  } catch {
    // nowhere left to report; the hook still passes through
  }
}

// ---------- init / uninstall ----------

function cmdInit(rest: readonly string[], deps: Deps): number {
  const { values } = args(rest, { yes: { type: 'boolean' }, 'no-hooks': { type: 'boolean' } });
  const now = deps.now();
  const { agent, created } = Agent.init(deps);
  try {
    const project = agent.projectAt(deps.cwd);
    const report = agent.snapshot(project, now);
    deps.out(
      `${created ? 'Created' : 'Reusing'} ${agent.paths.taperDir} (device ${agent.deviceId}).`,
    );
    deps.out(
      project === null ? 'No project here.' : `Project: ${project.repoId} (${project.root})`,
    );
    deps.out('Settings files:');
    for (const s of report.snapshots)
      deps.out(
        `  ${s.scope.padEnd(8)} ${s.path}  allow ${s.arrays.allow.length}, ask ${s.arrays.ask.length}, deny ${s.arrays.deny.length}`,
      );
    for (const e of report.errors)
      deps.out(`  ${e.scope.padEnd(8)} ${e.path}  NOT READ: ${e.message}`);
    for (const w of report.claudeWorkflows)
      deps.out(`  CI workflow running Claude Code: ${w} (its cli knobs stay shadow-only, C3)`);

    const t = agent.core.thresholds;
    const at = (d: number) => fmtDate(now + d * DAY_MS);
    deps.out(
      [
        '',
        'What happens next:',
        '  Every knob starts in shadow mode: taper records what would change and enforces nothing.',
        `  Hooks report usage; any use of a rule refreshes it. The ledger needs ${t.maturityDays} days of coverage first.`,
        `  An allow rule unused since today becomes stale_candidate on ${at(Math.max(t.t1Days, t.maturityDays))},`,
        `  pending_removal on ${at(t.t2Days)} and removed on ${at(t.t3Days)} (in shadow: recommendations only).`,
        '  deny/ask rules, managed rules and Read(...) rules are protected and never decay.',
        '  Enforce a knob with `taper mode <knob> automatic`; `taper status` shows them.',
      ].join('\n'),
    );

    if (values['no-hooks']) {
      deps.out('\nHooks not installed (--no-hooks). taper sees no usage until they are.');
      return 0;
    }
    const dogfood = deps.env.TAPER_DOGFOOD === '1';
    if (dogfood && project === null)
      throw new UsageError('TAPER_DOGFOOD=1 installs into the project settings; run it in a repo');
    const target = dogfood
      ? join(project?.root as string, '.claude', 'settings.json')
      : agent.paths.userSettings;
    const prefix = commandPrefix(deps.entry);
    if (!withHooks(readText(target), prefix).changed) {
      deps.out(`\nHooks already installed in ${target}.`);
    } else {
      deps.out(
        `\ntaper will add hooks for ${HOOK_EVENTS.join(', ')} to ${target}.` +
          '\nIt edits the "hooks" key only; permissions are never touched.',
      );
      const ok = values.yes === true || (deps.isTTY && deps.confirm('Install hooks? [y/N] '));
      if (!ok) {
        deps.out('Hooks not installed. Re-run `taper init --yes` to install them.');
        return 0;
      }
      installHooks(target, prefix);
      deps.out(`Installed hooks in ${target}.`);
    }
    const files = [...new Set([...(agent.config.hooks?.files ?? []), target])];
    agent.saveConfig({ ...agent.config, hooks: { command_prefix: prefix, files } });
    return 0;
  } finally {
    agent.close();
  }
}

function cmdUninstall(rest: readonly string[], deps: Deps): number {
  const { values } = args(rest, { purge: { type: 'boolean' } });
  const paths = resolvePaths(deps.env);
  let config: ReturnType<typeof readConfig> = null;
  try {
    config = readConfig(paths.config);
  } catch {
    deps.err(`${paths.config} is invalid; removing hooks by the current command only.`);
  }
  const prefixes = [
    ...new Set([config?.hooks?.command_prefix, commandPrefix(deps.entry)].filter((p) => p)),
  ] as string[];
  const files = [...new Set([...(config?.hooks?.files ?? []), paths.userSettings])];
  let failed = false;
  for (const f of files) {
    try {
      const n = removeHooks(f, prefixes);
      deps.out(n > 0 ? `Removed ${n} taper hook handler(s) from ${f}.` : `No taper hooks in ${f}.`);
    } catch (e) {
      failed = true;
      deps.err(`Could not update ${f}: ${(e as Error).message}`);
    }
  }
  if (values.purge) {
    rmSync(paths.taperDir, { recursive: true, force: true });
    deps.out(`Deleted ${paths.taperDir}.`);
  } else if (config !== null && !failed) {
    // Keep the ledger; forget where hooks were.
    const { hooks: _, ...kept } = config;
    writeConfig(paths.config, kept);
  }
  return failed ? 1 : 0;
}

// ---------- status ----------

interface MemberStatus {
  readonly rule: string;
  readonly state: Member['state'];
  readonly state_since: number;
  readonly declared_at: number;
  readonly last_seen_at: number | null;
  readonly cooldown_until: number | null;
  readonly protected: boolean;
  readonly next: { state: string; remaining_days: number; eta: number | null } | null;
  readonly blocked_by: readonly string[];
  readonly enforcement: 'prompt' | 'block' | null;
}

function explanations(
  agent: Agent,
  now: number,
  members: readonly Member[],
): Map<string, Explanation> {
  const knobs = agent.store.knobs();
  const all = agent.store.members();
  const coverage = agent.coverage(knobs);
  const out = new Map<string, Explanation>();
  for (const m of members) {
    const e = explain({
      knobs,
      members: all,
      coverage,
      now,
      config: agent.core,
      memberId: m.id,
      ledger: agent.store.ledger([m.id]),
    });
    if (e !== null) out.set(m.id, e);
  }
  return out;
}

/**
 * ETA assumes the clock keeps running: wall clock only. None while a guard holds the member
 * indefinitely (protected, frozen, last member); cooldown and maturity only delay it.
 */
function eta(e: Explanation, member: Member, now: number): number | null {
  const indefinitely = e.blockedBy.some(
    (g) => g === 'protected' || g === 'frozen' || g === 'last_member',
  );
  if (e.next === null || e.clock.kind !== 'wall' || indefinitely) return null;
  return Math.max(now + e.next.remainingDays * DAY_MS, member.cooldownUntil ?? 0);
}

function cmdStatus(agent: Agent, rest: readonly string[]): number {
  const { values } = args(rest, { json: { type: 'boolean' } });
  const now = agent.deps.now();
  agent.snapshot(agent.projectAt(agent.deps.cwd), now);
  const tick = agent.tick(now);
  const knobs = agent.store.knobs();
  const members = agent.store.members();
  const ex = explanations(agent, now, members);
  const frozen = new Set(
    knobs
      .filter((k) => members.some((m) => m.knobId === k.id && ex.get(m.id)?.clock.frozen))
      .map((k) => k.id),
  );
  const report = {
    now,
    device_id: agent.deviceId,
    tick_id: tick.tickId,
    knobs: knobs.map((k) => ({
      id: k.id,
      kind: k.kind,
      polarity: k.polarity,
      repo_id: k.repoId,
      mode: k.mode,
      protected: k.protected,
      clock: k.clock,
      frozen: frozen.has(k.id),
      members: members
        .filter((m) => m.knobId === k.id)
        .map((m): MemberStatus => {
          const e = ex.get(m.id) as Explanation;
          return {
            rule: m.rule,
            state: m.state,
            state_since: m.stateSince,
            declared_at: m.declaredAt,
            last_seen_at: m.lastSeenAt,
            cooldown_until: m.cooldownUntil,
            protected: e.protected,
            next:
              e.next === null
                ? null
                : {
                    state: e.next.state,
                    remaining_days: e.next.remainingDays,
                    eta: eta(e, m, now),
                  },
            blocked_by: e.blockedBy,
            enforcement: e.enforcement,
          };
        }),
    })),
  };
  if (values.json) {
    agent.deps.out(JSON.stringify(report, null, 2));
    return 0;
  }
  agent.deps.out(`taper status  ${fmtTime(now)}  device ${agent.deviceId}`);
  for (const k of report.knobs) {
    const live = k.members.filter((m) => m.state !== 'retired');
    if (live.length === 0) continue;
    const flags = [k.mode, k.protected ? 'protected' : '', k.frozen ? 'frozen' : '']
      .filter((f) => f)
      .join(', ');
    agent.deps.out(`\n${knobLabel(knobs.find((x) => x.id === k.id) as StoredKnob)}  [${flags}]`);
    agent.deps.out(`  id: ${k.id}`);
    for (const m of live) {
      const seen = m.last_seen_at === null ? 'never used' : `last used ${fmtDate(m.last_seen_at)}`;
      const next =
        m.next === null
          ? ''
          : m.protected
            ? ''
            : `  → ${m.next.state} ${m.next.eta === null ? `in ${Math.round(m.next.remaining_days * 10) / 10} clock days` : `~${fmtDate(m.next.eta)}`}`;
      const held =
        m.blocked_by.length > 0 && !m.protected ? `  (held: ${m.blocked_by.join(', ')})` : '';
      const enforced =
        m.enforcement === null ? '' : `  [hook ${m.enforcement === 'prompt' ? 'asks' : 'denies'}]`;
      agent.deps.out(`  ${m.state.padEnd(16)} ${m.rule}  ${seen}${next}${held}${enforced}`);
    }
  }
  return 0;
}

// ---------- explain / regrant / protect / mode ----------

function rulePositional(rest: readonly string[], what: string): string {
  const { positionals } = args(rest, {});
  const rule = normalizeRule(positionals.join(' '));
  if (rule === '') throw new UsageError(`usage: taper ${what} "<rule>"`);
  return rule;
}

function cmdExplain(agent: Agent, rest: readonly string[]): number {
  const rule = rulePositional(rest, 'explain');
  const now = agent.deps.now();
  const members = agent.membersByRule(rule);
  if (members.length === 0) {
    agent.deps.err(`No tracked rule ${JSON.stringify(rule)}. \`taper status\` lists them.`);
    return 1;
  }
  const knobs = agent.store.knobs();
  const ex = explanations(agent, now, members);
  const parts = members.map((m) =>
    narrative.explain(ex.get(m.id) as Explanation, {
      knob: knobs.find((k) => k.id === m.knobId) as StoredKnob,
      counts: agent.store.eventCounts(m.id),
    }),
  );
  agent.deps.out(parts.join('\n\n'));
  return 0;
}

const decayed = (m: Member) =>
  m.state === 'stale_candidate' || m.state === 'pending_removal' || m.state === 'removed';

function cmdRegrant(agent: Agent, rest: readonly string[]): number {
  const rule = rulePositional(rest, 'regrant');
  const now = agent.deps.now();
  const members = agent.membersByRule(rule);
  if (members.length === 0) {
    agent.deps.err(`No tracked rule ${JSON.stringify(rule)}.`);
    return 1;
  }
  const ts = agent.regrant(members.filter(decayed), now);
  if (ts.length === 0) {
    agent.deps.out(`Nothing to re-grant: ${JSON.stringify(rule)} is not decayed.`);
    return 0;
  }
  printRestores(agent, ts, now);
  return 0;
}

function printRestores(agent: Agent, ts: ReturnType<Agent['regrant']>, now: number): void {
  const knobs = agent.store.knobs();
  for (const t of ts.filter((x) => x.to === 'active')) {
    const m = agent.store.members({ ids: [t.memberId] })[0] as Member;
    const k = knobs.find((x) => x.id === m.knobId) as StoredKnob;
    const cd = resolveThresholds(agent.core, k).cooldownDays;
    agent.deps.out(
      `Re-granted ${JSON.stringify(m.rule)} (${knobLabel(k)}): active again, cooldown ${cd}d until ${fmtDate(m.cooldownUntil ?? now)}.`,
    );
  }
}

/** A knob id, or an alias for this device's allow knob of that kind in the current project. */
function resolveKnob(agent: Agent, ref: string): StoredKnob | null {
  const knobs = agent.store.knobs();
  const exact = knobs.find((k) => k.id === ref);
  if (exact !== undefined) return exact;
  if (!['user', 'project', 'local', 'managed'].includes(ref)) return null;
  const project = agent.projectAt(agent.deps.cwd);
  const enc = encodeURIComponent;
  const id =
    ref === 'user'
      ? `user:${enc(agent.deviceId)}:allow`
      : ref === 'managed'
        ? `managed:${enc(agent.deviceId)}:allow`
        : project === null
          ? null
          : ref === 'project'
            ? `project:${enc(project.repoId)}:allow`
            : `local:${enc(agent.deviceId)}:${enc(project.repoId)}:allow`;
  return knobs.find((k) => k.id === id) ?? null;
}

/** C1 and invariant 4: only allow rules outside managed policy may decay. */
function decayable(k: StoredKnob, rule: string | null): boolean {
  if (k.polarity !== 'allow' || k.kind === 'managed') return false;
  return rule === null || parseRule(rule, 'allow').kind !== 'inert';
}

function cmdProtect(agent: Agent, rest: readonly string[], on: boolean): number {
  const { positionals } = args(rest, {});
  const ref = positionals.join(' ').trim();
  if (ref === '') throw new UsageError(`usage: taper ${on ? 'protect' : 'unprotect'} <rule|knob>`);
  const now = agent.deps.now();
  const knob = resolveKnob(agent, ref);
  const targets =
    knob !== null
      ? agent.store.members().filter((m) => m.knobId === knob.id && m.state !== 'retired')
      : agent.membersByRule(ref);
  if (knob === null && targets.length === 0) {
    agent.deps.err(`No tracked rule or knob ${JSON.stringify(ref)}. \`taper status\` lists them.`);
    return 1;
  }
  const knobs = agent.store.knobs();
  const knobOf = (m: Member) => knobs.find((k) => k.id === m.knobId) as StoredKnob;
  if (!on) {
    const refused =
      knob !== null ? !decayable(knob, null) : targets.some((m) => !decayable(knobOf(m), m.rule));
    if (refused) {
      agent.deps.err(
        'Refusing: only allow rules outside managed policy can decay (C1). deny/ask arrays, managed knobs and rules taper does not understand stay protected.',
      );
      return 1;
    }
  }
  // ADR-0013: protecting a decayed member re-grants it first (SelfApprove), so "keep this"
  // never leaves it blocked or prompting.
  const restores = on ? agent.regrant(targets.filter(decayed), now) : [];
  agent.store.tx(() => {
    if (knob !== null) agent.store.updateKnob({ ...knob, protected: on });
    else {
      const fresh = agent.store.members({ ids: targets.map((m) => m.id) });
      agent.store.saveMembers(fresh.map((m) => ({ ...m, protected: on })));
    }
  });
  printRestores(agent, restores, now);
  const what =
    knob !== null ? `knob ${knob.id}` : `${targets.length} member(s) with ${JSON.stringify(ref)}`;
  agent.deps.out(`${on ? 'Protected' : 'Unprotected'} ${what}.`);
  if (!on && knob === null)
    for (const m of targets)
      if (isProtectedByDefault(m.rule, knobOf(m).kind, knobOf(m).polarity, true))
        agent.deps.out(
          `Note: ${JSON.stringify(m.rule)} is a Read rule, low-confidence evidence (C2).`,
        );
  return 0;
}

const C3_WARNING =
  'C3: this knob comes from a CI --settings file. Headless runs deny instead of prompting, so a ' +
  'pending_removal "ask" becomes a failed CI step and there is no in-context re-grant. taper ' +
  'never observes CI runs locally, so this knob stays frozen and will not tighten from this device.';

function cmdMode(agent: Agent, rest: readonly string[]): number {
  const { values, positionals } = args(rest, {
    yes: { type: 'boolean' },
    'ci-opt-in': { type: 'boolean' },
  });
  const [ref, mode] = positionals;
  if (ref === undefined || (mode !== 'shadow' && mode !== 'automatic'))
    throw new UsageError('usage: taper mode <knob> shadow|automatic [--yes] [--ci-opt-in]');
  const knob = resolveKnob(agent, ref);
  if (knob === null) {
    agent.deps.err(`No knob ${JSON.stringify(ref)}. \`taper status\` lists knob ids.`);
    return 1;
  }
  if (mode === 'automatic' && knob.kind === 'cli') {
    agent.deps.err(C3_WARNING);
    if (!values['ci-opt-in']) {
      agent.deps.err('Re-run with --ci-opt-in to switch it anyway.');
      return 1;
    }
  }
  if (mode === 'automatic' && knob.mode !== 'automatic') {
    const members = agent.store.members().filter((m) => m.knobId === knob.id);
    const preview = enforcement([{ ...knob, mode: 'automatic' }], members);
    if (preview.length > 0) {
      agent.deps.out('Switching enforces the states shadow mode already reached:');
      for (const p of preview)
        agent.deps.out(
          `  ${p.action === 'prompt' ? 'ask before use' : 'deny'}: ${JSON.stringify(p.rule)}`,
        );
      if (!values.yes) {
        agent.deps.out('Re-run with --yes to switch.');
        return 1;
      }
    }
  }
  agent.store.updateKnob({ ...knob, mode });
  agent.deps.out(`${knob.id} is now ${mode}.`);
  if (knob.protected) agent.deps.out('It is protected, so its members never decay.');
  return 0;
}

// ---------- recommend ----------

function cmdRecommend(agent: Agent, rest: readonly string[]): number {
  const { values } = args(rest, { format: { type: 'string' } });
  const format = values.format ?? 'text';
  if (format === 'pr') throw new UsageError('--format pr arrives in M7 (needs a GitHub token).');
  if (format !== 'text' && format !== 'diff')
    throw new UsageError('usage: taper recommend [--format text|diff]');
  const now = agent.deps.now();
  agent.tick(now);
  const knobs = agent.store.knobs();
  const members = agent.store.members().filter(decayed);
  const ex = explanations(agent, now, members);
  // Which file declares each allow knob (user, project, local, file-based cli).
  const files = new Map<string, string[]>();
  for (const k of knobs) files.set(k.id, []);
  for (const s of agent.store.allSnapshots(agent.deviceId)) {
    if (s.scope === 'managed' || s.inline) continue;
    const id = knobIdFor(s, 'allow', { managedSubject: agent.deviceId });
    files.get(id)?.push(s.path);
  }
  const items: AdviceItem[] = members
    .filter((m) => (knobs.find((k) => k.id === m.knobId) as StoredKnob).polarity === 'allow')
    .map((m) => {
      const k = knobs.find((x) => x.id === m.knobId) as StoredKnob;
      const paths = files.get(k.id) ?? [];
      return {
        rule: m.rule,
        knob: k,
        state: m.state as AdviceItem['state'],
        stateSince: m.stateSince,
        path: paths.length === 1 ? (paths[0] as string) : null,
        heldByLastMember: ex.get(m.id)?.blockedBy.includes('last_member') ?? false,
      };
    });
  if (format === 'text') {
    agent.deps.out(narrative.recommend({ now, items }));
    return 0;
  }
  const byFile = new Map<string, string[]>();
  for (const i of items)
    if (i.state === 'removed')
      for (const p of files.get(i.knob.id) ?? []) byFile.set(p, [...(byFile.get(p) ?? []), i.rule]);
  const diffs: string[] = [];
  for (const [path, rules] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const text = readText(path);
    if (text === null) continue;
    const next = withoutAllowRules(text, rules);
    if (next !== null) diffs.push(unifiedDiff(path, text, next));
  }
  agent.deps.out(
    diffs.length === 0
      ? '# No removed rules to delete. (Advisory: taper never applies this diff.)'
      : `# Advisory: taper never applies this diff. Review, then apply with \`git apply\` or by hand.\n${diffs.join('')}`,
  );
  return 0;
}

// ---------- simulate / snapshot ----------

function cmdSimulate(agent: Agent, rest: readonly string[]): number {
  const { values } = args(rest, { days: { type: 'string' } });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new UsageError('usage: taper simulate --days N (1..3650)');
  const now = agent.deps.now();
  const knobs = agent.store.knobs();
  const members = agent.store.members();
  // Assumption printed with the result: a session with a tool call every day in this project,
  // and no use of any tracked rule. Nothing is persisted.
  const future: Signal[] = [];
  for (let d = 0; d <= days; d++)
    future.push(
      { at: now + d * DAY_MS, kind: 'session' },
      { at: now + d * DAY_MS, kind: 'decision' },
    );
  const project = agent.projectAt(agent.deps.cwd);
  const coverage = agent.coverage(knobs, { repoId: project?.repoId ?? null, signals: future });
  const tl = simulate(
    { knobs, members, coverage, config: agent.core },
    [],
    now,
    now + days * DAY_MS,
    DAY_MS,
  );
  agent.deps.out(
    `Simulating ${days} day(s) from ${fmtTime(now)}, assuming a daily session here and no use of any tracked rule. Nothing is saved.`,
  );
  const rules = new Map(members.map((m) => [m.id, m]));
  let any = false;
  for (const step of tl.steps) {
    for (const t of step.transitions) {
      any = true;
      const m = rules.get(t.memberId) as Member;
      const k = knobs.find((x) => x.id === t.knobId) as StoredKnob;
      agent.deps.out(
        `  day ${Math.round((step.at - now) / DAY_MS)} (${fmtDate(step.at)}): ${JSON.stringify(m.rule)} ${t.from} → ${t.to}  ${knobLabel(k)}${t.shadow ? ' [shadow]' : ''}`,
      );
    }
  }
  if (!any) agent.deps.out('  No transitions in this window.');
  return 0;
}

function cmdSnapshot(agent: Agent): number {
  const now = agent.deps.now();
  const r = agent.snapshot(agent.projectAt(agent.deps.cwd), now);
  for (const s of r.snapshots)
    agent.deps.out(
      `${s.scope.padEnd(8)} ${s.path}  allow ${s.arrays.allow.length}, ask ${s.arrays.ask.length}, deny ${s.arrays.deny.length}`,
    );
  for (const e of r.errors)
    agent.deps.out(`${e.scope.padEnd(8)} ${e.path}  NOT READ: ${e.message}`);
  const declared = r.transitions.filter(
    (t) => t.reason === 'declared' || t.reason === 'redeclared',
  );
  const retired = r.transitions.filter((t) => t.to === 'retired');
  agent.deps.out(`${declared.length} rule(s) declared, ${retired.length} retired.`);
  return 0;
}
