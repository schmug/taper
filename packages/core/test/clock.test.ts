import { describe, expect, it } from 'vitest';
import type { KnobCoverage, Signal } from '../src/index.ts';
import { makeClock } from '../src/index.ts';
import { d, dailySignals, healthy, source } from './helpers.ts';

const W = 7;
const cov = (...sources: ReturnType<typeof source>[]): KnobCoverage => ({ knobId: 'k1', sources });

describe('wall clock', () => {
  it('counts calendar days under continuous coverage', () => {
    const clock = makeClock('wall', healthy('k1', 30), d(10), W);
    expect(clock.frozen).toBe(false);
    expect(clock.coveredSince).toBe(d(0));
    expect(clock.elapsed(d(0))).toBe(10);
    expect(clock.elapsed(d(4, 12))).toBe(5.5);
  });

  it('is frozen with no coverage and accrues nothing', () => {
    for (const coverage of [undefined, cov()]) {
      const clock = makeClock('wall', coverage, d(10), W);
      expect(clock.frozen).toBe(true);
      expect(clock.coveredSince).toBeNull();
      expect(clock.elapsed(d(0))).toBe(0);
    }
  });

  it('treats time before coverage started as blind', () => {
    const clock = makeClock('wall', cov(source(dailySignals(5, 30), 5)), d(10), W);
    expect(clock.elapsed(d(0))).toBe(5);
    expect(clock.coveredSince).toBe(d(5));
  });

  it('excludes a heartbeat gap longer than the window, retroactively', () => {
    const signals = [...dailySignals(0, 5), ...dailySignals(16, 30)];
    const clock = makeClock('wall', cov(source(signals)), d(20), W);
    expect(clock.frozen).toBe(false);
    expect(clock.elapsed(d(0))).toBe(20 - 11);
    expect(clock.coveredSince).toBe(d(16, 12));
  });

  it('keeps a gap of exactly the window', () => {
    const signals = [...dailySignals(0, 5), ...dailySignals(12, 30)];
    const clock = makeClock('wall', cov(source(signals)), d(20), W);
    expect(clock.elapsed(d(0))).toBe(20);
    expect(clock.coveredSince).toBe(d(0));
  });

  it('freezes when the trailing gap exceeds the window and stops accrual at the last heartbeat', () => {
    const clock = makeClock('wall', cov(source(dailySignals(0, 5))), d(13), W);
    expect(clock.frozen).toBe(true);
    expect(clock.coveredSince).toBeNull();
    expect(clock.elapsed(d(0))).toBe(5.5);
  });

  it('does not freeze while the trailing gap is within the window', () => {
    const clock = makeClock('wall', cov(source(dailySignals(0, 5))), d(12), W);
    expect(clock.frozen).toBe(false);
    expect(clock.elapsed(d(0))).toBe(12);
  });

  it('freezes when sessions arrive without decisions for longer than the window', () => {
    const signals = [...dailySignals(0, 5), ...dailySignals(6, 30, ['session'])];
    const clock = makeClock('wall', cov(source(signals)), d(20), W);
    expect(clock.frozen).toBe(true);
    expect(clock.elapsed(d(0))).toBe(6.5);
  });

  it('unfreezes when decisions resume and excludes the degraded stretch', () => {
    const signals = [
      ...dailySignals(0, 5),
      ...dailySignals(6, 15, ['session']),
      ...dailySignals(16, 30),
    ];
    const clock = makeClock('wall', cov(source(signals)), d(20), W);
    expect(clock.frozen).toBe(false);
    expect(clock.coveredSince).toBe(d(16, 12));
    expect(clock.elapsed(d(0))).toBe(20 - (16 - 6));
  });

  it('ignores a decisionless stretch within the window', () => {
    const signals = [
      ...dailySignals(0, 5),
      ...dailySignals(6, 10, ['session']),
      ...dailySignals(11, 30),
    ];
    const clock = makeClock('wall', cov(source(signals)), d(20), W);
    expect(clock.elapsed(d(0))).toBe(20);
  });

  it('does not count a decisionless idle stretch with no sessions as degraded', () => {
    // Heartbeats keep the source alive; no session means nothing went unobserved.
    const signals = [
      ...dailySignals(0, 5),
      ...dailySignals(6, 15, ['heartbeat']),
      ...dailySignals(16, 30),
    ];
    const clock = makeClock('wall', cov(source(signals)), d(20), W);
    expect(clock.elapsed(d(0))).toBe(20);
  });

  it('freezes the knob when any one source flatlines', () => {
    const a = source(dailySignals(0, 30), 0, 'a');
    const b = source(dailySignals(0, 5), 0, 'b');
    const clock = makeClock('wall', cov(a, b), d(20), W);
    expect(clock.frozen).toBe(true);
  });

  it('does not blind history when a source joins later', () => {
    const a = source(dailySignals(0, 30), 0, 'a');
    const b = source(dailySignals(15, 30), 15, 'b');
    const clock = makeClock('wall', cov(a, b), d(20), W);
    expect(clock.elapsed(d(0))).toBe(20);
    expect(clock.coveredSince).toBe(d(0));
  });

  it('ignores signals after now', () => {
    const signals: Signal[] = [...dailySignals(0, 5), { at: d(30), kind: 'session' }];
    const clock = makeClock('wall', cov(source(signals)), d(13), W);
    expect(clock.frozen).toBe(true);
  });

  it('accrues nothing for an anchor at or after now', () => {
    const clock = makeClock('wall', healthy(), d(10), W);
    expect(clock.elapsed(d(10))).toBe(0);
    expect(clock.elapsed(d(11))).toBe(0);
  });

  it('fails closed on a non-numeric window: every gap is blind', () => {
    const clock = makeClock('wall', healthy(), d(10, 12), Number.NaN);
    expect(clock.frozen).toBe(true);
    expect(clock.elapsed(d(0))).toBe(0);
  });
});

describe('active_days clock', () => {
  it('counts distinct days with a session after the anchor day', () => {
    const signals: Signal[] = [
      { at: d(1, 12), kind: 'session' },
      { at: d(1, 18), kind: 'session' },
      { at: d(2, 12), kind: 'session' },
      { at: d(5, 12), kind: 'session' },
      { at: d(5, 12), kind: 'decision' },
      { at: d(6, 12), kind: 'heartbeat' },
    ];
    const clock = makeClock('active_days', cov(source(signals)), d(10), W);
    expect(clock.elapsed(d(0))).toBe(3);
    expect(clock.elapsed(d(1, 6))).toBe(2);
  });

  it('is not frozen by a heartbeat gap: no sessions, no accrual', () => {
    const clock = makeClock('active_days', cov(source(dailySignals(0, 2))), d(30), W);
    expect(clock.frozen).toBe(false);
    expect(clock.coveredSince).toBe(d(0));
    expect(clock.elapsed(d(0))).toBe(2);
  });

  it('freezes on a degraded pipeline and does not count its session days', () => {
    const signals = [...dailySignals(0, 5), ...dailySignals(6, 20, ['session'])];
    const clock = makeClock('active_days', cov(source(signals)), d(20), W);
    expect(clock.frozen).toBe(true);
    expect(clock.elapsed(d(0))).toBe(5);
  });

  it("ignores a source's sessions from before it started reporting", () => {
    const a = source([], 0, 'a');
    const b = source([{ at: d(10, 12), kind: 'session' }], 50, 'b');
    const clock = makeClock('active_days', cov(a, b), d(60), W);
    expect(clock.elapsed(d(0))).toBe(0);
  });

  it('accrues nothing without coverage', () => {
    const clock = makeClock('active_days', undefined, d(10), W);
    expect(clock.frozen).toBe(true);
    expect(clock.elapsed(d(0))).toBe(0);
  });
});
