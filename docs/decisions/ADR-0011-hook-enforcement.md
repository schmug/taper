# ADR-0011: Hook enforcement decision and the working directory

Status: accepted (M3, 2026-09-23). Code: `packages/backend-claude-code/src/hook-decision.ts`,
`packages/agent/src/{hook,hooks-config}.ts`. Spec: HANDOFF §5.4A.

## Decision

- **Only automatic knobs act.** Candidates come from core `enforcement()`: `pending_removal` →
  prompt, `removed` → block, automatic knobs only. A shadow knob, or a knob id listed with both
  modes, never yields a decision (invariant 7).
- **Deny** when a matched member is `removed` and the call needs it: the call's outcome is
  `allow`, and matching again without the removed members' rules is not `allow`. This is
  §5.4A's "no other active allow member matches", generalized:
  - a compound command is denied when another member covers only some of its parts;
  - a command the read-only built-ins allow with no rule (`ls`) passes;
  - a call that Claude Code would prompt for or deny anyway (a file redirect, `&`, a human
    `ask`/`deny` rule) passes, because the removed rule is not what allows it.
  - This is gentler than M6's managed `deny`, which blocks every call the rule matches.
- **Ask** when a matched member is `pending_removal`, as §5.4A says. Deny wins when both apply,
  so a tier-1 prompt cannot approve a part that needs a removed rule.
- **Approval is usage.** The approved call runs, so PostToolUse attributes it to every matching
  allow member (C5) and core `applyUsage` restores a pending member with a cooldown (P4). A
  `removed` member is never restored by usage (invariant 5).
- **Reasons** are §5.4A's texts. N is whole calendar days: for `ask`, since the staleness anchor;
  for `deny`, from the anchor to the removal. The rule is JSON-quoted, so the suggested command
  stays copyable. "or the dashboard" stays in solo mode until M6.
- **Working directory.** Matching is anchored at the directory the session started in
  (SessionStart `cwd`, ADR-0006). Whether a tool event's `cwd` follows a Bash `cd` is UNVERIFIED,
  so when it differs taper matches under both: attribution takes the union (over-refresh is the
  safe side, C5), and the decision takes the least restrictive of the two. A session first seen
  on a tool event uses that event's `cwd`.
- **Output and failure.** stdout gets exactly the JSON object, with no trailing newline (Claude
  Code parses stdout that starts with `{` and ends with `}`, facts doc B4). The hook always exits
  0. Any error (bad payload, locked database) is logged by class and passes the call through;
  a timed-out PreToolUse hook also fails open (facts doc B4).
- **Registration.** `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `PermissionRequest`, `Stop` and `SessionEnd`, in the handler shape the M0 probe used
  (`matcher: "*"` on tool events, `timeout: 10`, none on SessionEnd). The command is
  `'<node>' '<taper script>' hook <Event>` with absolute, single-quoted paths, recorded in
  `config.json` so `taper uninstall` removes exactly those handlers. A Node upgrade that moves
  the binary breaks the hook, which then fails open.

## Consequences

- Hook enforcement is lower assurance (HANDOFF §5.4A, ADR-0002 row 10): `bypassPermissions` and
  auto mode can edit `.claude/`, a project can set `disableAllHooks`, and `--bare` skips hooks.
  The dead-man guard freezes knobs whose hooks stop reporting; it cannot stop a bypass.
- Measured latency (`pnpm bench:hook`, Node 22.22.3, darwin-arm64, bundle): PreToolUse median
  43.9 ms (p90 45.2), with an evaluate tick 45.6 ms, PostToolUse 44.9 ms; bare `node -e 0` 17 ms.
