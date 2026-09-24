// Hook enforcement, the solo writer (HANDOFF §5.4A, ADR-0011). Pure. The PreToolUse hook asks
// for a matched `pending_removal` member (tier 1: approving is usage, which restores it) and
// denies a matched `removed` member when the call needs it (tier 2: only a re-grant restores it).
// Only knobs that core's enforcement() lists as automatic act, so a shadow knob never yields a
// decision (invariant 7). The hook never edits a settings file (invariant 3).
//
// "No other active allow member matches" (§5.4A) is checked by matching again without the
// removed members' rules: deny only when the call is allowed with them and not without them.
// That covers compound commands, where another member can match one part only, and the
// read-only built-ins, which need no rule. When Claude Code would prompt or deny anyway, the
// removed rule is not what allows the call, so taper stays out of the way.
//
// Permission modes: taper never blocks what deleting the rule would allow. bypassPermissions
// runs everything without a rule, so taper decides nothing there. acceptEdits approves edits and
// a few filesystem commands on its own; those calls get no decision. Under auto (and an unknown
// mode) the classifier would review a call without the rule, so a removed rule asks instead of
// denying.

import {
  type Config,
  DAY_MS,
  type EnforcementAction,
  enforcement,
  type Knob,
  type Member,
  type MemberId,
  memberIdFor,
  resolveThresholds,
} from '@taper/core';
import type { PermissionMode } from './event.ts';
import { match, type ToolCall } from './match.ts';
import { buildPolicy, type EffectivePolicy, type PolicyRule } from './policy.ts';

export interface HookDecisionInput {
  readonly policy: EffectivePolicy;
  /**
   * The same call under each working directory taper considers: the session's start directory
   * and, if different, the one the hook reported. Whether hook `cwd` follows a `cd` is
   * UNVERIFIED (ADR-0006), so the least restrictive decision wins.
   */
  readonly calls: readonly ToolCall[];
  readonly knobs: readonly Knob[];
  /** At least every member the policy's allow rules map to. */
  readonly members: readonly Member[];
  readonly config: Config;
  readonly now: number;
  /** From the PreToolUse payload (facts doc B4); `unknown` when absent. */
  readonly permissionMode: PermissionMode;
}

export interface HookDecision {
  readonly permissionDecision: 'ask' | 'deny';
  readonly reason: string;
  /** Members the decision is about, by id. */
  readonly memberIds: readonly MemberId[];
}

/** For display. */
const quote = (rule: string): string => JSON.stringify(rule);
/** For a command the user may paste: single quotes, so nothing in the rule expands. */
const shellArg = (rule: string): string => `'${rule.replace(/'/g, `'\\''`)}'`;

/** HANDOFF §5.4A reason for a `pending_removal` member. */
export function askReason(rule: string, unusedDays: number, cooldownDays: number): string {
  return (
    `taper: ${quote(rule)} unused for ${unusedDays} days; approving restores it ` +
    `(cooldown ${cooldownDays}d). Run \`taper explain ${shellArg(rule)}\` for details.`
  );
}

/** HANDOFF §5.4A reason for a `removed` member. */
export function denyReason(rule: string, unusedDays: number): string {
  return (
    `taper: ${quote(rule)} removed after ${unusedDays} days unused. ` +
    `Re-grant: \`taper regrant ${shellArg(rule)}\` or the dashboard.`
  );
}

/** A `removed` member under auto or an unknown mode: a prompt, not a block (ADR-0011). */
export function removedAskReason(rule: string, unusedDays: number): string {
  return (
    `taper: ${quote(rule)} removed after ${unusedDays} days unused; approving allows this call ` +
    `only. Re-grant: \`taper regrant ${shellArg(rule)}\`.`
  );
}

/** The PreToolUse stdout shape (facts doc A2 'Hook I/O'). */
export function hookOutput(d: HookDecision) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: d.permissionDecision,
      permissionDecisionReason: d.reason,
    },
  };
}

/**
 * What acceptEdits approves with no rule, as allow rules that belong to no knob: file edits and
 * `mkdir/touch/mv/cp/rm/sed` (research doc 'Modes'; the command list and its working-directory
 * limit are UNVERIFIED, so the limit is ignored: the lenient side).
 */
const ACCEPT_EDITS: readonly PolicyRule[] = buildPolicy({
  home: '/',
  workspaceTrusted: true,
  sources: [
    {
      scope: 'user',
      path: '/<acceptEdits>/settings.json',
      arrays: {
        allow: ['Edit', ...['mkdir', 'touch', 'mv', 'cp', 'rm', 'sed'].map((c) => `Bash(${c} *)`)],
        ask: [],
        deny: [],
      },
    },
  ],
}).rules;

const anchorOf = (m: Member): number =>
  Math.max(
    m.declaredAt,
    m.lastSeenAt ?? Number.NEGATIVE_INFINITY,
    m.lastRestoredAt ?? Number.NEGATIVE_INFINITY,
  );
const wholeDays = (ms: number): number => Math.max(0, Math.floor(ms / DAY_MS));

const memberOf = (r: PolicyRule): MemberId | null =>
  r.polarity === 'allow' && r.knobId !== undefined ? memberIdFor(r.knobId, r.rule) : null;

function decideOne(input: HookDecisionInput, call: ToolCall): HookDecision | null {
  const mode = input.permissionMode;
  if (mode === 'bypassPermissions') return null;
  const modeRules = mode === 'acceptEdits' ? ACCEPT_EDITS : [];
  if (
    modeRules.length > 0 &&
    match({ ...input.policy, rules: modeRules }, call).outcome === 'allow'
  )
    return null;

  // The mode's own approvals count on both sides of the "does the call need it" check.
  const full = match({ ...input.policy, rules: [...input.policy.rules, ...modeRules] }, call);
  const matched = new Set(full.allMatchingAllowRules.map(memberOf));
  const actions = enforcement(
    input.knobs,
    input.members.filter((m) => matched.has(m.id)),
  );
  const byAction = (a: EnforcementAction['action']) => actions.filter((x) => x.action === a);
  const byId = new Map(input.members.map((m) => [m.id, m]));

  const blocks = byAction('block');
  if (blocks.length > 0 && full.outcome === 'allow') {
    const blocked = new Set(blocks.map((b) => b.memberId));
    const without: EffectivePolicy = {
      ...input.policy,
      rules: [...input.policy.rules.filter((r) => !blocked.has(memberOf(r) ?? '')), ...modeRules],
    };
    if (match(without, call).outcome !== 'allow') {
      const first = byId.get(blocks[0]?.memberId ?? '') as Member;
      const days = wholeDays(first.stateSince - anchorOf(first));
      const classifier = mode === 'auto' || mode === 'unknown';
      return {
        permissionDecision: classifier ? 'ask' : 'deny',
        reason: classifier ? removedAskReason(first.rule, days) : denyReason(first.rule, days),
        memberIds: blocks.map((b) => b.memberId),
      };
    }
  }

  const prompts = byAction('prompt');
  if (prompts.length === 0) return null;
  const first = byId.get(prompts[0]?.memberId ?? '') as Member;
  const knob = input.knobs.find((k) => k.id === first.knobId) as Knob;
  return {
    permissionDecision: 'ask',
    reason: askReason(
      first.rule,
      wholeDays(input.now - anchorOf(first)),
      resolveThresholds(input.config, knob).cooldownDays,
    ),
    memberIds: prompts.map((p) => p.memberId),
  };
}

const RANK = { ask: 1, deny: 2 } as const;

/** Least restrictive decision across `calls`; null (no decision) if any call yields none. */
export function hookDecision(input: HookDecisionInput): HookDecision | null {
  let best: HookDecision | null = null;
  for (const call of input.calls) {
    const d = decideOne(input, call);
    if (d === null) return null;
    if (best === null || RANK[d.permissionDecision] < RANK[best.permissionDecision]) best = d;
  }
  return best;
}
