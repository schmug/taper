import { describe, expect, it } from 'vitest';
import type { Transition } from '../src/index.ts';
import { applyUsage, evaluate, explain } from '../src/index.ts';
import { CONFIG, d, dailySignals, input, knob, member, source } from './helpers.ts';

const base = input();
const ledgerFor = (...transitions: Transition[]) => transitions;

describe('explain', () => {
  it('explains a due, unblocked member from the same assessment evaluate uses', () => {
    const i = input({ now: d(30) });
    const [t] = evaluate(i).transitions;
    const other: Transition = { ...(t as Transition), memberId: 'm2' };
    const x = explain({ ...i, memberId: 'm1', ledger: ledgerFor(other, t as Transition) });
    expect(x).toEqual({
      memberId: 'm1',
      knobId: 'k1',
      rule: 'rule:m1',
      state: 'active',
      stateSince: d(0),
      mode: 'automatic',
      protected: false,
      anchor: { at: d(0), basis: 'declared' },
      clock: { kind: 'wall', staleDays: 30, frozen: false, coveredSince: d(0), mature: true },
      next: { state: 'stale_candidate', thresholdDays: 30, remainingDays: 0 },
      due: true,
      blockedBy: [],
      enforcement: null,
      history: [t],
    });
  });

  it('reports every guard holding the member and the remaining clock days', () => {
    const coverage = [{ knobId: 'k1', sources: [source(dailySignals(0, 20))] }];
    const m = member({ protected: true, cooldownUntil: d(40), lastSeenAt: d(10) });
    const x = explain({ ...base, coverage, members: [m], now: d(30), memberId: 'm1', ledger: [] });
    expect(x?.blockedBy).toEqual(['protected', 'frozen', 'cooldown', 'immature']);
    expect(x?.protected).toBe(true);
    expect(x?.anchor).toEqual({ at: d(10), basis: 'last_seen' });
    expect(x?.next).toEqual({ state: 'stale_candidate', thresholdDays: 30, remainingDays: 19.5 });
    expect(x?.clock).toMatchObject({ frozen: true, coveredSince: null, mature: false });
  });

  it('names the last-member guard and the enforcement in force', () => {
    const members = [member({ state: 'pending_removal', lastRestoredAt: d(20) })];
    const x = explain({ ...base, members, memberId: 'm1', ledger: [] });
    expect(x?.blockedBy).toEqual(['last_member']);
    expect(x?.anchor.basis).toBe('restored');
    expect(x?.enforcement).toBe('prompt');
  });

  it('has no next step for removed or retired members', () => {
    const members = [member({ state: 'removed' })];
    const x = explain({ ...base, members, memberId: 'm1', ledger: [] });
    expect(x?.next).toBeNull();
    expect(x?.due).toBe(false);
    expect(x?.enforcement).toBe('block');
  });

  it('orders history by time, keeping ledger order for ties', () => {
    const m = member({ state: 'stale_candidate' });
    const { transitions } = applyUsage(
      [m],
      [
        { eventId: 'e1', at: d(50), memberIds: ['m1'] },
        { eventId: 'e0', at: d(40), memberIds: ['m1'] },
      ],
      { knobs: [knob()], config: CONFIG },
    );
    const late = { ...(transitions[0] as Transition), at: d(10), tickId: 'late' };
    const tie = { ...late, tickId: 'tie' };
    const x = explain({ ...base, memberId: 'm1', ledger: [...transitions, late, tie] });
    expect(x?.history.map((t) => t.tickId)).toEqual(['late', 'tie', 'usage:e0']);
  });

  it('returns null for an unknown member or a member of an unknown knob', () => {
    expect(explain({ ...base, memberId: 'nope', ledger: [] })).toBeNull();
    const members = [member({ knobId: 'k9' })];
    expect(explain({ ...base, members, memberId: 'm1', ledger: [] })).toBeNull();
  });
});
