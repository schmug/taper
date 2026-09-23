# ADR-0004: Core engine semantics

Status: accepted (M1, 2026-09-22). Code: `packages/core/src`.

## Decision

- **Units.** Times are epoch milliseconds, supplied by the caller (`now` is always an input).
  Threshold durations are days, measured in the knob's clock (ADR-0005).
- **One step per tick.** `evaluate()` moves a member at most one state per call, and only when it
  is due (`staleDays ≥ T` for the next state) and no guard holds it. A member far past T3 still
  goes `active → stale_candidate` first. This proves "no skipped states" per transition and keeps
  tightening slow when thresholds are lowered.
- **Staleness anchor = max(declaredAt, lastSeenAt, lastRestoredAt).** HANDOFF says
  `max(declared_at, last_seen_at)`. The third term is stricter: a re-granted but unused rule
  restarts at T1 instead of re-tightening three ticks after its cooldown ends.
- **Guard order and totality.** `assess()` (shared by `evaluate` and `explain`) returns every
  guard holding a member: `protected` (knob or member), `frozen` (dead-man at `now`, blocks all
  tightening), `cooldown`, `immature` (gates leaving `active` only, per HANDOFF §4.2),
  `last_member`. Comparisons fail closed on NaN config. Duplicate knob or member ids are
  ambiguous input: those members do not move.
- **Last-member guard** applies in `automatic` mode only. Members are processed in id order and
  a removal earlier in the same tick counts, so two last members never both go. A held member
  yields a `last_member_hold` recommendation (the approval request). The guard has no off switch.
- **Shadow mode.** Member state does progress (`shadow: true` on every transition recorded while
  the knob is in shadow) and each tightening step is also a `shadow_transition` recommendation.
  `enforcement()` returns nothing for shadow knobs, or for a knob id listed with both modes.
  Switching a knob to `automatic` enforces the states shadow reached; callers preview that with
  `enforcement()` before switching.
- **Usage in shadow withdraws a removal.** Invariant 5 ("`removed` exits only via re-grant")
  holds because enforcement makes usage unobservable. In shadow nothing is blocked, so usage of a
  shadow-`removed` member is real evidence and restores it. Keeping it `removed` would enforce a
  wrong removal the day the knob goes `automatic`. Only an unambiguously shadow knob does this.
- **Cooldown** is stamped on every observed use (P4), and on a restore it runs from the restore
  time. A late event never moves `lastSeenAt`, `firstSeenAt`, or `cooldownUntil` backwards, and
  no ledger entry is dated before the state it leaves.
- **Re-grant.** `regrant()` records `removed → restored → active` (two rows, same tick id
  `regrant:<requestId>`); from `stale_candidate`/`pending_removal` it records one row to
  `active`. The verifier ladder that approves it is outside core (M6).
- **Retirement.** `applySnapshot()` declares new rules (`null → active`, grace from the snapshot)
  and retires vanished ones (`→ retired`, `retiredFrom` kept). A returning rule is re-declared
  `active` with fresh grace, except one retired while `removed`, which returns to `removed`.
  Retirement is observation, not decay, so protection does not block it.
- **Idempotency.** Transitions are keyed by `(memberId, from, to, tickId)`; `applyTransitions()`
  applies a transition only while the member is in `from`, so re-applying a tick is a no-op.
- **API vs. HANDOFF §4.4 sketch.** `evaluate` also takes `tickId`; `applyUsage` takes
  `{knobs, config}` and returns `{members, transitions}` (restores belong in the ledger);
  `explain` takes the evaluate input plus `memberId` and `ledger`; `simulate` reads future
  liveness from `coverage`. Added: `applyTransitions`, `regrant`, `applySnapshot`,
  `enforcement`, `makeClock`.

## Deferred

- HANDOFF §11 item 6 (how long `retired` history stays visible) is storage policy: M4.
- Protecting a member that is already past `active` does not restore it; `taper protect` (M3)
  decides whether to pair it with a re-grant.

## Consequences

- Purity is enforced by `test/boundary.test.ts` (imports must stay in `src/`; no clock,
  randomness, crypto, timers, network, host globals, or locale APIs) plus `types: []` in
  `packages/core/tsconfig.json`. Tests typecheck separately with Node types (`test/tsconfig.json`).
