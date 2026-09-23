# ADR-0007: Settings snapshots, knob mapping, and the event schema

Status: accepted (M2, 2026-09-23). Code: `packages/backend-claude-code/src/{settings,loader,knobs,event}.ts`.
Resolves ADR-0002 row 6.

## Decision

- **Package shape.** `@taper/backend-claude-code` exports only pure modules, so the Worker can
  import them (M4). The node-only loader is the `./loader` subpath. `test/boundary.test.ts` fails
  if any `src` file calls a file-writing API, or if a module other than `loader.ts` imports
  `node:`, reads `process`, or reads a clock or randomness.
- **Loader (read-only, invariant 3).** It reads managed `managed-settings.json` and
  `managed-settings.d/*.json` in merge order, the user file (`CLAUDE_CONFIG_DIR` aware), the
  project and local files, and `--settings` files found in `.github/workflows/*.y{a,}ml`. It
  also reads inline `--settings '<json>'` arguments. It does not read MDM plists, the registry,
  or server-managed settings (M6).
  - A missing fixed-path file yields an empty snapshot, so its members retire.
  - Invalid JSON, an unreadable file, a missing or oversized `--settings` file, or an
    unresolvable `${{ }}` argument yields an error and no snapshot. A half-written file then
    cannot retire members.
  - It also reports the workflows that invoke Claude Code, which are C3 subjects.
- **Snapshot shape.** HANDOFF §5.2 plus two optional fields: `pipeline_id` (the workflow path,
  needed by the `cli` knob id) and `inline`. Validated by zod, strict.
- **Knobs: one per (scope, subject, array).** Ids are URI-encoded parts joined by `:`, for
  example `local:<device>:<repo>:allow`. The allow, ask and deny arrays are separate knobs
  because the same rule string can sit in two arrays, and the last-member guard is per array.
  Managed files merge into one knob per array. `cli` knobs are per `(repo, workflow)`. Every
  array gets a plan even when it is empty, so vanished rules retire.
- **Defaults.** Every knob starts in `shadow` (P3). Deny and ask knobs, and all managed knobs,
  are protected (C1). Members that are `Read(...)` or bare `Read` are protected unless the
  `protectReadRules` flag is off (C2). Rules the matcher treats as inert are always protected
  (ADR-0006). A `cli` knob stays `shadow`, and M3's CLI requires the C3 opt-in before it may
  switch to `automatic`. The managed subject is the org id in org mode and the device id in
  solo mode.
- **taper's own artifact.** A managed-scope `managed-settings.d/50-taper.json` is included in
  the effective policy, so outcomes account for taper's `ask`/`deny`. It never becomes a knob or
  a member.
- **Event schema (ADR-0002 row 6).** HANDOFF §3.3 with two changes:
  - `permission_mode` is required and may be `unknown`. OTel `tool_decision`/`tool_result` and
    SessionStart/SessionEnd carry no mode, and `manual` is normalized to `default`.
  - `decisive_member_id` becomes `decisive_member_ids`, a set, per ADR-0006.
  - The schema is strict, so a raw-argument field fails validation (invariant 8).
  - It lives in this package because its enums are Claude Code's. M4 can re-export it from
    `@taper/shared`.
- **Mapping to core.** `session_start` → `session`, `tool_decision`/`tool_result` → `decision`,
  and every other kind → `heartbeat` (ADR-0005). An accepted decision or a result becomes a
  `UsageEvent` for every matched member. The event id is `tool_use_id`, so a decision and its
  result collapse into one event.

## Deferred

- Reading workspace trust from `~/.claude.json` (M3, ADR-0002 row 1).
- `--allowedTools`/`--disallowedTools` and the claude-code-action `settings:` input as `cli`
  sources (M3/M4).
- `allowManagedPermissionRulesOnly` and `disableAllHooks` in the effective policy (M6/M7).
- A local file that git tracks needs trust (facts doc B1). Not modeled.
- A workflow that disappears leaves its `cli` knob without a snapshot. M3 decides how to retire
  its members.
