// Shell command splitting and normalization for Bash rules (facts doc B2, ADR-0006). Pure.
// Not a full shell parser: it splits on the documented separators while respecting quotes,
// escapes, comments, heredocs and substitutions, and surfaces nested commands from (), $() and
// backticks so deny/ask rules can see them. Where it cannot parse, it says so.

export interface ParsedShell {
  /** Simple commands: top-level subcommands plus those nested in (), $() and backticks. */
  readonly commands: readonly string[];
  /** A trailing `&&`/`||` or an unterminated quote/substitution. Allow rules never match these. */
  readonly unparseable: boolean;
}

interface Segment {
  text: string;
  nested: string[];
  group: string | null;
}

const BINARY_OPS = new Set(['&&', '||', '|', '|&']);
const LEADING_KEYWORD = /^(?:if|then|elif|else|do|while|until|!|\{)(?:\s+|$)/;
const CLOSING_KEYWORD = /^(?:fi|done|esac|\}|then|do|else)$/;
const HEADER = /^(?:for|select|case)\s/;

/** Index of the `)` closing the `(` at `open`, skipping quotes and escapes; -1 if none. */
function findClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      i = s.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (c === '"') {
      i = findDoubleQuoteEnd(s, i, []);
      if (i < 0) return -1;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Index of the closing `"` for the one at `start`; collects `$()`/backtick bodies. */
function findDoubleQuoteEnd(s: string, start: number, nested: string[]): number {
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '"') return i;
    else if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      const j = findClose(s, i + 1);
      if (j < 0) return -1;
      nested.push(s.slice(i + 2, j));
      i = j;
    } else if (c === '`') {
      const j = findBacktickEnd(s, i);
      if (j < 0) return -1;
      nested.push(s.slice(i + 1, j));
      i = j;
    }
  }
  return -1;
}

function findBacktickEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  return -1;
}

/** Operator starting at `i`, or null when the character belongs to a word or redirection. */
function operatorAt(s: string, i: number, buf: string): string | null {
  const two = s.slice(i, i + 2);
  if (two === '&&' || two === '||' || two === '|&' || two === ';;') return two;
  const c = s[i];
  if (c === ';' || c === '\n') return c;
  const prev = buf[buf.length - 1];
  if (c === '&') return s[i + 1] === '>' || prev === '>' || prev === '<' ? null : c;
  if (c === '|') return prev === '>' ? null : c;
  return null;
}

function split(cmd: string): { segments: Segment[]; unparseable: boolean } {
  const segments: Segment[] = [];
  let seg: Segment = { text: '', nested: [], group: null };
  let pendingBinary = false;
  const heredocs: { delim: string; stripTabs: boolean }[] = [];
  const fail = () => {
    segments.push(seg);
    return { segments, unparseable: true };
  };
  const append = (text: string) => {
    seg.text += text;
    if (text.trim() !== '') pendingBinary = false;
  };

  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i] as string;
    if (c === '\\') {
      if (cmd[i + 1] === '\n')
        i += 2; // line continuation
      else {
        append(cmd.slice(i, i + 2));
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return fail();
      append(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = findDoubleQuoteEnd(cmd, i, seg.nested);
      if (j < 0) return fail();
      append(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const j = findClose(cmd, i + 1);
      if (j < 0) return fail();
      if (cmd[i + 2] !== '(') seg.nested.push(cmd.slice(i + 2, j)); // $(( )) is arithmetic
      append(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const j = findBacktickEnd(cmd, i);
      if (j < 0) return fail();
      seg.nested.push(cmd.slice(i + 1, j));
      append(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '(') {
      const j = findClose(cmd, i);
      if (j < 0) return fail();
      const body = cmd.slice(i + 1, j);
      const last = seg.text[seg.text.length - 1];
      if (seg.text.trim() === '')
        seg.group = body; // subshell
      else if (last === '<' || last === '>') seg.nested.push(body); // process substitution
      append(cmd.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '#' && (seg.text === '' || /\s$/.test(seg.text))) {
      const nl = cmd.indexOf('\n', i);
      i = nl < 0 ? cmd.length : nl;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<') {
      if (cmd[i + 2] === '<') {
        append('<<<');
        i += 3;
        continue;
      }
      const m = /^<<(-?)[ \t]*('([^']*)'|"([^"]*)"|[^\s;&|<>()]+)/.exec(cmd.slice(i));
      if (m) {
        const token = m[2] as string;
        heredocs.push({ delim: m[3] ?? m[4] ?? token, stripTabs: m[1] === '-' });
        append(m[0]);
        i += m[0].length;
        continue;
      }
    }
    const op = operatorAt(cmd, i, seg.text);
    if (op !== null) {
      segments.push(seg);
      seg = { text: '', nested: [], group: null };
      if (op !== '\n' || !pendingBinary) pendingBinary = BINARY_OPS.has(op);
      i += op.length;
      if (op === '\n') i = skipHeredocBodies(cmd, i, heredocs.splice(0));
      continue;
    }
    append(c);
    i++;
  }
  segments.push(seg);
  return { segments, unparseable: pendingBinary };
}

/** Skips heredoc bodies that start at `i` (just after a newline). */
function skipHeredocBodies(
  cmd: string,
  start: number,
  docs: readonly { delim: string; stripTabs: boolean }[],
): number {
  let i = start;
  for (const doc of docs) {
    while (i < cmd.length) {
      const nl = cmd.indexOf('\n', i);
      const end = nl < 0 ? cmd.length : nl;
      const line = cmd.slice(i, end);
      i = nl < 0 ? cmd.length : nl + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delim) break;
    }
  }
  return i;
}

function commandsOf(seg: Segment, out: string[]): boolean {
  let ok = true;
  if (seg.group !== null) ok = collect(seg.group, out);
  else {
    let text = seg.text.trim();
    for (let m = LEADING_KEYWORD.exec(text); m; m = LEADING_KEYWORD.exec(text))
      text = text.slice(m[0].length);
    if (text !== '' && !CLOSING_KEYWORD.test(text) && !HEADER.test(text)) out.push(text);
  }
  for (const n of seg.nested) ok = collect(n, out) && ok;
  return ok;
}

function collect(cmd: string, out: string[]): boolean {
  const { segments, unparseable } = split(cmd);
  let ok = !unparseable;
  for (const seg of segments) ok = commandsOf(seg, out) && ok;
  return ok;
}

export function parseShell(command: string): ParsedShell {
  const commands: string[] = [];
  const ok = collect(command, commands);
  return { commands, unparseable: !ok };
}

interface Word {
  readonly text: string;
  readonly start: number;
}

/** Whitespace-separated words, respecting quotes and escapes. */
function words(s: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] as string)) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !/\s/.test(s[i] as string)) {
      const c = s[i];
      if (c === '\\') i += 2;
      else if (c === "'") i = s.indexOf("'", i + 1) + 1 || s.length;
      else if (c === '"') i = findDoubleQuoteEnd(s, i, []) + 1 || s.length;
      else i++;
    }
    out.push({ text: s.slice(start, i), start });
  }
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Number of words the wrapper at `k` occupies (0 = not a strippable wrapper). */
function wrapperLength(w: readonly Word[], k: number): number {
  const at = (n: number) => w[k + n]?.text;
  const isFlag = (n: number) => at(n)?.startsWith('-') ?? false;
  switch (at(0)) {
    case 'nohup':
    case 'builtin':
    case 'noglob':
      return 1;
    case 'command':
    case 'xargs':
      return isFlag(1) ? 0 : 1;
    case 'time': {
      let n = 1;
      while (at(n) === '-p') n++;
      return n;
    }
    case 'nice': {
      const a = at(1);
      if (a === '-n') return 3;
      return a !== undefined && /^(?:-n?-?\d+|--adjustment=-?\d+)$/.test(a) ? 2 : 1;
    }
    case 'timeout': {
      let n = 1;
      while (isFlag(n)) n += /^(?:-s|-k|--signal|--kill-after)$/.test(at(n) ?? '') ? 2 : 1;
      return at(n) === undefined ? 0 : n + 1; // + the duration
    }
    case 'stdbuf': {
      let n = 1;
      while (isFlag(n)) n += /^-[ioe]$/.test(at(n) ?? '') ? 2 : 1;
      return n;
    }
    default:
      return 0;
  }
}

/** Strips leading env assignments and process wrappers (timeout, nice, nohup, ...). */
export function stripWrappers(command: string): string {
  let s = command.trim();
  for (;;) {
    const w = words(s);
    let k = 0;
    while (k < w.length && ASSIGNMENT.test(w[k]?.text ?? '')) k++;
    const next = k + wrapperLength(w, k);
    const rest = w[next];
    if (next === 0 || rest === undefined) return s;
    s = s.slice(rest.start).trim();
  }
}

const READ_ONLY = new Set([
  'ls',
  'cat',
  'echo',
  'pwd',
  'head',
  'tail',
  'grep',
  'find',
  'wc',
  'which',
  'diff',
  'stat',
  'du',
  'cd',
]);
const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'shortlog',
]);
const EXACT_ONLY = new Set(['watch', 'setsid', 'ionice', 'flock']);
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir']);

/** True when an unquoted `>` appears (output redirection). */
function redirectsOutput(s: string): boolean {
  return words(s).some((w) => w.text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '').includes('>'));
}

/** Built-in read-only commands that run without a rule. */
export function isReadOnlyCommand(command: string): boolean {
  const s = stripWrappers(command);
  if (redirectsOutput(s)) return false;
  const [name, sub] = words(s).map((w) => w.text);
  if (name === 'git') return READ_ONLY_GIT.has(sub ?? '');
  if (name === 'find') return !requiresExactRule(s);
  return READ_ONLY.has(name ?? '');
}

/** Runners that prefix (wildcard) rules cannot approve. */
export function requiresExactRule(command: string): boolean {
  const w = words(stripWrappers(command)).map((x) => x.text);
  if (EXACT_ONLY.has(w[0] ?? '')) return true;
  return w[0] === 'find' && w.some((a) => FIND_ACTIONS.has(a));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Bash rule pattern: `*` matches any text; a single trailing ` *` also matches the bare prefix. */
export function matchCommandPattern(pattern: string, command: string): boolean {
  if (!pattern.includes('*')) return pattern === command;
  const parts = pattern.split('*');
  if (new RegExp(`^${parts.map(escapeRegExp).join('.*')}$`, 's').test(command)) return true;
  return parts.length === 2 && pattern.endsWith(' *') && command === pattern.slice(0, -2);
}
