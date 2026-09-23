import type {
  Config,
  EvaluateInput,
  Knob,
  KnobCoverage,
  Member,
  Signal,
  SourceCoverage,
} from '../src/index.ts';
import { DEFAULT_THRESHOLDS } from '../src/index.ts';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
/** 2026-01-01T00:00:00Z. */
export const T0 = 1_767_225_600_000;
/** Midnight UTC of day `n` after T0, plus optional hours. */
export const d = (n: number, hours = 0): number => T0 + n * DAY + hours * HOUR;

export const CONFIG: Config = { thresholds: DEFAULT_THRESHOLDS };

export function knob(overrides: Partial<Knob> = {}): Knob {
  return { id: 'k1', mode: 'automatic', protected: false, clock: 'wall', ...overrides };
}

export function member(overrides: Partial<Member> = {}): Member {
  const id = overrides.id ?? 'm1';
  return {
    id,
    knobId: 'k1',
    rule: `rule:${id}`,
    declaredAt: d(0),
    firstSeenAt: null,
    lastSeenAt: null,
    lastRestoredAt: null,
    state: 'active',
    stateSince: d(0),
    cooldownUntil: null,
    restoredCount: 0,
    protected: false,
    retiredFrom: null,
    ...overrides,
  };
}

/** One signal of each kind at noon on every day in [fromDay, toDay]. */
export function dailySignals(
  fromDay: number,
  toDay: number,
  kinds: ReadonlyArray<Signal['kind']> = ['session', 'decision'],
): Signal[] {
  const signals: Signal[] = [];
  for (let n = fromDay; n <= toDay; n++) {
    for (const kind of kinds) signals.push({ at: d(n, 12), kind });
  }
  return signals;
}

export function source(
  signals: readonly Signal[],
  sinceDay = 0,
  sourceId = 'dev1',
): SourceCoverage {
  return { sourceId, since: d(sinceDay), signals };
}

/** A knob whose single source reports sessions and decisions every day in [0, toDay]. */
export function healthy(knobId = 'k1', toDay = 400): KnobCoverage {
  return { knobId, sources: [source(dailySignals(0, toDay))] };
}

export function input(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    knobs: [knob()],
    members: [member()],
    coverage: [healthy()],
    now: d(100),
    tickId: 'tick-1',
    config: CONFIG,
    ...overrides,
  };
}
