# STATUS

## Unverified (blocking where noted)

Probes a–e ran against Claude Code 2.1.278 on macOS and are recorded (`docs/claude-code-facts.md`
Part A, `fixtures/`). Still unverified:

| Item | Blocks | How to close |
|---|---|---|
| Managed settings on disk: `managed-settings.d/` merge, `first-wins` vs `merge` across sources, `managed_settings_resolved` with a real file source | **M6** | Probe on a machine/VM where writing `/Library/Application Support/ClaudeCode/` (or `/etc/claude-code/`) is acceptable. |
| Linux/Windows behavior and paths | M6, M7 | Run `pnpm probe` on Linux; Windows docs-only. |
| `source` for auto-mode classifier approvals; PermissionRequest under auto | M6 (M2 attribution counts any `accept`, whatever the source: ADR-0007) | Probe with `--permission-mode auto`. |
| Rule-form matrix, remainder: path-rule and Agent denies, the `Task(...)` alias, asks inside compound commands, a bare `WebFetch` ask, and four cases added after the run. The 2026-09-23 run confirmed the rest (ADR-0006 table, ADR-0009) | M6: `50-taper.json` copies path, Agent and bare-name members into `ask`/`deny`, and needs them to take effect | Owner go-ahead for a rerun of fixtures 01, 06, 07, 11, 12, 15, 23, 27 (about $0.32). Then fix `observe()` from the saved streams. Every open case carries an `unverified` note. |
| `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` effect on customer OTel export | M7 | One probe each. |

## M0 — Verify and scaffold (2026-09-22)

**Done.** Docs re-verified (changelog head 2.1.280) and 13 live probe scenarios run against the
local 2.1.278 binary: cross-file `ask`/`deny` beats `allow` including via `--settings` (a),
PreToolUse `deny`/`ask` stdin/stdout shapes (b), "Yes, and don't ask again" writes a
space-wildcard prefix rule to `<git root>/.claude/settings.local.json` (c), OTLP/HTTP JSON
`tool_decision`/`tool_result` payloads captured (d), and headless asks are denied without a
`tool_decision` event (e). Facts in `docs/claude-code-facts.md`; divergences and their owning
milestones in ADR-0002. No C1–C5 contradiction. Scaffold: pnpm workspace with `@taper/core`,
`@taper/shared`, `@taper/backend-claude-code`, `taperd`; Biome, TS 7 strict, vitest per package,
CI workflow (ADR-0001).
**Deferred.** `apps/*` scaffolds to M4/M5. `.env.example` is blocked by the owner's global
`Read(.env.example)` deny; env vars live in `docs/SETUP.md`.
**Unverified.** See the table above. (Post-M0: repo `schmug/taper` created 2026-09-22; first CI run on `f134ec4` passed.)
**Next.** M1: core engine — state machine, guards, clocks, `explain`, `simulate`, property tests.
Prior art to consult (from `~/librarian`): `perplexityai-numbat` (hook+OTLP ingest → one event
model, shadow/enforce split), `netflix-repokid`/`aardvark` (unused-permission removal), and
`schmug-tdi-check` (Worker + D1 + fail-closed Access) for M4.

## M1 — Core engine (2026-09-22)

**Done.** `@taper/core` is a pure library: state machine `active → stale_candidate →
pending_removal → removed` plus ledger-only `restored` and snapshot-driven `retired`; guards
(protected, dead-man freeze, cooldown, ledger maturity, last-member, shadow) in one `assess()`
shared by `evaluate()` and `explain()`; `wall` and `active_days` clocks behind `Clock`;
`evaluate`, `applyTransitions` (idempotent), `applyUsage`, `regrant`, `applySnapshot`,
`enforcement`, `explain`, `simulate`. Semantics in ADR-0004, coverage/dead-man in ADR-0005.
`pnpm test` in core: 129 passing, 0 failing; coverage 100% statements/branches/functions/lines
over `packages/core/src` (196/196 branches), enforced by vitest thresholds. Nine fast-check
properties run 10,000 cases each (monotone tightening, guards total, cooldown, instant restore,
determinism under clone/freeze/permutation, shadow never enforces, idempotency,
explain/evaluate agreement, no skipped states over simulated time). Purity is enforced by
`test/boundary.test.ts` and `types: []`.
**Deferred.** HANDOFF §11 item 2 (`active_days` default for `local` knobs) until replay data
exists (M3/M4); §11 item 5 (`cli` dead-man window) to M7; §11 item 6 (`retired` history
retention) to M4; whether `taper protect` on a decayed member also re-grants it, to M3.
**Unverified.** Nothing in M1 depends on Claude Code facts. How Claude Code events map onto
core's `heartbeat`/`session`/`decision` signals is an M2/M4 question. A one-off mutation check
(11 guard mutants, each killed by a property) was run locally and not committed. fast-check
seeds vary per run; a failure prints its seed.
**Next.** M2: Claude Code rule matcher and settings loader (§5.1–5.2), fixtures per rule form,
differential job behind `CLAUDE_CODE_DIFF_TESTS=1`.

## M2 — Claude Code matcher and settings loader (2026-09-23)

**Done.** `@taper/backend-claude-code` has the following pieces.
- A rule parser and `match(policy, call) → { outcome, basis, decisiveRules, allMatchingAllowRules }`.
  It covers bare names, `Bash(x *)` / legacy `:*` / mid and leading wildcards, compound commands
  with subshells, `$()` and `for` bodies, wrapper and env stripping, the read-only Bash set,
  gitignore paths (`//`, `~/`, source-anchored `/`, `./`, `*`, `**`, `!`), the file-tool aliases,
  `WebFetch(domain:)`, MCP server and tool rules and globs, `Agent`/`Task`, parameter rules,
  `Skill`, `Monitor`, and workspace trust.
- The decisive tie-break (scope, source order, array index) and the compound decisive set
  (ADR-0006).
- A read-only settings loader: managed plus `.d/`, user, project, local, and `--settings` from CI
  workflows.
- A snapshot→knob mapping onto `core.applySnapshot`: one knob per scope, subject and array. It
  applies the C1–C3 defaults and never makes taper's `50-taper.json` a member.
- The event schema, with `permission_mode` required and `unknown` allowed, and the mapping onto
  core `Signal`/`UsageEvent` (ADR-0007).
- zod at the settings, snapshot, hook-stdin and event boundaries (`zod` 4.6.5, pinned).

Fixtures: 30 files in `fixtures/settings/`, one per rule form, 152 cases. The last full run
(`pnpm test`) gave core 129 passing and backend 502 passing, 0 failing, 24 skipped (the gated
differential sessions). `pnpm lint` and `pnpm typecheck` are clean. The loader read this
machine's real settings without error, and all 28 real rules parsed as modeled kinds.
**Deferred.**
- Trust from `~/.claude.json` (M3).
- `--allowedTools`/`--disallowedTools` and the action `settings:` input as `cli` sources.
- `allowManagedPermissionRulesOnly`/`disableAllHooks` in the policy.
- PowerShell, symlinks, Windows paths, and permission modes (ADR-0006/0007).
**Unverified.**
- The differential job (98 calls in 23 headless sessions) is built and gated behind
  `CLAUDE_CODE_DIFF_TESTS=1`, but it has not run. It spends model tokens (≈$0.50 on haiku,
  ADR-0008), so the rule-form matrix keeps its M0 flag. (It ran on 2026-09-23; see "M2
  differential results" below.)
- The stream parser it uses is tested against the ten recorded M0 streams.
**Next.** M3: the solo `taper` CLI, hooks, local ledger, hook enforcement, and trust read from
`~/.claude.json`.

## M2 differential results (2026-09-23)

**Done.** The differential job ran once with the owner's go-ahead against Claude Code 2.1.278
on haiku: 23 sessions, 98 calls, 13 mismatches, 0 not attempted, 0 timeouts, 218 s, $0.705.
The sanitized report is in `fixtures/differential/2026-09-23/`. From now on the runner also
saves each session's sanitized stream. Its writers refuse to write unless
`CLAUDE_CODE_DIFF_TESTS=1`. They drop thinking signatures, which embed the account's org UUID.
Facts are in `docs/claude-code-facts.md` A4. Dispositions and their C5 direction are in
ADR-0009.
**Changed.** Four matcher fixes, each written as a failing fixture first:
- a `&` operator makes the allow outcome `none` (`background`);
- an output redirect to a file does the same (`redirect`);
- `Bash(x:* more)` is `inert`, so it is protected;
- `WebSearch(x)` is read as bare `WebSearch`.

Allow attribution only widened or stayed the same. No guard and no human settings array
changed.

`pnpm test`: core 129 passing; backend 546 passing, 0 failing, 24 skipped (the gated sessions).
`pnpm lint` and `pnpm typecheck` are clean.
**Still UNVERIFIED.** Nine mismatches are suspected observer artifacts:
- five path denies and two Agent denies read as allowed, because the observer cannot see
  file-tool or Agent denials;
- a subshell ask and a bare `WebFetch` ask prompted, but not with reason type `rule`.

Each such case keeps `diff: true` and an `unverified` note. Four discriminator cases are new
and have not run. No C1–C5 contradiction was found.
**Next.** Get the owner's go-ahead for a rerun of fixtures 01, 06, 07, 11, 12, 15, 23 and 27
(about $0.32), then teach `observe()` the denial shapes from the saved streams. Separately:
the committed M0 streams in `fixtures/headless/` embed the org UUID inside thinking signatures.
The owner chose to scrub HEAD only, with no history rewrite, in a separate change. This change
does not touch `fixtures/headless/`.
