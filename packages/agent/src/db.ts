// The local ledger: ~/.taper/state.db (HANDOFF §3.4, §6; ADR-0010). Versioned migrations keyed on
// `PRAGMA user_version`; each runs once, inside an immediate transaction, so two hook processes
// starting at once cannot both apply it. Raw tool arguments have no column anywhere (invariant 8).

import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ensurePrivateDir } from './fsutil.ts';

export type Db = Database.Database;

/** Append only. Never edit a shipped migration; add the next one. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE knobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('managed', 'cli', 'local', 'project', 'user')),
    polarity TEXT NOT NULL CHECK (polarity IN ('allow', 'ask', 'deny')),
    repo_id TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('shadow', 'automatic')),
    protected INTEGER NOT NULL,
    clock TEXT NOT NULL CHECK (clock IN ('wall', 'active_days')),
    thresholds TEXT
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    knob_id TEXT NOT NULL REFERENCES knobs (id),
    rule TEXT NOT NULL,
    declared_at INTEGER NOT NULL,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    last_restored_at INTEGER,
    state TEXT NOT NULL,
    state_since INTEGER NOT NULL,
    cooldown_until INTEGER,
    restored_count INTEGER NOT NULL,
    protected INTEGER NOT NULL,
    retired_from TEXT
  );
  CREATE INDEX members_knob ON members (knob_id);
  CREATE INDEX members_rule ON members (rule);
  -- Append-only ledger. Idempotent on (member, from, to, tick) (HANDOFF §3.4).
  CREATE TABLE transitions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    knob_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    shadow INTEGER NOT NULL,
    tick_id TEXT NOT NULL,
    evidence TEXT NOT NULL
  );
  CREATE UNIQUE INDEX transitions_idem
    ON transitions (member_id, IFNULL(from_state, ''), to_state, tick_id);
  CREATE INDEX transitions_member ON transitions (member_id);
  -- Normalized events (backend EventSchema). No raw arguments: match, then drop.
  CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    repo_id TEXT,
    session_id TEXT NOT NULL,
    tool_use_id TEXT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    tool_name TEXT,
    decision TEXT,
    source TEXT,
    permission_mode TEXT NOT NULL,
    matched_member_ids TEXT NOT NULL,
    decisive_member_ids TEXT NOT NULL,
    args_hash TEXT
  );
  -- Liveness for the dead-man guard (ADR-0005), at most one row per source, kind and hour.
  CREATE TABLE signals (
    device_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'session', 'decision')),
    bucket INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (device_id, repo_id, kind, bucket)
  ) WITHOUT ROWID;
  -- The directory a session started in anchors matching (ADR-0006, ADR-0011).
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    cwd_basis TEXT NOT NULL CHECK (cwd_basis IN ('session_start', 'first_event', 'replay')),
    repo_root TEXT,
    repo_id TEXT,
    trust TEXT NOT NULL CHECK (trust IN ('true', 'false', 'unknown')),
    started_at INTEGER NOT NULL,
    permission_request INTEGER NOT NULL DEFAULT 0
  );
  -- Latest good snapshot per settings source (HANDOFF §5.2).
  CREATE TABLE snapshots (
    source_key TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    path TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE ticks (
    tick_id TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
  -- Mode and protection changes, so every state shown is explainable (invariant 9).
  CREATE TABLE knob_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    knob_id TEXT NOT NULL,
    member_id TEXT,
    field TEXT NOT NULL CHECK (field IN ('mode', 'protected')),
    from_value TEXT NOT NULL,
    to_value TEXT NOT NULL,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('system', 'user', 'admin'))
  );
  CREATE INDEX knob_changes_knob ON knob_changes (knob_id);
  `,
];

export function migrate(db: Db): void {
  db.transaction(() => {
    const current = db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.pragma(`user_version = ${v + 1}`);
    }
  }).immediate();
}

export function openDb(path: string): Db {
  ensurePrivateDir(dirname(path));
  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
