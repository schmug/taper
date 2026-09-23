// fast-check generators for engine inputs. Small id pools force collisions between knobs,
// members, and coverage; thresholds include NaN, Infinity, and negatives so guard totality is
// tested against malformed config, not just sane defaults.
import fc from 'fast-check';
import type {
  Config,
  EvaluateInput,
  Knob,
  KnobCoverage,
  LiveState,
  Member,
  MemberState,
  Signal,
  SourceCoverage,
  Thresholds,
  UsageEvent,
} from '../src/index.ts';
import { d, dailySignals, HOUR, T0 } from './helpers.ts';

export const KNOB_IDS = ['k1', 'k2', 'k3'] as const;
const MEMBER_IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] as const;
const LIVE: readonly LiveState[] = ['active', 'stale_candidate', 'pending_removal', 'removed'];
const STATES: readonly MemberState[] = [...LIVE, 'retired'];

/** A time within days [from, to] after T0, hour resolution. */
const time = (to = 200, from = 0) =>
  fc.integer({ min: from * 24, max: to * 24 }).map((h) => T0 + h * HOUR);

const days = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 0, max: 60 }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5) },
);

const rarely = fc.oneof(
  { weight: 4, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);

const thresholds: fc.Arbitrary<Thresholds> = fc.record({
  t1Days: days,
  t2Days: days,
  t3Days: days,
  cooldownDays: days,
  maturityDays: days,
  deadmanWindowDays: days,
});

export const config: fc.Arbitrary<Config> = fc.record({ thresholds });

export const knob: fc.Arbitrary<Knob> = fc.record(
  {
    id: fc.constantFrom(...KNOB_IDS),
    mode: fc.constantFrom('shadow', 'automatic'),
    protected: rarely,
    clock: fc.constantFrom('wall', 'active_days'),
    thresholds: fc.record(
      { t1Days: days, t2Days: days, t3Days: days, cooldownDays: days, maturityDays: days },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: ['id', 'mode', 'protected', 'clock'] },
);

const nullableTime = fc.option(time(), { nil: null, freq: 2 });

export const member: fc.Arbitrary<Member> = fc
  .record({
    id: fc.constantFrom(...MEMBER_IDS),
    knobId: fc.oneof(
      { weight: 9, arbitrary: fc.constantFrom(...KNOB_IDS) },
      { weight: 1, arbitrary: fc.constant('k9') },
    ),
    declaredAt: time(120),
    firstSeenAt: nullableTime,
    lastSeenAt: nullableTime,
    lastRestoredAt: nullableTime,
    state: fc.constantFrom(...STATES),
    stateSince: time(150),
    cooldownUntil: nullableTime,
    restoredCount: fc.nat(3),
    protected: rarely,
    retiredFrom: fc.constantFrom(...LIVE),
  })
  .map((m) => ({
    ...m,
    rule: `rule:${m.id}`,
    retiredFrom: m.state === 'retired' ? m.retiredFrom : null,
  }));

const signal: fc.Arbitrary<Signal> = fc.record({
  at: time(250),
  kind: fc.constantFrom('heartbeat', 'session', 'decision'),
});

const source: fc.Arbitrary<SourceCoverage> = fc
  .record({
    sourceId: fc.constantFrom('a', 'b'),
    sinceDay: fc.integer({ min: 0, max: 100 }),
    ranges: fc.array(
      fc.record({
        from: fc.integer({ min: 0, max: 250 }),
        length: fc.integer({ min: 0, max: 60 }),
        kinds: fc.subarray(['heartbeat', 'session', 'decision'] as const, { minLength: 1 }),
      }),
      { maxLength: 3 },
    ),
    extra: fc.array(signal, { maxLength: 6 }),
  })
  .map(({ sourceId, sinceDay, ranges, extra }) => ({
    sourceId,
    since: d(sinceDay),
    signals: [...ranges.flatMap((r) => dailySignals(r.from, r.from + r.length, r.kinds)), ...extra],
  }));

export const coverage: fc.Arbitrary<KnobCoverage> = fc.record({
  knobId: fc.constantFrom(...KNOB_IDS),
  sources: fc.array(source, { maxLength: 2 }),
});

/** Every knob reports daily from an early start, so members actually become due. */
const healthyCoverage: fc.Arbitrary<KnobCoverage[]> = fc
  .tuple(
    fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 3, maxLength: 3 }),
    fc.option(source, { nil: null, freq: 4 }),
  )
  .map(([starts, noise]) => [
    ...KNOB_IDS.map((knobId, n) => ({
      knobId,
      sources: [
        {
          sourceId: 'a',
          since: d(starts[n] ?? 0),
          signals: dailySignals(starts[n] ?? 0, 260),
        },
      ],
    })),
    ...(noise === null ? [] : [{ knobId: 'k1', sources: [noise] }]),
  ]);

/** Mostly well-formed input (unique ids); sometimes duplicate ids to exercise fail-closed paths. */
export const evaluateInput: fc.Arbitrary<EvaluateInput> = fc.record({
  knobs: fc.oneof(
    {
      weight: 6,
      arbitrary: fc
        .tuple(knob, knob, knob)
        .map((ks) => ks.map((k, n) => ({ ...k, id: KNOB_IDS[n] as string }))),
    },
    { weight: 3, arbitrary: fc.uniqueArray(knob, { selector: (k) => k.id, maxLength: 3 }) },
    { weight: 1, arbitrary: fc.array(knob, { maxLength: 4 }) },
  ),
  members: fc.oneof(
    { weight: 9, arbitrary: fc.uniqueArray(member, { selector: (m) => m.id, maxLength: 6 }) },
    { weight: 1, arbitrary: fc.array(member, { maxLength: 7 }) },
  ),
  coverage: fc.oneof(
    { weight: 1, arbitrary: fc.array(coverage, { maxLength: 4 }) },
    { weight: 2, arbitrary: healthyCoverage },
  ),
  now: fc.oneof({ weight: 1, arbitrary: time(250) }, { weight: 3, arbitrary: time(250, 100) }),
  tickId: fc.constantFrom('t1', 't2'),
  config,
});

export const usageEvent: fc.Arbitrary<UsageEvent> = fc.record({
  eventId: fc.string({ maxLength: 3 }),
  at: time(250),
  memberIds: fc.array(fc.constantFrom(...MEMBER_IDS, 'zz'), { maxLength: 4 }),
});
