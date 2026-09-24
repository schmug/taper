// OTLP/HTTP JSON logs → observations (HANDOFF §5.3 path 2; facts doc A2 'OTLP wire shape', B5).
// Pure. An observation still carries the raw call (`input`) because attribution needs it; the
// caller matches, then drops it (invariant 8). Events other than the ones below are ignored.
//
// - tool_decision: Bash input is `tool_parameters.full_command` (untruncated). File tools carry
//   no input here; their path is only on the result (ADR-0002 row 9).
// - tool_result: input from `tool_parameters` when it has the call, else the `tool_input` JSON
//   (values over 512 chars are truncated there). Source is left to the decision (row 9).
// - managed_settings_resolved with trigger `startup` → session_start; hook_registered →
//   heartbeat. OTel has no session event in the logs (session.count is a metric).

import { z } from 'zod';

export type ObservationKind = 'tool_decision' | 'tool_result' | 'session_start' | 'hook_registered';
export type DecisionSource =
  | 'config'
  | 'hook'
  | 'user_permanent'
  | 'user_temporary'
  | 'user_abort'
  | 'user_reject';

export interface Observation {
  readonly kind: ObservationKind;
  readonly sessionId: string;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly decision?: 'accept' | 'reject';
  readonly source?: DecisionSource;
  /** Raw tool arguments for the matcher only. Never persist (invariant 8). */
  readonly input?: Readonly<Record<string, unknown>>;
}

const AnyValue = z.looseObject({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  boolValue: z.boolean().optional(),
});
const LogRecord = z.looseObject({
  timeUnixNano: z.union([z.string(), z.number()]),
  attributes: z.array(z.looseObject({ key: z.string(), value: AnyValue })).default([]),
});
const Body = z.looseObject({
  resourceLogs: z
    .array(
      z.looseObject({
        scopeLogs: z.array(z.looseObject({ logRecords: z.array(z.unknown()).default([]) })),
      }),
    )
    .default([]),
});

const SOURCES = new Set<string>([
  'config',
  'hook',
  'user_permanent',
  'user_temporary',
  'user_abort',
  'user_reject',
]);

function toMs(nanos: string | number): number | null {
  const s = String(nanos);
  if (!/^\d+$/.test(s)) return null;
  return Number(BigInt(s) / 1_000_000n);
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The matcher's view of `tool_parameters` (facts doc B5): Bash, MCP, Skill, Agent/Task. */
function callFromParams(
  tool: string,
  params: Record<string, unknown> | null,
): { tool: string; input?: Record<string, unknown> } {
  if (params === null) return { tool };
  const server = str(params.mcp_server_name);
  const name = str(params.mcp_tool_name);
  if (tool === 'mcp_tool' && server !== undefined && name !== undefined)
    return { tool: `mcp__${server}__${name}`, input: {} };
  const command = str(params.full_command);
  if (tool === 'Bash' && command !== undefined) return { tool, input: { command } };
  const skill = str(params.skill_name);
  if (tool === 'Skill' && skill !== undefined) return { tool, input: { skill } };
  const agent = str(params.subagent_type);
  if ((tool === 'Agent' || tool === 'Task') && agent !== undefined)
    return { tool, input: { subagent_type: agent } };
  return { tool };
}

function observe(raw: unknown): Observation | null {
  const rec = LogRecord.safeParse(raw);
  if (!rec.success) return null;
  const at = toMs(rec.data.timeUnixNano);
  if (at === null) return null;
  const attr = new Map<string, string>();
  for (const { key, value } of rec.data.attributes) {
    const v = value.stringValue ?? (value.intValue === undefined ? undefined : `${value.intValue}`);
    if (v !== undefined) attr.set(key, v);
  }
  const sessionId = attr.get('session.id');
  if (sessionId === undefined || sessionId === '') return null;
  const base = { sessionId, at };

  switch (attr.get('event.name')) {
    case 'managed_settings_resolved':
      return attr.get('managed_settings.trigger') === 'startup'
        ? { ...base, kind: 'session_start' }
        : null;
    case 'hook_registered':
      return { ...base, kind: 'hook_registered' };
    case 'tool_decision':
    case 'tool_result': {
      const kind = attr.get('event.name') as 'tool_decision' | 'tool_result';
      const rawTool = attr.get('tool_name');
      const toolUseId = attr.get('tool_use_id');
      if (rawTool === undefined || toolUseId === undefined) return null;
      const fromParams = callFromParams(rawTool, parseJson(attr.get('tool_parameters')));
      const input =
        fromParams.input ?? (kind === 'tool_result' ? parseJson(attr.get('tool_input')) : null);
      const decision = kind === 'tool_result' ? 'accept' : attr.get('decision');
      if (decision !== 'accept' && decision !== 'reject') return null;
      const source = attr.get('source');
      return {
        ...base,
        kind,
        toolName: fromParams.tool,
        toolUseId,
        decision,
        ...(kind === 'tool_decision' && source !== undefined && SOURCES.has(source)
          ? { source: source as DecisionSource }
          : {}),
        ...(input === null || input === undefined ? {} : { input }),
      };
    }
    default:
      return null;
  }
}

/** One OTLP/HTTP JSON logs request body → observations in record order. Bad records are skipped. */
export function normalizeOtlpLogs(body: unknown): Observation[] {
  const parsed = Body.safeParse(body);
  if (!parsed.success) return [];
  const out: Observation[] = [];
  for (const rl of parsed.data.resourceLogs)
    for (const sl of rl.scopeLogs)
      for (const r of sl.logRecords) {
        const o = observe(r);
        if (o !== null) out.push(o);
      }
  return out;
}
