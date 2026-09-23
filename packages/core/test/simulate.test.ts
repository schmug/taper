import { describe, expect, it } from 'vitest';
import type { UsageEvent } from '../src/index.ts';
import { simulate } from '../src/index.ts';
import { CONFIG, DAY, d, healthy, knob, member } from './helpers.ts';

const state = {
  knobs: [knob()],
  members: [member(), member({ id: 'm2' })],
  coverage: [healthy()],
  config: CONFIG,
};
const daily = (id: string, from: number, to: number): UsageEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    eventId: `${id}-${from + i}`,
    at: d(from + i, 9),
    memberIds: [id],
  }));

const walk = (timeline: ReturnType<typeof simulate>) =>
  timeline.steps.flatMap((s) =>
    s.transitions.map((t) => `${(t.at - d(0)) / DAY}:${t.memberId}:${t.from}->${t.to}`),
  );

describe('simulate', () => {
  it('walks a member through every state while its sibling stays in use', () => {
    const timeline = simulate(state, daily('m2', 0, 100), d(0), d(100), DAY);
    expect(walk(timeline)).toEqual([
      '30:m1:active->stale_candidate',
      '45:m1:stale_candidate->pending_removal',
      '60:m1:pending_removal->removed',
    ]);
    expect(timeline.steps).toHaveLength(101);
    expect(timeline.steps[30]).toMatchObject({ at: d(30), tickId: `sim:${d(30)}`, frozen: [] });
    expect(timeline.members.map((m) => m.state)).toEqual(['removed', 'active']);
  });

  it('applies usage at its time: restore, then a fresh walk from the restore', () => {
    const events = [...daily('m2', 0, 120), { eventId: 'u', at: d(50, 9), memberIds: ['m1'] }];
    const timeline = simulate(state, events, d(0), d(120), DAY);
    expect(walk(timeline)).toEqual([
      '30:m1:active->stale_candidate',
      '45:m1:stale_candidate->pending_removal',
      '50.375:m1:pending_removal->active',
      '81:m1:active->stale_candidate',
      '96:m1:stale_candidate->pending_removal',
      '111:m1:pending_removal->removed',
    ]);
  });

  it('applies events at or before the start on the first step and ignores events after the end', () => {
    const events = [
      { eventId: 'past', at: d(-5), memberIds: ['m1'] },
      { eventId: 'future', at: d(99), memberIds: ['m1'] },
    ];
    const timeline = simulate(state, events, d(0), d(10), DAY);
    expect(timeline.members[0]?.lastSeenAt).toBe(d(-5));
  });

  it('is deterministic', () => {
    const a = simulate(state, daily('m2', 0, 100), d(0), d(100), DAY);
    const b = simulate(structuredClone(state), daily('m2', 0, 100), d(0), d(100), DAY);
    expect(b).toEqual(a);
  });

  it.each([0, -DAY, Number.NaN])('rejects a step of %s', (step) => {
    expect(() => simulate(state, [], d(0), d(10), step)).toThrow(RangeError);
  });
});
