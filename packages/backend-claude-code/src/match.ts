// match(effectivePolicy, toolCall) (HANDOFF §5.1). Deny → ask → allow, first match wins,
// specificity ignored. The decisive tie-break and the compound-command decisive set are ADR-0006.
// Pure. Raw tool arguments are only read here, never stored (invariant 8).
//
// The matcher models the rule layer plus two built-ins (the read-only Bash set, reads inside
// cwd). Permission modes (acceptEdits, auto, bypassPermissions, dontAsk) are not modeled:
// `none` means "falls through to the mode", which prompts in the default mode (C4).

import { isInside, matchPathPattern, normalizePath } from './path.ts';
import type { EffectivePolicy, PolicyRule } from './policy.ts';
import {
  canonicalTool,
  EDIT_FAMILY,
  type ParsedRule,
  type Polarity,
  READ_FAMILY,
  SHELL_TOOLS,
} from './rule.ts';
import {
  isReadOnlyCommand,
  matchCommandPattern,
  parseShell,
  redirectsToFile,
  requiresExactRule,
  stripWrappers,
} from './shell.ts';

export interface ToolCall {
  /** Tool name as Claude Code reports it (`Bash`, `Read`, `mcp__server__tool`, legacy `Task`). */
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * The session's primary working directory (where Claude Code started). It anchors relative
   * path rules and the in-cwd read built-in. Passing the shell's current directory after a `cd`
   * would under-match relative allow rules, which is the unsafe direction (C5). M3 decides how a
   * hook obtains it.
   */
  readonly cwd: string;
}

/**
 * - `rule`: a rule decided (deny/ask/allow).
 * - `builtin`: allowed with no rule (read-only Bash set, reads inside cwd).
 * - `too_long`: commands over 10,000 characters always prompt.
 * - `unparseable`: allow rules cannot match (e.g. trailing `&&`).
 * - `background`: a `&` operator; Claude Code prompts even if allow rules cover every part.
 * - `redirect`: an output redirection to a file; Claude Code prompts even if an allow rule
 *   matches. Both from the 2026-09-23 differential run (ADR-0009). Allow rules still count as
 *   matched for attribution (C5).
 * - `no_match`: falls through to the permission mode.
 */
export type MatchBasis =
  | 'rule'
  | 'builtin'
  | 'too_long'
  | 'unparseable'
  | 'background'
  | 'redirect'
  | 'no_match';

export interface MatchResult {
  /** `none` = no rule decided; Claude Code falls back to the permission mode (a prompt). */
  readonly outcome: 'allow' | 'ask' | 'deny' | 'none';
  readonly basis: MatchBasis;
  /** One rule for deny/ask; one per covered subcommand for allow (a set, ADR-0006). */
  readonly decisiveRules: readonly PolicyRule[];
  /** Every allow rule matching the call or any part of it, in tie-break order (C5). */
  readonly allMatchingAllowRules: readonly PolicyRule[];
}

export const MAX_COMMAND_LENGTH = 10_000;

const result = (
  outcome: MatchResult['outcome'],
  basis: MatchBasis,
  decisiveRules: readonly PolicyRule[],
  allMatchingAllowRules: readonly PolicyRule[],
): MatchResult => ({ outcome, basis, decisiveRules, allMatchingAllowRules });

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `*` matches any text; otherwise exact. */
function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 's').test(value);
}

function paramMatches(p: ParsedRule & { kind: 'param' }, input: ToolCall['input']): boolean {
  const v = input[p.param];
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return false;
  return globMatch(p.pattern, String(v));
}

/** Hostname match (facts doc B2): case-insensitive, trailing dot ignored, `*.` any depth. */
function domainMatches(pattern: string, url: unknown): boolean {
  if (typeof url !== 'string') return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  const pat = pattern.toLowerCase().replace(/\.$/, '');
  if (pat === '*') return true;
  const labels = (p: string) => p.split('*').map(escapeRegExp).join('[^.]+');
  const re = pat.startsWith('*.') ? `^(?:[^.]+\\.)+${labels(pat.slice(2))}$` : `^${labels(pat)}$`;
  return new RegExp(re).test(host);
}

/** The path a file tool acts on; Grep/Glob default to cwd. */
function targetPath(tool: string, call: ToolCall, home: string): string | null {
  const raw = str(call.input.file_path) ?? str(call.input.notebook_path) ?? str(call.input.path);
  if (raw !== null) return normalizePath(raw, call.cwd, home);
  return tool === 'Grep' || tool === 'Glob' ? normalizePath(call.cwd, call.cwd, home) : null;
}

/** Whole-call match for every non-shell rule kind (path negation handled by `collect`). */
function hitsCall(
  p: ParsedRule,
  r: PolicyRule,
  tool: string,
  call: ToolCall,
  path: string | null,
  home: string,
): boolean {
  switch (p.kind) {
    case 'tools':
      return p.tools.has(tool);
    case 'tool_glob':
      return p.re.test(tool);
    case 'param':
      return p.tools.has(tool) && paramMatches(p, call.input);
    case 'either':
      return p.options.some((o) => hitsCall(o, r, tool, call, path, home));
    case 'path': {
      const family = READ_FAMILY.has(tool) ? 'read' : EDIT_FAMILY.has(tool) ? 'edit' : null;
      if (family === null || path === null) return false;
      // A Read deny also blocks edits; an Edit allow also grants reads (facts doc B2).
      const applies =
        p.family === family ||
        (p.family === 'read' && r.polarity === 'deny') ||
        (p.family === 'edit' && r.polarity === 'allow');
      const ctx = { cwd: call.cwd, home, anchorDir: r.anchorDir };
      return applies && matchPathPattern(p.pattern, r.polarity, ctx, path);
    }
    case 'domain':
      return tool === 'WebFetch' && domainMatches(p.pattern, call.input.url);
    case 'agent':
      return (
        tool === 'Agent' && globMatch(p.pattern, str(call.input.subagent_type) ?? 'general-purpose')
      );
    case 'skill': {
      const text = [str(call.input.skill), str(call.input.args)].filter((x) => x).join(' ');
      return tool === 'Skill' && matchCommandPattern(p.pattern, text);
    }
    case 'command':
    case 'inert':
      return false;
  }
}

/** Rules of one polarity that hit, in rank order. A later `!` path rule carves matches out of
 * earlier path rules from the same source (facts doc B2). */
function collect(
  policy: EffectivePolicy,
  polarity: Polarity,
  hits: (r: PolicyRule) => boolean,
): PolicyRule[] {
  let out: PolicyRule[] = [];
  for (const r of policy.rules) {
    if (r.polarity !== polarity || !hits(r)) continue;
    if (r.parsed.kind === 'path' && r.parsed.negated)
      out = out.filter((x) => x.sourcePath !== r.sourcePath || x.parsed.kind !== 'path');
    else out.push(r);
  }
  return out;
}

function matchTool(policy: EffectivePolicy, tool: string, call: ToolCall): MatchResult {
  const path = targetPath(tool, call, policy.home);
  const hits = (r: PolicyRule) => hitsCall(r.parsed, r, tool, call, path, policy.home);
  const allows = collect(policy, 'allow', hits);
  const [deny] = collect(policy, 'deny', hits);
  if (deny) return result('deny', 'rule', [deny], allows);
  const [ask] = collect(policy, 'ask', hits);
  if (ask) return result('ask', 'rule', [ask], allows);
  // Reads inside the working directory need no rule (facts doc A1 r0).
  if (READ_FAMILY.has(tool) && path !== null && isInside(path, normalizePath(call.cwd, '/', '/')))
    return result('allow', 'builtin', [], allows);
  const [allow] = allows;
  return allow ? result('allow', 'rule', [allow], allows) : result('none', 'no_match', [], allows);
}

interface Sub {
  readonly forms: readonly string[];
  readonly stripped: string;
}

/** Shell rule hit: call-level kinds ignore `sub`; command patterns need one. */
function hitsShell(
  p: ParsedRule,
  tool: string,
  input: ToolCall['input'],
  sub: Sub | null,
  polarity: Polarity,
): boolean {
  switch (p.kind) {
    case 'tools':
      return p.tools.has(tool);
    case 'tool_glob':
      return p.re.test(tool);
    case 'param':
      return p.tools.has(tool) && paramMatches(p, input);
    case 'either':
      return p.options.some((o) => hitsShell(o, tool, input, sub, polarity));
    case 'command':
      if (sub === null) return false;
      // watch, find -delete, ...: prefix rules cannot approve them (facts doc B2).
      if (polarity === 'allow' && p.pattern.includes('*') && requiresExactRule(sub.stripped))
        return false;
      return sub.forms.some((f) => matchCommandPattern(p.pattern, f));
    default:
      return false;
  }
}

function matchShell(policy: EffectivePolicy, tool: string, call: ToolCall): MatchResult {
  const command = str(call.input.command) ?? '';
  const parsed = parseShell(command);
  // Match both the raw and the wrapper-stripped form. For allow this over-matches where Claude
  // Code strips less (unsafe env vars); over-refresh is the safe direction (C5, ADR-0006).
  const subs: Sub[] = parsed.commands.map((raw) => {
    const stripped = stripWrappers(raw);
    return { forms: stripped === raw ? [raw] : [raw, stripped], stripped };
  });
  const hitsAny = (r: PolicyRule) =>
    hitsShell(r.parsed, tool, call.input, null, r.polarity) ||
    subs.some((s) => hitsShell(r.parsed, tool, call.input, s, r.polarity));
  const allows = collect(policy, 'allow', hitsAny);
  const [deny] = collect(policy, 'deny', hitsAny);
  if (deny) return result('deny', 'rule', [deny], allows);
  const [ask] = collect(policy, 'ask', hitsAny);
  if (ask) return result('ask', 'rule', [ask], allows);
  if (command.length > MAX_COMMAND_LENGTH) return result('ask', 'too_long', [], allows);
  if (parsed.unparseable) return result('none', 'unparseable', [], allows);
  if (parsed.background) return result('none', 'background', [], allows);
  if (subs.some((s) => redirectsToFile(s.stripped))) return result('none', 'redirect', [], allows);

  const callLevel = allows.find((r) => hitsShell(r.parsed, tool, call.input, null, 'allow'));
  if (subs.length === 0)
    return callLevel
      ? result('allow', 'rule', [callLevel], allows)
      : result('none', 'no_match', [], allows);
  // Allow needs every subcommand covered, by a rule or by the read-only built-in set.
  const decisive = new Set<PolicyRule>();
  for (const s of subs) {
    if (isReadOnlyCommand(s.stripped)) continue;
    const r = allows.find((a) => hitsShell(a.parsed, tool, call.input, s, 'allow'));
    if (!r) return result('none', 'no_match', [], allows);
    decisive.add(r);
  }
  if (decisive.size === 0) return result('allow', 'builtin', [], allows);
  return result(
    'allow',
    'rule',
    [...decisive].sort((a, b) => a.rank - b.rank),
    allows,
  );
}

export function match(policy: EffectivePolicy, call: ToolCall): MatchResult {
  const tool = canonicalTool(call.tool);
  return SHELL_TOOLS.has(tool) ? matchShell(policy, tool, call) : matchTool(policy, tool, call);
}
