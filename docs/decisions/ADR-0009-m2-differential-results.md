# ADR-0009: M2 differential results (2026-09-23) and what changed

Status: accepted (M2, 2026-09-23). Evidence: `fixtures/differential/2026-09-23/report.json`
(sanitized). One approved run of the ADR-0008 job against Claude Code **2.1.278** on haiku:
23 sessions, 98 calls, **13 mismatches**, 0 not attempted, 0 timeouts, 218 s, **$0.705**. The raw
streams were not kept. From now on the runner saves them (`<workdir>/streams/`, sanitized).

## Decision

Each mismatch gets one of three dispositions: (a) the matcher was wrong and is fixed; (b) the
fixture expectation was wrong; (c) the observation is suspect, so the case keeps `diff: true`,
gets an `unverified` note, and the matcher does not change. There were no (b) cases. The C5
column says how the change moves allow attribution (`allMatchingAllowRules`): an under-match of
an allow rule the binary applies is the unsafe direction.

| # | Fixture / case | Pred → obs | Disposition | C5 direction |
|---|---|---|---|---|
| 1 | 01 bare `WebFetch` ask | ask → none | (c) the call prompted, but not with `decision_reason_type: rule`. Fixture 20's `WebFetch(domain:*)` ask did report `rule` | none; ask rules are protected (C1) |
| 2 | 06 `Bash(./probe.sh:* push)` vs `./probe.sh:x push` | allow → none | (a) `:*` before more text parses as `inert` | the rule loses attribution but can never decay (inert rules are protected), so this is safe under any reading |
| 3 | 07 ask inside `( … )` | ask → none | (c) the call prompted, but not reported as `rule`. Only single-command asks have been observed (M0). Control case added | none |
| 4 | 07 `a & b`, both allowed | allow → none | (a) a `&` operator makes the outcome `none`, basis `background` | neutral; matching allow rules are unchanged |
| 5 | 11 `ls > out.txt` with `Bash(ls *)` | allow → none | (a) an output redirection to a file makes the outcome `none`, basis `redirect`. `2>&1` still allows (07) | neutral, as in row 4 |
| 6–8 | 12 path denies: `Read(.env)` at depth, `Edit(build/**)` at depth, `Read(.env)` on a Write | deny → allow | (c) observer blind spot, below | none; deny rules are protected (C1) |
| 9–10 | 15 `Read(secrets/**)` direct; the negation in another source | deny → allow | (c) observer blind spot. The passing carve-out case is also marked, because it proves nothing | none |
| 11–12 | 23 `Agent(Explore)` deny; the `Task(Plan)` alias | deny → allow | (c) no permission signal was observed. The deny probably removes the agent type from the tool, so the call fails validation. The session cost ($0.026) fits no subagent having run | none |
| 13 | 27 `WebSearch(anything)` allow | none → allow | (a) `WebSearch(x)` parses as bare `WebSearch` | over-match; the safe side |

**Observer blind spot.** `observe()` detects a denial in only two ways:
`tool_result_meta.non_execution_kind = permission-rule`, or a `permission_denied` message.
M0 checked both for Bash only. In this run WebFetch and Bash denies were detected. Every Read,
Write and Agent deny came back `allow`. Two Write calls (fixture 12) had no allow rule covering
them, and uncovered Writes in the same session came back `none`, so those Writes cannot have
run. That means file-tool and Agent denies reach the stream through a channel the observer does
not read, most likely a plain tool error from input validation. The observer is not changed on
a guess. The next run's saved streams will show the shape.

**Rule changes, and why they are the smallest safe reading.**
- `:*` not at the end → `inert`. The docs call the colon literal, but the live call did not
  match. Whether Claude Code skips the rule or rewrites `:*` to ` *` is not known.
  `./nope.sh x push` is the case that tells them apart. `inert` is correct under both readings
  for decay, because it is protected.
- `&` at any depth, including a trailing `&`, prompts. Only `a & b` was observed. Deny and ask
  rules still see both sides.
- A file redirect is `>`, `>>`, `>|`, `&>`, `&>>` or `N>`. `>&N`, `>&-`, `>(…)` and `/dev/null`
  are not file redirects. The `/dev/null` exemption is UNVERIFIED (new case in 11). So is
  whether a bare `Bash` allow or an `Edit` allow on the target would approve the call.
- `WebSearch(x)`: this run cannot tell "Claude Code ignores the specifier" apart from
  "WebSearch needed no permission". Either way, matching is the safe side.

## Consequences

- The matcher's allow attribution only widened, or stayed the same. No guard changed
  (invariant 6). No human settings array outside `fixtures/` changed (invariant 3).
- No corollary C1–C5 is contradicted. Rows 1 and 3 leave one M6 risk open: taper's
  `50-taper.json` puts bare-name and compound-matching rules in `ask`. A bare `WebFetch` ask was
  not reported as a rule decision. M6's managed probe must confirm such entries take effect.
- A confirming rerun of fixtures 01, 06, 07, 11, 12, 15, 23 and 27 (`TAPER_DIFF_ONLY`) costs
  about $0.32. That is $0.297 for their 48 calls on 2026-09-23 plus about $0.025 for the four
  new cases. If WebSearch runs again (27) it adds one real search, and a subagent adds a little
  if an Agent deny does not apply. It still needs the owner's go-ahead. Rows 6–12 will mismatch again until `observe()` learns the denial
  shape from the saved streams.
