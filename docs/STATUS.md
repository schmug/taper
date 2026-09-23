# STATUS

## Unverified (blocking where noted)

Probes a–e ran against Claude Code 2.1.278 on macOS and are recorded (`docs/claude-code-facts.md`
Part A, `fixtures/`). Still unverified:

| Item | Blocks | How to close |
|---|---|---|
| Managed settings on disk: `managed-settings.d/` merge, `first-wins` vs `merge` across sources, `managed_settings_resolved` with a real file source | **M6** | Probe on a machine/VM where writing `/Library/Application Support/ClaudeCode/` (or `/etc/claude-code/`) is acceptable. |
| Linux/Windows behavior and paths | M6, M7 | Run `pnpm probe` on Linux; Windows docs-only. |
| `source` for auto-mode classifier approvals; PermissionRequest under auto | M2 (attribution), M6 | Probe with `--permission-mode auto`. |
| Full rule-form matrix (`Task(...)` alias, wrappers, compound commands, path rules) | M2 | Differential job `CLAUDE_CODE_DIFF_TESTS=1`. |
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
`pnpm test` in core: 128 passing, 0 failing; coverage 100% statements/branches/functions/lines
over `packages/core/src` (194/194 branches), enforced by vitest thresholds. Nine fast-check
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
