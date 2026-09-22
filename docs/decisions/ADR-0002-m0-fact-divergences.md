# ADR-0002: M0 fact divergences and where each is handled

Status: accepted (M0, 2026-09-22). Evidence: `docs/claude-code-facts.md` (Part A = probes on
Claude Code 2.1.278; Part B = docs at 2.1.280).

## Decision

No locked corollary (C1–C5) is contradicted, so work continues. C2 and C3 are strengthened; C4
and C5 need definitions, not changes. Each divergence below is assigned to the milestone that
must absorb it. None of them relaxes a guard.

| # | Fact (facts doc ref) | Disposition |
|---|---|---|
| 1 | `-p` in a never-trusted workspace ignores project `permissions.allow`; local and `--settings` allows still apply (A1 u0–u2) | **M2**: effective policy carries `workspaceTrusted: true\|false\|unknown`; the matcher drops project allows when `false`. `unknown` keeps them (over-refresh is the safe direction, C5). **M3**: snapshots record trust from `~/.claude.json` `projects[<path>].hasTrustDialogAccepted` (read that key only). |
| 2 | `source: user_permanent` is reported for every later use of a local rule in `-p`, not just when a rule is written; `ConfigChange` does not fire for Claude Code's own write (A2) | **M3/M4**: the re-snapshot request on `user_permanent` is idempotent (dedupe on device+repo+content_hash) and debounced. The hook path also re-snapshots after PermissionRequest→PostToolUse. |
| 3 | A headless `ask` that becomes a denial emits no `tool_decision` (A2) | No change: C3 already makes CI knobs shadow-only. Dead-man treats "sessions without tool_decision" as pipeline-degraded → freeze, never tighten. |
| 4 | `PermissionDenied` hook fires only for auto-mode classifier denials (B4) | **M6**: re-grant requests are filed by taper's own PreToolUse hook when it returns `deny` for a `removed` member (solo), and from `tool_decision reject` whose matcher-decisive rule is a taper-managed deny (org). |
| 5 | Managed sources are `first-wins` by default: `managed-settings.d/50-taper.json` is ignored when server-managed or MDM policy exists; an unparseable managed file stops Claude Code from starting (B3) | **M6**: writer is atomic (temp + rename) and schema-validated. SETUP documents `managedSourcesBehavior: "merge"` in the highest source, or delivering via that source. Control plane checks `managed_settings_resolved` (sources, `resolved_sha256`) to confirm the artifact is in force. |
| 6 | OTel `tool_decision`/`tool_result` carry no `permission_mode` (B5) | **M2** schema: `permission_mode` is `unknown` for OTel-sourced events unless reconstructed from `permission_mode_changed`. Hooks supply it. C4's math is unaffected. |
| 7 | Claude Code defines no order among matching allow rules; compound commands need an allow per subcommand (B2) | **M2** ADR: decisive tie-break = scope precedence (managed > cli > local > project > user), then array index; a compound command yields a decisive set. Refresh-all-matching is unchanged. |
| 8 | Space-wildcard `Bash(x *)` is primary, `:*` is legacy; `Write`/`NotebookEdit` use `Edit` rules; `Grep`/`Glob`/`LSP` use `Read` rules; wrapper stripping; built-in read-only Bash set (B2) | **M2** matcher + one fixture per form; differential job checks against the binary. |
| 9 | `tool_decision` has no path/URL; `tool_result.tool_input` has it (accepted calls only); `tool_result.decision_source` is absent for `config`; user MCP `tool_name` is `"mcp_tool"` (A2, B5) | **M4** normalizer joins decision+result on `tool_use_id` and takes the source from `tool_decision` only. |
| 10 | `bypassPermissions` allows `.claude/` writes; project settings can set `disableAllHooks`; `--bare` may become the `-p` default (B3, B4, B6) | Solo hook enforcement stays documented as lower assurance (HANDOFF §5.4). Hook absence is caught by the dead-man guard (freeze). |

## Consequences

- HANDOFF §12's "protected even in bypass" row and the research doc's Write-rule, Read-emission,
  and `cleanupPeriodDays: 0` claims are superseded by the facts doc.
- Managed-settings behavior on disk, auto-mode sources, and Linux/Windows remain UNVERIFIED
  (facts doc A3); M6 cannot close without a managed-settings probe on a machine where writing
  the managed path is acceptable.
