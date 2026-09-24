// Normalized Claude Code events (HANDOFF §3.3, ADR-0007) and their mapping onto core's generic
// Signal and UsageEvent. Pure. Raw tool arguments never enter an Event (invariant 8): the schema
// is strict, so a stray `tool_input` fails validation.

import type { Signal, UsageEvent } from '@taper/core';
import { z } from 'zod';
import type { ToolCall } from './match.ts';

/** Modes as hooks report them (facts doc B4); manual arrives as `default`. */
const MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
/**
 * `unknown` where the mode is not observable: OTel `tool_decision`/`tool_result` carry none, and
 * SessionStart/SessionEnd hooks omit it (ADR-0002 row 6). C4: the math ignores the mode anyway.
 */
export const PermissionModeSchema = z.enum([...MODES, 'unknown']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const EventSchema = z
  .object({
    event_id: z.string().min(1),
    org_id: z.string().min(1).optional(),
    device_id: z.string().min(1),
    repo_id: z.string().min(1).optional(),
    session_id: z.string().min(1),
    tool_use_id: z.string().min(1).optional(),
    at: z.number().int().nonnegative(),
    kind: z.enum([
      'tool_decision',
      'tool_result',
      'session_start',
      'session_end',
      'hook_registered',
      'snapshot',
    ]),
    tool_name: z.string().min(1).optional(),
    decision: z.enum(['accept', 'reject']).optional(),
    source: z
      .enum(['config', 'hook', 'user_permanent', 'user_temporary', 'user_abort', 'user_reject'])
      .optional(),
    /** Required on every event (C4); `unknown` when the signal path does not carry it. */
    permission_mode: PermissionModeSchema,
    matched_member_ids: z.array(z.string()),
    /** A set: compound commands can have several decisive rules (ADR-0006). */
    decisive_member_ids: z.array(z.string()),
    args_hash: z.string().min(1).optional(),
    raw_retained_until: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Event = z.infer<typeof EventSchema>;

/** Hook stdin for tool events (facts doc A2 'Hook I/O', B4). Unknown keys pass through. */
export const HookToolInputSchema = z.looseObject({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.enum([
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'PermissionDenied',
  ]),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()),
  /** Absent on PermissionRequest. */
  tool_use_id: z.string().min(1).optional(),
  permission_mode: z.string().optional(),
});
export type HookToolInput = z.infer<typeof HookToolInputSchema>;

/** Hook stdin for session events (facts doc A2, B4): SessionStart/SessionEnd carry no mode. */
export const HookSessionInputSchema = z.looseObject({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.enum(['SessionStart', 'Stop', 'SessionEnd']),
  permission_mode: z.string().optional(),
});
export type HookSessionInput = z.infer<typeof HookSessionInputSchema>;

export function permissionModeOf(raw: unknown): PermissionMode {
  if (raw === 'manual') return 'default';
  const parsed = PermissionModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'unknown';
}

/** The matcher's view of a hook tool event. The caller discards `input` after matching. */
export function toolCallFromHook(input: HookToolInput): ToolCall {
  return { tool: input.tool_name, input: input.tool_input, cwd: input.cwd };
}

/** Liveness for the dead-man guard (ADR-0005): sessions, heartbeats, observed decisions. */
export function toSignal(e: Event): Signal {
  switch (e.kind) {
    case 'session_start':
      return { at: e.at, kind: 'session' };
    case 'tool_decision':
    case 'tool_result':
      return { at: e.at, kind: 'decision' };
    case 'hook_registered':
    case 'session_end':
    case 'snapshot':
      return { at: e.at, kind: 'heartbeat' };
  }
}

/**
 * An accepted call is usage of every matching allow member (C5). A decision and its result share
 * a tool_use_id, so they carry the same event id.
 */
export function toUsageEvent(e: Event): UsageEvent | null {
  const accepted =
    (e.kind === 'tool_decision' && e.decision === 'accept') || e.kind === 'tool_result';
  if (!accepted || e.matched_member_ids.length === 0) return null;
  return { eventId: e.tool_use_id ?? e.event_id, at: e.at, memberIds: e.matched_member_ids };
}
