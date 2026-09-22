# CLAUDE.md — taper

You are implementing `HANDOFF.md` autonomously. Read it fully at the start of every session, then `docs/STATUS.md` to find where you left off. Milestones are strictly ordered (M0 → M7); do not skip ahead with red tests.

## Invariants (violating any of these is a bug, not a judgment call)

1. `packages/core` is pure: no I/O, no network, no randomness, no LLM, no imports outside the package. `evaluate()` is deterministic.
2. No LLM call exists anywhere in a decision path (core, ingest normalizer, attribution, queue consumer, cron evaluator, hook decision). The only LLM touchpoint is the optional `NarrativeProvider`, off by default.
3. taper never edits a human-authored `permissions.allow/ask/deny` array in any settings file. Tightening is expressed only through the machine-owned construct: hook decisions (solo) or the generated `50-taper.json` managed artifact (org). Human-file cleanup is advisory output only.
4. Only `allow` arrays decay. `deny` and `ask` arrays, `managed` knobs, and `Read(...)` members are protected by default. `cli` knobs are shadow-only by default.
5. Usage restores instantly and stamps a cooldown; nothing tightens during cooldown. `removed` exits only via an approved re-grant.
6. Guards are total: ledger maturity, new-member grace, last-member, protected, cooldown, dead-man freeze. A guard is never relaxed to make a test pass.
7. Shadow mode never invokes an enforcement writer.
8. Raw tool arguments are used for matching and then discarded (default `raw_retention_hours = 0` in org mode). Never enable `OTEL_LOG_USER_PROMPTS`. The dashboard never displays raw arguments.
9. Every state shown anywhere is explainable by a deterministic ledger walk (`explain()`), and every route on the control plane is org-scoped through the single tenant helper.
10. Cloudflare Access is the only authentication for humans. Devices use hashed, revocable bearer tokens.

## Working agreements

- Decide, record (ADR in `docs/decisions/`, ≤ 1 page), proceed. Stop only for real credentials (Cloudflare account/Access AUD, API key for differential tests, GitHub token) — mock to the boundary and list the human step in `docs/SETUP.md` and `docs/STATUS.md`.
- Live probe results beat this repo's docs. When a probe contradicts `HANDOFF.md` or `docs/research-claude-code-backend.md`, update `docs/claude-code-facts.md` and cite it in the ADR. If a contradiction breaks a corollary C1–C5, write it to `docs/STATUS.md` and stop.
- Tests before features for core and matcher; fixtures for every rule form and every hook/OTel payload shape you rely on.
- Commit at the end of each milestone with a message `M<n>: <summary>`; append a paragraph to `docs/STATUS.md` (done, deferred, unverified, next).
- Prefer fewer packages, fewer dependencies, boring code. Delete anything that exists only to look complete.
- Dogfooding hooks into this repo's own `.claude/settings.json` is allowed only behind `TAPER_DOGFOOD=1` and must be removable by `taper uninstall`.

## Stack (fixed)

pnpm workspaces · TypeScript strict/ESM · Hono on Cloudflare Workers · D1 + versioned migrations · Queues · Cron Triggers · Workers static assets · `jose` (Access JWT) · `zod` (all boundaries) · `better-sqlite3` (agent) · `vitest` + `@cloudflare/vitest-pool-workers` · `fast-check` · Vite + React + Tailwind (dashboard, no component library).

## Commands

- `pnpm test` — all packages; must be green before any milestone commit.
- `pnpm lint` · `pnpm typecheck`
- `pnpm probe` — `scripts/probe-claude-code.ts` (requires a `claude` binary; results → `fixtures/` + `docs/claude-code-facts.md`)
- `pnpm demo:solo` / `pnpm demo:org` — end-to-end demos with a compressed clock (M3 / M6 acceptance)
- `pnpm dev:cp` — `wrangler dev` for the control plane · `pnpm dev:dash` — dashboard
