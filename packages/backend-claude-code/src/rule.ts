// Claude Code permission-rule parser (HANDOFF §5.1, facts doc B2, ADR-0006). Pure.
// A rule is `Tool` or `Tool(specifier)`. Parsing depends on the array it sits in, because some
// forms are valid only in deny/ask (tool-name globs, parameter rules, `!` negation). Anything
// Claude Code skips, ignores, or that taper does not model parses as `inert`: it never matches,
// and knobs.ts protects it from decay (C5: never let attribution ambiguity cause a removal).

export type Polarity = 'allow' | 'ask' | 'deny';

export type ParsedRule =
  /** Bare tool name: matches every call of the listed (canonical) tools. */
  | { readonly kind: 'tools'; readonly tools: ReadonlySet<string> }
  /** Tool-name glob (deny/ask anywhere; allow only after a literal `mcp__<server>__`). */
  | { readonly kind: 'tool_glob'; readonly re: RegExp }
  /** Bash/Monitor command pattern; legacy `:*` already rewritten to ` *`. */
  | { readonly kind: 'command'; readonly pattern: string }
  /** Read/Edit gitignore-style path pattern. */
  | {
      readonly kind: 'path';
      readonly family: 'read' | 'edit';
      readonly pattern: string;
      readonly negated: boolean;
    }
  | { readonly kind: 'domain'; readonly pattern: string }
  | { readonly kind: 'agent'; readonly pattern: string }
  | { readonly kind: 'skill'; readonly pattern: string }
  /** `Tool(param:value)`, deny/ask only. */
  | {
      readonly kind: 'param';
      readonly tools: ReadonlySet<string>;
      readonly param: string;
      readonly pattern: string;
    }
  /** Rules with two documented readings; matches when either does. */
  | { readonly kind: 'either'; readonly options: readonly ParsedRule[] }
  /** Parsed, but Claude Code skips or ignores it, or taper does not model it. Never matches. */
  | { readonly kind: 'inert'; readonly reason: string };

/** Tools whose calls consult Read(...) rules (facts doc B2). */
export const READ_FAMILY: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LSP']);
/** Tools whose calls consult Edit(...) rules (facts doc B2). */
export const EDIT_FAMILY: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);
/** Tools whose calls consult Bash(...) rules. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor']);

const BARE_COVERS: Readonly<Record<string, ReadonlySet<string>>> = {
  Read: READ_FAMILY,
  Edit: EDIT_FAMILY,
  Bash: SHELL_TOOLS,
};

// Top-level scalar parameters that parameter rules may name (facts doc B2). The primary content
// field (`command`, `subagent_type`, `prompt`) is ignored by Claude Code with a warning.
const PARAMS: Readonly<Record<string, ReadonlySet<string>>> = {
  Bash: new Set(['timeout', 'run_in_background', 'dangerouslyDisableSandbox', 'description']),
  Agent: new Set(['model', 'run_in_background']),
};
const PRIMARY: Readonly<Record<string, ReadonlySet<string>>> = {
  Bash: new Set(['command']),
  Agent: new Set(['subagent_type', 'prompt']),
};

const TOOL_NAME = /^[A-Za-z0-9_*-]+$/;
const PARAM_SPEC = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/s;

const inert = (reason: string): ParsedRule => ({ kind: 'inert', reason });
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function normalizeRule(raw: string): string {
  return raw.trim();
}

/** Current tool name for a call (`Task` is the legacy name of `Agent`). */
export function canonicalTool(name: string): string {
  return name === 'Task' ? 'Agent' : name;
}

export function parseRule(rule: string, polarity: Polarity): ParsedRule {
  const r = normalizeRule(rule);
  if (r === '') return inert('empty rule');
  const open = r.indexOf('(');
  if (open === -1) return bare(r, polarity);
  if (!r.endsWith(')')) return inert('malformed: text after the specifier');
  const tool = r.slice(0, open);
  const spec = r.slice(open + 1, -1);
  if (tool === '') return inert('specifier without a tool name');
  if (!TOOL_NAME.test(tool)) return inert('malformed tool name');
  if (spec === '') return inert('empty specifier');
  if (tool.includes('*')) return inert('tool-name glob with a specifier');
  if (tool.startsWith('mcp__'))
    return inert('mcp__ rules with parentheses are skipped in settings');
  if (spec === '*') return bare(tool, polarity);
  return specified(canonicalTool(tool), spec, polarity);
}

function bare(name: string, polarity: Polarity): ParsedRule {
  if (!TOOL_NAME.test(name)) return inert('malformed tool name');
  if (name.includes('*')) return toolGlob(name, polarity);
  if (name.startsWith('mcp__') && !name.slice(5).includes('__'))
    return { kind: 'tool_glob', re: new RegExp(`^${escapeRegExp(name)}__.+$`, 's') };
  const tool = canonicalTool(name);
  const tools = new Set(BARE_COVERS[tool] ?? [tool]);
  // A Read deny also blocks Edit and Write on the same path (facts doc B2).
  if (tool === 'Read' && polarity === 'deny') for (const t of EDIT_FAMILY) tools.add(t);
  return { kind: 'tools', tools };
}

function toolGlob(name: string, polarity: Polarity): ParsedRule {
  if (polarity === 'allow') {
    // Allow accepts a glob only after a literal `mcp__<server>__` (facts doc B2).
    const server = /^mcp__[^*]+?__/.exec(name);
    if (!server || name.indexOf('*') < server[0].length)
      return inert('tool-name glob in an allow array is skipped');
  }
  const re = name.split('*').map(escapeRegExp).join('.*');
  return { kind: 'tool_glob', re: new RegExp(`^${re}$`, 's') };
}

function specified(tool: string, spec: string, polarity: Polarity): ParsedRule {
  switch (tool) {
    case 'Bash':
    case 'Monitor':
      return commandRule(spec, polarity);
    case 'Read':
    case 'Edit':
      return pathRule(tool === 'Read' ? 'read' : 'edit', spec, polarity);
    case 'WebFetch': {
      const pattern = spec.startsWith('domain:') ? spec.slice('domain:'.length) : '';
      return pattern === '' ? inert('WebFetch accepts only domain:') : { kind: 'domain', pattern };
    }
    case 'Agent':
      return agentRule(spec, polarity);
    case 'Skill':
      return { kind: 'skill', pattern: spec };
    case 'Write':
    case 'NotebookEdit':
    case 'MultiEdit':
    case 'Glob':
    case 'Grep':
    case 'LSP':
      return inert(`${tool}(path) rules are never consulted; use Read(...) or Edit(...)`);
    case 'PowerShell':
      return inert('PowerShell rules are not modeled');
    default:
      return inert(`${tool}(...) takes no specifier taper models`);
  }
}

function commandRule(spec: string, polarity: Polarity): ParsedRule {
  const command: ParsedRule = {
    kind: 'command',
    pattern: spec.endsWith(':*') ? `${spec.slice(0, -2)} *` : spec,
  };
  const param = PARAM_SPEC.exec(spec);
  if (!param || polarity === 'allow') return command;
  const [, name = '', value = ''] = param;
  if (PRIMARY.Bash?.has(name)) return inert('Bash(command:…) is ignored');
  if (!PARAMS.Bash?.has(name)) return command;
  const byParam: ParsedRule = { kind: 'param', tools: SHELL_TOOLS, param: name, pattern: value };
  // `Bash(timeout:*)` is both a parameter rule and the legacy prefix for `timeout`.
  return value === '*' ? { kind: 'either', options: [byParam, command] } : byParam;
}

function agentRule(spec: string, polarity: Polarity): ParsedRule {
  const param = PARAM_SPEC.exec(spec);
  const name = param?.[1] ?? '';
  if (PARAMS.Agent?.has(name)) {
    if (polarity === 'allow') return inert('parameter rules are deny/ask only');
    return { kind: 'param', tools: new Set(['Agent']), param: name, pattern: param?.[2] ?? '' };
  }
  if (PRIMARY.Agent?.has(name)) return inert('the primary Agent field is not a parameter rule');
  return { kind: 'agent', pattern: spec };
}

function pathRule(family: 'read' | 'edit', spec: string, polarity: Polarity): ParsedRule {
  if (!spec.startsWith('!')) return { kind: 'path', family, pattern: spec, negated: false };
  if (polarity === 'allow') return inert('! negation is deny/ask only');
  return { kind: 'path', family, pattern: spec.slice(1), negated: true };
}
