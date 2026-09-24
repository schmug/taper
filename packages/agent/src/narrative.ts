// NarrativeProvider (HANDOFF P2): prose from structured, deterministic data. The only provider is
// the template one below; it adds words, never facts, and nothing it returns feeds back into a
// decision. An LLM provider would plug in here, off by default (not built; invariant 2).

import type { Explanation, Guard, Transition } from '@taper/core';
import type { KnobChange, StoredKnob } from './store.ts';

export interface ExplainContext {
  readonly knob: StoredKnob;
  /** Events that matched this member, and in how many it was decisive. Counts only. */
  readonly counts: { readonly matched: number; readonly decisive: number };
  /** Mode changes of the knob and protection changes of the knob or this member. */
  readonly changes: readonly KnobChange[];
}

export interface AdviceItem {
  readonly rule: string;
  readonly knob: StoredKnob;
  readonly state: 'stale_candidate' | 'pending_removal' | 'removed';
  readonly stateSince: number;
  /** Settings file holding the rule, when taper knows exactly one. */
  readonly path: string | null;
  readonly heldByLastMember: boolean;
}

export interface Advice {
  readonly now: number;
  readonly items: readonly AdviceItem[];
}

export interface NarrativeProvider {
  readonly name: string;
  explain(e: Explanation, ctx: ExplainContext): string;
  recommend(a: Advice): string;
}

export const fmtTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;
export const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const days = (d: number): string => `${Math.round(d * 10) / 10}`;

export const knobLabel = (k: StoredKnob): string =>
  `${k.kind} ${k.polarity}${k.repoId === null ? '' : ` ${k.repoId}`}`;

const GUARD_TEXT: Record<Guard, string> = {
  protected: 'protected (member or knob): taper never tightens it',
  frozen:
    'clock frozen by the dead-man switch: no liveness signal from its sources inside the window, so stale time does not accrue',
  cooldown: 'cooldown after its last use or re-grant',
  immature: 'ledger maturity: the knob needs continuous coverage before any member leaves active',
  last_member: 'last-member guard: the last live member stops at pending_removal for approval',
};

function enforcementText(e: Explanation): string {
  if (e.enforcement === 'prompt')
    return 'the PreToolUse hook asks before each use; approving restores it';
  if (e.enforcement === 'block')
    return 'the PreToolUse hook denies calls that need it; only `taper regrant` restores it';
  if (e.mode === 'shadow' && (e.state === 'pending_removal' || e.state === 'removed'))
    return 'none (shadow mode: recommendation only)';
  return 'none';
}

function historyLine(t: Transition): string {
  const from = t.from ?? '(new)';
  const shadow = t.shadow ? ' shadow' : '';
  return `    ${fmtTime(t.at)}  ${from} → ${t.to}  ${t.reason} by ${t.actor}${shadow}  [${t.tickId}]`;
}

export const templateNarrative: NarrativeProvider = {
  name: 'template',

  explain(e, { knob, counts, changes }) {
    const anchor =
      e.anchor.basis === 'last_seen'
        ? `last used ${fmtTime(e.anchor.at)}`
        : e.anchor.basis === 'restored'
          ? `restored ${fmtTime(e.anchor.at)}`
          : `declared ${fmtTime(e.anchor.at)} (never used since)`;
    const next =
      e.next === null
        ? 'none (no further tightening step)'
        : `${e.next.state} at ${days(e.next.thresholdDays)} ${e.clock.kind === 'wall' ? '' : 'session '}days unused (${days(e.next.remainingDays)} to go)`;
    const holding =
      e.next === null
        ? 'n/a'
        : e.blockedBy.length === 0
          ? e.due
            ? 'nothing; the next evaluate tick moves it'
            : 'nothing yet; it is not due'
          : e.blockedBy.map((g) => GUARD_TEXT[g]).join('; ');
    return [
      `${JSON.stringify(e.rule)} in ${knobLabel(knob)} (${knob.id})`,
      `  state: ${e.state} since ${fmtTime(e.stateSince)}; mode: ${e.mode}${e.protected ? '; protected' : ''}`,
      `  staleness counted from: ${anchor}`,
      `  clock: ${e.clock.kind}, ${days(e.clock.staleDays)} days stale; frozen: ${e.clock.frozen ? 'yes' : 'no'}; mature: ${e.clock.mature ? 'yes' : 'no'}${e.clock.coveredSince === null ? '' : `; covered since ${fmtTime(e.clock.coveredSince)}`}`,
      `  next: ${next}`,
      `  held by: ${holding}`,
      `  enforcement: ${enforcementText(e)}`,
      `  evidence: matched ${counts.matched} observed call(s), decisive in ${counts.decisive}`,
      '  history:',
      ...(e.history.length === 0 ? ['    (none)'] : e.history.map(historyLine)),
      ...(changes.length === 0
        ? []
        : [
            '  knob and protection changes:',
            ...changes.map(
              (c) =>
                `    ${fmtTime(c.at)}  ${c.memberId === null ? 'knob' : JSON.stringify(e.rule)} ${c.field} ${c.from} → ${c.to} by ${c.actor}`,
            ),
          ]),
    ].join('\n');
  },

  recommend({ now, items }) {
    const lines = [
      `Advisory only (${fmtTime(now)}): taper never edits a settings file's permissions.`,
      'Apply these by hand, or review `taper recommend --format diff`.',
    ];
    const section = (
      title: string,
      state: AdviceItem['state'],
      extra: (i: AdviceItem) => string,
    ) => {
      const list = items.filter((i) => i.state === state);
      if (list.length === 0) return;
      lines.push('', title);
      for (const i of list)
        lines.push(
          `  - ${JSON.stringify(i.rule)}  ${knobLabel(i.knob)}  [${i.knob.mode}]  since ${fmtDate(i.stateSince)}${extra(i)}`,
        );
    };
    section('Removed: unused past T3; safe to delete from the file:', 'removed', (i) =>
      i.path === null ? '' : `\n      in ${i.path}`,
    );
    section('Pending removal: next step is removed.', 'pending_removal', (i) =>
      i.heldByLastMember ? ' (last live member: held for approval)' : '',
    );
    section('Stale candidates:', 'stale_candidate', () => '');
    if (items.length === 0)
      lines.push('', 'Nothing to recommend: no tracked allow rule has decayed.');
    if (items.some((i) => i.knob.mode === 'shadow'))
      lines.push(
        '',
        'Shadow knobs only record these states; nothing is enforced until `taper mode <knob> automatic`.',
      );
    return lines.join('\n');
  },
};
