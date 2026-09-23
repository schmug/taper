# ADR-0008: Differential job against the real binary

Status: accepted (M2, 2026-09-23). **Not yet run: it spends model tokens and needs the owner's
go-ahead.** Code: `packages/backend-claude-code/test/differential{,-runner}.ts`.

## Decision

- **Gate.** The sessions run only with `CLAUDE_CODE_DIFF_TESTS=1`. Without the flag, vitest
  reports them as skipped. The parts that need no model always run:
  - the gate itself;
  - the stream parser, tested against the ten recorded M0 streams in `fixtures/headless/`
    (allow, ask, deny, none, hook, and not attempted);
  - the scratch-repo setup.
- **Unit.** One headless session per fixture file that has `diff: true` cases: 23 sessions and
  98 calls. The model gets the calls as a numbered list of `tool` + exact JSON `input` and makes
  one call per turn. A call that the model never makes is reported as `not_attempted`, which
  counts as a mismatch. A call is never inferred.
- **Observation (facts doc A2).** Read per `tool_use_id`:
  - `tool_result_meta.non_execution_kind = permission-rule` → deny (`hook` if the result says
    `hook error`);
  - a `permission_denied` message with `decision_reason_type` `rule` → ask, `other` → none,
    `hook` → hook;
  - neither → allowed.
  Headless `-p` turns a prompt into a denial, so the job can tell ask from none but cannot show
  what a human would choose.
- **Isolation (same as the M0 probe).** Settings files are written only in local, project
  (never trusted, so only deny/ask apply) and `--settings` scope. It never writes user or
  managed settings. Flags: `--setting-sources project,local --strict-mcp-config
  --disable-slash-commands --tools <only the tools under test> --permission-mode manual
  --no-session-persistence`. `CLAUDE*`, `OTEL_*` and `ANTHROPIC_BASE_URL` are stripped from the
  environment. Telemetry stays off, and `OTEL_LOG_USER_PROMPTS` is never set.
  - Scratch repos live under `TAPER_DIFF_WORKDIR` (default `~/.cache/taper-diff/<fixture>`).
    They are recreated each run. `prepareSession` refuses any path outside that directory.
  - Claude Code adds each scratch path to `~/.claude.json` `projects`, as M0 did.
  - The owner's user-level hooks may still run (facts doc A2). The parser reports their
    decisions as `hook`, not as rule outcomes.
- **Excluded cases.** A case that would reach the network (allowed WebFetch, WebSearch), spawn a
  subagent (allowed Agent), need an MCP server, skill, language server or `watch`, or read the
  real home directory stays out of the job. Each such case records its reason in `diffNote`.

## Cost (estimate, from the M0 fixtures)

The recorded M0 sessions (`fixtures/headless/*.stream.jsonl`, `result.usage`) cost about 13.5k
input tokens per API request, almost all cache reads. `a0` was 2 requests: 8,186 cache-write,
19,060 cache-read and 282 output tokens, for $0.0197. That fits Haiku 4.5 at $1/M input, $2/M
1-hour cache write, $0.10/M cache read and $5/M output.

The job makes about 121 requests: 98 calls plus one closing turn per session. That is about
1.9M input tokens (≈95% cache reads) and about 30k output tokens, **≈ $0.50 (range $0.3–$1)**,
over about 25 minutes. This supersedes the facts doc's "~76k-token cached prefix per session".
The fixtures show about 27k per two-request session.

## Consequences

- Until the job runs, the rule-form matrix stays UNVERIFIED (docs/STATUS.md, M0 flag). Every
  choice in ADR-0006's open-choices table is a candidate mismatch.
- A mismatch means the fixture, the facts doc and possibly the matcher change together. Prefer
  the safe direction (C5) where Claude Code's behavior cannot be pinned down.
