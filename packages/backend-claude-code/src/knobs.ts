// Settings snapshots → core knobs and members (HANDOFF §3.1, §5.2; ADR-0007). Pure.
// One knob per (scope, subject, array). Defaults from the corollaries: only `allow` decays (C1),
// Read(...) members are protected (C2), every knob starts in shadow and `cli` knobs need an
// explicit opt-in to go automatic (C3, enforced by the CLI at M3). taper's own managed artifact
// (`managed-settings.d/50-taper.json`) is machine-owned: its rules shape the effective policy
// but never become members (invariant 3).

import {
  applySnapshot,
  type Knob,
  type Member,
  memberIdFor,
  type Snapshot,
  type Transition,
} from '@taper/core';
import { type MatchResult, match, type ToolCall } from './match.ts';
import {
  buildPolicy,
  type EffectivePolicy,
  type PolicyRule,
  type Scope,
  type Trust,
} from './policy.ts';
import { normalizeRule, type Polarity, parseRule } from './rule.ts';
import type { SettingsSnapshot } from './settings.ts';

export interface KnobOptions {
  /** Subject of managed knobs: the org id in org mode, the device id in solo mode. */
  readonly managedSubject: string;
  /** C2: Read(...) members are protected by default. */
  readonly protectReadRules?: boolean;
}

export interface KnobPlan {
  readonly knob: Knob;
  readonly kind: Scope;
  readonly polarity: Polarity;
  readonly snapshot: Snapshot;
  readonly isProtected: (rule: string) => boolean;
}

/** The machine-owned managed drop-in taper generates (HANDOFF §5.4B). */
export const TAPER_MANAGED_FILE = '50-taper.json';

const POLARITIES: readonly Polarity[] = ['allow', 'ask', 'deny'];
const SCOPE_ORDER: readonly Scope[] = ['managed', 'cli', 'local', 'project', 'user'];

export const isTaperOwned = (s: SettingsSnapshot): boolean =>
  s.scope === 'managed' && /(?:^|[/\\])managed-settings\.d[/\\]50-taper\.json$/.test(s.path);

/** Collision-free, readable knob id: components are URI-encoded and joined with `:`. */
export function knobIdFor(s: SettingsSnapshot, polarity: Polarity, opts: KnobOptions): string {
  const subject: (string | undefined)[] =
    s.scope === 'user'
      ? [s.device_id]
      : s.scope === 'project'
        ? [s.repo_id]
        : s.scope === 'local'
          ? [s.device_id, s.repo_id]
          : s.scope === 'managed'
            ? [opts.managedSubject]
            : [s.repo_id, s.pipeline_id];
  return [s.scope, ...subject.map((x) => x ?? ''), polarity].map(encodeURIComponent).join(':');
}

export function isProtectedByDefault(
  rule: string,
  kind: Scope,
  polarity: Polarity,
  protectReadRules: boolean,
): boolean {
  if (polarity !== 'allow' || kind === 'managed') return true; // C1; managed is admin policy
  const parsed = parseRule(rule, polarity);
  if (parsed.kind === 'inert') return true; // not understood or never consulted: never decay it
  const readRule =
    (parsed.kind === 'path' && parsed.family === 'read') ||
    (parsed.kind === 'tools' && parsed.tools.has('Read'));
  return protectReadRules && readRule; // C2
}

const defaultKnob = (id: string, kind: Scope, polarity: Polarity): Knob => ({
  id,
  mode: 'shadow',
  protected: polarity !== 'allow' || kind === 'managed',
  clock: 'wall',
});

export function planKnobs(snapshots: readonly SettingsSnapshot[], opts: KnobOptions): KnobPlan[] {
  const protectRead = opts.protectReadRules ?? true;
  const groups = new Map<
    string,
    { kind: Scope; polarity: Polarity; rules: string[]; at: number }
  >();
  const ordered = SCOPE_ORDER.flatMap((scope) => snapshots.filter((s) => s.scope === scope));
  for (const s of ordered) {
    if (isTaperOwned(s)) continue;
    for (const polarity of POLARITIES) {
      const id = knobIdFor(s, polarity, opts);
      const g = groups.get(id) ?? { kind: s.scope, polarity, rules: [], at: s.taken_at };
      g.at = Math.max(g.at, s.taken_at);
      for (const raw of s.arrays[polarity]) {
        const rule = normalizeRule(raw);
        if (rule !== '' && !g.rules.includes(rule)) g.rules.push(rule);
      }
      groups.set(id, g);
    }
  }
  return [...groups].map(([id, g]) => ({
    knob: defaultKnob(id, g.kind, g.polarity),
    kind: g.kind,
    polarity: g.polarity,
    snapshot: { knobId: id, takenAt: g.at, rules: g.rules },
    isProtected: (rule: string) => isProtectedByDefault(rule, g.kind, g.polarity, protectRead),
  }));
}

/** Declares new rules and retires vanished ones. Existing knobs keep their mode and flags. */
export function applySettingsSnapshots(
  members: readonly Member[],
  snapshots: readonly SettingsSnapshot[],
  opts: KnobOptions & { readonly knobs: readonly Knob[]; readonly tickId: string },
): { members: Member[]; transitions: Transition[]; knobs: Knob[] } {
  let current: Member[] = [...members];
  const transitions: Transition[] = [];
  const knobs: Knob[] = [...opts.knobs];
  for (const plan of planKnobs(snapshots, opts)) {
    let knob = knobs.find((k) => k.id === plan.knob.id);
    if (!knob) {
      knob = plan.knob;
      knobs.push(knob);
    }
    const out = applySnapshot(current, plan.snapshot, {
      knob,
      tickId: opts.tickId,
      isProtected: plan.isProtected,
    });
    current = out.members;
    transitions.push(...out.transitions);
  }
  return { members: current, transitions, knobs };
}

/** Effective policy for a device+repo, with knob ids on every human-owned rule. */
export function policyFromSnapshots(
  snapshots: readonly SettingsSnapshot[],
  opts: KnobOptions & { readonly home: string; readonly workspaceTrusted: Trust },
): EffectivePolicy {
  return buildPolicy({
    home: opts.home,
    workspaceTrusted: opts.workspaceTrusted,
    sources: snapshots.map((s) => ({
      scope: s.scope,
      path: s.path,
      arrays: s.arrays,
      ...(s.inline ? { inline: true } : {}),
      ...(isTaperOwned(s)
        ? {}
        : {
            knobIds: {
              allow: knobIdFor(s, 'allow', opts),
              ask: knobIdFor(s, 'ask', opts),
              deny: knobIdFor(s, 'deny', opts),
            },
          }),
    })),
  });
}

export interface Attribution {
  readonly outcome: MatchResult['outcome'];
  readonly basis: MatchResult['basis'];
  /** Every matching allow member: all of them are refreshed on accepted use (C5). */
  readonly matchedMemberIds: readonly string[];
  /** Members that decided the call, for the redundancy report (ADR-0006). */
  readonly decisiveMemberIds: readonly string[];
}

const memberIds = (rules: readonly PolicyRule[]): string[] => [
  ...new Set(rules.flatMap((r) => (r.knobId === undefined ? [] : [memberIdFor(r.knobId, r.rule)]))),
];

export function attribute(policy: EffectivePolicy, call: ToolCall): Attribution {
  const r = match(policy, call);
  return {
    outcome: r.outcome,
    basis: r.basis,
    matchedMemberIds: memberIds(r.allMatchingAllowRules),
    decisiveMemberIds: memberIds(r.decisiveRules),
  };
}
