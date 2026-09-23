# ADR-0005: Coverage, clocks, and the dead-man switch

Status: accepted (M1, 2026-09-22). Code: `packages/core/src/clock.ts`.

## Decision

**Coverage is raw liveness signals, not precomputed freeze flags.** The guard lives in core
(HANDOFF P5), so core decides what counts as dead. Input per knob:
`KnobCoverage { knobId, sources: [{ sourceId, since, signals: [{ at, kind }] }] }` with
`kind ∈ heartbeat | session | decision`. Backends map their events onto those kinds (M2/M4);
`since` counts as a heartbeat and a decision. Signals after `now` are ignored, which lets
`simulate()` read future liveness from the same structure.

**Blind time never accrues.** A clock excludes these intervals:

| Interval | wall | active_days |
|---|---|---|
| Before the earliest `since` of the knob's sources (uncovered) | blind | blind |
| Heartbeat gap longer than `deadmanWindowDays`: the whole gap, retroactively | blind | — |
| Degraded: from the first session after a decision until the next decision, when that exceeds the window | blind | blind |

A knob is **frozen** when `now` is blind (including no coverage at all). Freezing blocks every
tightening step and is reported in `evaluate().frozen`. A knob with several sources is blind
whenever any one source is (M6: one device flatlining freezes the shared `project` knob). A
source that joins later does not blind history before its `since`.

**Retroactive.** When a gap crosses the window, the whole gap stops counting, so stale time can
drop between ticks. Steps taken during the gap's first `window` days stand (tightening is
forward-only), matching "freezing never causes a transition" rather than undoing work.

**`wall`** = calendar days in `(anchor, now]` minus blind time. **`active_days`** = distinct UTC
days after the anchor's day with a non-blind `session`. Heartbeat gaps do not freeze
`active_days`: no session means no accrual, which is how it makes vacations and dead pipelines a
non-issue. Degraded pipelines (sessions without decisions) still freeze it.

**Ledger maturity** is measured in the knob's own clock over the unbroken covered stretch that
reaches `now`: wall days for `wall`, session days for `active_days`. Any blind interval restarts
it. It gates leaving `active` only.

## Consequences

- Pruned signals read as a heartbeat gap, i.e. blind, so signal retention caps stale time and
  restarts maturity. M4 must retain signals for longer than T3 plus the dead-man window.
  Compacting signals (e.g. per day) can shift where a degraded interval starts; not specified.
- Under `wall`, a user who works less than once per `deadmanWindowDays` never decays. That is
  the conservative direction and the use case for `active_days`.
- Degraded detection is linear in signals (two sorted passes).

## Deferred

- HANDOFF §11 item 2 (should `active_days` be the default for `local` knobs): needs replay data
  from M3/M4. Default stays `wall`.
- HANDOFF §11 item 5 (`deadmanWindowDays` default for `cli` knobs): per-knob override exists;
  the default is an M7 decision.
- Day boundaries are UTC. A per-org offset can be added if replay data shows it matters.
