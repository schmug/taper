import { describe, expect, it } from 'vitest';
import type { Member, UsageEvent } from '../src/index.ts';
import { applyUsage, regrant } from '../src/index.ts';
import { CONFIG, DAY, d, knob, member } from './helpers.ts';

const ctx = { knobs: [knob()], config: CONFIG };
const use = (eventId: string, at: number, ...memberIds: string[]): UsageEvent => ({
  eventId,
  at,
  memberIds,
});
const only = (members: readonly Member[]): Member => members[0] as Member;

describe('applyUsage', () => {
  it('refreshes an active member and stamps a cooldown without a transition', () => {
    const out = applyUsage([member()], [use('e1', d(10), 'm1')], ctx);
    expect(out.transitions).toEqual([]);
    expect(only(out.members)).toMatchObject({
      state: 'active',
      firstSeenAt: d(10),
      lastSeenAt: d(10),
      cooldownUntil: d(24),
      restoredCount: 0,
      lastRestoredAt: null,
    });
  });

  it.each(['stale_candidate', 'pending_removal'] as const)('restores %s instantly', (state) => {
    const m = member({ state, stateSince: d(40) });
    const out = applyUsage([m], [use('e1', d(50), 'm1')], ctx);
    expect(out.transitions).toEqual([
      {
        memberId: 'm1',
        knobId: 'k1',
        from: state,
        to: 'active',
        at: d(50),
        reason: 'usage',
        actor: 'user',
        shadow: false,
        tickId: 'usage:e1',
        evidence: { eventId: 'e1' },
      },
    ]);
    expect(only(out.members)).toMatchObject({
      state: 'active',
      stateSince: d(50),
      lastSeenAt: d(50),
      lastRestoredAt: d(50),
      cooldownUntil: d(64),
      restoredCount: 1,
    });
  });

  it('never restores a removed member of an automatic knob', () => {
    const m = member({ state: 'removed' });
    const out = applyUsage([m], [use('e1', d(50), 'm1')], ctx);
    expect(out.transitions).toEqual([]);
    expect(out.members).toEqual([m]);
  });

  it('withdraws a shadow removal on usage', () => {
    const m = member({ state: 'removed', stateSince: d(60) });
    const out = applyUsage([m], [use('e1', d(70), 'm1')], {
      knobs: [knob({ mode: 'shadow' })],
      config: CONFIG,
    });
    expect(out.transitions.map((t) => [t.from, t.to, t.shadow])).toEqual([
      ['removed', 'active', true],
    ]);
    expect(only(out.members).state).toBe('active');
  });

  it('keeps a removed member removed when its knob id is listed as both shadow and automatic', () => {
    const m = member({ state: 'removed' });
    const knobs = [knob({ mode: 'shadow' }), knob()];
    const out = applyUsage([m], [use('e1', d(70), 'm1')], { knobs, config: CONFIG });
    expect(out.members).toEqual([m]);
  });

  it('ignores retired members, unknown ids, and duplicate ids within an event', () => {
    const retired = member({ state: 'retired', retiredFrom: 'active' });
    const stale = member({ id: 'm2', state: 'stale_candidate' });
    const out = applyUsage([retired, stale], [use('e1', d(50), 'm1', 'zz', 'm2', 'm2')], ctx);
    expect(out.members[0]).toEqual(retired);
    expect(out.transitions.map((t) => t.memberId)).toEqual(['m2']);
    expect(out.members[1]?.restoredCount).toBe(1);
  });

  it('processes events in time order whatever the input order', () => {
    const m = member({ state: 'stale_candidate' });
    const events = [use('e2', d(60), 'm1'), use('e1', d(50), 'm1'), use('e0', d(50), 'm1')];
    const out = applyUsage([m], events, ctx);
    expect(out.transitions.map((t) => t.tickId)).toEqual(['usage:e0']);
    expect(only(out.members)).toMatchObject({
      firstSeenAt: d(50),
      lastSeenAt: d(60),
      cooldownUntil: d(74),
    });
  });

  it('never moves timestamps backwards for a late event; the cooldown runs from the restore', () => {
    const m = member({
      state: 'pending_removal',
      stateSince: d(60),
      firstSeenAt: d(20),
      lastSeenAt: d(30),
      cooldownUntil: d(44),
    });
    const out = applyUsage([m], [use('late', d(25), 'm1')], ctx);
    expect(out.transitions[0]?.at).toBe(d(60));
    expect(only(out.members)).toMatchObject({
      state: 'active',
      stateSince: d(60),
      firstSeenAt: d(20),
      lastSeenAt: d(30),
      lastRestoredAt: d(60),
      cooldownUntil: d(74),
    });
  });

  it('uses per-knob cooldown, and org defaults for a member of an unknown knob', () => {
    const k = knob({ thresholds: { cooldownDays: 3 } });
    const other = member({ id: 'm2', knobId: 'k9' });
    const out = applyUsage([member(), other], [use('e1', d(10), 'm1', 'm2')], {
      knobs: [k],
      config: CONFIG,
    });
    expect(out.members.map((m) => m.cooldownUntil)).toEqual([d(13), d(24)]);
  });

  it('keeps members with a duplicate id distinct', () => {
    const members = [member(), member({ state: 'removed' })];
    expect(applyUsage(members, [], ctx).members).toEqual(members);
  });

  it('does not mutate its inputs', () => {
    const members = Object.freeze([Object.freeze(member({ state: 'stale_candidate' }))]);
    const events = Object.freeze([Object.freeze(use('e1', d(50), 'm1'))]);
    expect(() => applyUsage(members, events, ctx)).not.toThrow();
    expect(members[0]?.state).toBe('stale_candidate');
  });
});

describe('regrant', () => {
  const request = { at: d(90), actor: 'admin' as const, requestId: 'r1', config: CONFIG };

  it('moves removed through restored to active with a cooldown', () => {
    const m = member({ state: 'removed', stateSince: d(60) });
    const out = regrant({ ...request, member: m, knob: knob() });
    expect(out.transitions.map((t) => [t.from, t.to, t.reason, t.actor, t.tickId])).toEqual([
      ['removed', 'restored', 'regrant', 'admin', 'regrant:r1'],
      ['restored', 'active', 'restored', 'admin', 'regrant:r1'],
    ]);
    expect(out.transitions[0]?.evidence).toEqual({ requestId: 'r1' });
    expect(out.member).toMatchObject({
      state: 'active',
      stateSince: d(90),
      lastRestoredAt: d(90),
      cooldownUntil: d(90) + 14 * DAY,
      restoredCount: 1,
      lastSeenAt: null,
    });
  });

  it('approves a pending member straight back to active', () => {
    const m = member({ state: 'pending_removal', stateSince: d(45) });
    const out = regrant({ ...request, member: m, knob: knob({ mode: 'shadow' }), actor: 'user' });
    expect(out.transitions.map((t) => [t.from, t.to, t.shadow])).toEqual([
      ['pending_removal', 'active', true],
    ]);
    expect(out.member.state).toBe('active');
  });

  it.each(['active', 'retired'] as const)('is a no-op for a %s member', (state) => {
    const m = member({ state });
    const out = regrant({ ...request, member: m, knob: knob() });
    expect(out).toEqual({ member: m, transitions: [] });
  });

  it('never records a restore before the state it leaves', () => {
    const m = member({ state: 'removed', stateSince: d(95), cooldownUntil: d(200) });
    const out = regrant({ ...request, member: m, knob: knob() });
    expect(out.transitions.map((t) => t.at)).toEqual([d(95), d(95)]);
    expect(out.member.cooldownUntil).toBe(d(200));
  });
});
