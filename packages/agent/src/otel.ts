// OTLP/HTTP JSON logs → the agent's ledger (HANDOFF §5.3 path 2). The same attribution and usage
// path as the hooks. OTel records carry no working directory, so the caller maps a session to
// one (M4 will use `workspace.host_paths`/`vcs.*` attributes); an unmapped session is skipped.
// Used by the solo demo's replay; `taper otel serve` (M6+) will call it too.

import { normalizeOtlpLogs } from '@taper/backend-claude-code';
import type { Agent } from './agent.ts';

export interface OtlpReport {
  readonly tools: number;
  readonly signals: number;
  readonly skipped: number;
}

export function ingestOtlp(
  agent: Agent,
  body: unknown,
  cwdFor: (sessionId: string) => string | null,
): OtlpReport {
  let tools = 0;
  let signals = 0;
  let skipped = 0;
  for (const o of normalizeOtlpLogs(body)) {
    const cwd = cwdFor(o.sessionId);
    if (cwd === null) {
      skipped++;
      continue;
    }
    const session = agent.session(o.sessionId, cwd, 'replay', o.at);
    if (o.kind === 'session_start' || o.kind === 'hook_registered') {
      agent.signal(session, o.kind === 'session_start' ? 'session' : 'heartbeat', o.at);
      signals++;
      continue;
    }
    // `user_permanent` may mean a rule was just written to the local file (ADR-0002 row 2).
    if (o.source === 'user_permanent')
      agent.resnapshotIfLocalChanged(agent.projectOf(session), o.at);
    agent.ingestTool(session, {
      kind: o.kind,
      at: o.at,
      toolName: o.toolName as string,
      ...(o.toolUseId === undefined ? {} : { toolUseId: o.toolUseId }),
      decision: o.decision as 'accept' | 'reject',
      ...(o.source === undefined ? {} : { source: o.source }),
      permissionMode: 'unknown',
      ...(o.input === undefined ? {} : { input: o.input }),
    });
    tools++;
  }
  return { tools, signals, skipped };
}

type Json = Record<string, unknown>;

/**
 * A recorded OTLP body moved `offsetMs` later, with `suffix` appended to session and tool-use
 * ids so a replay does not collide with an earlier one. For the compressed-clock demo.
 */
export function rebaseOtlp(body: unknown, opts: { offsetMs: number; suffix: string }): unknown {
  const shift = BigInt(opts.offsetMs) * 1_000_000n;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    const o = v as Json;
    if (typeof o.key === 'string' && (o.key === 'session.id' || o.key === 'tool_use_id')) {
      const value = o.value as { stringValue?: string };
      return { ...o, value: { ...value, stringValue: `${value.stringValue ?? ''}${opts.suffix}` } };
    }
    const out: Json = {};
    for (const [k, x] of Object.entries(o)) {
      if ((k === 'timeUnixNano' || k === 'observedTimeUnixNano') && /^\d+$/.test(String(x)))
        out[k] = String(BigInt(String(x)) + shift);
      else out[k] = walk(x);
    }
    return out;
  };
  return walk(body);
}
