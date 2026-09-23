// Event schema (HANDOFF §3.3, ADR-0002 row 6), hook stdin parsing against recorded fixtures,
// and the mapping of Claude Code events onto core's generic Signal and UsageEvent.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Event,
  EventSchema,
  HookToolInputSchema,
  permissionModeOf,
  toolCallFromHook,
  toSignal,
  toUsageEvent,
} from '../src/event.ts';

const HOOKS = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'hooks');
const hookFiles = (event: string) =>
  readdirSync(HOOKS, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(`-${event}.json`))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(HOOKS, f), 'utf8')) as Record<string, unknown>);

const event = (over: Partial<Event> = {}): Event => ({
  event_id: 'e1',
  device_id: 'dev1',
  session_id: 's1',
  at: 1_000,
  kind: 'tool_decision',
  permission_mode: 'unknown',
  matched_member_ids: ['m1'],
  decisive_member_ids: ['m1'],
  ...over,
});

describe('EventSchema', () => {
  it('requires permission_mode and accepts unknown for OTel-sourced events', () => {
    expect(EventSchema.parse(event())).toEqual(event());
    const { permission_mode: _, ...missing } = event();
    expect(EventSchema.safeParse(missing).success).toBe(false);
  });

  it('accepts every hook permission mode and rejects manual (reported as default)', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'])
      expect(
        EventSchema.safeParse(event({ permission_mode: mode as Event['permission_mode'] })).success,
      ).toBe(true);
    expect(EventSchema.safeParse({ ...event(), permission_mode: 'manual' }).success).toBe(false);
  });

  it('has no field for raw tool arguments (invariant 8)', () => {
    for (const raw of ['tool_input', 'tool_parameters', 'command', 'prompt'])
      expect(EventSchema.safeParse({ ...event(), [raw]: 'rm -rf /' }).success).toBe(false);
  });
});

describe('permissionModeOf', () => {
  it.each([
    ['default', 'default'],
    ['manual', 'default'],
    ['auto', 'auto'],
    [undefined, 'unknown'],
    ['something-new', 'unknown'],
    [3, 'unknown'],
  ])('%j → %s', (raw, mode) => {
    expect(permissionModeOf(raw)).toBe(mode);
  });

  it('is unknown for the recorded SessionStart payloads, which carry no mode', () => {
    const starts = hookFiles('SessionStart');
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(permissionModeOf(s.permission_mode)).toBe('unknown');
  });
});

describe('HookToolInputSchema + toolCallFromHook', () => {
  it.each(['PreToolUse', 'PostToolUse', 'PermissionRequest'])(
    'parses every recorded %s payload',
    (name) => {
      const payloads = hookFiles(name);
      expect(payloads.length).toBeGreaterThan(0);
      for (const p of payloads) {
        const input = HookToolInputSchema.parse(p);
        const call = toolCallFromHook(input);
        expect(call).toEqual({ tool: p.tool_name, input: p.tool_input, cwd: p.cwd });
      }
    },
  );

  it('rejects a payload without tool_input', () => {
    const [p] = hookFiles('PreToolUse');
    const { tool_input: _, ...rest } = p as Record<string, unknown>;
    expect(HookToolInputSchema.safeParse(rest).success).toBe(false);
  });
});

describe('toSignal', () => {
  it.each([
    ['session_start', 'session'],
    ['hook_registered', 'heartbeat'],
    ['session_end', 'heartbeat'],
    ['snapshot', 'heartbeat'],
    ['tool_decision', 'decision'],
    ['tool_result', 'decision'],
  ] as const)('%s → %s', (kind, signal) => {
    expect(toSignal(event({ kind }))).toEqual({ at: 1_000, kind: signal });
  });
});

describe('toUsageEvent', () => {
  it('counts accepted decisions and results, keyed by tool_use_id so both collapse', () => {
    const accepted = event({ decision: 'accept', source: 'config', tool_use_id: 'tu1' });
    expect(toUsageEvent(accepted)).toEqual({ eventId: 'tu1', at: 1_000, memberIds: ['m1'] });
    expect(toUsageEvent(event({ kind: 'tool_result', tool_use_id: 'tu1' }))).toEqual({
      eventId: 'tu1',
      at: 1_000,
      memberIds: ['m1'],
    });
  });

  it('ignores rejections, non-tool events and calls that matched no member', () => {
    expect(toUsageEvent(event({ decision: 'reject', source: 'user_reject' }))).toBeNull();
    expect(toUsageEvent(event({ decision: undefined }))).toBeNull();
    expect(toUsageEvent(event({ kind: 'session_start' }))).toBeNull();
    expect(toUsageEvent(event({ decision: 'accept', matched_member_ids: [] }))).toBeNull();
  });
});
