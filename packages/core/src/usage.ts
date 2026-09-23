// Loosening paths (HANDOFF P4, P7): usage restores instantly and stamps a cooldown; `removed`
// exits only through regrant(). In a shadow knob `removed` is a recommendation, and usage withdraws
// it (ADR-0004). Timestamps never move backwards, and a restore is never recorded before the state
// it leaves.

import { DAY_MS } from './clock.ts';
import { cmp } from './order.ts';
import { resolveThresholds } from './thresholds.ts';
import type { Actor, Config, Knob, LiveState, Member, Transition, UsageEvent } from './types.ts';

export interface UsageContext {
  readonly knobs: readonly Knob[];
  readonly config: Config;
}

export interface UsageOutput<M extends Member> {
  readonly members: M[];
  readonly transitions: Transition[];
}

const maxOf = (a: number | null, b: number): number => (a === null ? b : Math.max(a, b));
const cooldownMs = (knob: Knob | undefined, config: Config): number =>
  (knob === undefined ? config.thresholds : resolveThresholds(config, knob)).cooldownDays * DAY_MS;

function restore<M extends Member>(member: M, at: number, cooldown: number): M {
  return {
    ...member,
    state: 'active',
    stateSince: at,
    lastRestoredAt: at,
    cooldownUntil: maxOf(member.cooldownUntil, at + cooldown),
    restoredCount: member.restoredCount + 1,
  };
}

export function applyUsage<M extends Member>(
  members: readonly M[],
  events: readonly UsageEvent[],
  ctx: UsageContext,
): UsageOutput<M> {
  const transitions: Transition[] = [];
  const ordered = [...events].sort((a, b) => a.at - b.at || cmp(a.eventId, b.eventId));

  const out = members.map((member) => {
    const copies = ctx.knobs.filter((k) => k.id === member.knobId);
    // Only an unambiguously shadow knob may withdraw a removal (invariant 5).
    const shadow = copies.length > 0 && copies.every((k) => k.mode === 'shadow');
    const cooldown = cooldownMs(copies[0], ctx.config);
    let m = member;
    for (const event of ordered) {
      if (!event.memberIds.includes(m.id) || m.state === 'retired') continue;
      if (m.state === 'removed' && !shadow) continue;
      let next: M = {
        ...m,
        firstSeenAt: m.firstSeenAt === null ? event.at : Math.min(m.firstSeenAt, event.at),
        lastSeenAt: maxOf(m.lastSeenAt, event.at),
        cooldownUntil: maxOf(m.cooldownUntil, event.at + cooldown),
      };
      if (m.state !== 'active') {
        const at = Math.max(event.at, m.stateSince);
        next = restore(next, at, cooldown);
        transitions.push({
          memberId: m.id,
          knobId: m.knobId,
          from: m.state,
          to: 'active',
          at,
          reason: 'usage',
          actor: 'user',
          shadow,
          tickId: `usage:${event.eventId}`,
          evidence: { eventId: event.eventId },
        });
      }
      m = next;
    }
    return m;
  });
  // Ledger order: by time; ties keep member order.
  return { members: out, transitions: transitions.sort((a, b) => a.at - b.at) };
}

export interface RegrantRequest<M extends Member> {
  readonly member: M;
  readonly knob: Knob;
  readonly config: Config;
  readonly at: number;
  readonly actor: Actor;
  readonly requestId: string;
}

/**
 * Applies an approved re-grant (the ladder that approved it lives outside core). `removed` goes
 * through the transient `restored`; `stale_candidate`/`pending_removal` go straight to `active`.
 */
export function regrant<M extends Member>(
  req: RegrantRequest<M>,
): { member: M; transitions: Transition[] } {
  const { member, knob, actor, requestId } = req;
  if (member.state === 'active' || member.state === 'retired') {
    return { member, transitions: [] };
  }
  const at = Math.max(req.at, member.stateSince);
  const base = {
    memberId: member.id,
    knobId: member.knobId,
    at,
    actor,
    shadow: knob.mode === 'shadow',
    tickId: `regrant:${requestId}`,
    evidence: { requestId },
  };
  const from: LiveState = member.state;
  const transitions: Transition[] =
    from === 'removed'
      ? [
          { ...base, from, to: 'restored', reason: 'regrant' },
          { ...base, from: 'restored', to: 'active', reason: 'restored' },
        ]
      : [{ ...base, from, to: 'active', reason: 'regrant' }];
  return { member: restore(member, at, cooldownMs(knob, req.config)), transitions };
}
