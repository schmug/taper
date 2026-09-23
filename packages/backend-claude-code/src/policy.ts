// Effective policy: permission arrays merged across every settings source (facts doc B1), in the
// decisive tie-break order of ADR-0006: scope precedence, then source order, then array index.
// Pure.

import { normalizeRule, type ParsedRule, type Polarity, parseRule } from './rule.ts';

export type Scope = 'managed' | 'cli' | 'local' | 'project' | 'user';
/** Highest precedence first (facts doc B1 'Scope order'). */
export const SCOPES: readonly Scope[] = ['managed', 'cli', 'local', 'project', 'user'];

/** Workspace trust (ADR-0002 row 1). `unknown` keeps project allow rules: over-refresh is safe. */
export type Trust = boolean | 'unknown';

export interface PermissionArrays {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

export interface PolicySource {
  readonly scope: Scope;
  /** Settings file path (anchors `/path` rules); for inline `--settings` JSON, a synthetic id. */
  readonly path: string;
  readonly arrays: PermissionArrays;
  /** Inline `--settings '<json>'`: no file, so `/path` rules anchor at the session cwd. */
  readonly inline?: boolean;
  /** Knob per array, when the caller maps sources onto core knobs (knobs.ts). */
  readonly knobIds?: Partial<Record<Polarity, string>>;
}

export interface PolicyRule {
  /** Normalized (trimmed) rule string: the member's `rule`. */
  readonly rule: string;
  readonly scope: Scope;
  readonly polarity: Polarity;
  readonly sourcePath: string;
  /** Position in the source's original array. */
  readonly index: number;
  /** Tie-break rank; lower wins (ADR-0006). */
  readonly rank: number;
  /** Where `/path` patterns anchor; null = the session cwd (inline `--settings`). */
  readonly anchorDir: string | null;
  readonly parsed: ParsedRule;
  readonly knobId: string | undefined;
}

export interface EffectivePolicy {
  /** Sorted by `rank`. */
  readonly rules: readonly PolicyRule[];
  readonly home: string;
  readonly workspaceTrusted: Trust;
}

export interface PolicyInput {
  /** In merge order within a scope (managed-settings.json before managed-settings.d/*). */
  readonly sources: readonly PolicySource[];
  readonly home: string;
  readonly workspaceTrusted: Trust;
}

const POLARITIES: readonly Polarity[] = ['allow', 'ask', 'deny'];

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};

/** facts doc B2: `/path` anchors at ~/.claude (user), the file's dir (--settings), or the
 * primary working dir (project/local: the directory holding `.claude/`). Managed is not
 * documented; taper uses the file's directory (UNVERIFIED, ADR-0006). */
function anchorDir(src: PolicySource): string | null {
  switch (src.scope) {
    case 'project':
    case 'local':
      return dirname(dirname(src.path));
    case 'cli':
      return src.inline ? null : dirname(src.path);
    case 'managed':
    case 'user':
      return dirname(src.path);
  }
}

export function buildPolicy(input: PolicyInput): EffectivePolicy {
  const rules: PolicyRule[] = [];
  for (const scope of SCOPES) {
    for (const src of input.sources) {
      if (src.scope !== scope) continue;
      const anchor = anchorDir(src);
      for (const polarity of POLARITIES) {
        // An untrusted workspace ignores project allow rules (ADR-0002 row 1).
        if (polarity === 'allow' && scope === 'project' && input.workspaceTrusted === false)
          continue;
        src.arrays[polarity].forEach((raw, index) => {
          const rule = normalizeRule(raw);
          if (rule === '') return;
          rules.push({
            rule,
            scope,
            polarity,
            sourcePath: src.path,
            index,
            rank: rules.length,
            anchorDir: anchor,
            parsed: parseRule(rule, polarity),
            knobId: src.knobIds?.[polarity],
          });
        });
      }
    }
  }
  return { rules, home: input.home, workspaceTrusted: input.workspaceTrusted };
}
