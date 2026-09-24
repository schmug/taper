// M3 acceptance (HANDOFF §9): `scripts/demo.ts --solo` enrolls a temp $HOME, replays the recorded
// OTLP streams and hook payloads under a compressed clock, walks a member active →
// pending_removal, and a simulated approval restores it with a cooldown. Deterministic.

import { describe, expect, it } from 'vitest';
import { DEMO_RULE, runSoloDemo } from '../../../scripts/demo.ts';
import { tempDir } from './helpers.ts';

describe('solo demo', () => {
  const first = runSoloDemo(tempDir('taper-demo-a-'));

  it('walks the unused "don\'t ask again" rule to pending_removal, then restores it on use', () => {
    expect(
      first.walk.map((w) => `day ${w.day}: ${w.from} → ${w.to} (${w.reason}, ${w.actor})`),
    ).toEqual([
      'day 0: null → active (declared, system)',
      'day 30: active → stale_candidate (unused, system)',
      'day 46: stale_candidate → pending_removal (unused, system)',
      'day 47: pending_removal → active (usage, user)',
    ]);
    expect(first.walk[1]?.tickId).toBe('tick:2026-10-31T12:00');
    expect(first.walk[3]?.tickId).toBe('usage:toolu_demo_d47');
  });

  it('asks in context with the §5.4A reason while the knob is automatic', () => {
    expect(first.before).toEqual({ state: 'pending_removal', mode: 'automatic' });
    expect(first.decision).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `taper: ${JSON.stringify(DEMO_RULE)} unused for 47 days; approving restores it (cooldown 14d). Run \`taper explain '${DEMO_RULE}'\` for details.`,
      },
    });
  });

  it('restores instantly on the approved use and stamps a 14-day cooldown (P4)', () => {
    expect(first.after).toEqual({
      state: 'active',
      lastSeenDay: 47.501,
      cooldownUntilDay: 61.501,
      restoredCount: 1,
    });
  });

  it('prints status and explain from the ledger, with no LLM and no network', () => {
    const t = first.transcript.join('\n');
    expect(t).toContain('$ taper init --yes');
    expect(t).toMatch(
      /pending_removal +Bash\(\.\/probe\.sh c \*\) .*\(held: last_member\) {2}\[hook asks\]/,
    );
    expect(t).toContain('2026-11-16T12:00Z  stale_candidate → pending_removal  unused by system');
    expect(t).toContain('2026-11-17T12:01Z  pending_removal → active  usage by user');
  });

  it('records the active_days comparison for ADR-0005 (session days lag wall days)', () => {
    expect(first.activeDays).toEqual({ wallStaleDays: 46.2, sessionStaleDays: 29 });
  });

  it('is deterministic: a second run in another directory is identical', () => {
    expect(runSoloDemo(tempDir('taper-demo-b-'))).toEqual(first);
  });
});
