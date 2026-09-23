# SETUP — human steps

Steps an agent cannot do. Each names the milestone that needs it. Everything before that
boundary is implemented against mocks.

## Done

| Step | When |
|------|------|
| `github.com/schmug/taper` created, `main` pushed, CI green | 2026-09-22 |
| Default-branch ruleset requiring status check `check`; repo public | 2026-09-22 (see `docs/decisions/ADR-0003-merge-gate.md`) |

## Needed later

| # | Step | Needed by |
|---|------|-----------|
| 1 | Cloudflare account; `wrangler login` | M4 (`wrangler dev` works without it; deploy does not) |
| 2 | Cloudflare Access team domain + an Access application for the dashboard and `/api/*`; record its AUD | M4/M5 deploy |
| 3 | Optional Access service-token policy (`Action=Service Auth`) for `/ingest/*` and `/otlp/*` | M6 |
| 4 | GitHub token for `taper recommend --format pr` | M7 stretch |
| 5 | Go-ahead for a confirming rerun of the M2 differential job. The full job ran once on 2026-09-23 and cost $0.705 (ADR-0009). The rerun covers only the eight fixtures with open cases and costs about $0.32: `CLAUDE_CODE_DIFF_TESTS=1 TAPER_DIFF_ONLY=01-bare-tool-names,06-bash-legacy-colon,07-bash-compound,11-bash-read-only-builtins,12-read-edit-paths,15-path-negation,23-agent-task,27-inert-and-malformed pnpm --filter @taper/backend-claude-code exec vitest run test/differential.test.ts`. The sanitized report and streams are written to `~/.cache/taper-diff/`; copy them to `fixtures/differential/<date>/`. | Closes the M2 rule-matrix UNVERIFIED row |

## Environment variables

`.env.example` is not in the repo (see ADR-0001). Put local values in `.env` (scripts) or
`apps/control-plane/.dev.vars` (wrangler dev); both are gitignored.

| Variable | Used by | Meaning |
|----------|---------|---------|
| `ACCESS_TEAM_DOMAIN` | control plane | Access team domain, e.g. `myteam.cloudflareaccess.com`. JWT certs come from `https://<domain>/cdn-cgi/access/certs`. |
| `ACCESS_AUD` | control plane | Audience tag of the Access application. |
| `TAPER_BOOTSTRAP_ADMIN_EMAIL` | control plane | First Access login with this email creates the org and becomes `owner`. |
| `ARGS_HASH_SALT` | control plane (secret) | Salt for `args_hash`. 32+ random bytes, hex. Production: `wrangler secret put ARGS_HASH_SALT`. |
| `CLAUDE_CODE_DIFF_TESTS` | M2 differential tests | `1` runs matcher predictions against the real `claude` binary (spends tokens). Default off. |
| `TAPER_DIFF_MODEL` | differential tests | Model alias; default `haiku`. |
| `TAPER_DIFF_WORKDIR` | differential tests | Scratch repos, `report.json` and `streams/`; default `~/.cache/taper-diff`. |
| `TAPER_DIFF_ONLY` | differential tests | Comma-separated fixture stems (e.g. `07-bash-compound`) to run a subset. |
| `TAPER_PROBE_MODEL` | `pnpm probe` | Model alias for probes; default `haiku`. |
