# Claude Code facts (verified at M0, 2026-09-22)

The fact base taper builds on. It supersedes `docs/research-claude-code-backend.md` wherever they
differ. **Live probes beat docs; docs beat the research doc.** Update this file whenever a probe
or the docs change a fact, and cite it from the relevant ADR.

- Binary probed: **Claude Code 2.1.278**, macOS (darwin arm64), model `haiku`, `--permission-mode manual`.
- Docs read: code.claude.com/docs/en/*.md, changelog head **2.1.280** (2026-09-22).
- Reproduce: `pnpm probe [scenario …]` (`scripts/probe-claude-code.ts`). Raw evidence:
  `fixtures/probe-results.json`, `fixtures/headless/*.stream.jsonl`, `fixtures/hooks/<scenario>/`,
  `fixtures/otel/*.jsonl` (sanitized). Differential runs of the matcher (ADR-0008) are recorded
  in `fixtures/differential/<date>/` (A4).
- Tags: **CONFIRMED** (matches research doc/HANDOFF) · **DIVERGED** (differs; says how) · **NEW**
  (not in research doc) · **UNVERIFIED** (docs silent and not probed).

Part A is probe evidence. Part B is the docs re-verification (not probed unless Part A says so).

---

# Part A — Probe results (Claude Code 2.1.278)

## A1. Scenario outcomes

| Scenario | Setup (all `-p` unless noted) | Observed | Tag |
|---|---|---|---|
| a0-allow-control | trusted; project allow `Bash(./probe.sh a)` | ran; `tool_decision accept/config` | CONFIRMED |
| a1-local-ask-over-project-allow | + local ask, same specifier | denied; stream `permission_denied` `decision_reason_type=rule`; **no `tool_decision`** | CONFIRMED (precedence) / NEW (no event) |
| a2-cli-ask-over-project-allow | + `--settings` file ask, same specifier | same as a1 | CONFIRMED (`--settings` merges) |
| a3-cli-deny-over-project-allow | + `--settings` file deny | denied; `tool_decision reject/config`; `decision_reason_type=rule` | CONFIRMED |
| u0-untrusted-project-allow | never-trusted workspace; project allow only | **allow ignored**; stderr `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted…`; denied (`decision_reason_type=other`) | NEW |
| u1-untrusted-local-allow | never-trusted; `settings.local.json` allow only | ran; `tool_decision accept/`**`user_permanent`** | NEW |
| u2-untrusted-cli-allow | never-trusted; `--settings` allow only | ran; `accept/config` | NEW |
| r0-read-in-workdir | no rules; `Read ./probe.sh` in cwd | ran; **`tool_decision accept/config` emitted**, no `tool_parameters`; `tool_result.tool_input.file_path` absolute | DIVERGED (research: "may not emit") |
| e0-headless-unmatched | no rules | denied immediately, no hang; `decision_reason_type=other`, message `This command requires approval`; no `tool_decision` | CONFIRMED (C3) |
| b0-hook-passthrough | project allow `Bash(./probe.sh:*)`; hook prints nothing | ran; `accept/config`; legacy `:*` form matched `./probe.sh b-pass` | CONFIRMED |
| b1-hook-deny | same; PreToolUse `permissionDecision: deny` | blocked; tool result `PreToolUse:Bash hook error: <reason>`; `tool_decision reject/hook`; in `permission_denials`; no `permission_denied` system message | CONFIRMED |
| b2-hook-ask | same; PreToolUse `permissionDecision: ask` | denied (no host); `decision_reason_type=hook`, message = hook's `permissionDecisionReason`; **no `tool_decision`**; `PermissionRequest` hook **did not fire** | CONFIRMED (C3) / NEW |
| c0-dont-ask-again | **interactive** (tmux); no rules; user picks option 2 | wrote `{"permissions":{"allow":["Bash(./probe.sh c *)"]}}` to `<git root>/.claude/settings.local.json`; `tool_decision accept/user_permanent`; `tool_result decision_source=user_permanent` | CONFIRMED (target file) / NEW (rule shape) |

## A2. Facts established by the probes

**Precedence and merging (probe a).** An identical-specifier `ask` in `settings.local.json` or in
a `--settings` file beats a project `allow`; a `--settings` `deny` does too. The machine-owned
`ask`/`deny` construct (HANDOFF §5.4) works. CONFIRMED.

**Workspace trust (probe u).** NEW. In `-p`, a never-trusted workspace ignores
`permissions.allow` from `.claude/settings.json` but honors allow from `settings.local.json` and
`--settings`. Interactive trust is recorded as `projects["<abs path>"].hasTrustDialogAccepted` in
`~/.claude.json`. The trust dialog lists the project's pre-approved allow rules and, when any
exist, **defaults to "No, exit"**. Consequence for taper: a `project` knob member is inert on any
device or CI runner where that repo is untrusted; matcher attribution there over-refreshes (safe
direction, C5).

**`source` values (probes a, u, c, r).**
- A `settings.local.json` allow match reports **`user_permanent`** in `-p` (u1); the docs say
  interactive sessions report `config` for later matches and `user_permanent` only for the choice
  itself. So `user_permanent` does **not** reliably mean "a rule was just written" (HANDOFF §5.3).
- A `--settings` deny reports `reject/config` (a3), not `user_reject`.
- In-workdir `Read` with no rule reports `accept/config` (r0) — indistinguishable from a rule
  match. C2 stands for this reason.

**Headless prompt denials are invisible to OTel logs (probes a1, a2, b2, e0, u0).** NEW. An `ask`
that `-p` auto-denies emits no `tool_decision`. The only record is the stream's
`{"type":"system","subtype":"permission_denied","tool_name","tool_use_id","decision_reason_type":"rule|hook|other","message"}`
and the result's `permission_denials: [{tool_name, tool_use_id, tool_input}]`
(`--output-format json` carries `permission_denials` too). `deny` matches (rule or hook) do emit
`tool_decision reject`.

**Hook I/O (probe b).**
- Stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny|ask","permissionDecisionReason":"…"}}` with exit 0 is honored against a matching allow rule. CONFIRMED.
- PreToolUse stdin keys: `session_id, prompt_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id`. Bash `tool_input` = `{command, description}`. `permission_mode` is `"default"` under `--permission-mode manual`.
- SessionStart: `session_id, transcript_path, cwd, hook_event_name, source:"startup"` — **no `permission_mode`**. SessionEnd adds `prompt_id, reason:"other"` in `-p`.
- `-p` sequence: SessionStart → PreToolUse → PostToolUse → Stop → SessionEnd. Interactive (c0): SessionStart → PreToolUse → **PermissionRequest** → PostToolUse → SessionEnd.
- PermissionRequest stdin: no `tool_use_id`; `permission_suggestions: [{type:"addRules", rules:[{toolName:"Bash", ruleContent:"./probe.sh c *"}], behavior:"allow", destination:"localSettings"}]`. It shows the exact rule "don't ask again" would write.
- **`ConfigChange` did not fire** when Claude Code wrote `settings.local.json` itself (c0). A re-snapshot trigger must use `user_permanent`/PermissionRequest+PostToolUse, not ConfigChange.
- Registration ≠ execution: with `--setting-sources project,local`, `hook_registered` still listed hooks with `hook_source=userSettings`, yet `hook_execution_complete` for `PreToolUse:Bash` counted `num_hooks=1` (project hook only). `hook_registered` alone cannot prove taper's hook runs.

**"Yes, and don't ask again" (probe c).** Option text `2. Yes, and don’t ask again for: ./probe.sh c *` (curly apostrophe). It saved a **space-wildcard prefix rule** `Bash(./probe.sh c *)`, not the exact command. Target: `<git root>/.claude/settings.local.json`, created if absent. CONFIRMED. Whether Claude Code adds that file to git ignores is **UNVERIFIED** here: the owner's global `~/.config/git/ignore` already ignores it, and Claude Code wrote neither `.gitignore` nor `.git/info/exclude`.

**OTLP wire shape (probe d).**
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` → `POST <endpoint>/v1/logs` and `/v1/metrics`, `content-type: application/json`.
- Resource attributes: `host.arch, os.type, os.version, service.name="claude-code", service.version="2.1.278"`. No `host.name`.
- Scope `com.anthropic.claude_code.events`. Log record `body.stringValue = "claude_code.<event>"`; attribute `event.name = "<event>"` (no prefix). Standard attributes on every event: `user.id, session.id, organization.id, user.email, user.account_uuid, user.account_id, terminal.type` (`"non-interactive"` for `-p`).
- `tool_decision`: `event.timestamp, event.sequence, prompt.id, decision, source, tool_name, tool_use_id, tool_source, tool_parameters`. Bash `tool_parameters` = JSON string `{"bash_command":"<first word>","full_command":"<command>"}`. Read has no `tool_parameters`.
- `tool_result`: `success, duration_ms, tool_parameters, tool_input` (JSON string), size fields. **`decision_source`/`decision_type` are absent when the source is `config`** (a0, b0, r0); present for `user_permanent` (c0). DIVERGED from docs.
- `user_prompt.prompt` and `assistant_response.response` are `"<REDACTED>"` (lengths only) with `OTEL_LOG_USER_PROMPTS` unset. Invariant 8 holds.
- Log events seen: `api_request, assistant_response, hook_execution_start, hook_execution_complete, hook_registered, managed_settings_resolved, mcp_server_connection, plugin_loaded, tool_decision, tool_result, user_prompt`. Metrics seen: `claude_code.session.count, active_time.total, cost.usage, token.usage`.
- `managed_settings_resolved` at startup: `managed_settings.trigger=startup`, `.sources=[]` (none on this machine), `.source_behavior="first-wins"`, `.helper.state="none"`.

**CLI (all probes).** `--permission-mode` choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` (`default` accepted as alias; reported as `"default"` everywhere). `--permission-prompts host|none` (default `host`); with no host, prompts are denied. The stream `init` message reports `permissionMode:"default"`.

**Probe mechanics worth keeping.** A nested `claude` must run with `CLAUDECODE`, `CLAUDE_*` and
`ANTHROPIC_BASE_URL` stripped from the environment. Each two-request Haiku session used about
27k input tokens, mostly cache reads: about $0.02 with a cold cache, $0.005 warm (the `result.usage`
lines in `fixtures/headless/`). An earlier "~76k-token prefix" figure is wrong; see ADR-0008.
`--setting-sources` does not fully isolate user hooks.

## A3. Not probed (UNVERIFIED)

| Item | Why not | Needed by |
|---|---|---|
| Managed settings on disk (`/Library/Application Support/ClaudeCode/`, `managed-settings.d/` merge, first-wins vs merge across sources) | needs root; would change the owner's machine | **M6** (org enforcement) |
| Linux/Windows paths and behavior | macOS only | M6/M7 |
| `source` for auto-mode classifier approvals; PermissionRequest under auto | docs silent; auto not exercised | M2 (attribution), M6 |
| `Task(...)` as alias of `Agent(...)`; path-rule and Agent denies; asks inside compound commands | The 2026-09-23 differential run (A4) could not observe them: the observer blind spot | a rerun with saved streams, then an `observe()` fix (ADR-0009) |
| Whether `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` suppress customer OTel export | docs silent | M7 (dead-man edge cases) |
| Interactive `user_temporary`/`user_reject`/`user_abort` sources | only option 2 was exercised | M3 fixtures (record when needed) |
| Whether a tool hook's `cwd` follows a Bash `cd` | every M0 call ran in the start directory | M3 matches under both and takes the least restrictive decision (ADR-0011) |
| Which directory is the project root when Claude Code starts in a subdirectory of a repo | not probed | M3 uses the git top-level (ADR-0010) |
| Whether `.claude.json` moves into `CLAUDE_CONFIG_DIR` | not probed | M3 assumes it does (ADR-0010); trust falls back to `unknown` if absent |
| Whether hook stdout with a trailing newline still parses as JSON | the probe hook wrote none | M3 writes none (ADR-0011) |

## A4. Differential run (2026-09-23, Claude Code 2.1.278)

This is the ADR-0008 job, run once with the owner's go-ahead: `CLAUDE_CODE_DIFF_TESTS=1`, haiku,
23 headless sessions, 98 calls, 218 s, $0.705. Evidence is in
`fixtures/differential/2026-09-23/report.json` (the raw streams were not kept). Dispositions are
in ADR-0009. Fixture numbers refer to `fixtures/settings/NN-*.json`.

- **DIVERGED: `:*` before more text.** The docs say the colon is literal in `Bash(x:* push)`.
  But `Bash(./probe.sh:* push)` did not allow `./probe.sh:x push`; it prompted (06). taper
  treats such rules as `inert`. Whether Claude Code skips the rule or rewrites `:*` to ` *` is
  UNVERIFIED. Trailing `:*` works as documented, including the bare command (06).
- **DIVERGED: a background `&` prompts.** `./probe.sh a 1 & ./probe.sh b 2` prompted even though
  an allow rule covered each part. The same shape joined by `&&`, `|`, or `2>&1 |` was allowed
  (07). The docs list `&` as an ordinary separator. A trailing `&` is UNVERIFIED.
- **NEW: a redirect to a file prompts despite a matching allow.** `ls > out.txt` prompted under
  `Bash(ls *)` (11). `echo hi > out.txt` with no rule also prompted, so a redirect is not in the
  read-only set. `2>&1` does not prompt (07). `/dev/null` is UNVERIFIED.
- **DIVERGED: `WebSearch(anything)`.** The docs say WebSearch takes a bare name only. But with
  `WebSearch(anything)` as the only WebSearch rule, a WebSearch call ran without a prompt (27).
  It is UNVERIFIED whether the specifier is ignored or WebSearch needs no permission at all.
- **NEW: ask reason types are not uniform.** A prompt caused by an ask rule reported
  `decision_reason_type: rule` in these cases:
  - single Bash commands (M0 a1/a2),
  - the tool-name glob `B*` (22),
  - `WebFetch(domain:*)` (20).

  In these cases the call prompted, but the reason type was **not** `rule`:
  - a bare `WebFetch` ask (01),
  - an ask on a command inside a subshell of a compound command (07).

  Which of these asks actually applied is UNVERIFIED. For M6, confirm that bare-name asks in a
  managed `50-taper.json` take effect.
- **NEW: Read, Write and Agent denies emit neither signal the observer reads.** These are
  `tool_result_meta.non_execution_kind` and the `permission_denied` message. Bash and WebFetch
  denies did emit them (07, 10, 11, 19, 24, 29).
  - Every path deny (12, 15) and Agent deny (23) came back looking allowed.
  - Two of those were Writes that no allow rule covered, and uncovered Writes in the same
    session prompted. So those two Writes were denied some other way, most likely by an input
    validation error.
  - The Agent session cost ($0.026) fits no subagent having run.
  - The exact shape is UNVERIFIED until a run saves its streams.
- **CONFIRMED by the run (matcher predictions held):**
  - Bash rule forms:
    - exact rules, with literal parentheses (03);
    - the space wildcard with its word boundary, and `*` with no space (04);
    - middle and leading wildcards, and the two-wildcard bare-form rule (05);
    - the trailing legacy `:*` (06);
    - `&&` and `|` needing every part, and deny inside `;`, `$()` and `for` (07);
    - wrapper stripping: `timeout`, `time`, `nice -n`, `nohup`, `command`, `stdbuf`,
      `noglob`, nested wrappers; `command -v` is not stripped (08);
    - `find -delete` needing an exact rule (09);
    - a safe env var before an allowed command, and deny past any assignment (10);
    - read-only built-ins, deny beating a built-in, and write-side VCS commands not being
      built-in (11).
  - Path rules:
    - `//abs`, and `/path` anchoring for local and `--settings` (12, 14);
    - a single-segment dir allow matching only at cwd (12);
    - a bare filename glob matching at any depth (12);
    - `*` staying within one segment, and `**` matching zero or more segments (12);
    - Write using Edit rules, and Read using Read rules (16);
    - `Write(path)` never being consulted (17).
  - WebFetch domain rules: a leading `*.` excludes the apex, a middle `*` matches one label,
    and a domain deny applies (19). A `WebFetch(domain:*)` ask beats a bare allow (20).
  - Tool-name globs: a `B*` ask covers Bash, and `*` in allow is skipped (22).
  - Parameter rules: `Agent(model:opus)` ask (23), a `run_in_background` deny, and
    `Bash(command:…)` being ignored (24).
  - Malformed rules are skipped (27).
  - Workspace trust: an untrusted project's allow is ignored, its deny still applies, and a
    local allow applies (29).

---

# Part B — Docs re-verification (code.claude.com, changelog head 2.1.280)

Compiled from the official docs on 2026-09-22 by a research pass; each item cites its page.
Items are docs claims only unless Part A covers them.

## B0. Corollary C1–C5 check (read first)

| Corollary | Verdict | Why |
|---|---|---|
| C1 polarity (only `allow` decays; deny/ask protected) | **Holds, strengthened** | An explicit `ask` rule is never auto-approved in any mode, including `bypassPermissions` and `auto`. A hook `allow` can't override an ask or deny rule. In `dontAsk` mode, an `ask` becomes a denial. (permission-modes#actions-no-mode-auto-approves, permissions#extend-permissions-with-hooks) |
| C2 Read is low-confidence | **Holds, strengthened** | OTel `tool_decision.tool_parameters` carries Bash, MCP, Skill and Agent details only, **not file paths**. Paths appear only in `tool_result.tool_input`, which fires for accepted calls and needs `OTEL_LOG_TOOL_DETAILS=1`. `Read(...)` rules also govern Grep, Glob and LSP, plus `@file` mentions, which fire no tool call and no hook. An `Edit(...)` allow also grants Read on the same path. The docs imply `tool_decision` *is* emitted for inherently safe calls (`source: "config"` includes "the tool is inherently safe"). Part A r0 confirms: `accept/config`. |
| C3 headless shadow-only | **Holds, strengthened** | A `-p` run with no permission host denies anything that would prompt. `--permission-prompts none` does the same explicitly (v2.1.259+). **NEW:** `dontAsk` mode, in any session, turns `ask` rules into denials. **NEW:** a `-p` or SDK run in a folder never trusted interactively (typical CI) **does not apply `permissions.allow` from project `.claude/settings.json` at all**. It prints "this workspace has not been trusted" to stderr. (permissions#what-runs-before-you-trust-a-folder) |
| C4 auto mode doesn't change the math; record `permission_mode` on every event | **Partial gap (data availability, not logic)** | Hook stdin carries `permission_mode` on tool events. **The OTel `tool_decision` and `tool_result` events carry no permission-mode attribute.** Mode is only in `claude_code.permission_mode_changed` (`from_mode`, `to_mode`, `trigger`). The session's starting mode isn't on any documented event, so the OTel path can reconstruct mode only partially and needs an `unknown` value. Two more facts: under auto mode Claude Code **drops** broad allow rules, and "allow rules have no effect in `bypassPermissions`". Which `source` a classifier-approved call reports is NOT-FOUND. Record this in an ADR; it doesn't require a stop. |
| C5 conservative attribution; "decisive = first match in Claude Code's evaluation order" | **Holds, but "decisive" is under-defined** | Claude Code defines order only across arrays (deny → ask → allow, first match, specificity ignored). No order among multiple matching allow rules is documented or observable, so taper must define a deterministic tie-break in an ADR. A compound command also needs **each subcommand** matched by some allow rule, which can mean several jointly decisive rules per call. "Refresh all matching" is unaffected. |

**No corollary is contradicted outright.** Two HANDOFF design points are threatened; details in §3 and §4:
- **§5.4B managed drop-in:** under the default `managedSourcesBehavior: "first-wins"`, a `managed-settings.d/50-taper.json` is **ignored** whenever server-managed settings or an MDM/HKLM policy delivers any policy key. A malformed drop-in makes Claude Code **refuse to start**.
- **§5.5 `PermissionDenied`:** the hook fires **only for auto-mode classifier denials**. It doesn't fire for deny-rule matches, hook denies, or manual "No".

---

## B1. Permission rules, precedence, merging

- **Evaluation order.** Deny → ask → allow, first match wins, specificity doesn't matter. An allow can't carve an exception out of a deny, and the same holds for ask vs allow. **CONFIRMED.** https://code.claude.com/docs/en/permissions#manage-permissions
- **Arrays merge across scopes.** List keys combine across files; `permissions.allow`, `ask` and `deny` merge. A deny at any level blocks an allow at any level. **CONFIRMED.** https://code.claude.com/docs/en/settings#lists-merge-instead-of-overriding, https://code.claude.com/docs/en/permissions#settings-precedence
- **Local allow vs higher ask.** The docs' troubleshooting note says an allow from "Yes, and don't ask again" in the local file doesn't outrank a project or managed `ask`. **CONFIRMED.** https://code.claude.com/docs/en/settings#permission-rules-combine-differently-than-you-expected
- **Scope order.** Managed > command line (`--settings`, flags) > local > project > user. **CONFIRMED.** https://code.claude.com/docs/en/settings#settings-precedence
- **Workspace trust gates project allow rules.** **NEW.** `permissions.allow` and `additionalDirectories` in project `.claude/settings.json` apply only after the folder is trusted. `-p` and SDK runs never show the trust dialog, so in a never-trusted folder those rules are unused. `deny` and `ask` apply immediately. `.claude/settings.local.json` applies without trust while it is untracked by git and `.claude` isn't a symlink. Manual trust: `projects["<path>"].hasTrustDialogAccepted=true` in `~/.claude.json`. https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
- **Bare-name deny removes the tool.** **NEW.** A bare `Bash` deny, or `Bash(*)`, removes the tool from Claude's context. A scoped deny leaves the tool available. `EndConversation` can't be denied or asked while any other tool remains. https://code.claude.com/docs/en/permissions#manage-permissions
- **`allowManagedPermissionRulesOnly` (managed-only).** Ignores allow/ask/deny from user, project, local and `--settings`. Ignores `--allowedTools`. Hides the "always allow" options and **stops saving new rules**. `--disallowedTools` and session deny/ask rules still apply. **CONFIRMED + NEW detail.** https://code.claude.com/docs/en/settings-reference#allowmanagedpermissionrulesonly
- **Invalid entries.** A malformed rule in a user, project or local file is skipped with a "Settings Warning" and the rest of the file applies. Invalid JSON rejects the whole file. **NEW.** https://code.claude.com/docs/en/settings#fix-a-broken-settings-file

## B2. Rule syntax forms (matcher fixtures)

Source for all of this section: https://code.claude.com/docs/en/permissions#permission-rule-syntax, https://code.claude.com/docs/en/tools-reference#configure-tools-with-permission-rules-and-hooks

Each form below has a matcher fixture in `fixtures/settings/`. Where the docs are silent, the
matcher's choice is listed in ADR-0006 as UNVERIFIED until the differential job runs.

- **Rule format.** `Tool` or `Tool(specifier)`. Parentheses inside a specifier are literal, so no escaping is needed. **CONFIRMED.**
- **Bare names.** `Bash`, `Read`, `WebFetch`, and so on match every use of the tool, and `Bash(*)` equals `Bash`. **CONFIRMED.**
- **Bash wildcard form.** The current form is `Bash(git *)`. `*` matches any text including spaces and can appear anywhere: `Bash(git * main)`, `Bash(* --version)`. **DIVERGED** from HANDOFF §5.1 wording: the primary form is now space + `*`.
  - A trailing ` *` also matches the bare command: `Bash(ls *)` matches `ls`. That holds only when the trailing `*` is the rule's only wildcard.
  - The space is significant: `Bash(ls *)` doesn't match `lsof`, but `Bash(ls*)` does.
  - **Legacy `:*`** is equivalent to a trailing ` *`, and only at the end of a pattern. In `Bash(git:* push)` the colon is literal. The permission dialog writes the **space form**. **DIVERGED (A4):** live, `:*` before more text did not match as a literal colon.
  - Startup warning for an allow rule with `*` before the subcommand.
- **Compound commands.** Separators are `&&`, `||`, `;`, `|`, `|&`, `&` and newline. **DIVERGED (A4):** live, a `&` makes the command prompt even when every part is allowed, and so does an output redirection to a file.
  - **Allow** requires each subcommand to be matched independently.
  - **Deny and ask** apply if *any* subcommand matches, including inside subshells, `$()`, and `for` bodies.
  - A trailing `&&` or `||` with nothing after it is unparseable, so allow rules don't match it.
  - **CONFIRMED + NEW detail.** https://code.claude.com/docs/en/permissions#compound-commands
- **Wrapper stripping.** **NEW, matcher must replicate.**
  - Before matching, Claude Code strips `timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, zsh `noglob`, and bare `xargs` (only when it has no flags).
  - It also strips leading assignments of *known-safe* env vars for allow rules. Deny and ask rules match past *any* leading assignment.
  - Not stripped: `command -v`, `nocorrect`, `direnv exec`, `npx`, `docker exec`, and similar runners.
  - `watch`, `setsid`, `ionice`, `flock`, and `find -exec`/`find -delete` can't be approved by prefix rules; they need exact matches.
  - https://code.claude.com/docs/en/permissions#process-wrappers
- **Built-in read-only Bash set.** **NEW, attribution impact.**
  - Runs without a rule in every mode: `ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, and read-only `git`.
  - An allow rule for these is never decisive, which matters for the redundancy report.
  - Commands over 10,000 characters always prompt.
  - https://code.claude.com/docs/en/permissions#read-only-commands
- **Parameter rules `Tool(param:value)`.** **NEW.**
  - Deny/ask only, built-in tools only, one top-level scalar parameter, `*` wildcard allowed. Examples: `Agent(model:opus)`, `Bash(run_in_background:true)`.
  - Primary content fields such as `Bash(command:…)` are ignored with a warning.
  - `mcp__` rules with parentheses are **skipped** when loaded from settings files; they work only in `--disallowedTools`.
  - https://code.claude.com/docs/en/permissions#match-by-input-parameter
- **Tool-name globs.** **NEW.**
  - Deny/ask accept globs such as `"*"` and `"mcp__*"`.
  - Allow accepts a glob only after a literal `mcp__<server>__`, as in `mcp__github__get_*`. `"*"`, `"B*"` and `"mcp__*"` in allow are skipped with a warning.
  - A deny/ask naming an unknown tool triggers a startup warning.
  - https://code.claude.com/docs/en/permissions#tool-name-wildcards
- **Read/Edit path specifiers (gitignore syntax).**
  - `//path` is absolute. `~/path` is relative to home. `/path` is relative to the **settings source**:
    - project or local settings: primary working dir
    - user settings: `~/.claude/`
    - `--settings <file>`: the file's directory
    - CLI/session rules: primary working dir
  - `path` and `./path` are relative to cwd. `*` matches within a segment, `**` across segments. A bare filename matches at any depth.
  - **CONFIRMED + DIVERGED detail:** `/path` in *user* settings anchors at `~/.claude`, not the project. https://code.claude.com/docs/en/permissions#read-and-edit
  - **NEW:** a single-segment relative dir such as `Edit(src/**)` matches only `<cwd>/src` as an **allow** rule, but any depth as a **deny/ask** rule.
  - **NEW:** `!` negation in deny/ask carves out only from earlier rules in the same source.
  - **NEW:** symlinks: allow needs both the link and its target to match; deny fires on either.
  - **NEW:** Windows paths are normalized to `/c/...`.
- **Write/NotebookEdit/Glob/MultiEdit path rules are never consulted.** **DIVERGED** (HANDOFF §5.1 lists `Read/Edit/Write` specifiers).
  - File permission checks use only `Edit(path)` and `Read(path)`.
  - `Edit` rules cover Edit, Write and NotebookEdit. `Read` rules cover Read, Grep, Glob and LSP.
  - A **bare** `Write` deny still matches at tool level.
  - A `Read` deny also blocks Edit and Write on the same path (v2.1.208 for edits, v2.1.228 for writes).
  - An `Edit(...)` allow also grants Read on that path.
  - https://code.claude.com/docs/en/permissions#read-and-edit, https://code.claude.com/docs/en/tools-reference#configure-tools-with-permission-rules-and-hooks
- **`WebFetch(domain:…)`.**
  - Matches the hostname, case-insensitive, and ignores a trailing dot.
  - `*.example.com` matches any subdomain depth but not the apex. A mid-pattern `*` matches only one label.
  - `WebFetch(domain:*)` ≠ bare `WebFetch`: they differ in sandbox allowlist effect and in deny semantics.
  - Wildcards need v2.1.172+.
  - **CONFIRMED + NEW detail.** https://code.claude.com/docs/en/permissions#webfetch
- **MCP.** `mcp__server` and `mcp__server__*` match all of a server's tools; `mcp__server__tool` matches one tool. Connector tools appear as `mcp__claude_ai_<server>__<tool>`. Plugin servers appear as `mcp__plugin_<plugin>_<server>__<tool>`. **CONFIRMED + NEW.** https://code.claude.com/docs/en/permissions#mcp, https://code.claude.com/docs/en/hooks#match-mcp-tools
- **`Agent(...)`.** `Agent(Explore)`, `Agent(my-custom-agent)`. `Task(...)` isn't mentioned in current permission docs; OTel still says "Agent tool or legacy Task tool". The changelog shows `Task(AgentName)` was the earlier syntax. Whether `Task(...)` is still accepted as an alias is **NOT-FOUND**, so probe it. Under auto mode, `Agent` allow rules are dropped. https://code.claude.com/docs/en/permissions#agent-subagents
- **`WebSearch`.** Bare name only; no specifier. **CONFIRMED** (docs). **DIVERGED (A4):** live, `WebSearch(anything)` in allow did not stop a WebSearch call from running. https://code.claude.com/docs/en/tools-reference#configure-tools-with-permission-rules-and-hooks
- **Other specifier tools.** **NEW.**
  - `Skill(name)` is an exact match; `Skill(name *)` is a prefix match. Deny also matches aliases and unqualified nested names.
  - `PowerShell(...)` uses the Bash-like shape, canonicalizes aliases, and matches case-insensitively.
  - `Monitor` uses `Bash(...)` rules.
  - `Cd(...)` governs `/cd` only and isn't model-invocable.
  - Every other tool (`ExitPlanMode`, etc.) takes a bare name only.
  - https://code.claude.com/docs/en/skills (line "Permission syntax: `Skill(name)`…"), https://code.claude.com/docs/en/permissions#powershell
- **Glob/Grep availability.** `Glob` and `Grep` are **absent by default on macOS, Linux and WSL**. **NEW.** https://code.claude.com/docs/en/tools-reference
- **Canonical names vs labels.** Rules and hook matchers match canonical names only, not transcript labels; for example, `TaskStop`, not "Stop Task". **NEW.**

## B3. Settings files, managed settings, CLI flags

- **Managed file paths.**
  - macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
  - Linux/WSL: `/etc/claude-code/managed-settings.json`
  - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`
  - Legacy `C:\ProgramData\ClaudeCode\managed-settings.json` is **not read**.
  - **CONFIRMED** (and the Windows ambiguity is resolved). https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy
- **MDM and registry.**
  - macOS plist domain `com.anthropic.claudecode`.
  - Windows `HKLM\SOFTWARE\Policies\ClaudeCode`, value `Settings` (`REG_SZ` or `REG_EXPAND_SZ`, JSON string).
  - **NEW:** user-writable fallback at `HKCU\SOFTWARE\Policies\ClaudeCode`, used only when no admin source delivers a policy key.
  - MDM and HKLM are polled every 30 min. Files reload on change. Server-managed settings are fetched at startup and hourly.
  - **CONFIRMED + NEW.** https://code.claude.com/docs/en/managed-settings#choose-a-delivery-mechanism
- **`managed-settings.d/`.** It sits next to `managed-settings.json`. Merge order is `managed-settings.json` first, then `*.json` alphabetically; hidden and non-`.json` files are ignored.
  - Scalars: the later file wins. Lists union and dedupe. Nested blocks such as `env` merge key by key.
  - **CONFIRMED + NEW merge rules.** https://code.claude.com/docs/en/managed-settings#split-a-file-based-policy-across-teams
- **Cross-source precedence inside the managed tier.** **DIVERGED, threatens HANDOFF §5.4B.**
  - Source ranking: remote (server-managed or gateway) > MDM (plist/HKLM) > files (`managed-settings.json` + `.d/`) > HKCU.
  - Under the default `managedSourcesBehavior: "first-wins"`, **only the highest source that delivers any policy key is used**. The rest are ignored, with no warning. `/status` shows `Skipped sources`.
  - Exception: a short list of cross-source keys, including `env`, which merges **per variable** (v2.1.223+).
  - The **telemetry unit** is all-or-nothing from the highest source that sets any of them: `OTEL_EXPORTER_OTLP_*`, `OTEL_LOG_*`, `OTEL_LOGS_EXPORTER`, beta tracing vars, and `otelHeadersHelper`.
  - **Consequence:** in an org that already uses claude.ai server-managed settings or an MDM Claude Code profile, taper's `50-taper.json` permissions and hooks **do not apply**. Its OTEL env is also dropped if the higher source sets any telemetry-unit key.
  - The fix is `managedSourcesBehavior: "merge"`, which the **highest** source must set (v2.1.242+). Under merge, lists union and locks take the strictest value.
  - https://code.claude.com/docs/en/managed-settings#how-claude-code-combines-managed-sources, https://code.claude.com/docs/en/server-managed-settings#per-key-exceptions-across-managed-sources
- **Unparseable managed files refuse startup.** **NEW, writer-safety constraint.** A managed file, drop-in, plist or HKLM value that isn't parseable JSON makes Claude Code **refuse to start** (v2.1.259+). An absent file is fine, and an empty file counts as `{}`. Individual invalid entries are skipped. `50-taper.json` writes must be atomic and schema-validated. https://code.claude.com/docs/en/managed-settings#find-entries-claude-code-dropped
- **Server-managed approval gate.** **NEW.**
  - Delivered hooks, `otelHeadersHelper`, and non-empty `OTEL_EXPORTER_OTLP_ENDPOINT`, proxy or base-URL env need a user approval dialog. Rejecting it exits Claude Code.
  - `-p` runs apply them for that run without approval.
  - The fetch requires a direct `api.anthropic.com` connection with an eligible credential. It is skipped when `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_USE_*` is set.
  - https://code.claude.com/docs/en/server-managed-settings#security-approval-dialogs
- **Other managed-only keys.** `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, `managedSourcesBehavior`, `policyHelper`, `strictPluginOnlyCustomization`, and more. **CONFIRMED + NEW.** https://code.claude.com/docs/en/managed-settings#keys-only-a-managed-source-can-set
- **`policyHelper`.** A managed-only executable whose emitted `managedSettings` becomes the **only** managed settings for the session. **NEW**; it's an alternative delivery path for taper's org artifact. https://code.claude.com/docs/en/settings-reference#policyhelper
- **Managed `env` can force telemetry and pin the collector.** **CONFIRMED.**
  - A managed `OTEL_EXPORTER_OTLP_ENDPOINT`, `_PROTOCOL` or `_HEADERS` removes conflicting developer-set per-signal variables (v2.1.217+).
  - **NEW:** the exporter selectors `OTEL_LOGS_EXPORTER` and `OTEL_METRICS_EXPORTER` follow normal per-key precedence, so set them in managed settings too.
  - Settings `env` overwrites shell exports.
  - https://code.claude.com/docs/en/monitoring-usage#how-managed-settings-lock-the-otlp-destination, https://code.claude.com/docs/en/settings-reference#env
- **`--settings <file-or-json>`.** Sits above user/project/local and below managed. List keys merge by the same rules, so its permission arrays merge. **CONFIRMED.**
  - **NEW:** a file must be a regular file of 2 MiB or less. `/path` rules in it anchor at the file's directory. It's ignored for permission rules under `allowManagedPermissionRulesOnly`.
  - https://code.claude.com/docs/en/settings#settings-precedence, https://code.claude.com/docs/en/cli-reference
- **`--setting-sources`.** Takes a comma list of `user`, `project`, `local`. Managed settings and `--settings` always load. **NEW.** https://code.claude.com/docs/en/cli-reference
- **`--allowedTools` / `--disallowedTools`.**
  - Both are session allow/deny rules in the same syntax.
  - A managed deny can't be overridden by `--allowedTools`.
  - A bare name in `--disallowedTools` removes the tool.
  - `--allowedTools` is ignored under `allowManagedPermissionRulesOnly`.
  - **CONFIRMED.** https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/permissions#settings-precedence
- **`--permission-mode`.** Local `--help` lists `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`; `default` is also accepted. It overrides `defaultMode`. `-p` starts in `default` when nothing is configured. **CONFIRMED.** https://code.claude.com/docs/en/cli-reference
- **`permissions.defaultMode` values.** `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, plus `manual` as an alias for `default` (v2.1.200+). **NEW:** `auto` and `bypassPermissions` are **ignored in project and local settings** (bypass since v2.1.257). https://code.claude.com/docs/en/settings-reference#permissions-defaultmode
- **Other flags.** **NEW.**
  - `--bare`: skips hooks, plugins, `.mcp.json` and CLAUDE.md, and doesn't run the retention sweep. The docs say it will become the `-p` default in a future release, **which would silently remove taper's hooks from `-p` runs**.
  - `--safe-mode`: disables non-managed hooks.
  - `--restricted`: loads only managed settings and `--settings`.
  - https://code.claude.com/docs/en/headless#start-faster-with-bare-mode, https://code.claude.com/docs/en/cli-reference

## B4. Hooks

- **Current event names (33).** `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`. **CONFIRMED** (the "~30" estimate) **+ NEW names.** https://code.claude.com/docs/en/hooks#hook-lifecycle
- **Config shape.** `hooks.<Event>[] = { matcher, hooks: [ handler… ] }`. **CONFIRMED + NEW fields.**
  - Handler `type` is one of `command`, `http`, `mcp_tool`, `prompt`, `agent`.
  - Common handler fields: `if` (one permission rule; tool events only), `timeout` (seconds), `statusMessage`, `once` (skills only).
  - Command handler fields: `command`, `args` (exec form, no shell), `async`, `asyncRewake`, `shell` (`bash` or `powershell`).
  - Matcher: `"*"`, `""` or omitted matches all. Letters, digits, `_`, `-`, space, `,` and `|` give exact or list match. Anything else is an unanchored JS regex. MCP matchers need `mcp__server__.*`.
  - Identical handlers across files run once, and all matching handlers run in parallel.
  - https://code.claude.com/docs/en/hooks#configuration
- **Timeout defaults.** **NEW** (the research doc doesn't cover them).
  - 600 s for `command`, `http` and `mcp_tool`; 30 s for `prompt`; 60 s for `agent`.
  - Lowered to 30 s on `UserPromptSubmit`, `PreModelSwitch` and `PostModelSwitch`, and 10 s on `MessageDisplay`.
  - **`SessionEnd` hooks share a 1.5 s budget**, raisable to 60 s via per-hook `timeout` or `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`.
  - A **timed-out PreToolUse command hook does not block**; the call continues through the normal permission flow (fail-open).
  - https://code.claude.com/docs/en/hooks#common-fields, https://code.claude.com/docs/en/hooks#timeouts
- **Common stdin fields.** `session_id`, `prompt_id` (v2.1.196+), `transcript_path`, `cwd`, `scratchpad_dir` (v2.1.257+), `permission_mode`, `effort` (`{level}`), `hook_event_name`. Subagent or `--agent` runs add `agent_id` and `agent_type`.
  - `permission_mode` ∈ `"default"|"plan"|"acceptEdits"|"auto"|"dontAsk"|"bypassPermissions"`. Manual mode arrives as `"default"`, never as `"manual"`.
  - **Not every event carries `permission_mode`**: the SessionStart and SessionEnd examples omit it.
  - **CONFIRMED + NEW fields.** https://code.claude.com/docs/en/hooks#common-input-fields
- **PreToolUse input.** Common fields + `tool_name`, `tool_input`, `tool_use_id`, plus `mcp_server {name, source}` for MCP tools (v2.1.274+).
  - `tool_input.file_path` for Read, Write and Edit is always **absolute** (`~` and relative paths expanded; native separators on Windows).
  - Bash `tool_input` fields: `command`, `description`, `timeout`, `run_in_background`.
  - WebFetch fields: `url`, `prompt`.
  - **CONFIRMED + NEW.** https://code.claude.com/docs/en/hooks#pretooluse-input
- **PreToolUse output.**
  - `hookSpecificOutput`: `{ hookEventName: "PreToolUse", permissionDecision: "allow"|"deny"|"ask"|"defer", permissionDecisionReason, updatedInput, additionalContext }`.
  - Reason visibility: for `allow` and `ask` the reason is shown to the **user, not Claude**; for `deny` it goes to Claude.
  - **`defer` is honored only in `-p`**; interactive sessions warn and ignore it.
  - Deny and ask rules are still evaluated whatever the hook returns.
  - A hook `ask` forces a prompt **even in auto mode** (v2.1.211+).
  - Exit 2 = deny.
  - **CONFIRMED + NEW.** https://code.claude.com/docs/en/hooks#pretooluse-decision-control
- **Multiple hooks.** `deny > defer > ask > allow`. **CONFIRMED.**
- **Exit codes.** **CONFIRMED + NEW.**
  - 0: success; stdout is parsed as JSON if it starts with `{` and ends with `}`.
  - 2: blocking, and JSON `allow` can't override it.
  - Any other code: non-blocking error and the action proceeds. **Exit 1 does not block.**
  - Invalid JSON or schema: non-blocking error.
  - https://code.claude.com/docs/en/hooks#exit-code-output
- **PermissionRequest.** Input: `tool_name`, `tool_input`, `permission_suggestions[]`, **with no `tool_use_id`**. It fires only when a prompt would show, or when a no-prompt session would auto-deny.
  - Output: `hookSpecificOutput.decision {behavior: allow|deny, updatedInput, updatedPermissions, message, interrupt}`. Exit 2 is ignored.
  - `updatedPermissions[].destination` ∈ `session|localSettings|projectSettings|userSettings`.
  - **NEW.** https://code.claude.com/docs/en/hooks#permissionrequest
- **PermissionDenied.** **DIVERGED** (HANDOFF §5.5 uses it as the re-grant trigger). It fires **only when auto mode denies**. It does *not* fire for deny-rule matches, PreToolUse hook blocks, or manual "No".
  - Input: `tool_name`, `tool_input`, `tool_use_id`, `reason`.
  - Output: `hookSpecificOutput.retry`.
  - https://code.claude.com/docs/en/hooks#permissiondenied
- **PostToolUse.** Input: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`, `mcp_server`. It fires only after success. **CONFIRMED.** https://code.claude.com/docs/en/hooks#posttooluse-input
- **PostToolUseFailure.** Fires when a tool that started executing fails. Input: `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt`, `duration_ms`. It doesn't fire for permission denials. **NEW:** taper should count it as usage, because the call was approved. https://code.claude.com/docs/en/hooks#posttoolusefailure
- **SessionStart.** Common fields + `source` ∈ `startup|resume|clear|compact|fork` + optional `model`, `agent_type`, `session_title`. It supports only `command` and `mcp_tool` handlers and runs in the background at launch. **CONFIRMED + NEW.** https://code.claude.com/docs/en/hooks#sessionstart-input
- **SessionEnd.** Common fields + `reason` ∈ `clear|resume|logout|prompt_input_exit|other`. `bypass_permissions_disabled` was removed in v2.1.234. It has a 1.5 s budget. **CONFIRMED (exists) + NEW.** https://code.claude.com/docs/en/hooks#sessionend
- **Stop.** Common fields + `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]`. It doesn't fire on user interrupt, and API errors fire `StopFailure` instead. **NEW.** https://code.claude.com/docs/en/hooks#stop
- **ConfigChange.** `source` ∈ `user_settings|project_settings|local_settings|policy_settings|skills`, + `file_path`. It fires on settings-file edits during a session, but not for server-managed, MDM or registry changes. **NEW:** it's a natural trigger for re-snapshotting after a `user_permanent` write to `settings.local.json`. https://code.claude.com/docs/en/hooks#configchange
- **Hook env.** Hooks inherit Claude Code's env **minus all `OTEL_*` exporter vars**. **NEW.** https://code.claude.com/docs/en/hooks#common-input-fields
- **`disableAllHooks` / `allowManagedHooksOnly`.** **NEW, tamper and deployment constraints.**
  - Outside managed settings, `disableAllHooks` disables user, project, local and plugin hooks but never managed hooks.
  - A **project `.claude/settings.json` can set `disableAllHooks: true` and switch off taper's user-level solo hooks.** So can `--settings '{"disableAllHooks":true}'`.
  - `allowManagedHooksOnly: true` (managed) blocks user, project and local hooks, so an org's taper hooks must live in managed settings.
  - `-p` runs execute project hooks even in untrusted folders.
  - https://code.claude.com/docs/en/settings-reference#disableallhooks, https://code.claude.com/docs/en/hooks#disable-or-remove-hooks
- **Hooks don't identify the matched config rule.** **CONFIRMED.**

## B5. OpenTelemetry

- **Exporter env vars.**
  - `CLAUDE_CODE_ENABLE_TELEMETRY=1` (required).
  - `OTEL_LOGS_EXPORTER` = `otlp|console|none`. `OTEL_METRICS_EXPORTER` = `otlp|prometheus|console|none`.
  - `OTEL_EXPORTER_OTLP_PROTOCOL` = `grpc|http/json|http/protobuf`. **There is no default protocol; it must be set.**
  - `OTEL_EXPORTER_OTLP_ENDPOINT`, per-signal `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and `_LOGS_PROTOCOL`, and `OTEL_EXPORTER_OTLP_HEADERS` (per-signal headers merge with it).
  - `OTEL_LOGS_EXPORT_INTERVAL` defaults to **5000 ms**; `OTEL_METRIC_EXPORT_INTERVAL` defaults to 60000 ms.
  - **http/json is supported for logs. CONFIRMED.** **NEW:** HTTP exports carry `Content-Length` rather than chunked encoding since v2.1.212, which suits a Workers endpoint.
  - https://code.claude.com/docs/en/monitoring-usage#common-configuration-variables
- **`otelHeadersHelper`.** A settings key valid in any file. It prints a JSON object of string headers.
  - Applies to http/json and http/protobuf only, not grpc.
  - Runs at startup and every 29 min by default (`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS`).
  - **On helper failure nothing is exported.** The failure shows in `/status`, the debug log, and stderr under `-p`. That makes it a dead-man signal.
  - Delivered via server-managed settings, it needs user approval.
  - **CONFIRMED + NEW.** https://code.claude.com/docs/en/monitoring-usage#dynamic-headers
- **Standard attributes (all events).**
  - `session.id`, `organization.id`, `user.account_uuid`, `user.account_id`, `user.id` (an anonymous per-install id in `~/.claude.json`), `user.email`, `terminal.type`.
  - Opt-in: `app.version` (`OTEL_METRICS_INCLUDE_VERSION`), `app.entrypoint` (`OTEL_METRICS_INCLUDE_ENTRYPOINT`).
  - `OTEL_RESOURCE_ATTRIBUTES` keys, which can't override built-ins except `vcs.*`.
  - **NEW:** `vcs.repository.url.full`, `vcs.owner.name`, `vcs.repository.name`, `vcs.provider.name` with `OTEL_METRICS_INCLUDE_REPOSITORY=true` (v2.1.269+). These give per-repo attribution from telemetry alone.
  - Events only: `prompt.id`, `event.name`, `event.timestamp`, `event.sequence` (per process, not per session), `workspace.host_paths`, `workflow.run_id`, `workflow.name`.
  - **CONFIRMED + NEW.** https://code.claude.com/docs/en/monitoring-usage#standard-attributes
- **`claude_code.tool_decision`.**
  - `tool_name`, `tool_use_id`, `decision` ∈ `accept|reject`, `tool_source` ∈ `builtin|mcp|sdk_host_builtin_mcp` (v2.1.214+).
  - `source` ∈ `config|hook|user_permanent|user_temporary|user_abort|user_reject`.
  - `tool_parameters`, a JSON string, only with `OTEL_LOG_TOOL_DETAILS=1`: Bash gives `bash_command`, `full_command` (untruncated), `timeout`, `description`, `dangerouslyDisableSandbox`; MCP gives `mcp_server_name`, `mcp_tool_name`; Skill gives `skill_name`; Agent/Task gives `subagent_type`.
  - **CONFIRMED core.**
  - **DIVERGED:** (a) `tool_decision` has **no `tool_input`, file path or URL**. Those are only on `tool_result.tool_input`. (b) For user-configured MCP servers, **`tool_name` is the literal `"mcp_tool"`**; the real names are only in `tool_parameters` with the flag.
  - **NEW `source` semantics.**
    - `config` covers settings rules including deny matches in personal settings, managed policy, CLI flags, mode, session grants, inherently-safe tools, and failed prompt requests.
    - `user_permanent` and `user_temporary` are emitted **only for the choice itself in the interactive CLI**; later matches report `config`. In `-p` or SDK runs, later matches keep reporting `user_permanent` or `user_temporary`.
    - In `-p`, personal deny-rule matches report `user_reject`.
  - https://code.claude.com/docs/en/monitoring-usage#tool-decision-event
- **`claude_code.tool_result`.**
  - `tool_name`, `tool_use_id`, `success` ("true"/"false"), `duration_ms`, `error_type`, `error` (with details flag), `decision_type` (always `"accept"`), `decision_source` ∈ `config|hook|user_permanent|user_temporary`.
  - `tool_input_size_bytes`, `tool_result_size_bytes`, `mcp_server_scope`.
  - With the details flag: `tool_parameters` and **`tool_input`** (JSON args; values over 512 chars truncated, total about 4K chars), plus `vcs.ref.head.*` on git commit.
  - It's not emitted for rejected calls.
  - **CONFIRMED + NEW.** https://code.claude.com/docs/en/monitoring-usage#tool-result-event
- **What `OTEL_LOG_TOOL_DETAILS=1` adds.** `tool_parameters` on decision and result, `tool_input` on result, `error`, real MCP, skill, plugin and workflow names, `hook_matcher` on `hook_registered`, and MCP `server_name`. **CONFIRMED + NEW scope.**
- **`OTEL_LOG_USER_PROMPTS`.** Default off; it gates `user_prompt.prompt`. `OTEL_LOG_ASSISTANT_RESPONSES` **falls back to `OTEL_LOG_USER_PROMPTS` when unset** (**NEW**). Invariant 8 is unaffected; keep both unset.
- **Session and hook-registration events.** **CONFIRMED (hook_registered exists) + NEW.**
  - `claude_code.hook_registered` fires once per configured hook at session start: `hook_event`, `hook_type`, `hook_source` ∈ `userSettings|projectSettings|localSettings|flagSettings|policySettings|pluginHook`, `safe_mode`, and `hook_matcher` with details.
  - **It doesn't carry the command, so taper can't be positively identified among several hooks on the same event and source.**
  - `claude_code.hook_execution_start` and `hook_execution_complete`: `hook_event`, `hook_name` (for example `"PreToolUse:Write"`), `num_hooks`, `num_success`, `num_blocking`, `num_non_blocking_error`, `num_cancelled`, `total_duration_ms`, `managed_only`, `hook_source` ∈ `policySettings|merged`.
  - `claude_code.session.count` is a **metric**, not a log event (attribute `start_type` ∈ `fresh|resume|continue|agents_view`), so it only arrives if metrics export is on. For a logs-only pipeline, use `hook_registered` or `managed_settings_resolved` as the session heartbeat.
  - https://code.claude.com/docs/en/monitoring-usage#hook-registered-event
- **Other relevant events.** **NEW.**
  - `claude_code.permission_mode_changed` (`from_mode`, `to_mode`, `trigger` ∈ `shift_tab|exit_plan_mode|auto_gate_denied|auto_opt_in`).
  - `claude_code.managed_settings_resolved` (v2.1.274+): `managed_settings.trigger` ∈ `startup|change|refused`, `managed_settings.sources[]` ∈ `remote|plist|hklm|file|parent|hkcu`, `managed_settings.source_behavior`, and helper state. With `OTEL_LOG_MANAGED_SETTINGS=1` it adds `managed_settings.resolved_sha256` and a redacted `managed_settings.settings` in which rules appear as `Read([REDACTED])`. This lets the control plane **verify that 50-taper.json is actually in force** and detect a skipped `file` source.
  - `claude_code.retention_sweep` (v2.1.227+): `result`, `period_days`, `transcripts_deleted`, and more.
  - `claude_code.user_prompt`, `assistant_response`, `api_request`, `api_error`, `api_refusal`, `api_retries_exhausted`, `auth`, `mcp_server_connection`, `internal_error`, `plugin_installed`, `plugin_loaded`, `skill_activated`, `at_mention`, `hook_plugin_metrics`, `compaction`, `subagent_completed`, `feedback_survey`, `api_request_body`, `api_response_body`.
- **Traces.** Tracing requires `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER`. `ENABLE_BETA_TRACING_DETAILED` and `BETA_TRACING_ENDPOINT` are a separate detailed mode. **CONFIRMED**; taper doesn't need traces. https://code.claude.com/docs/en/monitoring-usage#traces-beta
- **OTLP log-record wire shape.** The docs don't say whether the log record *body* holds `claude_code.tool_decision` or whether only the `event.name` attribute does. **NOT-FOUND**; the probe must capture a real payload.
- **`DISABLE_TELEMETRY` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.** The docs describe them as affecting Anthropic operational telemetry. Whether they suppress the customer OTel export is **NOT-FOUND**, so probe it. That matters for the dead-man signal.

## B6. "Yes, and don't ask again" and protected paths

- **Write target.** The rule is written to `.claude/settings.local.json` at the **git repository root**; for worktrees, the main checkout's root (v2.1.211+). **CONFIRMED.**
  - The fallback location is **DIVERGED** from the research doc. Outside a repo, when the repo root is `$HOME`, on Windows, or when the ownership check fails, the *local file* stays in the starting directory's `.claude/`, next to `settings.json`. The rule is **not** written into `.claude/settings.json`.
  - **NEW:** the VS Code approval card lets the user pick the destination file, including the shared project file.
  - https://code.claude.com/docs/en/permissions#permission-system, https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository
- **What gets saved.** File-edit approvals are session-only and never saved. Bash, WebFetch (per domain) and **WebSearch** approvals are saved permanently. A compound command saves one rule per subcommand, up to 5, and a `cd` outside the working dirs saves a `Read` rule. Generated path rules escape gitignore metacharacters. Bash prefix rules are saved in the **space form**. **CONFIRMED + NEW.**
- **Protected paths.**
  - Directories: `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, and `.claude` except `.claude/worktrees`.
  - Files: shell rc files, `.gitconfig`, `.npmrc`, `.mcp.json`, `.claude.json`, and more.
  - Per mode: `default` and `acceptEdits` **prompt**; `auto` **goes to the classifier**; `dontAsk` **denies**; **`bypassPermissions` allows**, since v2.1.126.
  - Allow rules never pre-approve these writes. In prompting modes, a `.claude/` prompt offers "allow Claude to edit its own settings for this session".
  - **DIVERGED:** the research doc and HANDOFF §12 say "auto-denied/prompted even in bypass". Bypass now **allows** protected-path writes, and auto mode may approve them via the classifier, so hook enforcement in user settings is not tamper-proof in those modes.
  - https://code.claude.com/docs/en/permission-modes#protected-paths

## B7. Headless `-p`

- **Unanswerable prompts are denied.** An `ask` with no permission host is **denied** rather than paused. `--permission-prompts none` (v2.1.259+) denies explicitly and tells Claude not to retry. **CONFIRMED.** https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs
- **`permission_denials`.** With `--output-format stream-json`, denials appear as `permission_denied` system messages, and the final result lists them in **`permission_denials`**. Read, Edit and Write path-deny denials were missing from that list before v2.1.269. `--output-format json` also carries `permission_denials` (observed at M0). **CONFIRMED (stream-json).**
- **`--permission-prompt-tool`.** Names an MCP tool that answers prompts in `-p`, and waits up to `MCP_TIMEOUT` (30 s) for its server. It can't approve `requiresUserInteraction` MCP tools. It is not shown in local `claude --help`, but the flag is documented. **CONFIRMED + NEW.** https://code.claude.com/docs/en/cli-reference
- **Hooks and trust in `-p`.** A `-p` run executes project hooks and `.mcp.json` servers even in an untrusted folder, **but does not apply project `permissions.allow`**. `defer` works only in `-p`. **NEW.** https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder

## B8. Auto mode

- **Default on Pro, Max and Team.** Auto is the built-in starting mode on Pro, Max and Team (terminal and VS Code). Enterprise and Console API keys start in `default`. Admins disable it with `permissions.disableAutoMode: "disable"`. **CONFIRMED** (state). The 2026-08-14 date isn't in the docs or changelog: **NOT-FOUND**, and immaterial. https://code.claude.com/docs/en/permission-modes#which-mode-a-session-starts-in
- **Rule order under auto.** Allow, ask and deny rules resolve **first**, so deny and ask still win. Content-scoped ask rules fall back to a prompt. **CONFIRMED.**
- **Allow rules dropped on entering auto mode.** Blanket `Bash(*)` and `PowerShell(*)`, wildcarded interpreters (`Bash(python*)`), package-manager run commands, `Agent` allow rules, and `Monitor` allow rules. Narrow rules stay. `autoMode.classifyAllShell: true` suspends *all* shell allow rules. **CONFIRMED + NEW list.** https://code.claude.com/docs/en/permission-modes (accordion "How the classifier evaluates actions"), https://code.claude.com/docs/en/settings-reference#automode-classifyallshell
- **Fallback to manual.** 3 consecutive or 20 total blocks. **CONFIRMED.**
- **Auto never prunes persisted rules.** **CONFIRMED** (no pruning feature exists in the docs).

## B9. Transcripts and retention

- **Path.** `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the cwd with non-alphanumerics replaced by `-` (truncated to 200 chars plus a hash). Subagent transcripts go in `<session>/subagents/`. **CONFIRMED.** https://code.claude.com/docs/en/sessions#where-transcripts-are-stored
  - **NEW:** `CLAUDE_CONFIG_DIR` relocates the directory, and `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) renames `<project>`.
  - The entry format is internal and changes between versions.
- **`cleanupPeriodDays`.** Default **30**, minimum **1**. The sweep runs in the background after session start, at most once per session. The research doc's "`0` disables writing (bug #23710)" is **DIVERGED**: **`0` now fails validation** (changelog v2.1.89). The advice "don't use 0; use e.g. 3650" still stands. https://code.claude.com/docs/en/settings-reference#cleanupperioddays
  - **NEW:** under first-wins, a managed `cleanupPeriodDays` pins retention and the sweep runs even if lower files are broken.
  - To stop transcript writes, set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` or pass `--no-session-persistence` with `-p`.

