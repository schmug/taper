# SETUP — human steps

Steps an agent cannot do. Each names the milestone that needs it. Everything before that
boundary is implemented against mocks.

## Needed now

| # | Step | Needed by | Why |
|---|------|-----------|-----|
| 1 | Create `github.com/schmug/taper` and `git remote add origin …`; push `main` | CI | `.github/workflows/ci.yml` exists but has never run. HANDOFF §9 switches milestone delivery to branch + PR once a remote exists. |
| 2 | Add required status check `check` on `main` (ruleset) | merge gate | Agent PRs self-merge only through a required check. |

## Needed later

| # | Step | Needed by |
|---|------|-----------|
| 3 | Cloudflare account; `wrangler login` | M4 (`wrangler dev` works without it; deploy does not) |
| 4 | Cloudflare Access team domain + an Access application for the dashboard and `/api/*`; record its AUD | M4/M5 deploy |
| 5 | Optional Access service-token policy (`Action=Service Auth`) for `/ingest/*` and `/otlp/*` | M6 |
| 6 | GitHub token for `taper recommend --format pr` | M7 stretch |

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
| `TAPER_PROBE_MODEL` | `pnpm probe` | Model alias for probes; default `haiku`. |
