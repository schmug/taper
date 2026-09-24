# ADR-0014: `active_days` stays off by default for `local` knobs

Status: accepted (M3, 2026-09-23). Answers HANDOFF §11 item 2 for now; ADR-0005 left it open
until replay data existed.

## Evidence

The only replay data is the M3 solo demo (`scripts/demo.ts --solo`), which is synthetic. It
replays the recorded hook payloads and OTLP streams over 47 days: one session a day on days
1–12, then one every other day. The rule written on day 0 is never used again.

| Clock | Member at the day-46 tick |
|---|---|
| `wall` | 46.2 stale days → `pending_removal` |
| `active_days` | 29 session days → still `active` (T1 is 30) |

Session days ran at about 63% of wall days, so `active_days` would slow decay by roughly that
factor for someone who works in the repo on alternate days. The demo test asserts both numbers.

## Decision

Keep `wall` as the default for every knob kind. The data is synthetic, and the case
`active_days` exists for is already covered: project and local knobs see only signals from
sessions in their own repo (ADR-0010), so their wall clock freezes after `deadmanWindowDays`
away from the repo. A holiday does not decay a repo's rules under either clock.

Revisit with real usage: dogfooding (`TAPER_DOGFOOD=1`) or M4's replay of real OTLP streams.
The per-knob `clock` field already allows a switch without a migration.
