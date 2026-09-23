// Loads fixtures/settings/*.json (one file per rule form) for the unit suite and the differential
// job. Placeholders: {{cwd}} session working dir, {{root}} its parent, {{home}} home dir.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PolicyRule, PolicySource, Scope } from '../src/index.ts';

export const FIXTURE_DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'settings');

const Rules = z
  .object({
    allow: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const Ref = z.string().regex(/^(managed|cli|local|project|user)\.(allow|ask|deny)\[\d+\]$/);

const Case = z
  .object({
    name: z.string().min(1),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    expect: z
      .object({
        outcome: z.enum(['allow', 'ask', 'deny', 'none']),
        basis: z.enum(['rule', 'builtin', 'too_long', 'unparseable', 'no_match']).optional(),
        decisive: z.array(Ref).default([]),
        allowMatches: z.array(Ref).default([]),
      })
      .strict(),
    /** Run against the real binary in the differential job. */
    diff: z.boolean().default(false),
    /** Why a case is not run by the differential job. */
    diffNote: z.string().optional(),
  })
  .strict();

export const FixtureSchema = z
  .object({
    form: z.string().min(1),
    source: z.string().min(1),
    /** Applies to every case without `diff: true`. */
    diffNote: z.string().optional(),
    workspaceTrusted: z.union([z.boolean(), z.literal('unknown')]).default(true),
    settings: z
      .object({
        managed: Rules.optional(),
        cli: Rules.optional(),
        local: Rules.optional(),
        project: Rules.optional(),
        user: Rules.optional(),
      })
      .strict(),
    cases: z.array(Case).min(1),
  })
  .strict();

export type Fixture = z.infer<typeof FixtureSchema>;
export type FixtureCase = Fixture['cases'][number];

export interface Paths {
  readonly cwd: string;
  readonly root: string;
  readonly home: string;
}

export const UNIT_PATHS: Paths = { cwd: '/work/repo', root: '/work', home: '/home/u' };

export const fill = (s: string, p: Paths): string =>
  s.replaceAll('{{cwd}}', p.cwd).replaceAll('{{root}}', p.root).replaceAll('{{home}}', p.home);

export function fillDeep(v: unknown, p: Paths): unknown {
  if (typeof v === 'string') return fill(v, p);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, p));
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, p)]));
  return v;
}

export function settingsPath(scope: Scope, p: Paths): string {
  switch (scope) {
    case 'managed':
      return '/Library/Application Support/ClaudeCode/managed-settings.json';
    case 'cli':
      return `${p.root}/cli/settings.json`;
    case 'local':
      return `${p.cwd}/.claude/settings.local.json`;
    case 'project':
      return `${p.cwd}/.claude/settings.json`;
    case 'user':
      return `${p.home}/.claude/settings.json`;
  }
}

export function sourcesFor(fx: Fixture, p: Paths): PolicySource[] {
  const out: PolicySource[] = [];
  for (const scope of ['managed', 'cli', 'local', 'project', 'user'] as const) {
    const rules = fx.settings[scope];
    if (!rules) continue;
    const arr = (xs: string[] | undefined) => (xs ?? []).map((r) => fill(r, p));
    out.push({
      scope,
      path: settingsPath(scope, p),
      arrays: { allow: arr(rules.allow), ask: arr(rules.ask), deny: arr(rules.deny) },
    });
  }
  return out;
}

export const refOf = (r: PolicyRule): string => `${r.scope}.${r.polarity}[${r.index}]`;

export function loadFixtures(): { file: string; fixture: Fixture }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      fixture: FixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'))),
    }));
}
