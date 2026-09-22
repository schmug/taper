# Research fact base: Applying taper to Claude Code's settings.json (compiled 2026-09-22)

> Status: point-in-time findings from Claude Code documentation, changelog, and community sources as of ~2026-09-22. Claude Code changes weekly. **Re-verify every claim marked with a source at Milestone 0** and record the result in `docs/claude-code-facts.md`. Where a live probe disagrees with this file, the probe wins.

## TL;DR
- Claude Code's permission engine merges `allow/ask/deny` arrays from all settings files and evaluates deny → ask → allow, first match wins, specificity irrelevant. An `ask` rule with the identical specifier in a *different* file overrides an `allow` — so taper can express `pending_removal` non-destructively by writing an `ask` rule into a separate machine-owned file. A wrong removal degrades to a permission prompt rather than a lockout.
- The usage signal is first-class: the OpenTelemetry `claude_code.tool_decision` event carries `decision` (accept/reject) and `source` (`config` / `user_permanent` / `user_temporary` / `user_abort` / `user_reject` / `hook`) plus `tool_use_id`, and enterprises can force telemetry on and pin the collector via managed settings — but the signal identifies the *tool call*, not *which allow rule matched*. taper must do rule attribution itself.
- Two hard caveats: (1) Claude Code's `auto` mode became the default on Pro/Max/Team on 2026-08-14 and uses an LLM classifier for runtime permission decisions; it does *not* prune rules. (2) A running agent can edit non-protected settings files via Bash/Edit, so taper's machine-owned file must live in managed settings (or a `--settings` file it cannot write) to be tamper-resistant.

## Key findings
1. The non-destructive "pending_removal" construct works: merged arrays + deny→ask→allow precedence mean a machine-owned `ask` (soft) or `deny` (hard) neutralizes a human `allow` without editing it.
2. Telemetry is rule-blind: `tool_decision`/`tool_result` OTel events, transcripts, and the Analytics Admin API record that a tool ran and whether config approved it, not which allow-rule string matched.
3. Re-grant is cheap and in-context (Android-analogous) — except headless: in `-p`/CI with no permission host, an `ask` becomes a denial.
4. Claude Code has no native rule expiry, pruning, or per-rule usage analytics. Only skills/CLAUDE.md context get "unused" pruning.
5. Managed settings (MDM plist / Windows registry / `/etc/claude-code/managed-settings.json` / server-managed from the console) give taper a tamper-proof, admin-owned place to write machine-managed rules and to force telemetry on.

## Section 1 — Permission model (as of Sept 2026)

**Arrays.** `permissions.allow` runs without prompting; `permissions.deny` blocks outright (applies even in `bypassPermissions`); `permissions.ask` forces a prompt. Unmatched actions fall to the active permission mode. (code.claude.com/docs/en/permissions)

**Precedence.** deny → ask → allow, first match wins, specificity does not change order. A broad deny (`Bash(aws *)`) blocks calls that also match a narrower allow; an allow cannot carve an exception out of a deny; the same holds between ask and allow. (code.claude.com/docs/en/permissions)

**Multiple files merge.** The allow/ask/deny arrays from every scope merge into one effective policy (most other keys take the highest scope's value; the three permission lists always merge). Docs ship a troubleshooting note for exactly this: "Yes, and don't ask again" saves an `allow` rule to the local file, and that allow does not outrank an `ask` from a project or managed file. (code.claude.com/docs/en/settings)

**Scopes, highest to lowest.**
1. Managed/enterprise: macOS `/Library/Application Support/ClaudeCode/managed-settings.json`; Linux/WSL `/etc/claude-code/managed-settings.json`; Windows `C:\Program Files\ClaudeCode\managed-settings.json` (legacy `C:\ProgramData\ClaudeCode` reportedly no longer read — version-dependent, verify). Also MDM (macOS `com.anthropic.claudecode` plist/mobileconfig; Windows registry `HKLM\SOFTWARE\Policies\ClaudeCode` value `Settings`), a `managed-settings.d/*.json` drop-in directory merged alphabetically, and server-managed settings pushed from the admin console (Team/Enterprise). Cannot be overridden by any lower level including command line.
2. Command line: `claude --settings <file-or-json>`; its permission arrays merge into the combined policy; sits below managed and above local/project/user.
3. Project local: `.claude/settings.local.json`, gitignored by default (Claude Code configures git to ignore it when created).
4. Shared project: `.claude/settings.json`.
5. User: `~/.claude/settings.json`.
A deny/ask at any level beats an allow at any level; `--allowedTools` cannot override a managed deny.

**Modes.** `permissions.defaultMode`: `default`/`manual`, `acceptEdits` (auto-approves file edits + `mkdir/touch/mv/cp/rm/sed` inside the working dir), `plan`, `dontAsk` (prompts become denials), `bypassPermissions`, `auto` (LLM classifier). `permissions.disableBypassPermissionsMode` and `permissions.disableAutoMode` (`"disable"`) lock modes out — most useful in managed settings. `permissions.additionalDirectories` extends file access. `permissions.allowManagedPermissionRulesOnly` makes managed settings the only rule source.

**Automated write path already exists.** "Yes, and don't ask again" on a Bash command or WebFetch domain writes a new allow rule into `.claude/settings.local.json` at the git repo root (resolved through worktrees; falls back to `.claude/settings.json` outside a repo, on Windows, when repo root is home, or on ownership-check failure). File-modification approvals are session-only, not saved. Compound commands save a rule per subcommand (up to 5). Generated path rules escape gitignore metacharacters. taper adds a decay counterpart to an existing growth path; it does not introduce machine co-authorship.

**Auto mode.** Research preview 2026-03-24; default for new sessions on Pro, Max, and Team since 2026-08-14 (Enterprise, Console API keys, Bedrock/AWS still start manual). A separate classifier reviews each action; reverts to manual after 3 consecutive or 20 total blocks in a session. Anthropic's rationale: users approved 97% of prompts; in a 1,053-person study humans caught 13.6% of planted dangerous commands vs 89% for the classifier. Under auto mode, broad allow rules granting arbitrary code execution (e.g., `python:*`) are set aside so they cannot bypass the classifier; deny and ask rules still run first. Auto mode decides per action at runtime and never prunes persisted rules. taper's machine-owned `ask`/`deny` rules remain authoritative under auto mode.

**No native expiry/review/pruning.** `/permissions` lists rules and source files; `/doctor` validates syntax; `cleanupPeriodDays` prunes transcripts, not rules. Anthropic guidance is qualitative least-privilege ("start with a strict deny list, add allow rules only as you build confidence"); third-party enterprise guides recommend manual monthly/quarterly reviews.

## Section 2 — Usage signal sources

**OpenTelemetry (primary).** `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus `OTEL_LOGS_EXPORTER=otlp` and/or `OTEL_METRICS_EXPORTER`. Event `claude_code.tool_decision` on every accept/reject with: `tool_name`, `tool_use_id` (correlates with hooks/transcripts/spans), `decision` ∈ accept|reject, `tool_source` ∈ builtin|mcp|sdk_host_builtin_mcp (v2.1.214+), `source` ∈ `config` (settings rules, managed policy, `--allowedTools`, mode, session grant, or inherently-safe — "does not indicate which of these matched"), `hook`, `user_permanent` (saved an allow rule), `user_temporary`, `user_abort`, `user_reject`. `tool_parameters`/`tool_input` only with `OTEL_LOG_TOOL_DETAILS=1` (`bash_command`/`full_command`, `file_path`, `mcp_server_name`/`mcp_tool_name`, …). `claude_code.tool_result` fires on completion with `decision_source` ∈ config|hook|user_permanent|user_temporary. `code_edit_tool.decision` metric counts Edit/Write/NotebookEdit outcomes. Distributed tracing (beta, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) adds `claude_code.tool.blocked_on_user` spans. Managed settings `env` block can force telemetry on and pin the collector; managed settings strip conflicting developer-set `OTEL_EXPORTER_OTLP_*` at startup (v2.1.217+). (code.claude.com/docs/en/monitoring-usage)

**Rule-attribution gap.** `source: config` confirms a settings rule (or mode/built-in safety) approved the call, not which rule string. With `OTEL_LOG_TOOL_DETAILS=1` the full command/path is present, so taper re-runs its own matcher to attribute.

**Hooks.** ~30 events (PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, SessionStart/End, Stop, SubagentStop, PreCompact, Notification, PermissionDenied, …). Common stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`; PreToolUse adds `tool_name`, `tool_input`, `tool_use_id`. PreToolUse may return `hookSpecificOutput.permissionDecision` ∈ allow|deny|ask|defer with `permissionDecisionReason` and optional `updatedInput`; surfaces as `source: hook`. Multiple hooks: most restrictive wins (deny > defer > ask > allow). A hook `allow` cannot override a deny/ask rule; a hook `deny`/exit-2 blocks even in bypass mode. Hook payloads do not identify the matched config rule. `hook_registered`/`hook_execution_*` OTel events let taper detect whether its hooks are still installed (dead-man input). (code.claude.com/docs/en/hooks)

**Transcripts.** `~/.claude/projects/<slug>/<session-uuid>.jsonl`, plaintext, tool_use blocks and results; join keys `tool_use_id`, `message.uuid`, `request_id`. Retention `cleanupPeriodDays` default 30, swept at startup by mtime. **`cleanupPeriodDays: 0` disables transcript writing entirely (bug #23710) — use a large value such as 3650.** taper must own a durable ledger independent of transcript retention. Managed settings can pin `cleanupPeriodDays`.

**Other.** `~/.claude/history.jsonl` (prompts); Analytics Admin API (`/v1/organizations/usage_report/claude_code`, daily aggregates by tool type, not by rule); `/permissions` UI; Agent SDK `canUseTool`; `--output-format stream-json` (`permission_denials`); `claude --debug`.

**Tamper/availability.** OTel: pinnable by managed settings and shipped off-box → most tamper-resistant, best for enterprise/CI. Transcripts and `history.jsonl`: local plaintext, agent-editable. Hooks: local, but presence is observable via `hook_registered`. All available headless except the interactive UI.

## Section 3 — Semantic fit

**Knobs.** One knob per (settings scope × array), members = rule strings. `pending_removal` = machine-owned `ask` with the identical specifier in a separate file (managed settings, `--settings`, or `settings.local.json`); `removed` = escalate to `deny` (or drop a fully machine-owned member). Human policy untouched, reversible by removing the machine entry.

**Visibility/polarity.** allow: observable via matching `source: config` calls (+ tool details). deny: only observable when something tries the denied action; decaying deny rules loosens policy → protect by default. ask: observable via prompt outcomes. Read in-workdir: may not emit `tool_decision` at all (inherently-safe path) → invisible usage → protect by default. Edits under `acceptEdits` remain visible (`source: config`).

**Re-grant.** Removing/shadowing an allow rule prompts in-context on next use (Bash, WebFetch, WebSearch, Edit/Write, MCP). In headless `-p`/CI with no permission host an `ask` becomes a denial (`--permission-prompts none` denies; TTY-less runs deny or hang, see issue #9026). Decay in CI must be shadow-only or human-gated, or pipeline `--allowedTools`/`--settings` must be updated in the same change.

**Last-member.** Empty vs absent `permissions.allow` are functionally equivalent (fall to mode). Blast radius is a prompt storm, not a lockout.

**Dead-man.** Watch for absence of `claude_code.session.count` / `hook_registered` at session start. Sessions arriving without `tool_decision` events or taper hooks → pipeline degraded → freeze clocks. Nothing at all → treat as inactivity → still freeze. `otelHeadersHelper` failures (in `/status`, `--debug`) are another break signal.

**Tampering.** Agents can modify non-protected settings via Edit/Write/Bash. `.claude/` and `.git/` are protected paths (writes auto-denied; in bypass mode a `.claude/` write prompts "Yes, and allow Claude to edit its own settings for this session"). `settings.local.json` is under `.claude/` but a bypass-mode agent with session approval could still edit it. Robust answer: machine-owned rules in managed settings (OS-protected from user and agent) or a `--settings` file outside the workspace.

## Section 4 — Prior art
- Claude Code rule tooling: browser settings builders/linters/simulators (e.g., `Claude-Settings-Simulator`, `claude-permissions-audit`), usage analytics (ccusage, OTel dashboards on SigNoz/Grafana/OpenObserve, Anthropic Analytics + Admin API). None decay or expire rules.
- Other agents: Cursor CLI `permissions.allow/deny` (`Shell()/Read()/Write()/WebFetch()/Mcp()`), Gemini CLI `autoApprovedTools` + TOML policy engine + Conseca pre-flight scan, Codex `--full-auto`/`--yolo` — no unused-permission decay anywhere. Gemini CLI CVSS-10 CI RCE (April 2026) via allowlist bypass under `--yolo` shows stale/over-broad allowlists are an active attack surface.
- Android auto-reset (confirmed): Android 11+ revokes permissions from apps unused ≥ 3 months (`auto_revoke_unused_threshold_millis2` = 90 days exactly), reverting to "unrequested" so the app must re-request in context. Android 12 added App Hibernation (second tier: revoke + clear caches + force-stop). Back-ported to Android 6–10 via Play services (Dec 2021–Q1 2022). Exemptions requested by the app, granted by the user; device-admin/policy-fixed permissions auto-exempt.

## Section 5 — Backend comparison (Claude Code vs Pomerium as first backend)
- Install base: Claude Code — run-rate >$2.5B and weekly actives doubled since 2026-01-01 per Anthropic's 2026-02-12 Series G announcement; enterprise > half of revenue; ~4% of public GitHub commits. Pomerium — smaller, ops-centric, deployed centrally via config/CRDs/console.
- Signal acquisition: Claude Code — many endpoints, standard OTLP, forceable by managed settings. Pomerium — few central proxies, bespoke mTLS log ingest.
- Write-back: Claude Code — JSON files / PRs / managed artifacts, diff-friendly. Pomerium — PPL YAML/CRDs/console, tied to a running control plane.
- Blast radius: Claude Code — wrong removal degrades to a prompt (interactive) or denial (headless). Pomerium — wrong removal locks a human out of an app. Decisive advantage for Claude Code as first backend.
- Admin locus: Pomerium — natural central plane. Claude Code — managed settings + team-shared `.claude/settings.json`; solo devs collapse admin to self.
- Redundancy risk: no evidence Anthropic is building per-rule usage analytics or expiry; auto mode and skill pruning are adjacent, not overlapping. Monitor the changelog.

## Recommendations carried into HANDOFF.md
Stage 1 shadow on a dev machine (OTel + transcripts, own matcher, protect deny/ask); Stage 2 non-destructive tightening via machine-owned `ask`/`deny` file; Stage 3 managed settings + forced telemetry + admin-approval ladder; headless/CI shadow-only; dead-man on heartbeat + hook registration.

## Caveats
Version volatility (features gated to v2.1.2xx); Windows managed path conflict; `source: config` is coarse; `cleanupPeriodDays: 0` footgun; auto mode sets aside broad allow rules at runtime; tamper trust depends on managed settings; adoption figures are point-in-time.
