// Reconciles a knob's members with a snapshot of its declared rules (HANDOFF §5.2, ADR-0004).
// A new rule is declared `active` with grace from the snapshot time. A vanished rule is `retired`,
// never `removed`: the human deleted it, taper did not. A returning rule is re-declared `active`,
// except one retired while `removed`, which returns to `removed` because only a re-grant exits
// `removed` (invariant 5). Rules are compared as exact strings; normalization is the backend's.

import type { Knob, KnobId, Member, MemberId, Transition } from './types.ts';

export interface Snapshot {
  readonly knobId: KnobId;
  readonly takenAt: number;
  readonly rules: readonly string[];
}

export interface SnapshotOptions {
  readonly knob: Knob;
  readonly tickId: string;
  /** Backend-specific default protection for newly declared members. */
  readonly isProtected?: (rule: string) => boolean;
}

export const memberIdFor = (knobId: KnobId, rule: string): MemberId =>
  JSON.stringify([knobId, rule]);

export function applySnapshot(
  members: readonly Member[],
  snapshot: Snapshot,
  opts: SnapshotOptions,
): { members: Member[]; transitions: Transition[] } {
  const { knobId, takenAt } = snapshot;
  const declared = new Set(snapshot.rules);
  const transitions: Transition[] = [];
  const record = (m: Member, from: Transition['from'], to: Member['state'], at: number) => {
    const reason = from === null ? 'declared' : from === 'retired' ? 'redeclared' : 'vanished';
    transitions.push({
      memberId: m.id,
      knobId,
      from,
      to,
      at,
      reason,
      actor: 'system',
      shadow: opts.knob.mode === 'shadow',
      tickId: opts.tickId,
      evidence: { takenAt },
    });
  };

  const out = members.map((m): Member => {
    if (m.knobId !== knobId) return m;
    const present = declared.has(m.rule);
    declared.delete(m.rule);
    const at = Math.max(takenAt, m.stateSince);
    if (m.state === 'retired') {
      if (!present) return m;
      const to = m.retiredFrom === 'removed' ? 'removed' : 'active';
      record(m, 'retired', to, at);
      const fresh = to === 'active' ? { declaredAt: takenAt } : {};
      return { ...m, ...fresh, state: to, stateSince: at, retiredFrom: null };
    }
    if (present) return m;
    record(m, m.state, 'retired', at);
    return { ...m, state: 'retired', stateSince: at, retiredFrom: m.state };
  });

  for (const rule of declared) {
    const m: Member = {
      id: memberIdFor(knobId, rule),
      knobId,
      rule,
      declaredAt: takenAt,
      firstSeenAt: null,
      lastSeenAt: null,
      lastRestoredAt: null,
      state: 'active',
      stateSince: takenAt,
      cooldownUntil: null,
      restoredCount: 0,
      protected: opts.isProtected?.(rule) ?? false,
      retiredFrom: null,
    };
    record(m, null, 'active', takenAt);
    out.push(m);
  }
  return { members: out, transitions };
}
