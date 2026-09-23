import { describe, expect, it } from 'vitest';
import { applySnapshot, memberIdFor } from '../src/index.ts';
import { d, knob, member } from './helpers.ts';

const opts = { knob: knob(), tickId: 'snap-1' };
const snap = (takenAt: number, ...rules: string[]) => ({ knobId: 'k1', takenAt, rules });

describe('applySnapshot', () => {
  it('declares new rules as active members with grace from the snapshot time', () => {
    const out = applySnapshot([], snap(d(5), 'Bash(git *)', 'Read(./src/**)', 'Bash(git *)'), {
      ...opts,
      isProtected: (rule) => rule.startsWith('Read('),
    });
    expect(out.members).toEqual([
      {
        id: memberIdFor('k1', 'Bash(git *)'),
        knobId: 'k1',
        rule: 'Bash(git *)',
        declaredAt: d(5),
        firstSeenAt: null,
        lastSeenAt: null,
        lastRestoredAt: null,
        state: 'active',
        stateSince: d(5),
        cooldownUntil: null,
        restoredCount: 0,
        protected: false,
        retiredFrom: null,
      },
      expect.objectContaining({ rule: 'Read(./src/**)', protected: true }),
    ]);
    expect(out.transitions.map((t) => [t.from, t.to, t.reason, t.tickId])).toEqual([
      [null, 'active', 'declared', 'snap-1'],
      [null, 'active', 'declared', 'snap-1'],
    ]);
  });

  it('declares members unprotected when the backend supplies no default', () => {
    const out = applySnapshot([], snap(d(5), 'Read(./x)'), opts);
    expect(out.members[0]?.protected).toBe(false);
  });

  it('derives collision-free member ids', () => {
    expect(memberIdFor('a', 'b:c')).not.toBe(memberIdFor('a:b', 'c'));
  });

  it('leaves present members untouched and retires vanished ones', () => {
    const kept = member({ id: 'm1', rule: 'keep', lastSeenAt: d(3) });
    const gone = member({ id: 'm2', rule: 'gone', state: 'pending_removal', stateSince: d(50) });
    const elsewhere = member({ id: 'm3', knobId: 'k2', rule: 'other' });
    const out = applySnapshot([kept, gone, elsewhere], snap(d(60), 'keep'), opts);
    expect(out.members[0]).toBe(kept);
    expect(out.members[1]).toMatchObject({
      state: 'retired',
      retiredFrom: 'pending_removal',
      stateSince: d(60),
    });
    expect(out.members[2]).toBe(elsewhere);
    expect(out.transitions.map((t) => [t.memberId, t.from, t.to, t.reason])).toEqual([
      ['m2', 'pending_removal', 'retired', 'vanished'],
    ]);
  });

  it('re-declares a returning rule as a fresh active member', () => {
    const m = member({ state: 'retired', retiredFrom: 'pending_removal', stateSince: d(60) });
    const out = applySnapshot([m], snap(d(70), m.rule), {
      ...opts,
      knob: knob({ mode: 'shadow' }),
    });
    expect(out.members[0]).toMatchObject({
      state: 'active',
      declaredAt: d(70),
      stateSince: d(70),
      retiredFrom: null,
    });
    expect(out.transitions.map((t) => [t.from, t.to, t.reason, t.shadow])).toEqual([
      ['retired', 'active', 'redeclared', true],
    ]);
  });

  it('returns a rule retired while removed to removed: only a re-grant exits removed', () => {
    const m = member({ state: 'retired', retiredFrom: 'removed', stateSince: d(60) });
    const out = applySnapshot([m], snap(d(70), m.rule), opts);
    expect(out.members[0]).toMatchObject({ state: 'removed', declaredAt: d(0), retiredFrom: null });
    expect(out.transitions.map((t) => [t.from, t.to])).toEqual([['retired', 'removed']]);
  });

  it('keeps a retired member retired while its rule stays absent', () => {
    const m = member({ state: 'retired', retiredFrom: 'active' });
    const out = applySnapshot([m], snap(d(70)), opts);
    expect(out).toEqual({ members: [m], transitions: [] });
  });

  it('never records a transition before the state it leaves', () => {
    const m = member({ state: 'stale_candidate', stateSince: d(80) });
    const out = applySnapshot([m], snap(d(70)), opts);
    expect(out.transitions[0]?.at).toBe(d(80));
  });
});
