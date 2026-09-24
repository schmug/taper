// Workspace trust (ADR-0002 row 1): `projects[<path>].hasTrustDialogAccepted` in ~/.claude.json.
// That boolean is the only value taken from the file; the parsed object is dropped at once and
// nothing else from it is stored or logged. `false` drops project allow rules from matching, which
// under-refreshes them if wrong, so the result is false only when every candidate path says an
// explicit false. Anything unclear is 'unknown', which keeps them (over-refresh is safe, C5).

import type { Trust } from '@taper/backend-claude-code';
import { readText } from './fsutil.ts';

function flag(projects: object, dir: string): boolean | undefined {
  if (!Object.hasOwn(projects, dir)) return undefined;
  const entry: unknown = (projects as Record<string, unknown>)[dir];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const v: unknown = (entry as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted;
  return typeof v === 'boolean' ? v : undefined;
}

/** `dirs`: candidate project paths (session start directory, repo root). Any `true` wins. */
export function readTrust(claudeJson: string, dirs: readonly string[]): Trust {
  let flags: (boolean | undefined)[];
  try {
    const text = readText(claudeJson);
    if (text === null) return 'unknown';
    const projects: unknown = (JSON.parse(text) as { projects?: unknown }).projects;
    if (typeof projects !== 'object' || projects === null) return 'unknown';
    flags = dirs.map((d) => flag(projects, d));
  } catch {
    return 'unknown';
  }
  if (flags.includes(true)) return true;
  return flags.length > 0 && flags.every((f) => f === false) ? false : 'unknown';
}
