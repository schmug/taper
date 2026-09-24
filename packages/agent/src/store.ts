// Typed queries over the local ledger (db.ts). No logic beyond row mapping and idempotent writes:
// decisions live in core, the backend and agent.ts.

import type { Event, Polarity, Scope, SettingsSnapshot, Trust } from '@taper/backend-claude-code';
import type {
  Evidence,
  Knob,
  LedgerState,
  LiveState,
  Member,
  MemberState,
  Signal,
  Thresholds,
  Transition,
} from '@taper/core';
import type { Db } from './db.ts';

export interface StoredKnob extends Knob {
  readonly kind: Scope;
  readonly polarity: Polarity;
  /** Subject repo of project/local/cli knobs; null for user and managed. */
  readonly repoId: string | null;
}

export interface SessionRow {
  readonly sessionId: string;
  /** The directory the session started in: anchors matching (ADR-0011). */
  readonly cwd: string;
  readonly cwdBasis: 'session_start' | 'first_event' | 'replay';
  readonly repoRoot: string | null;
  readonly repoId: string | null;
  readonly trust: Trust;
  readonly startedAt: number;
  readonly permissionRequest: boolean;
}

export interface SignalRow extends Signal {
  readonly repoId: string | null;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => Number(v) === 1;
const placeholders = (k: number) => Array.from({ length: k }, () => '?').join(', ');

function toKnob(r: Row): StoredKnob {
  const thresholds =
    r.thresholds === null ? undefined : (JSON.parse(String(r.thresholds)) as Partial<Thresholds>);
  return {
    id: String(r.id),
    kind: r.kind as Scope,
    polarity: r.polarity as Polarity,
    repoId: r.repo_id === null ? null : String(r.repo_id),
    mode: r.mode as Knob['mode'],
    protected: bool(r.protected),
    clock: r.clock as Knob['clock'],
    ...(thresholds === undefined ? {} : { thresholds }),
  };
}

function toMember(r: Row): Member {
  return {
    id: String(r.id),
    knobId: String(r.knob_id),
    rule: String(r.rule),
    declaredAt: Number(r.declared_at),
    firstSeenAt: n(r.first_seen_at),
    lastSeenAt: n(r.last_seen_at),
    lastRestoredAt: n(r.last_restored_at),
    state: r.state as MemberState,
    stateSince: Number(r.state_since),
    cooldownUntil: n(r.cooldown_until),
    restoredCount: Number(r.restored_count),
    protected: bool(r.protected),
    retiredFrom: r.retired_from === null ? null : (r.retired_from as LiveState),
  };
}

function toTransition(r: Row): Transition {
  return {
    memberId: String(r.member_id),
    knobId: String(r.knob_id),
    from: r.from_state === null ? null : (r.from_state as LedgerState),
    to: r.to_state as LedgerState,
    at: Number(r.at),
    reason: r.reason as Transition['reason'],
    actor: r.actor as Transition['actor'],
    shadow: bool(r.shadow),
    tickId: String(r.tick_id),
    evidence: JSON.parse(String(r.evidence)) as Evidence,
  };
}

const trustText = (t: Trust): string => (t === 'unknown' ? 'unknown' : t ? 'true' : 'false');
const trustOf = (s: unknown): Trust => (s === 'true' ? true : s === 'false' ? false : 'unknown');

const HOUR = 3_600_000;

export class Store {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Runs `fn` in one immediate transaction (serializes concurrent hook processes). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  knobs(): StoredKnob[] {
    return (this.db.prepare('SELECT * FROM knobs ORDER BY id').all() as Row[]).map(toKnob);
  }

  /** Inserts new knobs; an existing knob keeps its mode, protection, clock and thresholds. */
  addKnobs(knobs: readonly StoredKnob[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO knobs (id, kind, polarity, repo_id, mode, protected, clock, thresholds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const k of knobs)
      stmt.run(
        k.id,
        k.kind,
        k.polarity,
        k.repoId,
        k.mode,
        k.protected ? 1 : 0,
        k.clock,
        k.thresholds === undefined ? null : JSON.stringify(k.thresholds),
      );
  }

  updateKnob(k: StoredKnob): void {
    this.db
      .prepare('UPDATE knobs SET mode = ?, protected = ?, clock = ?, thresholds = ? WHERE id = ?')
      .run(
        k.mode,
        k.protected ? 1 : 0,
        k.clock,
        k.thresholds === undefined ? null : JSON.stringify(k.thresholds),
        k.id,
      );
  }

  members(filter: { ids?: readonly string[]; rule?: string } = {}): Member[] {
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return [];
      const rows = this.db
        .prepare(
          `SELECT * FROM members WHERE id IN (${placeholders(filter.ids.length)}) ORDER BY id`,
        )
        .all(...filter.ids) as Row[];
      return rows.map(toMember);
    }
    if (filter.rule !== undefined)
      return (
        this.db
          .prepare('SELECT * FROM members WHERE rule = ? ORDER BY id')
          .all(filter.rule) as Row[]
      ).map(toMember);
    return (this.db.prepare('SELECT * FROM members ORDER BY id').all() as Row[]).map(toMember);
  }

  saveMembers(members: readonly Member[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO members (id, knob_id, rule, declared_at, first_seen_at, last_seen_at,
         last_restored_at, state, state_since, cooldown_until, restored_count, protected,
         retired_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         declared_at = excluded.declared_at, first_seen_at = excluded.first_seen_at,
         last_seen_at = excluded.last_seen_at, last_restored_at = excluded.last_restored_at,
         state = excluded.state, state_since = excluded.state_since,
         cooldown_until = excluded.cooldown_until, restored_count = excluded.restored_count,
         protected = excluded.protected, retired_from = excluded.retired_from`,
    );
    for (const m of members)
      stmt.run(
        m.id,
        m.knobId,
        m.rule,
        m.declaredAt,
        m.firstSeenAt,
        m.lastSeenAt,
        m.lastRestoredAt,
        m.state,
        m.stateSince,
        m.cooldownUntil,
        m.restoredCount,
        m.protected ? 1 : 0,
        m.retiredFrom,
      );
  }

  /** Idempotent on (member, from, to, tick). Returns how many rows were new. */
  appendTransitions(ts: readonly Transition[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO transitions
         (member_id, knob_id, from_state, to_state, at, reason, actor, shadow, tick_id, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const t of ts)
      added += stmt.run(
        t.memberId,
        t.knobId,
        t.from,
        t.to,
        t.at,
        t.reason,
        t.actor,
        t.shadow ? 1 : 0,
        t.tickId,
        JSON.stringify(t.evidence),
      ).changes;
    return added;
  }

  ledger(memberIds?: readonly string[]): Transition[] {
    if (memberIds !== undefined && memberIds.length === 0) return [];
    const rows =
      memberIds === undefined
        ? (this.db.prepare('SELECT * FROM transitions ORDER BY seq').all() as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM transitions WHERE member_id IN (${placeholders(memberIds.length)})
               ORDER BY seq`,
            )
            .all(...memberIds) as Row[]);
    return rows.map(toTransition);
  }

  /** false when an event with this id is already recorded. */
  insertEvent(e: Event): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO events (event_id, device_id, repo_id, session_id, tool_use_id, at,
             kind, tool_name, decision, source, permission_mode, matched_member_ids,
             decisive_member_ids, args_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.event_id,
          e.device_id,
          e.repo_id ?? null,
          e.session_id,
          e.tool_use_id ?? null,
          e.at,
          e.kind,
          e.tool_name ?? null,
          e.decision ?? null,
          e.source ?? null,
          e.permission_mode,
          JSON.stringify(e.matched_member_ids),
          JSON.stringify(e.decisive_member_ids),
          e.args_hash ?? null,
        ).changes > 0
    );
  }

  /** How often each member was matched and decisive (evidence counts, never arguments). */
  eventCounts(memberId: string): { matched: number; decisive: number } {
    const q = (col: string) =>
      Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM events, json_each(events.${col})
               WHERE json_each.value = ?`,
            )
            .get(memberId) as Row
        ).c,
      );
    return { matched: q('matched_member_ids'), decisive: q('decisive_member_ids') };
  }

  /** One row per device, repo, kind and hour; the first signal in the hour keeps its time. */
  addSignal(deviceId: string, repoId: string | null, kind: Signal['kind'], at: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO signals (device_id, repo_id, kind, bucket, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(deviceId, repoId ?? '', kind, Math.floor(at / HOUR), at);
  }

  signals(deviceId: string): SignalRow[] {
    return (
      this.db
        .prepare('SELECT repo_id, kind, at FROM signals WHERE device_id = ? ORDER BY at')
        .all(deviceId) as Row[]
    ).map((r) => ({
      repoId: r.repo_id === '' ? null : String(r.repo_id),
      kind: r.kind as Signal['kind'],
      at: Number(r.at),
    }));
  }

  session(id: string): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as
      | Row
      | undefined;
    if (r === undefined) return null;
    return {
      sessionId: String(r.session_id),
      cwd: String(r.cwd),
      cwdBasis: r.cwd_basis as SessionRow['cwdBasis'],
      repoRoot: r.repo_root === null ? null : String(r.repo_root),
      repoId: r.repo_id === null ? null : String(r.repo_id),
      trust: trustOf(r.trust),
      startedAt: Number(r.started_at),
      permissionRequest: bool(r.permission_request),
    };
  }

  /** First writer wins: a session keeps the directory it was first seen in. */
  addSession(s: SessionRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions
           (session_id, cwd, cwd_basis, repo_root, repo_id, trust, started_at, permission_request)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.sessionId,
        s.cwd,
        s.cwdBasis,
        s.repoRoot,
        s.repoId,
        trustText(s.trust),
        s.startedAt,
        s.permissionRequest ? 1 : 0,
      );
  }

  setPermissionRequest(id: string, pending: boolean): void {
    this.db
      .prepare('UPDATE sessions SET permission_request = ? WHERE session_id = ?')
      .run(pending ? 1 : 0, id);
  }

  /** Latest good snapshots for the device: user and managed, plus the repo's sources. */
  snapshots(deviceId: string, repoId: string | null): SettingsSnapshot[] {
    return (
      this.db
        .prepare(
          `SELECT body FROM snapshots WHERE device_id = ? AND (repo_id = '' OR repo_id = ?)
           ORDER BY scope, path`,
        )
        .all(deviceId, repoId ?? '') as Row[]
    ).map((r) => JSON.parse(String(r.body)) as SettingsSnapshot);
  }

  /** Every stored snapshot of the device, all repos. */
  allSnapshots(deviceId: string): SettingsSnapshot[] {
    return (
      this.db
        .prepare('SELECT body FROM snapshots WHERE device_id = ? ORDER BY source_key')
        .all(deviceId) as Row[]
    ).map((r) => JSON.parse(String(r.body)) as SettingsSnapshot);
  }

  /** Stored snapshot keys and hashes in one repo scope (null = the user and managed rows). */
  snapshotKeys(deviceId: string, repoId: string | null): { key: string; hash: string }[] {
    return (
      this.db
        .prepare(
          'SELECT source_key, content_hash FROM snapshots WHERE device_id = ? AND repo_id = ?',
        )
        .all(deviceId, repoId ?? '') as Row[]
    ).map((r) => ({ key: String(r.source_key), hash: String(r.content_hash) }));
  }

  putSnapshot(key: string, s: SettingsSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (source_key, device_id, scope, repo_id, path, taken_at, content_hash,
           body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_key) DO UPDATE SET taken_at = excluded.taken_at,
           content_hash = excluded.content_hash, body = excluded.body`,
      )
      .run(
        key,
        s.device_id,
        s.scope,
        s.scope === 'user' || s.scope === 'managed' ? '' : (s.repo_id ?? ''),
        s.path,
        s.taken_at,
        s.content_hash,
        JSON.stringify(s),
      );
  }

  deleteSnapshot(key: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE source_key = ?').run(key);
  }

  /** Claims `tickId`; false if that tick already ran (HANDOFF §7 idempotent ticks). */
  claimTick(tickId: string, at: number): boolean {
    return (
      this.db.prepare('INSERT OR IGNORE INTO ticks (tick_id, at) VALUES (?, ?)').run(tickId, at)
        .changes > 0
    );
  }
}
