import { describe, expect, it } from 'vitest';
import type { EvaluateInput, Member, Signal } from '../src/index.ts';
import { applyTransitions, evaluate } from '../src/index.ts';
import { d, dailySignals, healthy, input, knob, member, source } from './helpers.ts';

const transitionsOf = (i: EvaluateInput) =>
  evaluate(i).transitions.map((t) => `${t.memberId}:${t.from}->${t.to}`);

describe('evaluate: thresholds', () => {
  it('moves active to stale_candidate once unused for T1', () => {
    const out = evaluate(input({ now: d(30) }));
    expect(out.transitions).toEqual([
      {
        memberId: 'm1',
        knobId: 'k1',
        from: 'active',
        to: 'stale_candidate',
        at: d(30),
        reason: 'unused',
        actor: 'system',
        shadow: false,
        tickId: 'tick-1',
        evidence: { clock: 'wall', staleDays: 30, thresholdDays: 30, anchorAt: d(0) },
      },
    ]);
    expect(out.recommendations).toEqual([]);
    expect(out.frozen).toEqual([]);
  });

  it('does nothing before T1', () => {
    expect(transitionsOf(input({ now: d(29, 23) }))).toEqual([]);
  });

  it('moves one state per tick even when far past every threshold', () => {
    expect(transitionsOf(input({ now: d(300) }))).toEqual(['m1:active->stale_candidate']);
  });

  it('uses T2 and T3 for the later steps', () => {
    const stale = member({ state: 'stale_candidate' });
    const pending = member({ id: 'm2', state: 'pending_removal' });
    const other = member({ id: 'm3', lastSeenAt: d(99) });
    const members = [stale, pending, other];
    expect(transitionsOf(input({ members, now: d(44, 23) }))).toEqual([]);
    expect(transitionsOf(input({ members, now: d(45) }))).toEqual([
      'm1:stale_candidate->pending_removal',
    ]);
    expect(transitionsOf(input({ members, now: d(60) }))).toEqual([
      'm1:stale_candidate->pending_removal',
      'm2:pending_removal->removed',
    ]);
  });

  it('anchors staleness at the latest of declared, last seen, and last restored', () => {
    for (const m of [
      member({ declaredAt: d(50) }),
      member({ lastSeenAt: d(50) }),
      member({ lastRestoredAt: d(50) }),
    ]) {
      expect(transitionsOf(input({ members: [m], now: d(79, 23) }))).toEqual([]);
      expect(transitionsOf(input({ members: [m], now: d(80) }))).toEqual([
        'm1:active->stale_candidate',
      ]);
    }
  });

  it('applies per-knob threshold overrides', () => {
    const knobs = [knob({ thresholds: { t1Days: 20 } })];
    expect(transitionsOf(input({ knobs, now: d(20) }))).toEqual(['m1:active->stale_candidate']);
  });

  it('counts active days on an active_days knob', () => {
    const knobs = [knob({ clock: 'active_days', thresholds: { t1Days: 3, maturityDays: 2 } })];
    const signals: Signal[] = [
      { at: d(10, 12), kind: 'session' },
      { at: d(10, 12), kind: 'decision' },
      { at: d(20, 12), kind: 'session' },
      { at: d(20, 12), kind: 'decision' },
    ];
    const coverage = [{ knobId: 'k1', sources: [source(signals)] }];
    expect(transitionsOf(input({ knobs, coverage, now: d(25) }))).toEqual([]);
    signals.push({ at: d(24, 12), kind: 'session' }, { at: d(24, 12), kind: 'decision' });
    const out = evaluate(input({ knobs, coverage, now: d(25) }));
    expect(out.transitions[0]?.evidence).toMatchObject({ clock: 'active_days', staleDays: 3 });
  });
});

describe('evaluate: guards', () => {
  it('never moves removed or retired members', () => {
    const members = [
      member({ state: 'removed' }),
      member({ id: 'm2', state: 'retired', retiredFrom: 'active' }),
      member({ id: 'm3', lastSeenAt: d(299) }),
    ];
    expect(transitionsOf(input({ members, now: d(300) }))).toEqual([]);
  });

  it('protected member or knob: never leaves its state by system action', () => {
    const due = input({ now: d(300) });
    expect(transitionsOf({ ...due, members: [member({ protected: true })] })).toEqual([]);
    expect(transitionsOf({ ...due, knobs: [knob({ protected: true })] })).toEqual([]);
    const pending = member({ state: 'pending_removal', protected: true });
    expect(transitionsOf({ ...due, members: [pending] })).toEqual([]);
  });

  it('dead-man: a frozen knob does not tighten and is reported', () => {
    const coverage = [{ knobId: 'k1', sources: [source(dailySignals(0, 90))] }];
    const out = evaluate(input({ coverage, now: d(100) }));
    expect(out.transitions).toEqual([]);
    expect(out.frozen).toEqual(['k1']);
  });

  it('dead-man: a knob without coverage is frozen', () => {
    const out = evaluate(input({ coverage: [], now: d(100) }));
    expect(out.transitions).toEqual([]);
    expect(out.frozen).toEqual(['k1']);
  });

  it('dead-man: a frozen member already past its threshold still waits', () => {
    // Stale time accrued before the flatline is not enough: freezing never causes a transition.
    const coverage = [{ knobId: 'k1', sources: [source(dailySignals(0, 40))] }];
    expect(transitionsOf(input({ coverage, now: d(60) }))).toEqual([]);
  });

  it('cooldown blocks tightening until it expires', () => {
    const m = member({ cooldownUntil: d(100) });
    expect(transitionsOf(input({ members: [m], now: d(99, 23) }))).toEqual([]);
    expect(transitionsOf(input({ members: [m], now: d(100) }))).toEqual([
      'm1:active->stale_candidate',
    ]);
  });

  it('ledger maturity gates leaving active only', () => {
    const knobs = [knob({ thresholds: { t1Days: 5, t2Days: 6, t3Days: 60 } })];
    const coverage = [{ knobId: 'k1', sources: [source(dailySignals(0, 30))] }];
    const members = [member(), member({ id: 'm2', state: 'stale_candidate' })];
    expect(transitionsOf(input({ knobs, coverage, members, now: d(13, 23) }))).toEqual([
      'm2:stale_candidate->pending_removal',
    ]);
    expect(transitionsOf(input({ knobs, coverage, members, now: d(14) }))).toEqual([
      'm1:active->stale_candidate',
      'm2:stale_candidate->pending_removal',
    ]);
  });

  it('ledger maturity restarts after a coverage gap', () => {
    const knobs = [knob({ thresholds: { t1Days: 5 } })];
    const signals = [...dailySignals(0, 20), ...dailySignals(30, 60)];
    const coverage = [{ knobId: 'k1', sources: [source(signals)] }];
    expect(transitionsOf(input({ knobs, coverage, now: d(40) }))).toEqual([]);
    expect(transitionsOf(input({ knobs, coverage, now: d(44, 12) }))).toEqual([
      'm1:active->stale_candidate',
    ]);
  });

  it('last-member guard: automatic knob holds its last live member and asks for approval', () => {
    const members = [
      member({ state: 'pending_removal' }),
      member({ id: 'm2', state: 'removed' }),
      member({ id: 'm3', state: 'retired', retiredFrom: 'active' }),
    ];
    const out = evaluate(input({ members, now: d(100) }));
    expect(out.transitions).toEqual([]);
    expect(out.recommendations).toEqual([
      { kind: 'last_member_hold', memberId: 'm1', knobId: 'k1', at: d(100), tickId: 'tick-1' },
    ]);
  });

  it('last-member guard: counts removals earlier in the same tick', () => {
    const members = [
      member({ id: 'm2', state: 'pending_removal' }),
      member({ id: 'm1', state: 'pending_removal' }),
    ];
    const out = evaluate(input({ members, now: d(100) }));
    expect(out.transitions.map((t) => t.memberId)).toEqual(['m1']);
    expect(out.recommendations.map((r) => [r.kind, r.memberId])).toEqual([
      ['last_member_hold', 'm2'],
    ]);
  });

  it('last-member guard: a live sibling lets removal proceed', () => {
    const members = [member({ state: 'pending_removal' }), member({ id: 'm2', lastSeenAt: d(99) })];
    expect(transitionsOf(input({ members, now: d(100) }))).toEqual(['m1:pending_removal->removed']);
  });

  it('last-member guard: raises no approval while another guard also blocks', () => {
    const members = [member({ state: 'pending_removal', cooldownUntil: d(200) })];
    expect(evaluate(input({ members, now: d(100) })).recommendations).toEqual([]);
  });
});

describe('evaluate: shadow mode', () => {
  it('records would-be transitions as shadow and recommends them', () => {
    const out = evaluate(input({ knobs: [knob({ mode: 'shadow' })], now: d(30) }));
    expect(out.transitions.map((t) => [t.to, t.shadow])).toEqual([['stale_candidate', true]]);
    expect(out.recommendations).toEqual([
      {
        kind: 'shadow_transition',
        memberId: 'm1',
        knobId: 'k1',
        from: 'active',
        to: 'stale_candidate',
        at: d(30),
        tickId: 'tick-1',
      },
    ]);
  });

  it('does not apply the last-member guard to a recommendation', () => {
    const out = evaluate(
      input({
        knobs: [knob({ mode: 'shadow' })],
        members: [member({ state: 'pending_removal' })],
        now: d(100),
      }),
    );
    expect(out.transitions.map((t) => [t.to, t.shadow])).toEqual([['removed', true]]);
  });
});

describe('evaluate: determinism', () => {
  it('ignores members of unknown knobs and orders output by knob then member id', () => {
    const knobs = [knob({ id: 'k2' }), knob({ id: 'k1' })];
    const coverage = [healthy('k1'), healthy('k2')];
    const members: Member[] = [
      member({ id: 'b', knobId: 'k2' }),
      member({ id: 'a', knobId: 'k2' }),
      member({ id: 'z', knobId: 'k1' }),
      member({ id: 'x', knobId: 'k9' }),
    ];
    expect(transitionsOf(input({ knobs, coverage, members, now: d(30) }))).toEqual([
      'z:active->stale_candidate',
      'a:active->stale_candidate',
      'b:active->stale_candidate',
    ]);
  });

  it('fails closed on a duplicate knob id: a protected copy is never bypassed', () => {
    const knobs = [knob({ protected: true }), knob()];
    const out = evaluate(input({ knobs, now: d(300) }));
    expect(out.transitions).toEqual([]);
  });

  it('fails closed on a duplicate member id', () => {
    const members = [member(), member({ protected: true })];
    expect(transitionsOf(input({ members, now: d(300) }))).toEqual([]);
  });

  it('merges every coverage entry for a knob, so any flatlined source freezes it', () => {
    const coverage = [healthy(), { knobId: 'k1', sources: [source(dailySignals(0, 5), 0, 'b')] }];
    const out = evaluate(input({ coverage, now: d(300) }));
    expect(out.transitions).toEqual([]);
    expect(out.frozen).toEqual(['k1']);
  });

  it('reports frozen knobs sorted by id', () => {
    const knobs = [knob({ id: 'k2' }), knob({ id: 'k1' }), knob({ id: 'k3' })];
    const out = evaluate(input({ knobs, coverage: [healthy('k3')], members: [] }));
    expect(out.frozen).toEqual(['k1', 'k2']);
  });
});

describe('applyTransitions', () => {
  it('applies evaluate output and is idempotent', () => {
    const i = input({ members: [member(), member({ id: 'm2', lastSeenAt: d(99) })], now: d(30) });
    const { transitions } = evaluate(i);
    const once = applyTransitions(i.members, transitions);
    expect(once.map((m) => [m.id, m.state, m.stateSince])).toEqual([
      ['m1', 'stale_candidate', d(30)],
      ['m2', 'active', d(0)],
    ]);
    expect(applyTransitions(once, transitions)).toEqual(once);
  });

  it('keeps members with a duplicate id distinct', () => {
    const members = [member(), member({ state: 'removed' })];
    expect(applyTransitions(members, [])).toEqual(members);
  });
});
