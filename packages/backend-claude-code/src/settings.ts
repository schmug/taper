// Settings files and snapshots (HANDOFF §5.2, ADR-0007). Pure: text in, data out. The loader that
// reads the disk is src/loader.ts.

import { z } from 'zod';
import type { PermissionArrays } from './policy.ts';

const Rules = z.array(z.string());

/** HANDOFF §5.2, plus `pipeline_id` (cli knobs) and `inline` (inline `--settings` JSON). */
export const SettingsSnapshotSchema = z
  .object({
    device_id: z.string().min(1),
    repo_id: z.string().min(1).optional(),
    /** Workflow path for `cli` snapshots (HANDOFF §3.1). */
    pipeline_id: z.string().min(1).optional(),
    /** Inline `--settings '<json>'`: `path` is `<workflow>#settings[n]`. */
    inline: z.boolean().optional(),
    scope: z.enum(['managed', 'cli', 'local', 'project', 'user']),
    path: z.string().min(1),
    taken_at: z.number().int().nonnegative(),
    content_hash: z.string().regex(/^[0-9a-f]{64}$/),
    arrays: z.object({ allow: Rules, ask: Rules, deny: Rules }).strict(),
    hooks_present: z.boolean(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.scope !== 'user' && s.scope !== 'managed' && s.repo_id === undefined)
      ctx.addIssue({ code: 'custom', path: ['repo_id'], message: `${s.scope} needs repo_id` });
    if (s.scope === 'cli' && s.pipeline_id === undefined)
      ctx.addIssue({ code: 'custom', path: ['pipeline_id'], message: 'cli needs pipeline_id' });
  });
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;

export interface ParsedSettings {
  readonly arrays: PermissionArrays;
  readonly hooksPresent: boolean;
}

// Only the keys taper reads. Everything else passes through untouched; wrong-typed permission
// lists are skipped entry by entry, as Claude Code skips invalid entries (facts doc B1).
const SettingsFile = z.looseObject({
  permissions: z.unknown().optional(),
  hooks: z.unknown().optional(),
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function parseSettingsText(
  text: string,
): { ok: true; settings: ParsedSettings } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = text.trim() === '' ? {} : JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const file = SettingsFile.safeParse(json);
  if (!file.success) return { ok: false, error: 'settings root is not a JSON object' };
  const p = isRecord(file.data.permissions) ? file.data.permissions : {};
  const hooks = file.data.hooks;
  return {
    ok: true,
    settings: {
      arrays: { allow: strings(p.allow), ask: strings(p.ask), deny: strings(p.deny) },
      hooksPresent:
        isRecord(hooks) && Object.values(hooks).some((v) => Array.isArray(v) && v.length > 0),
    },
  };
}

export type SettingsRef =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'inline'; readonly json: string }
  | { readonly kind: 'unresolved'; readonly token: string };

const SETTINGS_ARG = /--settings(?:=|\s+)(?:'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+))/g;

/** `--settings` arguments in a CI workflow file (HANDOFF §3.1 `cli` knobs). Text scan, no YAML. */
export function findSettingsRefs(workflow: string): SettingsRef[] {
  const refs: SettingsRef[] = [];
  for (const m of workflow.matchAll(SETTINGS_ARG)) {
    const value = m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? m[3] ?? '';
    if (value.includes('${{')) refs.push({ kind: 'unresolved', token: value });
    else if (value.trimStart().startsWith('{')) refs.push({ kind: 'inline', json: value });
    else refs.push({ kind: 'file', path: value });
  }
  return refs;
}

const CLAUDE_INVOCATION =
  /anthropics\/claude-code(?:-base)?-action|@anthropic-ai\/claude-code|\bclaude\s+(?:-p|--print)\b/;

/** True when a workflow runs Claude Code: its knobs are shadow-only by default (C3). */
export function invokesClaudeCode(workflow: string): boolean {
  return CLAUDE_INVOCATION.test(workflow);
}
