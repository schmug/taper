# Security Policy

taper is a permission-tightening tool for Claude Code. It reads Claude Code settings files and
usage signals, and writes machine-owned `ask`/`deny` rules. A flaw here can loosen a policy that
a user or admin believes is tight. That makes the enforcement path security-sensitive even at
pre-alpha.

## Reporting a vulnerability

**Please report privately. Do not open a public issue**, because a public issue discloses the
problem before a fix exists.

Use GitHub's private vulnerability reporting:

- **[Report a vulnerability](https://github.com/schmug/taper/security/advisories/new)**
  (Security tab → *Report a vulnerability*)

Please include the affected file or component, the impact, and steps to reproduce. Where relevant,
include the settings files and tool call that trigger the problem.

## In scope

- Any path by which taper **loosens** policy. For example: it edits a human-authored
  `permissions` array, drops or shadows a `deny`/`ask` rule, or restores a `removed` rule without an
  approved re-grant.
- Guard bypasses in the decay engine, such as cooldown, last-member, protected, ledger maturity, or
  the dead-man freeze.
- Tenant isolation, authentication, or device-token handling in the control plane (once it exists).
- Leakage of raw tool arguments, prompts, or credentials into stored events, logs, or the dashboard.

## Out of scope

- Vulnerabilities in Claude Code itself, Cloudflare, or other dependencies. Report those to the
  respective projects.
- Findings that require the attacker to already have write access to the user's managed settings
  or the taper state directory.

## Response timeline

This is a volunteer-maintained project, so timelines are best-effort:

- **Acknowledgement:** within about 7 days.
- **Assessment and fix plan:** within about 30 days of acknowledgement.
