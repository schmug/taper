// explain(): the member's ledger history plus the same guard assessment evaluate() runs
// (invariant 9). Structured, no prose: a NarrativeProvider renders it. Deterministic.

import { assess, isLive, knobContext } from './assess.ts';
import { enforcement } from './enforcement.ts';
import type {
  ClockKind,
  EnforcementAction,
  EvaluateInput,
  Guard,
  KnobId,
  LiveState,
  MemberId,
  MemberState,
  Mode,
  Transition,
} from './types.ts';

export interface ExplainInput extends Omit<EvaluateInput, 'tickId'> {
  readonly memberId: MemberId;
  readonly ledger: readonly Transition[];
}

export interface Explanation {
  readonly memberId: MemberId;
  readonly knobId: KnobId;
  readonly rule: string;
  readonly state: MemberState;
  readonly stateSince: number;
  readonly mode: Mode;
  /** Member or knob protection. */
  readonly protected: boolean;
  readonly anchor: { readonly at: number; readonly basis: 'last_seen' | 'restored' | 'declared' };
  readonly clock: {
    readonly kind: ClockKind;
    readonly staleDays: number;
    readonly frozen: boolean;
    readonly coveredSince: number | null;
    readonly mature: boolean;
  };
  readonly next: {
    readonly state: LiveState;
    readonly thresholdDays: number;
    /** Clock days until due, ignoring guards. */
    readonly remainingDays: number;
  } | null;
  readonly due: boolean;
  /** Empty and `due` together mean the next evaluate() tick moves this member. */
  readonly blockedBy: readonly Guard[];
  readonly enforcement: EnforcementAction['action'] | null;
  /** This member's ledger entries, by time; ties keep ledger order. */
  readonly history: readonly Transition[];
}

export function explain(input: ExplainInput): Explanation | null {
  const member = input.members.find((m) => m.id === input.memberId);
  const knob = input.knobs.find((k) => k.id === member?.knobId);
  if (member === undefined || knob === undefined) return null;

  const ctx = knobContext(knob, input.coverage, input.now, input.config);
  const live = input.members.filter((m) => m.knobId === knob.id && isLive(m.state)).length;
  const a = assess(member, ctx, live);
  const basis =
    a.anchorAt === member.lastSeenAt
      ? 'last_seen'
      : a.anchorAt === member.lastRestoredAt
        ? 'restored'
        : 'declared';

  return {
    memberId: member.id,
    knobId: knob.id,
    rule: member.rule,
    state: member.state,
    stateSince: member.stateSince,
    mode: knob.mode,
    protected: knob.protected || member.protected,
    anchor: { at: a.anchorAt, basis },
    clock: {
      kind: knob.clock,
      staleDays: a.staleDays,
      frozen: ctx.clock.frozen,
      coveredSince: ctx.clock.coveredSince,
      mature: ctx.mature,
    },
    next:
      a.next === null || a.thresholdDays === null
        ? null
        : {
            state: a.next,
            thresholdDays: a.thresholdDays,
            remainingDays: Math.max(0, a.thresholdDays - a.staleDays),
          },
    due: a.due,
    blockedBy: a.blockedBy,
    enforcement: enforcement(input.knobs, [member])[0]?.action ?? null,
    history: input.ledger.filter((t) => t.memberId === member.id).sort((x, y) => x.at - y.at),
  };
}
