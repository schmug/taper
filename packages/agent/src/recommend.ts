// Advisory human-file cleanup (HANDOFF §5.4 'Advisory cleanup'). Output only: nothing here writes
// a file (invariant 3). The diff deletes `removed` members from the allow array of the file that
// declares them. It removes whole lines when each rule sits on its own line, and checks that the
// result parses to exactly the expected settings. Otherwise it shows the file re-serialized.

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The settings text with `rules` removed from `permissions.allow`, or null if none are there. */
export function withoutAllowRules(text: string, rules: readonly string[]): string | null {
  const obj: unknown = JSON.parse(text);
  if (!isObject(obj) || !isObject(obj.permissions) || !Array.isArray(obj.permissions.allow))
    return null;
  const drop = new Set(rules);
  const allow = obj.permissions.allow as unknown[];
  if (!allow.some((r) => typeof r === 'string' && drop.has(r.trim()))) return null;
  const expected = {
    ...obj,
    permissions: {
      ...obj.permissions,
      allow: allow.filter((r) => !(typeof r === 'string' && drop.has(r.trim()))),
    },
  };

  const lines = text.split('\n');
  const removedAt: number[] = [];
  for (const rule of drop) {
    const literal = JSON.stringify(rule);
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t === literal || t === `${literal},`) removedAt.push(i);
    });
  }
  const keep = lines.map(() => true);
  for (const i of removedAt) keep[i] = false;
  // A removed last element leaves a dangling comma on the element before it.
  for (const i of removedAt) {
    if ((lines[i] as string).trim().endsWith(',')) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (!keep[j]) continue;
      const l = lines[j] as string;
      if (l.trim() === '') continue;
      if (l.trimEnd().endsWith(',')) lines[j] = l.replace(/,(\s*)$/, '$1');
      break;
    }
  }
  const surgical = lines.filter((_, i) => keep[i]).join('\n');
  try {
    if (JSON.stringify(JSON.parse(surgical)) === JSON.stringify(expected)) return surgical;
  } catch {
    // fall through to re-serialization
  }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  return `${JSON.stringify(expected, null, indent)}${text.endsWith('\n') ? '\n' : ''}`;
}

/** Minimal unified diff (LCS over lines, 3 lines of context). Deterministic. */
export function unifiedDiff(path: string, a: string, b: string): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ t: ' ', s: x[i] as string, ai: i++, bi: j++ });
    } else if (
      j < m &&
      (i >= n || ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))
    ) {
      ops.push({ t: '+', s: y[j] as string, ai: i, bi: j++ });
    } else {
      ops.push({ t: '-', s: x[i] as string, ai: i++, bi: j });
    }
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  const CONTEXT = 3;
  let k = 0;
  while (k < ops.length) {
    if ((ops[k] as Op).t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    // Extend the hunk while changes are within 2*CONTEXT of each other.
    for (let e = k; e < ops.length; e++) {
      if ((ops[e] as Op).t !== ' ') end = e;
      else if (e - end > 2 * CONTEXT) break;
    }
    end = Math.min(ops.length - 1, end + CONTEXT);
    const hunk = ops.slice(start, end + 1);
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    const first = hunk[0] as Op;
    out.push(`@@ -${first.ai + 1},${aLen} +${first.bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k = end + 1;
  }
  return `${out.join('\n')}\n`;
}
