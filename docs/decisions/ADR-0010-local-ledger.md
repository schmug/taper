# ADR-0010: Local ledger, snapshots, coverage and the evaluate tick (solo mode)

Status: accepted (M3, 2026-09-23). Code: `packages/agent/src/{db,store,agent,hook,otel}.ts`.
Resolves ADR-0002 rows 1 and 2 and the ADR-0007 `cli` retirement deferral.

## Decision

- **Storage.** `~/.taper/state.db` through `better-sqlite3` 13.0.3 (pinned; its N-API prebuilds
  load with no install script, so `pnpm-workspace.yaml` lists it in `ignoredBuiltDependencies`).
  WAL, `busy_timeout` 5 s. Migrations are an append-only array keyed on `PRAGMA user_version`,
  applied in one immediate transaction. `~/.taper/` is 0700; `config.json` is 0600 and strict.
- **No raw arguments anywhere (invariant 8).** No column holds a tool input. Events are
  validated by the backend's strict `EventSchema`. `args_hash` = sha256(per-device salt, input).
  `raw_retention_hours` accepts only 0. The hook error log records the error class and code only,
  because messages can quote the payload.
- **Event ids** are `<kind>:<tool_use_id>`, so a hook `PostToolUse` and the OTel `tool_result` of
  the same call are one event, and a replay is a no-op.
- **Snapshots.** Latest good snapshot per source (`scope, repo, pipeline, path`). A source that
  fails to load keeps its last good snapshot, so its rules still attribute usage; a vanished
  drop-in or `--settings` file is dropped. Triggers: `init`, `status`, `snapshot`, SessionStart,
  Stop, SessionEnd, PermissionRequest→PostToolUse, and OTel `user_permanent`. PreToolUse never
  snapshots (latency).
- **Re-snapshot on `user_permanent` (row 2).** Keyed on device + repo + content hash of the
  local file: one file read, a full snapshot only when the hash changed. The hook path uses
  PermissionRequest→PostToolUse instead, and snapshots before attributing that call, so a rule
  "don't ask again" just wrote is declared and gets its first use.
- **`cli` knob retirement (ADR-0007).** A `cli` knob of the project with no snapshot this time
  retires its members, unless any `cli` source failed to load (a half-read CI config retires
  nothing).
- **Trust (row 1).** Read once per session from `~/.claude.json`: only
  `projects[<dir>].hasTrustDialogAccepted`, for the session directory and the repo root. Any
  `true` → trusted; every candidate an explicit `false` → untrusted; anything else `unknown`.
- **Project.** The git top-level of the session's start directory; outside git, a directory
  with `.claude/`. `$HOME` is never a project. `repo_id` = normalized origin URL (host
  lower-cased, userinfo, port and `.git` dropped), else `path:<root>`. Read from `.git` files,
  not by spawning git.
- **Coverage (ADR-0005 inputs).** Signals are deduplicated per device, repo, kind and hour.
  SessionStart and OTel `managed_settings_resolved` at startup → `session`. A `decision` means
  usage is observable, so only observations that carry arguments count: PostToolUse(Failure),
  and OTel tool events with tool details. PreToolUse, an OTel tool event without arguments,
  Stop, SessionEnd, PermissionRequest and `hook_registered` → `heartbeat`. If PostToolUse stops
  arriving, sessions without decisions freeze the knob (the review of this change showed that
  counting PreToolUse let a rule decay while its usage path was broken). User and managed knobs see every signal of
  the device since enrollment. Project and local knobs see only signals from sessions in their
  repo, so their wall clock freezes after `deadmanWindowDays` away from the repo. `cli` knobs
  see nothing locally and stay frozen.
- **Tick.** `evaluate()` with tick id `tick:<ISO minute>`, claimed in a `ticks` row inside the
  same transaction: at most one evaluation per minute however many hooks fire. It runs on every
  hook invocation and on `status`/`recommend`.
- **Local policy.** A session's effective policy is managed, user, project and local sources.
  `cli` sources (CI `--settings` files) are left out: they load only in that workflow's runs.
- **Knob changes.** Mode and protection changes are rows in `knob_changes` (who, when, from,
  to), added by migration 2, and `explain` lists them with the ledger (invariant 9).
- **Symlinked settings.** Atomic writes follow every symlink hop (a dangling target is
  created), refuse a loop, and replace only the final file, so a dotfiles link survives
  `taper init`. The file keeps its exact permission bits (chmod after write, past the umask).
- **Solo self-approval.** `regrant`, `protect` (ADR-0013) and a switch back to `shadow` (which
  lets usage withdraw a removal, ADR-0004) are user actions at the `SelfApprove` level.

## Deferred

- Retention: signals and events are never pruned yet. Signals must outlive T3 plus the dead-man
  window (ADR-0005). M4/M7 decide the horizon.
- Worktrees: the project root is the worktree's checkout, but Claude Code writes the local file
  at the main checkout's root (facts doc B6). New local rules there are not seen (never decay).
- `CLAUDE_CONFIG_DIR`: taper assumes `.claude.json` moves into it. UNVERIFIED.
- A changed origin URL gives the repo a new `repo_id`, and with it new project and local knobs.
  The new members start with fresh grace; the old ones keep their state and stop receiving
  signals, so they freeze. Nothing tightens.
- Which directory Claude Code treats as the project root when started in a subdirectory of a
  repo. taper uses the git top-level. UNVERIFIED.
