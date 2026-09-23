// evaluate(): one deterministic tick (HANDOFF §4). Each member moves at most one state per tick,
// and only when it is due and no guard holds it. Output order is by knob id, then member id, so
// the result does not depend on input order. Ambiguous input (duplicate knob or member ids) fails
// closed: those members do not move.

import { assess, isLive, knobContext } from './assess.ts';
import { byId } from './order.ts';
import type {
  EvaluateInput,
  EvaluateOutput,
  KnobId,
  LiveState,
  Member,
  Recommendation,
  Transition,
} from './types.ts';

function duplicates(ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return dup;
}

export function evaluate(input: EvaluateInput): EvaluateOutput {
  const { now, tickId } = input;
  const transitions: Transition[] = [];
  const recommendations: Recommendation[] = [];
  const frozen: KnobId[] = [];
  const dupKnobs = duplicates(input.knobs.map((k) => k.id));
  const dupMembers = duplicates(input.members.map((m) => m.id));

  for (const knob of [...input.knobs].sort(byId)) {
    const ctx = knobContext(knob, input.coverage, now, input.config);
    if (ctx.clock.frozen && !frozen.includes(knob.id)) frozen.push(knob.id);
    if (dupKnobs.has(knob.id)) continue;

    const members = input.members.filter((m) => m.knobId === knob.id).sort(byId);
    let live = members.filter((m) => isLive(m.state)).length;
    for (const member of members) {
      const a = assess(member, ctx, live);
      if (a.next === null || !a.due || dupMembers.has(member.id)) continue;
      if (a.blockedBy.length > 0) {
        if (a.blockedBy.length === 1 && a.blockedBy[0] === 'last_member') {
          recommendations.push({
            kind: 'last_member_hold',
            memberId: member.id,
            knobId: knob.id,
            at: now,
            tickId,
          });
        }
        continue;
      }
      const shadow = knob.mode === 'shadow';
      const from = member.state as LiveState;
      transitions.push({
        memberId: member.id,
        knobId: knob.id,
        from,
        to: a.next,
        at: now,
        reason: 'unused',
        actor: 'system',
        shadow,
        tickId,
        evidence: {
          clock: knob.clock,
          staleDays: a.staleDays,
          thresholdDays: a.thresholdDays,
          anchorAt: a.anchorAt,
        },
      });
      if (shadow) {
        recommendations.push({
          kind: 'shadow_transition',
          memberId: member.id,
          knobId: knob.id,
          from,
          to: a.next,
          at: now,
          tickId,
        });
      }
      if (a.next === 'removed') live--;
    }
  }
  return { transitions, recommendations, frozen };
}

/**
 * Applies evaluate() output to members. A transition applies only while the member is still in
 * its `from` state, so re-applying the same transitions is a no-op (idempotent per
 * member/from/to/tick). Transitions through the transient `restored` are skipped: regrant(),
 * applyUsage(), and applySnapshot() return updated members themselves.
 */
export function applyTransitions<M extends Member>(
  members: readonly M[],
  transitions: readonly Transition[],
): M[] {
  return members.map((member) => {
    let m = member;
    for (const t of transitions) {
      if (t.memberId === m.id && t.from === m.state && t.to !== 'restored') {
        m = { ...m, state: t.to, stateSince: t.at };
      }
    }
    return m;
  });
}
