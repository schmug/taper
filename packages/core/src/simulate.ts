// simulate(): run the engine forward with a compressed clock (HANDOFF §4.4, `taper simulate`).
// At each tick `t` (from, from+step, …, ≤ to): apply usage events with `at ≤ t`, then evaluate at
// `t` with tickId `sim:<t>`. Future liveness signals come from `coverage`, which evaluate reads
// only up to `now`; a caller that wants "I keep working daily" must supply those signals.

import { applyTransitions, evaluate } from './evaluate.ts';
import type {
  Config,
  EvaluateOutput,
  Knob,
  KnobCoverage,
  Member,
  Transition,
  UsageEvent,
} from './types.ts';
import { applyUsage } from './usage.ts';

export interface SimulationState<M extends Member = Member> {
  readonly knobs: readonly Knob[];
  readonly members: readonly M[];
  readonly coverage: readonly KnobCoverage[];
  readonly config: Config;
}

export interface TimelineStep extends EvaluateOutput {
  readonly at: number;
  readonly tickId: string;
  /** Usage restores applied before the tick, then the tick's own transitions. */
  readonly transitions: readonly Transition[];
}

export interface Timeline<M extends Member = Member> {
  readonly steps: readonly TimelineStep[];
  readonly members: readonly M[];
}

export function simulate<M extends Member>(
  state: SimulationState<M>,
  futureEvents: readonly UsageEvent[],
  from: number,
  to: number,
  step: number,
): Timeline<M> {
  if (!(step > 0)) throw new RangeError(`simulate: step must be > 0, got ${step}`);
  const { knobs, coverage, config } = state;
  const pending = [...futureEvents].sort((a, b) => a.at - b.at);
  let members: M[] = [...state.members];
  const steps: TimelineStep[] = [];

  for (let now = from; now <= to; now += step) {
    const due = pending.filter((e) => e.at <= now);
    pending.splice(0, due.length);
    const usage = applyUsage(members, due, { knobs, config });
    const tickId = `sim:${now}`;
    const out = evaluate({ knobs, members: usage.members, coverage, now, tickId, config });
    members = applyTransitions(usage.members, out.transitions);
    steps.push({
      ...out,
      at: now,
      tickId,
      transitions: [...usage.transitions, ...out.transitions],
    });
  }
  return { steps, members };
}
