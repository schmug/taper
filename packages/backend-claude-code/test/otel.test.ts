// OTLP/HTTP JSON logs → observations, against the recorded M0 streams (facts doc A2 'OTLP wire
// shape', B5). Raw arguments come out only as a matcher input (invariant 8).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOtlpLogs, type Observation } from '../src/otel.ts';

const OTEL = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'otel');
const bodies = (name: string): unknown[] =>
  readFileSync(join(OTEL, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { body: unknown }).body);
const observe = (name: string): Observation[] => bodies(name).flatMap(normalizeOtlpLogs);
const tools = (obs: Observation[]) =>
  obs.filter((o) => o.kind === 'tool_decision' || o.kind === 'tool_result');

describe('normalizeOtlpLogs', () => {
  it('reads an accepted Bash decision and its result with the full command (a0)', () => {
    const obs = tools(observe('a0-allow-control'));
    expect(obs).toEqual([
      {
        kind: 'tool_decision',
        sessionId: '6898c6bf-fbea-45e3-a484-e9e02afe0e2c',
        at: 1790113393038,
        toolName: 'Bash',
        toolUseId: 'toolu_01RXQpAkxUUbQeEyW6L2WrFp',
        decision: 'accept',
        source: 'config',
        input: { command: './probe.sh a' },
      },
      {
        kind: 'tool_result',
        sessionId: '6898c6bf-fbea-45e3-a484-e9e02afe0e2c',
        at: 1790113393892,
        toolName: 'Bash',
        toolUseId: 'toolu_01RXQpAkxUUbQeEyW6L2WrFp',
        decision: 'accept',
        input: { command: './probe.sh a' },
      },
    ]);
  });

  it('takes the source from tool_decision only (ADR-0002 row 9)', () => {
    const [decision, result] = tools(observe('c0-dont-ask-again'));
    expect(decision?.source).toBe('user_permanent');
    expect(result?.source).toBeUndefined();
  });

  it('keeps rejects and hook sources (a3, b1)', () => {
    expect(tools(observe('a3-cli-deny-over-project-allow'))[0]).toMatchObject({
      decision: 'reject',
      source: 'config',
    });
    expect(tools(observe('b1-hook-deny'))[0]).toMatchObject({ decision: 'reject', source: 'hook' });
  });

  it('has no input for a Read decision; the result carries the path (r0)', () => {
    const [decision, result] = tools(observe('r0-read-in-workdir'));
    expect(decision?.toolName).toBe('Read');
    expect(decision?.input).toBeUndefined();
    expect(result?.input).toEqual({ file_path: '/probe/r0-read-in-workdir/repo/probe.sh' });
  });

  it('maps startup managed_settings_resolved to session_start and hook_registered to a heartbeat', () => {
    const kinds = observe('a0-allow-control').map((o) => o.kind);
    expect(kinds.filter((k) => k === 'session_start').length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === 'hook_registered').length).toBeGreaterThan(0);
  });

  it('emits no tool observation when the headless ask left no tool_decision (a1, e0)', () => {
    expect(tools(observe('a1-local-ask-over-project-allow'))).toEqual([]);
    expect(tools(observe('e0-headless-unmatched'))).toEqual([]);
  });

  it('parses every recorded stream; metrics bodies yield nothing', () => {
    for (const f of readdirSync(OTEL).filter((x) => x.endsWith('.jsonl'))) {
      const obs = observe(f.replace(/\.jsonl$/, ''));
      for (const o of obs) expect(o.sessionId).not.toBe('');
    }
    expect(normalizeOtlpLogs({ resourceMetrics: [] })).toEqual([]);
  });

  it('rebuilds user MCP tool names from tool_parameters (facts doc B5)', () => {
    const record = (attrs: Record<string, string>) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '2000000000',
                  attributes: Object.entries(attrs).map(([key, v]) => ({
                    key,
                    value: { stringValue: v },
                  })),
                },
              ],
            },
          ],
        },
      ],
    });
    const [o] = normalizeOtlpLogs(
      record({
        'event.name': 'tool_decision',
        'session.id': 's',
        tool_name: 'mcp_tool',
        tool_use_id: 't',
        decision: 'accept',
        source: 'config',
        tool_parameters: JSON.stringify({ mcp_server_name: 'github', mcp_tool_name: 'get_issue' }),
      }),
    );
    expect(o).toMatchObject({ toolName: 'mcp__github__get_issue', at: 2000 });
  });

  it('drops malformed records instead of throwing', () => {
    expect(normalizeOtlpLogs(null)).toEqual([]);
    expect(normalizeOtlpLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] })).toEqual(
      [],
    );
    const bad = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: 'x',
                  attributes: [{ key: 'event.name', value: { stringValue: 'tool_decision' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(normalizeOtlpLogs(bad)).toEqual([]);
  });
});
