# ADR-0013: `taper protect` on a member that already decayed

Status: accepted (M3, 2026-09-23). Resolves the ADR-0004 deferral. Code:
`packages/agent/src/cli.ts` (`cmdProtect`), core `regrant()`.

## Context

In core, `protected` only stops tightening. A member that is already `pending_removal` or
`removed` stays there when it is protected: the hook keeps asking, or keeps denying, forever.
The user said "never decay this", and the result is a rule that is still blocked.

## Decision

- **Solo mode:** `taper protect <rule|knob>` first re-grants every decayed member it covers
  (`stale_candidate`, `pending_removal` or `removed` → `active`, with a cooldown), through core
  `regrant()` with actor `user` and request id `selfapprove:<time>`, and then sets `protected`.
  The ledger shows the re-grant rows before the member is protected.
- Invariant 5 holds: the only way out of `removed` is still an approved re-grant. In solo mode
  the approver is the user (`SelfApprove`, HANDOFF §5.5), the same level `taper regrant` uses.
- **Org mode (M6):** protecting a decayed member must pass the org's verifier level
  (`AdminOnly` by default). A user who may not re-grant may not protect-to-restore either.
- **`unprotect`** is refused for `deny`/`ask` knobs and their members, managed knobs, and rules
  the matcher treats as `inert`. Only allow rules may decay (C1, invariant 4), and taper never
  decays what it cannot match (ADR-0006). A `Read(...)` rule may be unprotected, which is the
  C2 opt-in, and the CLI says that its evidence is low-confidence.

## Consequences

- `protect` never leaves a member enforced. `unprotect` changes no state; decay resumes on the
  next tick, subject to every guard.
