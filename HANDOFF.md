# taper — Claude Code backend, org control plane, and dashboard
## Autonomous implementation handoff (v1.0, 2026-09-22)

**Consumer:** Claude Code (Opus 5.5), running unattended in the repo root.
**Owner:** Cory (`schmug`). Target repo: `schmug/taper`.
**Read this whole file before writing any code.** Then read `CLAUDE.md`. Then start Milestone 0.

---

## 0. What you are building, in one paragraph

taper is an enforcement-agnostic least-privilege *decay* engine. A **knob** is any named scope with a membership set and observable usage; **members** that go unused walk a guarded state machine (`active → stale_candidate → pending_removal → removed`, plus `restored`). This handoff makes **Claude Code's `settings.json` permission rules the first backend**: knobs are permission arrays in specific settings files, members are individual rule strings (`Bash(git:*)`, `WebFetch(domain:api.example.com)`, `mcp__github__create_issue`), and the usage signal comes from Claude Code's own hooks and OpenTelemetry events. You will ship (1) the core engine as a pure library, (2) a local agent/CLI that works fully offline for a single user, (3) a multi-tenant control plane on Cloudflare Workers + D1 for orgs, and (4) a dashboard fronted by Cloudflare Access. The Pomerium backend previously specified (handoff v2.1) is **deferred to backend #2**; nothing in `packages/core` may be Claude-Code-specific.

Why Claude Code first: a wrong removal degrades to a permission prompt, not a lockout; the signal is a first-class product feature (`claude_code.tool_decision`); managed settings give an admin-owned, tamper-resistant place to write machine-owned rules; and the install base is enormous. The research report `docs/research-claude-code-backend.md` has the citations — treat it as the fact base, and re-verify at M0 because Claude Code changes weekly.

---

## 1. Locked design principles (do not renegotiate)

| # | Principle | What it means for this codebase |
|---|-----------|--------------------------------|
| P1 | **Deterministic decisions.** Set math on timestamps decides what tightens. | `packages/core` has zero network, zero randomness, zero LLM. `evaluate()` is a pure function of `(state, events, now, config)`. Same inputs → same transitions, always. |
| P2 | **LLM only for prose.** | Narratives (explanations, PR descriptions, digest emails) come from a pluggable `NarrativeProvider`. Default is a deterministic template provider. An LLM provider is optional, off by default, and can never feed back into `evaluate()`. |
| P3 | **Per-knob modes.** `shadow` (default, recommend only) and `automatic`. | Shadow mode records what *would* transition and surfaces it; nothing is enforced. Automatic mode enforces via the backend's enforcement construct. Mode is a knob property, never global. |
| P4 | **Hysteresis.** Tighten slowly, restore instantly on any usage, cooldown after restore. | Any observed use of a member in any non-`removed` state → `active` immediately, `cooldown_until = now + cooldown`. During cooldown no tightening transitions occur for that member. |
| P5 | **Guards.** | Last-member guard (never ratchet a knob to zero unattended), protected knobs/members, new-member grace (staleness measured from `max(declared_at, last_seen_at)`), ledger maturity gate, dead-man's switch (ingest flatline freezes clocks; never mass-removes). All guards are implemented in core and tested by property tests. |
| P6 | **Machine changes never rewrite human-authored policy.** | taper never edits `permissions.allow/ask/deny` in any file a human wrote. Removal is a *separate, clearly machine-owned, reversible construct* (see §5). Human-file cleanup is emitted only as advisory diffs/PRs. |
| P7 | **Cheap re-grant is the political linchpin.** Verification strength is a pluggable ladder; admin-approval by default in orgs. | `RegrantVerifier` ladder: `SelfApprove` (solo default) → `AdminOnly` (org default) → `AccessIdentity` → `AccessIdentityPlusDevice` → `WebAuthn` (stretch, not v1). |
| P8 | **Android auto-reset is the reference prior art.** | Two tiers: reversible in-context re-grant (`pending_removal` prompts), then a harder tier (`removed` requires the ladder). Exemptions are requested by the subject, granted by the human. |

Claude-Code-specific corollaries (derived from the research, also locked):

- **C1 — Polarity.** Only `allow` arrays decay. `deny` and `ask` arrays are **protected by default**: their usage is invisible when they are doing their job, and decaying them loosens policy. They still appear in the dashboard, marked protected.
- **C2 — Read rules are low-confidence.** In-working-directory file reads may not emit a `tool_decision` at all. `Read(...)` members default to `protected: true` with a config flag to opt in.
- **C3 — Headless/CI knobs are shadow-only by default.** In `-p`/CI with no permission host, an `ask` becomes a denial, not a pause, so the cheap re-grant does not exist there. Knobs whose subject is a `--settings` file or a repo with a CI Claude Code workflow default to `shadow` and require explicit `automatic` opt-in with a warning.
- **C4 — Auto mode does not change the math.** Record `permission_mode` on every event. Usage under `auto` still counts as usage. Do not attempt to model the classifier.
- **C5 — Conservative attribution.** When a tool call matches multiple allow members (e.g., `Bash(git:*)` and `Bash(git status)`), refresh `last_seen_at` on **all** of them. Separately record the *decisive* member (first match in Claude Code's evaluation order) to drive a redundancy report. Never let attribution ambiguity cause a removal.

---

## 2. Repository layout and stack

Monorepo, TypeScript everywhere (the core must run identically in Node/Bun on a laptop and in a Cloudflare Worker), `pnpm` workspaces, strict TS, ESM.

```
taper/
  CLAUDE.md                      # invariants + working agreements for you (provided)
  HANDOFF.md                     # this file
  docs/
    research-claude-code-backend.md   # fact base (provided)
    claude-code-facts.md         # YOU write at M0: verified facts, versions, probe results
    decisions/ADR-NNNN-*.md      # YOU write: one per non-trivial choice
    SETUP.md                     # YOU write: human steps (Cloudflare account, Access app, secrets)
    STATUS.md                    # YOU write: per-milestone status; unverified probes listed at top
  packages/
    core/                        # pure engine: state machine, guards, ledger types, evaluate()
    backend-claude-code/         # rule parser/matcher, settings loader, event normalizer, enforcement writers
    agent/                       # `taper` CLI + hooks entrypoint + local SQLite + optional daemon
    shared/                      # API types (zod schemas), OTLP JSON types, constants
  apps/
    control-plane/               # Cloudflare Worker (Hono): ingest, evaluator cron, API, artifact generation
    dashboard/                   # Vite + React + Tailwind SPA, served as Worker static assets
  fixtures/
    settings/                    # settings-file combos for matcher tests
    otel/                        # recorded OTLP JSONL streams for replay tests
    hooks/                       # recorded hook stdin payloads
  scripts/
    probe-claude-code.ts         # M0 live probes against a real `claude` binary
    demo.ts                      # end-to-end demo with compressed clock
```

**Stack decisions (fixed):** Hono on Workers; D1 (SQLite) for durable state with versioned migrations; Queues for ingest buffering; Cron Triggers for evaluator ticks; R2 for raw-event archive (optional, off by default); Workers static assets for the dashboard; `jose` for Access JWT verification; `zod` for every boundary schema; `better-sqlite3` (Node) for the local agent ledger; `fast-check` for property tests; `vitest` + `@cloudflare/vitest-pool-workers` for Worker tests. No ORM beyond a thin typed query layer. No component library beyond Tailwind.

**Cloudflare Access is the only login system.** Do not build passwords, sessions, or OAuth. The dashboard and `/api/*` sit behind an Access application; the Worker verifies `Cf-Access-Jwt-Assertion` and maps `email` → user/roles. Ingest endpoints (`/ingest/*`, `/otlp/*`) use per-device bearer tokens minted at enrollment (optionally also gated by an Access service-token policy — document both in `SETUP.md`).

---

## 3. Domain model

### 3.1 Knobs for the Claude Code backend

A knob is identified by the **policy source** it represents, so usage aggregates correctly across people and machines:

| Knob kind | Subject | Backing file | Decayable by default | Notes |
|-----------|---------|--------------|----------------------|-------|
| `user` | `device_id` | `~/.claude/settings.json` | `allow` only | One per enrolled device. |
| `project` | `repo_id` (normalized git remote URL) | `.claude/settings.json` | `allow` only | **Shared across every device/user using that repo** — this is where org-level aggregation pays off. |
| `local` | `(device_id, repo_id)` | `.claude/settings.local.json` | `allow` only | Where Claude Code writes "Yes, and don't ask again" rules. Highest churn. |
| `managed` | `org_id` | managed-settings path(s) | **protected** | Admin policy. Decay only if an admin opts a specific managed knob in. |
| `cli` | `(repo_id, pipeline_id)` | `--settings` file / `--allowedTools` | shadow-only (C3) | Discovered from CI workflow files; `pipeline_id` = workflow path. |

Each knob has: `mode` (`shadow` | `automatic`), `protected`, `clock` (`wall` | `active_days`, see §4.3), `thresholds` (override of org defaults), `last_member_guard: true`.

### 3.2 Members

`member = (knob_id, rule)` where `rule` is the normalized rule string (whitespace-trimmed, tool name case preserved, specifier untouched). Same string in two knobs = two members. Fields: `declared_at` (first time seen in a snapshot), `first_seen_at`, `last_seen_at` (last attributed usage), `state`, `state_since`, `cooldown_until`, `restored_count`, `protected`, `source_line` (file + array index at last snapshot, for diffs).

`declared_at` for pre-existing rules at enrollment = enrollment time (new-member grace applies to everything on day one — this is intentional; it prevents an enrollment-day purge).

### 3.3 Events (normalized signal)

```
Event {
  event_id, org_id?, device_id, repo_id?, session_id, tool_use_id?,
  at, kind: 'tool_decision' | 'tool_result' | 'session_start' | 'session_end' | 'hook_registered' | 'snapshot',
  tool_name?, decision?: 'accept'|'reject', source?: 'config'|'hook'|'user_permanent'|'user_temporary'|'user_abort'|'user_reject',
  permission_mode?, matched_member_ids: string[], decisive_member_id?, args_hash?, raw_retained_until?
}
```

Raw tool arguments are needed only to run the matcher. **Match, then drop:** persist `matched_member_ids`, `decisive_member_id`, and a salted `args_hash`; retain raw args no longer than `raw_retention_hours` (default 0 in org mode, i.e., discard after matching in the ingest handler). Never enable `OTEL_LOG_USER_PROMPTS`.

### 3.4 Ledger

Append-only `transitions` table: `(member_id, from_state, to_state, at, reason_code, actor: system|user|admin, evidence_json, tick_id)`. Transitions are idempotent on `(member_id, from_state, to_state, tick_id)`. `explain(member)` is a deterministic walk of this ledger plus the current guard evaluation — no inference.

### 3.5 Org model (control plane)

`orgs → users (Access email) → org_members (role: owner|admin|member|viewer) → devices (enrolled, token_hash, platform, last_event_at) → repos`. Knobs belong to an org. Approvals table holds `regrant` requests and (in shadow mode) `removal` recommendations awaiting acceptance. A single control-plane deployment hosts many orgs; tenant isolation is a tested invariant.

---

## 4. The engine (`packages/core`)

### 4.1 State machine

```
active ──(unused ≥ T1)──▶ stale_candidate ──(unused ≥ T2)──▶ pending_removal ──(unused ≥ T3)──▶ removed
  ▲                             │                                  │                               │
  └───── any usage (instant) ───┴──────── any usage (instant) ─────┘                  regrant via ladder ──▶ restored ──▶ active (cooldown)
```

- "Unused for D" means `now − max(declared_at, last_seen_at) ≥ D` under the knob's clock.
- `restored` is a transient state recorded in the ledger, then the member is `active` with `cooldown_until` set.
- `removed` members are never auto-restored by usage; the enforcement construct blocks use, so usage can't be observed. They exit only via a `regrant` approval.

**Default thresholds (Claude Code profile, wall clock):** `T1 = 30d`, `T2 = 45d`, `T3 = 60d`, `cooldown = 14d`, `ledger_maturity = 14d`, `new_member_grace` implicit via `declared_at`. All overridable per org and per knob. (Android uses 90d for a much slower-changing surface; dev-tool allow-lists bloat faster and re-grant is cheaper, hence shorter.)

### 4.2 Guards (all enforced inside `evaluate()`)

| Guard | Rule |
|-------|------|
| Ledger maturity | No transition out of `active` for any member of a knob until the knob has had continuous ingest coverage for ≥ `ledger_maturity`. |
| New-member grace | Staleness clock starts at `max(declared_at, last_seen_at)`. |
| Last-member guard | A knob may not transition its last non-removed member to `removed` in `automatic` mode; it stops at `pending_removal` and raises an approval. |
| Protected | Protected knobs/members never leave `active` by system action. |
| Cooldown | No tightening transitions while `now < cooldown_until`. |
| Dead-man's switch | If a device (or knob's signal sources) has no `session_start`/`hook_registered` heartbeat for > `deadman_window` (default 7d) **or** heartbeats arrive but zero `tool_decision` events for > `deadman_window` while sessions exist (pipeline degraded), the clock for affected knobs **freezes** — stale time stops accruing — and the dashboard shows the knob as `frozen`. Freezing never causes a transition. |
| Mode | In `shadow`, every would-be transition beyond `active` is written to the ledger with `actor=system, shadow=true` and surfaced as a recommendation; the enforcement writer is never invoked. |

### 4.3 Clocks

`wall` (default, matches the locked principle) counts calendar time with dead-man freezing. `active_days` counts only days on which the knob's subject had at least one session — it makes vacations and dead pipelines a non-issue by construction. Implement both behind `Clock`; `wall` is default; write an ADR recommending whether `active_days` should become the default for `local` knobs after you have replay data.

### 4.4 API surface of core

```ts
evaluate(input: { knobs, members, coverage, now, config }): { transitions: Transition[]; recommendations: Recommendation[]; frozen: KnobId[] }
applyUsage(members, events): Member[]            // instant restore semantics, cooldown stamping
explain(member, ledger, now): Explanation         // deterministic, structured, renderable by NarrativeProvider
simulate(state, futureEvents, from, to, step): Timeline
```

Property tests must prove: monotone tightening (a member never skips a state), instant restore, cooldown blocks tightening, guards are total (no input causes a guard to be bypassed), determinism (same input → identical output across runs), and that `shadow` never yields an enforcement action.

---

## 5. The Claude Code backend (`packages/backend-claude-code`)

### 5.1 Rule parser and matcher

Implement Claude Code's rule semantics as a pure library with a fixture suite, then **verify against the real binary at M0** (see §9). Cover: bare tool names (`Bash`, `Edit`, `Write`, `Read`, `WebFetch`, `WebSearch`, `Agent`/`Task`), `Bash(prefix:*)` prefix form, the newer wildcard form, gitignore-style path specifiers for `Read/Edit/Write` (relative, `//absolute`, `~/home`, `**`), `WebFetch(domain:…)`, `mcp__server` and `mcp__server__tool`, compound shell commands (each subcommand evaluated), and the "specifier only, no tool" cases. Evaluation order deny → ask → allow, first match wins, specificity ignored, arrays merged across all files. Expose `match(effectivePolicy, toolCall) → { outcome, decisiveRule, allMatchingAllowRules }`.

Where the docs are ambiguous, the live probe result wins and gets a fixture + a line in `docs/claude-code-facts.md`.

### 5.2 Settings loader and snapshots

Discover and parse every scope on a device: managed (per-OS paths + `managed-settings.d/*.json`), user, project, local, plus `--settings` files referenced by CI workflow YAML. Emit a `SettingsSnapshot { device_id, repo_id?, scope, path, taken_at, content_hash, arrays: {allow, ask, deny}, hooks_present }`. Snapshots create/refresh members (new rule → `declared_at = taken_at`; vanished rule → member `retired` in ledger, not `removed`). Snapshot on `SessionStart`, `Stop`/`SessionEnd`, and on the agent's evaluate tick.

### 5.3 Signal ingestion — two paths, same normalizer

1. **Hooks (solo default, also available in org mode).** `taper hook <event>` reads stdin JSON, appends an `Event`, and — in `automatic` mode with `hook` enforcement — returns a permission decision. Register `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` (and `SessionEnd` if present). The hook must be fast (< 50 ms typical): local SQLite, no network on the hot path; org sync happens on the daemon/tick.
2. **OpenTelemetry (org default).** Managed settings' `env` block forces `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=<control-plane>/otlp`, `OTEL_LOG_TOOL_DETAILS=1`, and auth headers (`OTEL_EXPORTER_OTLP_HEADERS` or an `otelHeadersHelper` script the agent installs that mints a short-lived device token). The Worker's `/otlp/v1/logs` endpoint accepts OTLP/HTTP JSON and normalizes `claude_code.tool_decision`, `claude_code.tool_result`, session and hook-registration events into `Event`s. Also accept OTLP protobuf if cheap; otherwise document the JSON requirement.

Both paths converge in `normalize(raw) → Event[]` and then `attribute(event, effectivePolicyAtTime) → matched_member_ids`. Attribution needs the effective policy for that device+repo at event time → the ingest handler looks up the latest snapshot ≤ `event.at` (falls back to latest, flags `attribution_confidence: 'stale_snapshot'`).

`source: user_permanent` means Claude Code just wrote a new allow rule into `settings.local.json`; enqueue an immediate re-snapshot request for that device+repo so the new member exists with `declared_at ≈ now`.

### 5.4 Enforcement constructs (the machine-owned, reversible layer)

Two writers, selected per deployment. Neither ever touches a human-authored `permissions` array.

**A. `hook` enforcement (solo default).** The `PreToolUse` hook consults local state and returns:
- `pending_removal` member matched → `permissionDecision: "ask"` with reason `taper: "<rule>" unused for N days; approving restores it (cooldown 14d). Run \`taper explain "<rule>"\` for details.`
- `removed` member matched (and no other active allow member matches) → `permissionDecision: "deny"` with reason `taper: "<rule>" removed after N days unused. Re-grant: \`taper regrant "<rule>"\` or the dashboard.`
- otherwise → no decision (pass through).
Because hook decisions surface as `source: hook` in telemetry and a hook `ask` prompts the user in-context, this is a faithful Android tier-1. Approval at that prompt is observed by the hook chain as usage → instant restore (P4). The hook config lives under the `hooks` key of the user settings file; installing it is the one write `taper init` makes to that file, with explicit confirmation, and it is idempotent and removable (`taper uninstall`).

**B. `managed_rules` enforcement (org default).** The control plane generates a versioned artifact `50-taper.json` for each org:
```json
{ "permissions": { "ask": ["<pending_removal rules…>"], "deny": ["<removed rules…>"] },
  "hooks": { "SessionStart": [...], "PreToolUse": [...] } }
```
placed in the OS managed-settings drop-in directory by either an MDM/config-management push (artifact downloadable from the dashboard with a checksum) or the `taper agent sync` daemon running with the privileges required to write that path. Because `ask`/`deny` at any scope beat `allow` at any scope, the human's allow rule is untouched yet neutralized; removing the entry restores instantly. Managed placement is what makes the construct tamper-resistant against both the user and the agent — document this clearly in `SETUP.md`, including the fallback (hook enforcement, lower assurance) when no MDM exists.

**Advisory cleanup.** `taper recommend --format diff|pr` produces the human-file edit that *would* delete `removed` members from their original file, for a human to apply or merge. With a GitHub token configured it can open a PR against `.claude/settings.json` (stretch; behind a flag).

### 5.5 Re-grant ladder in Claude Code terms

| Level | Who/what approves | Where |
|-------|-------------------|-------|
| `SelfApprove` (solo default) | The user, in-context prompt (`pending_removal`) or `taper regrant` (`removed`) | Local |
| `AdminOnly` (org default) | Org admin clicks Approve | Dashboard approvals queue |
| `AccessIdentity` | The requesting user, authenticated by Access, self-approves for their own `user`/`local` knobs; admins still required for `project`/`managed` | Dashboard |
| `AccessIdentityPlusDevice` | As above plus the request must originate from an enrolled device token | Dashboard + agent |
| `WebAuthn` | Out of scope for v1; leave the interface slot. | — |

Requests are created automatically: a `PermissionDenied`-type hook event (or a denied `tool_decision` whose decisive rule is a taper `deny`) files a `regrant` request with the triggering call's hash — the request is made *in-context at the moment of need*, the grant is made by a human (P8).

---

## 6. Local agent (`packages/agent`) — the `taper` CLI

Package name `taperd`, binary `taper`. Works with **no network and no Cloudflare account** in solo mode. Local state in `~/.taper/state.db` (SQLite) plus `~/.taper/config.json`.

| Command | Behavior |
|---------|----------|
| `taper init` | Detect settings files, create local ledger, install hooks (confirm), take first snapshot, print what will happen and when. |
| `taper status [--json]` | Knobs → members → state, last seen, next transition ETA, frozen flag. |
| `taper explain "<rule>"` | Deterministic explanation from ledger + guards. |
| `taper regrant "<rule>"` | Runs the ladder; in solo mode restores immediately with cooldown. |
| `taper protect <rule\|knob>` / `unprotect` | Toggle protection. |
| `taper mode <knob> shadow\|automatic` | Per-knob mode with the C3 warning for `cli` knobs. |
| `taper recommend [--format text\|diff\|pr]` | Advisory human-file cleanup and redundancy report. |
| `taper simulate --days N` | Dry-run the clock forward; prints the timeline. Deterministic. |
| `taper hook <event>` | Hook entrypoint (stdin JSON → event; optional decision on stdout). |
| `taper snapshot` | Force a settings snapshot. |
| `taper enroll --org <url> --token <t>` | Join an org: store device token, switch signal path to OTel/managed per org policy, keep local ledger as a cache. |
| `taper sync` / `taper agent run` | Pull the org's machine-owned artifact and place it (requires privilege for managed paths); generate a launchd/systemd unit. |
| `taper otel serve` | Optional local OTLP receiver (alternative to hooks for users who already export OTel). |
| `taper uninstall` | Remove hooks and, with `--purge`, local state. |

Solo mode is the *same* engine and *same* backend as org mode; enrollment only changes where the ledger of record lives and which enforcement writer is active.

---

## 7. Control plane (`apps/control-plane`)

Hono Worker. Bindings: D1 `TAPER_DB`, Queue `taper-ingest`, Cron `*/15 * * * *` (evaluator tick), optional R2 `taper-archive`, static assets for the dashboard. Environment: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `TAPER_BOOTSTRAP_ADMIN_EMAIL`, `ARGS_HASH_SALT` (secret).

**Routes**
- `POST /otlp/v1/logs` — OTLP/HTTP; device bearer token; enqueue raw; 202.
- `POST /ingest/snapshot`, `POST /ingest/events` — agent-originated; device bearer token.
- `POST /enroll` — one-time enrollment code → device token (admin creates codes in dashboard).
- `GET /api/me`, `GET /api/orgs/:org/knobs`, `GET /api/knobs/:id`, `GET /api/members/:id/explain`, `GET /api/approvals`, `POST /api/approvals/:id/decide`, `POST /api/knobs/:id/mode`, `POST /api/members/:id/protect`, `GET /api/artifacts/managed-rules/latest`, `GET /api/health/ingest`, `GET /api/audit` — all behind Access; role-checked.
- `GET /api/stream` — SSE for live dashboard updates (nice-to-have).

**Pipelines**
- Queue consumer: `normalize → attribute → applyUsage → persist events (raw dropped) → mark ingest_health`.
- Cron evaluator: per org, load knobs/members/coverage → `core.evaluate()` → persist transitions → regenerate `managed-rules` artifact if changed (versioned, content-addressed) → create approvals for shadow recommendations and last-member-guard stops → emit notifications (webhook/email adapter interface; Slack webhook adapter is enough for v1).
- Ingest-health job: computes dead-man state per device and per knob.

**Auth**
- Access JWT: verify signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` = `ACCESS_AUD`, `exp`, then map `email` → user. First login by `TAPER_BOOTSTRAP_ADMIN_EMAIL` creates the org and the `owner`; subsequent users are `viewer` until an admin changes roles.
- Device tokens: random 256-bit, stored hashed, scoped to `(org, device)`, revocable in the dashboard.
- Tenant isolation: every query is org-scoped through a single helper; a test asserts no route can read across orgs.

**Determinism at the edge:** the Worker runs the *same* `core.evaluate()` as the local agent; `tick_id` = ISO minute of the cron run so reruns are idempotent.

---

## 8. Dashboard (`apps/dashboard`)

Vite + React + TypeScript + Tailwind, dense operator UI, light/dark, no marketing chrome. Data via `/api/*` with typed client generated from the zod schemas in `packages/shared`.

Screens (v1):
1. **Overview** — knobs by state (active / stale / pending / removed / frozen), transitions over time, ingest health summary, approvals count.
2. **Knobs** — filterable table (kind, subject, mode, protected, member counts by state); knob detail with members, `last_seen`, next-transition ETA, redundancy notes (shadowed members), and the machine-owned rules currently applied for this knob.
3. **Member detail** — the deterministic explanation (ledger walk + guard evaluation), evidence summary (counts, not raw commands), actions: protect, regrant, force re-snapshot.
4. **Approvals** — re-grant requests and shadow-mode recommendations; approve/reject with reason; shows verifier level used.
5. **Ingest health** — per device: last event, last session, hook registration, dead-man state; per knob: frozen/not.
6. **Artifacts** — current `50-taper.json` with version, checksum, diff from previous, download, and the MDM placement instructions.
7. **Settings** — org thresholds, clock, default modes per knob kind, retention, notification adapter, roles, enrollment codes, device tokens.
8. **Audit** — the ledger, filterable, exportable as JSONL.

The dashboard never shows raw tool arguments (they are not stored). Every state claim on screen links to its ledger evidence.

---

## 9. Milestones, acceptance criteria, and what "autonomous" means here

Work strictly in order. Each milestone ends with: tests green, an ADR for any non-obvious choice, `docs/` updated, a commit on `main` (or a branch + PR if a remote exists), and a one-paragraph status appended to `docs/STATUS.md`. Do not start the next milestone with known-red tests.

**M0 — Verify and scaffold (day 0).**
- Fetch the current Claude Code docs for permissions, settings, hooks, monitoring/OTel, and headless mode; record exact field names, env vars, file paths, and the Claude Code version you tested against in `docs/claude-code-facts.md`. Flag every divergence from `docs/research-claude-code-backend.md`.
- If a `claude` binary is available, run `scripts/probe-claude-code.ts` to confirm empirically: (a) an `ask` rule in one file overrides an `allow` for the same specifier in another, including via `--settings`; (b) `PreToolUse` hook `ask`/`deny` semantics and the exact stdin/stdout shapes; (c) which file "Yes, and don't ask again" writes to; (d) the `tool_decision` event attributes with `OTEL_LOG_TOOL_DETAILS=1` against a local OTLP receiver; (e) headless behavior of an `ask` with no permission host. Record results as fixtures. If no binary/API key is available, mark each probe `UNVERIFIED` and proceed — but list them at the top of `docs/STATUS.md` as blocking for M6.
- Scaffold the monorepo, CI (`pnpm lint && pnpm test`), and `.env.example`.
- **Done when:** facts doc exists, probes recorded or explicitly deferred, `pnpm test` runs (empty) green.

**M1 — Core engine.** Pure library with the state machine, all guards, both clocks, `explain`, `simulate`, and the property-test suite in §4.4. **Done when:** 100% branch coverage of `evaluate()`, property tests pass 10k runs, no imports outside the package.

**M2 — Claude Code matcher + settings loader.** §5.1–5.2 with fixtures; differential test job (`CLAUDE_CODE_DIFF_TESTS=1`) that runs the matcher's predictions against the real binary when available. **Done when:** every documented rule form has a fixture; differential job passes or is marked deferred with the M0 flag.

**M3 — Solo mode end to end.** `taper` CLI with hooks, local ledger, hook enforcement, `status/explain/regrant/simulate/recommend`. **Done when:** `scripts/demo.ts --solo` enrolls a temp `$HOME`, replays `fixtures/otel/*.jsonl` and hook payloads with a compressed clock, shows a member walk `active → pending_removal`, then a simulated approval restores it with cooldown — all deterministic and asserted in a test.

**M4 — Control plane.** §7 complete with D1 migrations, queue consumer, cron evaluator, artifact generation, Access auth, tenant isolation tests. **Done when:** Worker tests green; `wrangler dev` serves the API; replaying fixtures through `/otlp/v1/logs` yields the same transitions as M3's local run (cross-check test).

**M5 — Dashboard.** §8 screens against the live API; Access-gated. **Done when:** every screen renders against fixture data; approvals round-trip; artifact download works; no raw args anywhere.

**M6 — Org enforcement + ladder.** `managed_rules` writer, `taper enroll/sync/agent run`, MDM placement docs and downloadable artifact, `AdminOnly` and `AccessIdentity*` verifiers, in-context re-grant request creation. **Done when:** `scripts/demo.ts --org` runs two simulated devices sharing one repo, aggregates usage on the `project` knob, produces a `50-taper.json` containing a pending `ask`, an admin approval removes it, and ingest-health freezes a knob when one device's stream flatlines.

**M7 — Hardening and release.** Dead-man edge cases, redundancy report, notification adapter, `SETUP.md` for a fresh Cloudflare account (Workers, D1, Queues, Access app + service token policy), `README.md`, `CHANGELOG.md`, `npm publish --dry-run` for `taperd`, tagged `v0.1.0`.

**Definition of done for the whole handoff:** a fresh machine can `npm i -g taperd && taper init` and see its own allow-lists decay in shadow mode with zero infrastructure; an org admin following `SETUP.md` can deploy the control plane, enroll two devices, watch shared-repo usage aggregate, approve a re-grant from the dashboard, and download a managed-settings artifact — with every transition explainable from the ledger and no LLM in the loop.

---

## 10. Autonomy rules (how you operate in this repo)

- **Decide, record, proceed.** Any choice not fixed above is yours; write an ADR (≤ 1 page) and keep going. Do not stop to ask about library picks, naming, or UI layout.
- **Stop only for these:** you need a real Cloudflare account/Access team domain/AUD, a real API key for differential tests, or a GitHub token for the PR feature. In each case implement everything up to that boundary, mock it, and list the human step in `docs/SETUP.md` and `docs/STATUS.md`.
- **Never** edit a human-authored `permissions` array in any settings file, including test fixtures that represent human files. **Never** add an LLM call to `packages/core`, the queue consumer, or the evaluator. **Never** weaken a guard to make a test pass; fix the test's expectations only if the spec is wrong, and say so in the ADR.
- **Dogfood carefully.** You may install taper's hooks in the repo's own `.claude/settings.json` for testing, but only under a `TAPER_DOGFOOD=1` flag, and remove them in `taper uninstall` tests.
- **Facts drift.** If a live probe contradicts this handoff or the research doc, the probe wins; update `docs/claude-code-facts.md` and note the change in the relevant ADR. If a contradiction invalidates a locked corollary (C1–C5), stop and write the conflict into `docs/STATUS.md` rather than improvising a new principle.
- **Keep it small.** Prefer fewer packages, fewer dependencies, and boring code. Remove anything that exists only to look complete.

---

## 11. Open items intentionally left to you (write an ADR for each)

1. OTLP protobuf support in the Worker, or JSON-only with a documented requirement.
2. Whether `active_days` should become the default clock for `local` knobs (decide after replay data exists).
3. Notification adapter beyond a generic webhook (Slack first is fine).
4. Whether the dashboard uses SSE or polling for live updates.
5. Exact `deadman_window` default for `cli` knobs (pipelines may legitimately run weekly).
6. Whether `retired` members (rule vanished from the human file) should keep ledger history visible for 90 days or forever.

---

## 12. Fact-verification checklist for M0 (from the research doc; re-check live)

| Claim the design depends on | Where to verify |
|-----------------------------|-----------------|
| Permission arrays from all scopes **merge**; precedence deny → ask → allow, first match, specificity irrelevant | code.claude.com/docs/en/permissions, /settings |
| `--settings <file>` permission arrays merge into the effective policy | code.claude.com/docs/en/settings |
| Managed-settings paths per OS, `managed-settings.d/` drop-ins, MDM/registry delivery, server-managed settings | code.claude.com/docs/en/settings (enterprise/managed section) |
| "Yes, and don't ask again" writes an allow rule to `.claude/settings.local.json` at the repo root; not saved for file edits | code.claude.com/docs/en/permissions |
| Hook events, stdin fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`), and `hookSpecificOutput.permissionDecision` ∈ allow/deny/ask(/defer) | code.claude.com/docs/en/hooks |
| `claude_code.tool_decision` attributes: `decision`, `source` (config/hook/user_permanent/user_temporary/user_abort/user_reject), `tool_use_id`; `OTEL_LOG_TOOL_DETAILS=1` adds command/path detail; managed `env` can force telemetry and pin the collector | code.claude.com/docs/en/monitoring-usage |
| Transcripts at `~/.claude/projects/<slug>/*.jsonl`; `cleanupPeriodDays` default 30; `0` disables writing (do not use) | code.claude.com/docs/en/settings + changelog |
| Headless `-p`: an `ask` with no permission host is denied; `permission_denials` in `stream-json` | code.claude.com/docs/en/headless |
| `.claude/` is a protected path (writes auto-denied/prompted even in bypass) | code.claude.com/docs/en/permissions |
| Auto mode default on Pro/Max/Team since 2026-08-14; deny/ask still evaluated first; broad allow rules set aside under auto | anthropic.com blog + permission-modes reference |

End of handoff.
