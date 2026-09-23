// HANDOFF §4.4 property suite, 10k runs each: monotone tightening, instant restore, cooldown
// blocks tightening, guards total, determinism, shadow never enforces. Oracles are computed here
// from first principles where cheap (protection, cooldown, thresholds, live counts) and from the
// unit-tested clock for dead-man and maturity.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EvaluateInput, Knob, LiveState, Member, MemberState } from '../src/index.ts';
import {
  applyTransitions,
  applyUsage,
  DAY_MS,
  enforcement,
  evaluate,
  explain,
  makeClock,
  resolveThresholds,
  simulate,
} from '../src/index.ts';
import { evaluateInput, usageEvent } from './arbitraries.ts';
import { DAY, HOUR } from './helpers.ts';

const RUNS = { numRuns: 10_000 };
const SUCC: Partial<Record<MemberState, LiveState>> = {
  active: 'stale_candidate',
  stale_candidate: 'pending_removal',
  pending_removal: 'removed',
};
const isLive = (s: MemberState) => s !== 'removed' && s !== 'retired';

const uniqueBy = <T extends { id: string }>(xs: readonly T[]): T[] => {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x.id, (counts.get(x.id) ?? 0) + 1);
  return xs.filter((x) => counts.get(x.id) === 1);
};
const firstBy = <T extends { id: string }>(xs: readonly T[]): T[] =>
  xs.filter((x, i) => xs.findIndex((y) => y.id === x.id) === i);

function clockFor(i: EvaluateInput, knob: Knob) {
  const th = resolveThresholds(i.config, knob);
  const sources = i.coverage.filter((c) => c.knobId === knob.id).flatMap((c) => c.sources);
  return {
    th,
    clock: makeClock(knob.clock, { knobId: knob.id, sources }, i.now, th.deadmanWindowDays),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('properties (10k runs each)', () => {
  it('monotone tightening: at most one step per member, along the chain, from its current state', () => {
    fc.assert(
      fc.property(evaluateInput, (i) => {
        const { transitions } = evaluate(i);
        const moved = new Set<string>();
        for (const t of transitions) {
          const m = i.members.find((x) => x.id === t.memberId) as Member;
          expect(moved.has(t.memberId)).toBe(false);
          moved.add(t.memberId);
          expect(t.from).toBe(m.state);
          expect(t.to).toBe(SUCC[m.state]);
          expect([t.reason, t.actor, t.at, t.tickId]).toEqual([
            'unused',
            'system',
            i.now,
            i.tickId,
          ]);
        }
      }),
      RUNS,
    );
  });

  it('guards total: no transition bypasses protection, dead-man, cooldown, maturity, threshold, or last-member', () => {
    fc.assert(
      fc.property(evaluateInput, (i) => {
        const out = evaluate(i);
        const knobs = uniqueBy(i.knobs);
        for (const t of out.transitions) {
          const k = knobs.find((x) => x.id === t.knobId) as Knob;
          const [m, ...dups] = i.members.filter((x) => x.id === t.memberId) as [Member];
          expect(k).toBeDefined();
          expect(dups).toEqual([]);
          expect(k.protected || m.protected).toBe(false);
          const { th, clock } = clockFor(i, k);
          expect(clock.frozen).toBe(false);
          expect(m.cooldownUntil === null || i.now >= m.cooldownUntil).toBe(true);
          if (m.state === 'active') {
            expect(clock.elapsed(clock.coveredSince as number) >= th.maturityDays).toBe(true);
          }
          const anchor = Math.max(
            m.declaredAt,
            m.lastSeenAt ?? -Infinity,
            m.lastRestoredAt ?? -Infinity,
          );
          const threshold = {
            stale_candidate: th.t1Days,
            pending_removal: th.t2Days,
            removed: th.t3Days,
          }[t.to as LiveState & ('stale_candidate' | 'pending_removal' | 'removed')];
          expect(clock.elapsed(anchor) >= threshold).toBe(true);
        }
        const after = applyTransitions(i.members, out.transitions);
        for (const k of knobs.filter((x) => x.mode === 'automatic')) {
          const live = (ms: readonly Member[]) =>
            ms.filter((m) => m.knobId === k.id && isLive(m.state)).length;
          if (live(i.members) > 0) expect(live(after)).toBeGreaterThan(0);
        }
        for (const k of firstBy(i.knobs)) {
          const frozen = i.knobs
            .filter((x) => x.id === k.id)
            .some((x) => clockFor(i, x).clock.frozen);
          expect(out.frozen.includes(k.id)).toBe(frozen);
        }
      }),
      RUNS,
    );
  });

  it('cooldown blocks tightening: a member that would move stays put while cooling', () => {
    fc.assert(
      fc.property(evaluateInput, fc.integer({ min: 1, max: 60 * 24 }), (i, hours) => {
        const moved = new Set(evaluate(i).transitions.map((t) => t.memberId));
        const cooling = i.members.map((m) =>
          moved.has(m.id) ? { ...m, cooldownUntil: i.now + hours * HOUR } : m,
        );
        for (const t of evaluate({ ...i, members: cooling }).transitions) {
          expect(moved.has(t.memberId)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it('instant restore: any usage of a restorable member makes it active with a cooldown', () => {
    fc.assert(
      fc.property(evaluateInput, fc.array(usageEvent, { maxLength: 6 }), (i, events) => {
        const members = uniqueBy(i.members);
        const out = applyUsage(members, events, { knobs: i.knobs, config: i.config });
        members.forEach((m, n) => {
          const after = out.members[n] as Member;
          const uses = events.filter((e) => e.memberIds.includes(m.id)).map((e) => e.at);
          const copies = i.knobs.filter((k) => k.id === m.knobId);
          const shadow = copies.length > 0 && copies.every((k) => k.mode === 'shadow');
          const restorable = m.state !== 'retired' && (m.state !== 'removed' || shadow);
          if (uses.length === 0 || !restorable) {
            expect(after).toBe(m);
            return;
          }
          const last = Math.max(...uses);
          expect(after.state).toBe('active');
          expect(after.lastSeenAt).toBe(Math.max(m.lastSeenAt ?? -Infinity, last));
          const th =
            copies[0] === undefined ? i.config.thresholds : resolveThresholds(i.config, copies[0]);
          const cooldown = th.cooldownDays * DAY_MS;
          if (Number.isFinite(cooldown)) {
            expect(after.cooldownUntil as number).toBeGreaterThanOrEqual(last + cooldown);
          }
          const restores = out.transitions.filter((t) => t.memberId === m.id);
          if (m.state === 'active') {
            expect(restores).toEqual([]);
          } else {
            expect(restores.map((t) => [t.from, t.to, t.reason])).toEqual([
              [m.state, 'active', 'usage'],
            ]);
            expect(after.restoredCount).toBe(m.restoredCount + 1);
          }
        });
      }),
      RUNS,
    );
  });

  it('determinism: same output for cloned, frozen, and permuted input', () => {
    const permuted = evaluateInput.chain((i) =>
      fc.record({
        original: fc.constant(i),
        knobs: fc.shuffledSubarray([...i.knobs], { minLength: i.knobs.length }),
        members: fc.shuffledSubarray([...i.members], { minLength: i.members.length }),
        coverage: fc.shuffledSubarray([...i.coverage], { minLength: i.coverage.length }),
      }),
    );
    fc.assert(
      fc.property(permuted, ({ original, knobs, members, coverage }) => {
        const expected = evaluate(deepFreeze(structuredClone(original)));
        const reversedSignals = coverage.map((c) => ({
          ...c,
          sources: [...c.sources]
            .reverse()
            .map((s) => ({ ...s, signals: [...s.signals].reverse() })),
        }));
        expect(evaluate({ ...original, knobs, members, coverage: reversedSignals })).toEqual(
          expected,
        );
        expect(evaluate(original)).toEqual(expected);
      }),
      RUNS,
    );
  });

  it('shadow never yields an enforcement action', () => {
    fc.assert(
      fc.property(evaluateInput, (i) => {
        const out = evaluate(i);
        for (const t of out.transitions) {
          const k = i.knobs.find((x) => x.id === t.knobId) as Knob;
          expect(t.shadow).toBe(k.mode === 'shadow');
        }
        const shadowKnobs = new Set(i.knobs.filter((k) => k.mode === 'shadow').map((k) => k.id));
        const after = applyTransitions(i.members, out.transitions);
        const actions = enforcement(i.knobs, after);
        for (const a of actions) expect(shadowKnobs.has(a.knobId)).toBe(false);
        const enforcedOnly = applyTransitions(
          i.members,
          out.transitions.filter((t) => !t.shadow),
        );
        expect(actions).toEqual(enforcement(i.knobs, enforcedOnly));
      }),
      RUNS,
    );
  });

  it('applyTransitions is idempotent', () => {
    fc.assert(
      fc.property(evaluateInput, (i) => {
        const { transitions } = evaluate(i);
        const once = applyTransitions(i.members, transitions);
        expect(applyTransitions(once, transitions)).toEqual(once);
      }),
      RUNS,
    );
  });

  it('explain agrees with evaluate', () => {
    fc.assert(
      fc.property(evaluateInput, (i) => {
        const moved = new Set(evaluate(i).transitions.map((t) => t.memberId));
        for (const m of uniqueBy(i.members)) {
          const x = explain({ ...i, memberId: m.id, ledger: [] });
          const clear = x?.due === true && x.blockedBy.length === 0;
          if (moved.has(m.id)) expect(clear).toBe(true);
          if (!clear) expect(moved.has(m.id)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it('over time, no member skips a state and removed exits only in shadow', () => {
    fc.assert(
      fc.property(
        evaluateInput,
        fc.array(usageEvent, { maxLength: 5 }),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom(6 * HOUR, DAY, 3 * DAY),
        (i, events, steps, step) => {
          const members = uniqueBy(i.members);
          const timeline = simulate(
            { ...i, members },
            events,
            i.now,
            i.now + (steps - 1) * step,
            step,
          );
          const state = new Map(members.map((m) => [m.id, m.state as MemberState]));
          for (const t of timeline.steps.flatMap((s) => s.transitions)) {
            expect(t.from).toBe(state.get(t.memberId));
            if (t.reason === 'unused') {
              expect(t.to).toBe(SUCC[t.from as MemberState]);
            } else {
              expect([t.reason, t.to]).toEqual(['usage', 'active']);
              if (t.from === 'removed') expect(t.shadow).toBe(true);
            }
            state.set(t.memberId, t.to as MemberState);
          }
          expect(timeline.members.map((m) => m.state)).toEqual([...state.values()]);
        },
      ),
      RUNS,
    );
  });
});
