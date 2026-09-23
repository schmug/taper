# ADR-0006: Matcher semantics and the decisive tie-break

Status: accepted (M2, 2026-09-23). Code: `packages/backend-claude-code/src/{rule,shell,path,policy,match}.ts`.
Fixtures: `fixtures/settings/*.json` (one per rule form). Resolves ADR-0002 rows 1, 7 and 8.

## Decision

- **API.** `match(policy, call) → { outcome, basis, decisiveRules, allMatchingAllowRules }`.
  `outcome` is `allow | ask | deny | none`; `none` means no rule decided and Claude Code falls
  back to the permission mode. HANDOFF's `decisiveRule` is a list, because a compound command
  can have several decisive rules (ADR-0002 row 7). `basis` is `rule`, `builtin` (read-only Bash
  set or a read inside cwd), `too_long` (over 10,000 characters), `unparseable`, or `no_match`.
- **Tie-break (ADR-0002 row 7).** Claude Code defines no order among matching rules of one array.
  taper's order is scope (managed > cli > local > project > user), then source order within the
  scope (`managed-settings.json` before `managed-settings.d/*` alphabetically), then array index.
  A deny or ask outcome has one decisive rule. An allow outcome has one decisive rule per covered
  subcommand, deduplicated. A subcommand covered by the read-only set has no decisive rule.
- **Attribution (C5).** `allMatchingAllowRules` lists every allow rule that matches the call or
  any subcommand, whatever the outcome. A taper `ask` that the user approves must restore the
  allow member (P4), so attribution does not depend on the outcome.
- **Trust (ADR-0002 row 1).** The policy has `workspaceTrusted: true | false | 'unknown'`. Only
  `false` drops project allow rules. `unknown` keeps them.
- **Over-match is the chosen error direction for allow.** A rule that taper matches too narrowly
  is never refreshed and decays while in use. A rule that taper matches too broadly is refreshed
  when it should not be, which is safe. So allow rules are tested against both the raw and the
  wrapper-stripped subcommand, and every leading `NAME=value` is stripped. Claude Code strips
  only known-safe variables, and the docs do not list them. `fixtures/settings/10-*` records this
  divergence.
- **Not understood means protected.** Claude Code skips some rules: malformed rules, `Write(path)`
  and other path rules it never consults, `mcp__x(...)`, allow-side globs, and allow-side `!`.
  taper does not model some others (`PowerShell`, `Cd`). All of these parse as `inert` and never
  match. `isProtectedByDefault` keeps them out of decay, which C5 requires.
- **Not modeled.** Permission modes, including auto mode's dropped allow rules (C4). Symlink
  resolution. Windows `/c/...` paths. `additionalDirectories`. The Skill deny aliasing. Heredoc
  and `case` edge cases beyond fixtures 07 and `test/shell.test.ts`. Output redirection
  (`2>/dev/null` included) makes a command not read-only. Since ADR-0009, a background `&` or an
  output redirection to a file (not `/dev/null`, not `>&N`) makes the allow outcome `none`. The
  matching allow rules are still listed for attribution.

## Choices the docs leave open

Status after the 2026-09-23 differential run (ADR-0009, Claude Code 2.1.278).

| Choice | Fixture | Status |
|---|---|---|
| `Task(x)` rules alias `Agent(x)`; legacy `Task` calls use Agent rules | 23 | UNVERIFIED: the observer cannot see Agent denies |
| `Tool(*)` equals bare `Tool` for every tool (docs say so only for Bash) | 02 | Confirmed for Bash only |
| `Bash(name:*)` in deny/ask with a Bash parameter name matches either reading | 24 | UNVERIFIED: not discriminated by the run |
| Managed `/path` anchors at the managed file's directory | policy test | UNVERIFIED: managed scope is not runnable |
| `dir/**` also covers `dir` itself (for Grep/Glob on a directory) | 16 | UNVERIFIED: not exercised |
| Relative patterns match only under cwd; single-segment dirs float for deny/ask only | 12, 15 | Allow side confirmed; the deny side is hidden by the observer blind spot |
| Output redirection disqualifies a read-only command | 11 | Confirmed. Also, a file redirect prompts even when an allow rule matches (ADR-0009) |
| A bare `Read` deny also blocks the Edit family | rule test | UNVERIFIED: not run |
| `:*` before more text is `inert` | 06 | The literal-colon reading is refuted. Skipped vs rewritten is UNVERIFIED |
| `&` anywhere (including trailing) prompts | 07 | `a & b` confirmed; trailing `&` UNVERIFIED |
| A redirect to `/dev/null` is not a file write | 11 | UNVERIFIED |
| `WebSearch(x)` equals bare `WebSearch` | 27 | The call was allowed; the mechanism is UNVERIFIED |

## Consequences

- The differential job (ADR-0008) checks the fixture cases that can run headless against a real
  binary. MCP, Skill, Monitor, user and managed scope, and anything that would spend network or
  subagent tokens stay docs-only. Each such case gives its reason in its `diffNote`.
- The redundancy report (M7) can call an allow rule redundant when it is never decisive.
- `ToolCall.cwd` must be the session's primary working directory, not the shell's current one.
  A subdirectory `cwd` would under-match relative allow rules. M3 must source it correctly from
  hook stdin (UNVERIFIED: whether hook `cwd` follows a Bash `cd`).
