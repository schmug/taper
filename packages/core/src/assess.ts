// Per-member guard evaluation shared by evaluate() and explain(), so what the engine does and what
// it says it would do cannot drift apart.

import { type Clock, makeClock } from './clock.ts';
import { resolveThresholds } from './thresholds.ts';
import type {
  Config,
  Guard,
  Knob,
  KnobCoverage,
  LiveState,
  Member,
  MemberState,
  Thresholds,
} from './types.ts';

const NEXT: Partial<Record<MemberState, LiveState>> = {
  active: 'stale_candidate',
  stale_candidate: 'pending_removal',
  pending_removal: 'removed',
};

export const isLive = (state: MemberState): boolean => state !== 'removed' && state !== 'retired';

export interface KnobContext {
  readonly knob: Knob;
  readonly thresholds: Thresholds;
  readonly clock: Clock;
  /** Ledger maturity: the covered stretch reaching `now` spans at least `maturityDays`. */
  readonly mature: boolean;
}

export function knobContext(
  knob: Knob,
  coverage: readonly KnobCoverage[],
  now: number,
  config: Config,
): KnobContext {
  const thresholds = resolveThresholds(config, knob);
  const sources = coverage.filter((c) => c.knobId === knob.id).flatMap((c) => c.sources);
  const clock = makeClock(
    knob.clock,
    { knobId: knob.id, sources },
    now,
    thresholds.deadmanWindowDays,
  );
  const mature =
    clock.coveredSince !== null && clock.elapsed(clock.coveredSince) >= thresholds.maturityDays;
  return { knob, thresholds, clock, mature };
}

export interface Assessment {
  /** The one state a tightening step would move to; null for removed/retired. */
  readonly next: LiveState | null;
  /** max(declaredAt, lastSeenAt, lastRestoredAt): staleness is measured from here. */
  readonly anchorAt: number;
  readonly staleDays: number;
  readonly thresholdDays: number | null;
  readonly due: boolean;
  /** Every guard currently holding the member, in a fixed order. */
  readonly blockedBy: readonly Guard[];
}

/** `liveMembers` = members of the knob not removed or retired, including this one. */
export function assess(member: Member, ctx: KnobContext, liveMembers: number): Assessment {
  const { knob, thresholds, clock } = ctx;
  const anchorAt = Math.max(
    member.declaredAt,
    member.lastSeenAt ?? Number.NEGATIVE_INFINITY,
    member.lastRestoredAt ?? Number.NEGATIVE_INFINITY,
  );
  const staleDays = clock.elapsed(anchorAt);
  const next = NEXT[member.state] ?? null;
  const thresholdDays =
    next === 'stale_candidate'
      ? thresholds.t1Days
      : next === 'pending_removal'
        ? thresholds.t2Days
        : next === 'removed'
          ? thresholds.t3Days
          : null;
  const due = thresholdDays !== null && staleDays >= thresholdDays;

  const blockedBy: Guard[] = [];
  if (knob.protected || member.protected) blockedBy.push('protected');
  if (clock.frozen) blockedBy.push('frozen');
  if (member.cooldownUntil !== null && !(clock.now >= member.cooldownUntil)) {
    blockedBy.push('cooldown');
  }
  if (member.state === 'active' && !ctx.mature) blockedBy.push('immature');
  if (next === 'removed' && knob.mode === 'automatic' && liveMembers <= 1) {
    blockedBy.push('last_member');
  }
  return { next, anchorAt, staleDays, thresholdDays, due, blockedBy };
}
