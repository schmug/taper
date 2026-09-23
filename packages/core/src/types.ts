// Domain types for the decay engine (HANDOFF §3–§4). Backend-agnostic: nothing here knows what a
// Claude Code rule or event looks like. Times are epoch milliseconds; durations in config are
// days. ADR-0004 (engine semantics) and ADR-0005 (coverage, clocks, dead-man) record the choices.

export type KnobId = string;
export type MemberId = string;

/** Persistent member states. `restored` is ledger-only (see LedgerState). */
export type MemberState = 'active' | 'stale_candidate' | 'pending_removal' | 'removed' | 'retired';
export type LedgerState = MemberState | 'restored';
/** States a member can be in while its rule still exists in the knob. */
export type LiveState = Exclude<MemberState, 'retired'>;

export type Mode = 'shadow' | 'automatic';
export type ClockKind = 'wall' | 'active_days';
export type Actor = 'system' | 'user' | 'admin';

export interface Thresholds {
  /** active → stale_candidate after this many clock days unused. */
  readonly t1Days: number;
  /** stale_candidate → pending_removal. */
  readonly t2Days: number;
  /** pending_removal → removed. */
  readonly t3Days: number;
  readonly cooldownDays: number;
  /** Continuous coverage (in the knob's clock) required before any member leaves `active`. */
  readonly maturityDays: number;
  /** Signal gap (wall days) after which the dead-man switch freezes the knob's clock. */
  readonly deadmanWindowDays: number;
}

export interface Config {
  readonly thresholds: Thresholds;
}

export interface Knob {
  readonly id: KnobId;
  readonly mode: Mode;
  readonly protected: boolean;
  readonly clock: ClockKind;
  /** Per-knob overrides of `Config.thresholds`. */
  readonly thresholds?: Partial<Thresholds>;
}

export interface Member {
  readonly id: MemberId;
  readonly knobId: KnobId;
  readonly rule: string;
  /** First snapshot containing the rule (enrollment time for pre-existing rules). */
  readonly declaredAt: number;
  readonly firstSeenAt: number | null;
  /** Last attributed usage. */
  readonly lastSeenAt: number | null;
  /** Last restore by usage or re-grant; part of the staleness anchor (ADR-0004). */
  readonly lastRestoredAt: number | null;
  readonly state: MemberState;
  readonly stateSince: number;
  readonly cooldownUntil: number | null;
  readonly restoredCount: number;
  readonly protected: boolean;
  /** State the member held when its rule vanished; null unless `state === 'retired'`. */
  readonly retiredFrom: LiveState | null;
}

/**
 * Liveness signal from one source (device) of a knob. Backends map their events onto these:
 * `session` = a session started (also a heartbeat), `heartbeat` = the pipeline is alive without a
 * session (e.g. hook registration), `decision` = a permission decision was observed.
 */
export interface Signal {
  readonly at: number;
  readonly kind: 'heartbeat' | 'session' | 'decision';
}

export interface SourceCoverage {
  readonly sourceId: string;
  /** When this source started reporting for the knob. Counts as a heartbeat and a decision. */
  readonly since: number;
  /** Any order. Signals after `now` are ignored, so `simulate` can read the future from here. */
  readonly signals: readonly Signal[];
}

export interface KnobCoverage {
  readonly knobId: KnobId;
  readonly sources: readonly SourceCoverage[];
}

/** An observed, accepted use. The backend's attribution decides which members it matched (C5). */
export interface UsageEvent {
  readonly eventId: string;
  readonly at: number;
  readonly memberIds: readonly MemberId[];
}

export type ReasonCode =
  | 'declared'
  | 'redeclared'
  | 'vanished'
  | 'unused'
  | 'usage'
  | 'regrant'
  | 'restored';

export type Evidence = Readonly<Record<string, string | number | boolean | null>>;

export interface Transition {
  readonly memberId: MemberId;
  readonly knobId: KnobId;
  /** null only for `declared`. */
  readonly from: LedgerState | null;
  readonly to: LedgerState;
  readonly at: number;
  readonly reason: ReasonCode;
  readonly actor: Actor;
  /** Recorded while the knob was in shadow mode; enforcement never follows it. */
  readonly shadow: boolean;
  readonly tickId: string;
  readonly evidence: Evidence;
}

export type Guard = 'protected' | 'frozen' | 'cooldown' | 'immature' | 'last_member';

export type Recommendation =
  | {
      readonly kind: 'shadow_transition';
      readonly memberId: MemberId;
      readonly knobId: KnobId;
      readonly from: LiveState;
      readonly to: LiveState;
      readonly at: number;
      readonly tickId: string;
    }
  | {
      readonly kind: 'last_member_hold';
      readonly memberId: MemberId;
      readonly knobId: KnobId;
      readonly at: number;
      readonly tickId: string;
    };

export interface EvaluateInput {
  readonly knobs: readonly Knob[];
  readonly members: readonly Member[];
  readonly coverage: readonly KnobCoverage[];
  readonly now: number;
  readonly tickId: string;
  readonly config: Config;
}

export interface EvaluateOutput {
  readonly transitions: readonly Transition[];
  readonly recommendations: readonly Recommendation[];
  /** Knobs whose clock is frozen by the dead-man switch (or that have no coverage) at `now`. */
  readonly frozen: readonly KnobId[];
}

/** Machine-owned enforcement derived from state: `prompt` = in-context re-grant, `block` = deny. */
export interface EnforcementAction {
  readonly memberId: MemberId;
  readonly knobId: KnobId;
  readonly rule: string;
  readonly action: 'prompt' | 'block';
}
