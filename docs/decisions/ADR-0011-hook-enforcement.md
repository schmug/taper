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
- **Permission modes.** taper never blocks what deleting the rule would allow (from the
  M3 review). From the PreToolUse `permission_mode`:
  - `bypassPermissions` runs every call without a rule, so taper returns no decision.
  - `acceptEdits` approves file edits and `mkdir/touch/mv/cp/rm/sed` with no rule (research doc;
    UNVERIFIED, and its working-directory limit is ignored, the lenient side). Those calls get no
    decision. For a compound command, those commands count as covered on both sides of the
    "does the call need the removed rule" check.
  - `auto`, or a missing mode: without the rule the classifier would review the call, which it
    may allow. A removed rule therefore asks instead of denying, with the reason
    `taper: "<rule>" removed after N days unused; approving allows this call only. Re-grant: …`.
    Approving does not restore it (invariant 5).
  - `default`, `plan` and `dontAsk` follow §5.4A as written.
- **Approval is usage.** The approved call runs, so PostToolUse attributes it to every matching
  allow member (C5) and core `applyUsage` restores a pending member with a cooldown (P4). A
  `removed` member is never restored by usage (invariant 5).
- **Reasons** are §5.4A's texts, with one change: the suggested `taper explain`/`taper regrant`
  argument is single-quoted for the shell, so `$(…)`, backticks, `$VAR` and `!` in a rule never
  expand when it is pasted (§5.4A shows double quotes). N is whole calendar days: for `ask`, since
  the staleness anchor; for `deny`, from the anchor to the removal. "or the dashboard" stays in
  solo mode until M6.
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

- Known imprecision, recorded rather than fixed:
  - PreToolUse reads the stored snapshots. A rule the human deleted mid-session, or a project
    allow that an untrusted workspace ignores (`unknown` trust keeps it), can yield a deny where
    Claude Code would prompt, until the next Stop, SessionEnd or SessionStart re-snapshots.
  - A pending member asks even when another live rule allows the call, as §5.4A reads. Approval
    or plain use restores it either way.
  - In `dontAsk`, a hook `ask` becomes a denial (facts doc B0), so a pending member cannot be
    approved in context there. Deleting the rule would also deny, so this is not stricter.
  - Whether a prompt raised by taper's `ask` offers "Yes, and don't ask again" is UNVERIFIED (the
    M0 hook-ask probe was headless). If it does, it writes a new local allow rule. That is a new
    human-owned member with fresh grace; the removed member stays removed, but the call is then
    allowed without it.
  - Installing hooks re-serializes the settings file with its detected indent. Every value is
    unchanged (checked), but hand formatting can change.

- Hook enforcement is lower assurance (HANDOFF §5.4A, ADR-0002 row 10): `bypassPermissions` and
  auto mode can edit `.claude/`, a project can set `disableAllHooks`, and `--bare` skips hooks.
  The dead-man guard freezes knobs whose hooks stop reporting; it cannot stop a bypass.
- Measured latency (`pnpm bench:hook`, Node 22.22.3, darwin-arm64, bundle): PreToolUse median
  44.2 ms (p90 45.7), with an evaluate tick 46.0 ms, PostToolUse 45.3 ms; bare `node -e 0` 17 ms.
