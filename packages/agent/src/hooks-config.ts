// taper's hook registration (HANDOFF §5.3, §5.4A). Writing it is the one change `taper init` makes
// to a settings file: under the `hooks` key only, idempotent, and removed by `taper uninstall`.
// Every rewrite is checked to leave `permissions` deep-equal (invariant 3) and is written
// atomically. The handler shape is the one the M0 probe confirmed (facts doc A2 'Hook I/O').

import { readText, writeAtomic } from './fsutil.ts';

/** Events taper registers. PostToolUseFailure counts as usage (facts doc B4). */
export const HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);
/** Seconds. A timed-out PreToolUse hook fails open (facts doc B4). SessionEnd has its own 1.5 s budget. */
const TIMEOUT_S = 10;

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
export const commandPrefix = (entry: readonly string[]): string => entry.map(shellQuote).join(' ');
export const hookCommand = (prefix: string, event: string): string => `${prefix} hook ${event}`;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(text: string | null): { obj: Json; indent: string; newline: boolean } {
  if (text === null || text.trim() === '') return { obj: {}, indent: '  ', newline: true };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('settings file is not valid JSON; fix it before taper edits its hooks');
  }
  if (!isObject(obj)) throw new Error('settings file root is not a JSON object');
  if (obj.hooks !== undefined && !isObject(obj.hooks))
    throw new Error('settings "hooks" is not an object; taper will not rewrite it');
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  return { obj, indent, newline: text.endsWith('\n') };
}

const render = (obj: Json, indent: string, newline: boolean): string =>
  `${JSON.stringify(obj, null, indent)}${newline ? '\n' : ''}`;

/** Invariant 3 backstop: a hooks rewrite may not change any permissions value. */
export function assertPermissionsUnchanged(before: unknown, after: unknown): void {
  const p = (o: unknown) => JSON.stringify(isObject(o) ? o.permissions : undefined);
  if (p(before) !== p(after))
    throw new Error('refusing to write: permissions would change (invariant 3)');
}

const commandsOf = (entry: unknown): string[] =>
  isObject(entry) && Array.isArray(entry.hooks)
    ? entry.hooks.flatMap((h) => (isObject(h) && typeof h.command === 'string' ? [h.command] : []))
    : [];

function entryFor(prefix: string, event: HookEvent): Json {
  const handler: Json = { type: 'command', command: hookCommand(prefix, event) };
  if (event !== 'SessionEnd') handler.timeout = TIMEOUT_S;
  return TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
}

export function withHooks(text: string | null, prefix: string): { text: string; changed: boolean } {
  const { obj, indent, newline } = parse(text);
  const before = structuredClone(obj);
  const hooks: Json = isObject(obj.hooks) ? obj.hooks : {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (list.some((e) => commandsOf(e).includes(hookCommand(prefix, event)))) continue;
    hooks[event] = [...list, entryFor(prefix, event)];
    changed = true;
  }
  if (!changed) return { text: text ?? render(obj, indent, newline), changed: false };
  obj.hooks = hooks;
  assertPermissionsUnchanged(before, obj);
  return { text: render(obj, indent, newline), changed: true };
}

export function withoutHooks(
  text: string | null,
  prefixes: readonly string[],
): { text: string | null; changed: boolean; removed: number } {
  if (text === null) return { text: null, changed: false, removed: 0 };
  const { obj, indent, newline } = parse(text);
  if (!isObject(obj.hooks)) return { text, changed: false, removed: 0 };
  const before = structuredClone(obj);
  const ours = new Set(prefixes.flatMap((p) => HOOK_EVENTS.map((e) => hookCommand(p, e))));
  const hooks = obj.hooks;
  let removed = 0;
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept: unknown[] = [];
    for (const entry of list) {
      if (!isObject(entry) || !Array.isArray(entry.hooks)) {
        kept.push(entry);
        continue;
      }
      const handlers = entry.hooks.filter(
        (h) => !(isObject(h) && typeof h.command === 'string' && ours.has(h.command)),
      );
      removed += entry.hooks.length - handlers.length;
      if (handlers.length > 0) kept.push({ ...entry, hooks: handlers });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed === 0) return { text, changed: false, removed: 0 };
  if (Object.keys(hooks).length === 0) delete obj.hooks;
  assertPermissionsUnchanged(before, obj);
  return { text: render(obj, indent, newline), changed: true, removed };
}

/** Returns true when the file changed. */
export function installHooks(path: string, prefix: string): boolean {
  const next = withHooks(readText(path), prefix);
  if (next.changed) writeAtomic(path, next.text);
  return next.changed;
}

/** Returns the number of handlers removed. */
export function removeHooks(path: string, prefixes: readonly string[]): number {
  const next = withoutHooks(readText(path), prefixes);
  if (next.changed && next.text !== null) writeAtomic(path, next.text);
  return next.removed;
}
