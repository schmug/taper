// `taper hook <event>` (HANDOFF §5.3 path 1, §5.4A). Stdin JSON → session → signal → usage or a
// decision. Fast path: local SQLite only, no network. Snapshots run on session events and after
// PermissionRequest → PostToolUse (ADR-0002 row 2), never on PreToolUse.
//
// cwd (ADR-0006, ADR-0011): matching is anchored at the directory the session started in, taken
// from SessionStart. Whether a tool event's `cwd` follows a Bash `cd` is UNVERIFIED, so a differing
// event cwd is matched too: attribution takes the union (C5), a decision the least restrictive.

import {
  HookSessionInputSchema,
  HookToolInputSchema,
  hookOutput,
  permissionModeOf,
} from '@taper/backend-claude-code';
import type { Agent } from './agent.ts';

/** Returns what to print on stdout, or null for no decision. Throws on a malformed payload. */
export function handleHook(agent: Agent, event: string, text: string, now: number): string | null {
  const raw: unknown = JSON.parse(text);
  switch (event) {
    case 'SessionStart':
    case 'Stop':
    case 'SessionEnd': {
      const p = HookSessionInputSchema.parse(raw);
      if (p.hook_event_name !== event) return null;
      const start = event === 'SessionStart';
      const session = agent.session(
        p.session_id,
        p.cwd,
        start ? 'session_start' : 'first_event',
        now,
      );
      agent.signal(session, start ? 'session' : 'heartbeat', now);
      agent.snapshot(agent.projectOf(session), now);
      agent.tick(now);
      return null;
    }
    case 'PermissionRequest': {
      const p = HookToolInputSchema.parse(raw);
      if (p.hook_event_name !== event) return null;
      const session = agent.session(p.session_id, p.cwd, 'first_event', now);
      agent.store.setPermissionRequest(session.sessionId, true);
      agent.signal(session, 'heartbeat', now);
      return null;
    }
    case 'PreToolUse': {
      const p = HookToolInputSchema.parse(raw);
      if (p.hook_event_name !== event) return null;
      const session = agent.session(p.session_id, p.cwd, 'first_event', now);
      // Not a `decision` signal: usage is only observed at PostToolUse. If PostToolUse stops
      // arriving, the knob must look degraded and freeze (ADR-0005, ADR-0010).
      agent.signal(session, 'heartbeat', now);
      agent.tick(now);
      const mode = permissionModeOf(p.permission_mode);
      const d = agent.decide(session, p.tool_name, p.tool_input, now, mode, p.cwd);
      return d === null ? null : JSON.stringify(hookOutput(d));
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const p = HookToolInputSchema.parse(raw);
      if (p.hook_event_name !== event) return null;
      const session = agent.session(p.session_id, p.cwd, 'first_event', now);
      // "Yes, and don't ask again" wrote a rule before the tool ran (facts doc A2): declare it
      // before attributing this use to it.
      if (session.permissionRequest) {
        agent.store.setPermissionRequest(session.sessionId, false);
        agent.snapshot(agent.projectOf(session), now);
      }
      agent.ingestTool(session, {
        kind: 'tool_result',
        at: now,
        toolName: p.tool_name,
        ...(p.tool_use_id === undefined ? {} : { toolUseId: p.tool_use_id }),
        decision: 'accept',
        permissionMode: permissionModeOf(p.permission_mode),
        input: p.tool_input,
        eventCwd: p.cwd,
      });
      agent.tick(now);
      return null;
    }
    default:
      return null;
  }
}
