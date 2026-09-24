// The solo agent (HANDOFF §6, ADR-0010): the local ledger plus the pure engine (core) and the
// Claude Code backend. Every decision is made by core or the backend; this module only loads
// state, calls them, and persists what they return.
//
// - Snapshots: loadSettings → latest good snapshot per source → applySettingsSnapshots.
// - Usage: normalize → attribute (raw arguments are matched here, then dropped: invariant 8) →
//   EventSchema-validated event → applyUsage (instant restore, cooldown: invariant 5).
// - Tick: evaluate() once per ISO minute (`tick:<YYYY-MM-DDTHH:MM>`), idempotent.
// - Enforcement: only the hook writer, only for automatic knobs (invariant 7), never a settings
//   file's permissions (invariant 3).

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySettingsSnapshots,
  attribute,
  type DecisionSource,
  type EffectivePolicy,
  type Event,
  EventSchema,
  type HookDecision,
  hookDecision,
  normalizeRule,
  type PermissionMode,
  planKnobs,
  policyFromSnapshots,
  type SettingsSnapshot,
  type ToolCall,
  toSignal,
  toUsageEvent,
} from '@taper/backend-claude-code';
import { type LoadError, loadSettings } from '@taper/backend-claude-code/loader';
import {
  applySnapshot,
  applyTransitions,
  applyUsage,
  type Config,
  evaluate,
  type KnobCoverage,
  type Member,
  regrant,
  type Signal,
  type Transition,
} from '@taper/core';
import { coreConfig, readConfig, type TaperConfig, writeConfig } from './config.ts';
import { type Db, openDb } from './db.ts';
import type { Deps } from './deps.ts';
import { readText } from './fsutil.ts';
import { type Paths, resolvePaths } from './paths.ts';
import { findRepo, type RepoInfo } from './repo.ts';
import { type SessionRow, Store, type StoredKnob } from './store.ts';
import { readTrust } from './trust.ts';

export class NotInitialized extends Error {
  constructor() {
    super('taper is not initialized on this device; run `taper init`');
  }
}

export interface SnapshotReport {
  readonly snapshots: readonly SettingsSnapshot[];
  readonly errors: readonly LoadError[];
  readonly claudeWorkflows: readonly string[];
  readonly transitions: readonly Transition[];
}

export interface ToolObservation {
  readonly kind: 'tool_decision' | 'tool_result';
  readonly at: number;
  readonly toolName: string;
  readonly toolUseId?: string;
  readonly decision: 'accept' | 'reject';
  readonly source?: DecisionSource;
  readonly permissionMode: PermissionMode;
  /** Raw arguments: matched in ingestTool, then dropped (invariant 8). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** The cwd the event reported, when it differs from the session's start directory. */
  readonly eventCwd?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const snapshotKey = (s: SettingsSnapshot): string =>
  JSON.stringify([s.scope, s.repo_id ?? '', s.pipeline_id ?? '', s.path]);
const changed = <M>(before: readonly M[], after: readonly M[]): M[] =>
  after.filter((m, i) => m !== before[i]);

/** Tick id = ISO minute (HANDOFF §7): reruns inside the same minute are no-ops. */
export const tickIdAt = (now: number): string => `tick:${new Date(now).toISOString().slice(0, 16)}`;

export class Agent {
  readonly deps: Deps;
  readonly paths: Paths;
  readonly config: TaperConfig;
  readonly core: Config;
  readonly store: Store;

  private constructor(deps: Deps, paths: Paths, config: TaperConfig, db: Db) {
    this.deps = deps;
    this.paths = paths;
    this.config = config;
    this.core = coreConfig(config);
    this.store = new Store(db);
  }

  static open(deps: Deps): Agent {
    const paths = resolvePaths(deps.env);
    const config = readConfig(paths.config);
    if (config === null) throw new NotInitialized();
    return new Agent(deps, paths, config, openDb(paths.db));
  }

  /** Opens the agent, creating config and ledger on first use. Keeps an existing device id. */
  static init(deps: Deps): { agent: Agent; created: boolean } {
    const paths = resolvePaths(deps.env);
    let config = readConfig(paths.config);
    const created = config === null;
    if (config === null) {
      config = {
        version: 1,
        device_id: deps.randomHex(16),
        args_salt: deps.randomHex(32),
        enrolled_at: deps.now(),
        protect_read_rules: true,
        raw_retention_hours: 0,
      };
      writeConfig(paths.config, config);
    }
    return { agent: new Agent(deps, paths, config, openDb(paths.db)), created };
  }

  close(): void {
    this.store.db.close();
  }

  get deviceId(): string {
    return this.config.device_id;
  }

  saveConfig(next: TaperConfig): void {
    writeConfig(this.paths.config, next);
  }

  /**
   * The project a directory belongs to: its git top-level, or outside git a directory holding
   * `.claude/` (facts doc B6). $HOME is never a project: its `.claude/settings.json` is the user
   * file.
   */
  projectAt(dir: string): RepoInfo | null {
    const repo = findRepo(dir);
    if (repo !== null) return repo.root === this.paths.home ? null : repo;
    const hasClaude = (() => {
      try {
        return statSync(join(dir, '.claude')).isDirectory();
      } catch {
        return false;
      }
    })();
    return hasClaude && dir !== this.paths.home ? { root: dir, repoId: `path:${dir}` } : null;
  }

  // ---------- snapshots ----------

  /** Reads managed, user and (if any) the project's settings; declares and retires members. */
  snapshot(project: RepoInfo | null, now: number): SnapshotReport {
    const res = loadSettings({
      deviceId: this.deviceId,
      ...(project === null ? {} : { repoId: project.repoId, repoRoot: project.root }),
      home: this.paths.home,
      configDir: this.paths.claudeDir,
      ...(this.deps.managedDir === undefined ? {} : { managedDir: this.deps.managedDir }),
      takenAt: now,
    });
    const opts = {
      managedSubject: this.deviceId,
      protectReadRules: this.config.protect_read_rules,
    };
    const transitions = this.store.tx(() => {
      // Latest good snapshot per source. An unreadable or invalid source keeps its last good
      // snapshot, so its rules still attribute usage; a vanished drop-in or --settings file goes.
      const fresh = new Map(res.snapshots.map((s) => [snapshotKey(s), s]));
      const errored = new Set(res.errors.map((e) => e.path));
      for (const repo of project === null ? [null] : [null, project.repoId]) {
        for (const row of this.store.snapshotKeys(this.deviceId, repo)) {
          const s = fresh.get(row.key);
          if (s === undefined) {
            const path = (JSON.parse(row.key) as string[])[3] as string;
            if (!errored.has(path)) this.store.deleteSnapshot(row.key);
          } else if (s.content_hash !== row.hash) this.store.putSnapshot(row.key, s);
          fresh.delete(row.key);
        }
      }
      for (const [key, s] of fresh) this.store.putSnapshot(key, s);

      const known = new Set(this.store.knobs().map((k) => k.id));
      const plans = planKnobs(res.snapshots, opts);
      this.store.addKnobs(
        plans
          .filter((p) => !known.has(p.knob.id))
          .map((p) => ({
            ...p.knob,
            kind: p.kind,
            polarity: p.polarity,
            repoId: p.kind === 'user' || p.kind === 'managed' ? null : (project?.repoId ?? null),
          })),
      );
      const knobs = this.store.knobs();
      const members = this.store.members();
      const out = applySettingsSnapshots(members, res.snapshots, {
        ...opts,
        knobs,
        tickId: `snapshot:${now}`,
      });
      let next = out.members;
      const ts = [...out.transitions];

      // A workflow that no longer passes --settings leaves its cli knob without a snapshot
      // (ADR-0007): retire its members, unless some cli source failed to load this time.
      if (project !== null && !res.errors.some((e) => e.scope === 'cli')) {
        const planned = new Set(plans.map((p) => p.knob.id));
        for (const k of knobs) {
          if (k.kind !== 'cli' || k.repoId !== project.repoId || planned.has(k.id)) continue;
          const r = applySnapshot(
            next,
            { knobId: k.id, takenAt: now, rules: [] },
            {
              knob: k,
              tickId: `snapshot:${now}`,
            },
          );
          next = r.members;
          ts.push(...r.transitions);
        }
      }
      this.store.saveMembers([
        ...changed(members, next.slice(0, members.length)),
        ...next.slice(members.length),
      ]);
      this.store.appendTransitions(ts);
      return ts;
    });
    return {
      snapshots: res.snapshots,
      errors: res.errors,
      claudeWorkflows: res.claudeWorkflows,
      transitions,
    };
  }

  /**
   * Re-snapshot only when the project's local file changed (ADR-0002 row 2): the debounce key
   * is device + repo + content hash, so repeated `user_permanent` events cost one file read.
   */
  resnapshotIfLocalChanged(project: RepoInfo | null, now: number): boolean {
    if (project === null) return false;
    const path = join(project.root, '.claude', 'settings.local.json');
    let text: string;
    try {
      text = readText(path) ?? '';
    } catch {
      return false;
    }
    const stored = this.store
      .snapshots(this.deviceId, project.repoId)
      .find((s) => s.scope === 'local' && s.path === path);
    if (stored?.content_hash === sha256(text)) return false;
    this.snapshot(project, now);
    return true;
  }

  // ---------- sessions, policy, signals ----------

  /** The session row; created on first sight. A session keeps the directory it started in. */
  session(sessionId: string, cwd: string, basis: SessionRow['cwdBasis'], now: number): SessionRow {
    const existing = this.store.session(sessionId);
    if (existing !== null) return existing;
    const project = this.projectAt(cwd);
    const dirs = project === null || project.root === cwd ? [cwd] : [cwd, project.root];
    this.store.addSession({
      sessionId,
      cwd,
      cwdBasis: basis,
      repoRoot: project?.root ?? null,
      repoId: project?.repoId ?? null,
      trust: readTrust(this.paths.claudeJson, dirs),
      startedAt: now,
      permissionRequest: false,
    });
    return this.store.session(sessionId) as SessionRow;
  }

  projectOf(session: SessionRow): RepoInfo | null {
    return session.repoRoot === null || session.repoId === null
      ? null
      : { root: session.repoRoot, repoId: session.repoId };
  }

  policy(session: SessionRow): EffectivePolicy {
    return policyFromSnapshots(this.store.snapshots(this.deviceId, session.repoId), {
      managedSubject: this.deviceId,
      home: this.paths.home,
      workspaceTrusted: session.trust,
    });
  }

  signal(session: SessionRow | null, kind: Signal['kind'], at: number): void {
    this.store.addSignal(this.deviceId, session?.repoId ?? null, kind, at);
  }

  /**
   * Coverage per knob (ADR-0005, ADR-0010): user and managed knobs see every signal of this
   * device since enrollment; project and local knobs see only signals from sessions in their
   * repo; cli knobs are never observed locally, so they stay frozen.
   */
  coverage(knobs: readonly StoredKnob[], extra: readonly Signal[] = []): KnobCoverage[] {
    const rows = this.store.signals(this.deviceId);
    const byRepo = new Map<string, Signal[]>();
    for (const r of rows) {
      if (r.repoId === null) continue;
      const list = byRepo.get(r.repoId) ?? [];
      list.push({ at: r.at, kind: r.kind });
      byRepo.set(r.repoId, list);
    }
    const all: Signal[] = [...rows.map((r) => ({ at: r.at, kind: r.kind })), ...extra];
    return knobs.map((k) => {
      if (k.kind === 'user' || k.kind === 'managed')
        return {
          knobId: k.id,
          sources: [{ sourceId: this.deviceId, since: this.config.enrolled_at, signals: all }],
        };
      const repo = k.kind === 'cli' || k.repoId === null ? [] : (byRepo.get(k.repoId) ?? []);
      if (repo.length === 0) return { knobId: k.id, sources: [] };
      return {
        knobId: k.id,
        sources: [
          {
            sourceId: `${this.deviceId}:${k.repoId}`,
            since: (repo[0] as Signal).at,
            signals: [...repo, ...extra],
          },
        ],
      };
    });
  }

  // ---------- evaluate tick ----------

  tick(now: number): { tickId: string; ran: boolean; transitions: readonly Transition[] } {
    const tickId = tickIdAt(now);
    return this.store.tx(() => {
      if (!this.store.claimTick(tickId, now)) return { tickId, ran: false, transitions: [] };
      const knobs = this.store.knobs();
      const members = this.store.members();
      const out = evaluate({
        knobs,
        members,
        coverage: this.coverage(knobs),
        now,
        tickId,
        config: this.core,
      });
      this.store.saveMembers(changed(members, applyTransitions(members, out.transitions)));
      this.store.appendTransitions(out.transitions);
      return { tickId, ran: true, transitions: out.transitions };
    });
  }

  // ---------- usage and decisions ----------

  /** The call as the matcher sees it, under the session's start directory and the event's. */
  private calls(
    session: SessionRow,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    eventCwd?: string,
  ): ToolCall[] {
    const cwds = [session.cwd];
    if (eventCwd !== undefined && eventCwd !== session.cwd) cwds.push(eventCwd);
    return cwds.map((cwd) => ({ tool: toolName, input, cwd }));
  }

  /** Attribute, persist the event without arguments, apply usage. Idempotent per event id. */
  ingestTool(session: SessionRow, obs: ToolObservation): Event {
    const policy = this.policy(session);
    const calls =
      obs.input === undefined ? [] : this.calls(session, obs.toolName, obs.input, obs.eventCwd);
    const found = calls.map((c) => attribute(policy, c));
    const argsHash =
      obs.input === undefined
        ? undefined
        : sha256(`${this.config.args_salt}\n${JSON.stringify(obs.input)}`);
    const event = EventSchema.parse({
      event_id:
        obs.toolUseId === undefined
          ? `${obs.kind}:${session.sessionId}:${obs.at}:${argsHash ?? ''}`
          : `${obs.kind}:${obs.toolUseId}`,
      device_id: this.deviceId,
      ...(session.repoId === null ? {} : { repo_id: session.repoId }),
      session_id: session.sessionId,
      ...(obs.toolUseId === undefined ? {} : { tool_use_id: obs.toolUseId }),
      at: obs.at,
      kind: obs.kind,
      tool_name: obs.toolName,
      decision: obs.decision,
      ...(obs.source === undefined ? {} : { source: obs.source }),
      permission_mode: obs.permissionMode,
      // C5: every matching allow member, under every directory reading.
      matched_member_ids: [...new Set(found.flatMap((f) => f.matchedMemberIds))].sort(),
      decisive_member_ids: [...(found[0]?.decisiveMemberIds ?? [])],
      ...(argsHash === undefined ? {} : { args_hash: argsHash }),
    });
    this.store.tx(() => {
      if (!this.store.insertEvent(event)) return;
      const usage = toUsageEvent(event);
      if (usage !== null) {
        const members = this.store.members({ ids: usage.memberIds });
        const out = applyUsage(members, [usage], { knobs: this.store.knobs(), config: this.core });
        this.store.saveMembers(changed(members, out.members));
        this.store.appendTransitions(out.transitions);
      }
      this.store.addSignal(this.deviceId, session.repoId, toSignal(event).kind, event.at);
    });
    return event;
  }

  /** PreToolUse (HANDOFF §5.4A): ask / deny / nothing. Reads state only. */
  decide(
    session: SessionRow,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    now: number,
    eventCwd?: string,
  ): HookDecision | null {
    const policy = this.policy(session);
    const calls = this.calls(session, toolName, input, eventCwd);
    const ids = new Set(calls.flatMap((c) => attribute(policy, c).matchedMemberIds));
    if (ids.size === 0) return null;
    return hookDecision({
      policy,
      calls,
      knobs: this.store.knobs(),
      members: this.store.members({ ids: [...ids] }),
      config: this.core,
      now,
    });
  }

  // ---------- SelfApprove re-grant (HANDOFF §5.5) ----------

  membersByRule(rule: string): Member[] {
    return this.store.members({ rule: normalizeRule(rule) });
  }

  /** Restores every decayed member with this rule now, with a cooldown (P4, P7 SelfApprove). */
  regrant(members: readonly Member[], now: number): Transition[] {
    return this.store.tx(() => {
      const knobs = this.store.knobs();
      const out: Transition[] = [];
      for (const member of members) {
        const knob = knobs.find((k) => k.id === member.knobId);
        if (knob === undefined) continue;
        const r = regrant({
          member,
          knob,
          config: this.core,
          at: now,
          actor: 'user',
          requestId: `selfapprove:${now}`,
        });
        if (r.transitions.length === 0) continue;
        this.store.saveMembers([r.member]);
        this.store.appendTransitions(r.transitions);
        out.push(...r.transitions);
      }
      return out;
    });
  }
}
