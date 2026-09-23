// Clocks and the dead-man switch (HANDOFF §4.2–4.3, ADR-0005). A clock measures how much
// "unused time" a member accrues. Time the knob could not observe is blind and never accrues:
//   - before the knob's first source started reporting (uncovered),
//   - wall only: a heartbeat gap longer than the window (the whole gap, retroactively),
//   - both clocks: sessions arriving without a decision for longer than the window (degraded).
// A knob is frozen when `now` is blind. Comparisons are written to fail closed on NaN.

import type { ClockKind, KnobCoverage, SourceCoverage } from './types.ts';

export const DAY_MS = 86_400_000;

export interface Clock {
  readonly kind: ClockKind;
  readonly now: number;
  /** Dead-man state at `now`. A frozen clock never justifies a tightening transition. */
  readonly frozen: boolean;
  /** Start of the unbroken covered stretch that reaches `now`; null when frozen. */
  readonly coveredSince: number | null;
  /** Clock days accrued in (from, now]: wall days minus blind time, or active session days. */
  elapsed(from: number): number;
}

type Interval = readonly [start: number, end: number];

const sorted = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

/** Between consecutive decisions: blind from the first session once it waited past the window. */
function degraded(
  decisions: number[],
  sessions: number[],
  now: number,
  windowMs: number,
): Interval[] {
  const blind: Interval[] = [];
  let j = 0;
  for (let i = 0; i < decisions.length; i++) {
    const from = decisions[i] as number;
    const next = decisions[i + 1];
    while (j < sessions.length && (sessions[j] as number) <= from) j++;
    const first = sessions[j];
    if (first === undefined || (next !== undefined && first >= next)) continue;
    const end = next ?? now;
    if (!(end - first <= windowMs)) blind.push([first, next ?? Number.POSITIVE_INFINITY]);
  }
  return blind;
}

function heartbeatGaps(heartbeats: number[], now: number, windowMs: number): Interval[] {
  const blind: Interval[] = [];
  for (let i = 0; i < heartbeats.length; i++) {
    const from = heartbeats[i] as number;
    const next = heartbeats[i + 1];
    const end = next ?? now;
    if (!(end - from <= windowMs)) blind.push([from, next ?? Number.POSITIVE_INFINITY]);
  }
  return blind;
}

function sourceBlind(
  source: SourceCoverage,
  kind: ClockKind,
  now: number,
  windowMs: number,
): Interval[] {
  const seen = source.signals.filter((s) => s.at > source.since && s.at <= now);
  const at = (kinds: readonly string[]) =>
    sorted([source.since, ...seen.filter((s) => kinds.includes(s.kind)).map((s) => s.at)]);
  const sessions = sorted(seen.filter((s) => s.kind === 'session').map((s) => s.at));
  const blind = degraded(at(['decision']), sessions, now, windowMs);
  if (kind === 'wall') blind.push(...heartbeatGaps(at(['heartbeat', 'session']), now, windowMs));
  return blind;
}

function merge(intervals: Interval[]): Interval[] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const dayOf = (t: number): number => Math.floor(t / DAY_MS);

export function makeClock(
  kind: ClockKind,
  coverage: KnobCoverage | undefined,
  now: number,
  deadmanWindowDays: number,
): Clock {
  const sources = coverage?.sources ?? [];
  const windowMs = deadmanWindowDays * DAY_MS;
  const start = Math.min(...sources.map((s) => s.since));
  const blind = merge([
    [Number.NEGATIVE_INFINITY, Number.isFinite(start) ? start : Number.POSITIVE_INFINITY],
    ...sources.flatMap((s) => sourceBlind(s, kind, now, windowMs)),
  ]);
  const isBlind = (t: number) => blind.some(([s, e]) => s <= t && t < e);
  const frozen = isBlind(now);
  const coveredSince = frozen
    ? null
    : Math.max(...blind.filter(([, e]) => e <= now).map(([, e]) => e));

  const blindMs = (from: number): number =>
    blind.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, now) - Math.max(s, from)), 0);

  const sessionDays = (from: number): number => {
    const days = new Set<number>();
    for (const source of sources) {
      for (const signal of source.signals) {
        const { at } = signal;
        if (signal.kind !== 'session' || at <= source.since || at <= from || at > now) continue;
        if (isBlind(at)) continue;
        if (dayOf(at) > dayOf(from)) days.add(dayOf(at));
      }
    }
    return days.size;
  };

  return {
    kind,
    now,
    frozen,
    coveredSince,
    elapsed(from) {
      if (!(from < now)) return 0;
      return kind === 'wall' ? (now - from - blindMs(from)) / DAY_MS : sessionDays(from);
    },
  };
}
