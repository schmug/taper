// Source-level purity check for packages/core/src (CLAUDE.md invariant 1). Text-based on purpose:
// core is small and written to be checkable by regex. Comments are stripped first.

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['new Date()', /\bnew\s+Date\s*\(\s*\)/],
  ['Date()', /(?<!new\s+)\bDate\s*\(/],
  ['crypto', /\bcrypto\b/],
  ['performance', /\bperformance\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['fetch', /\bfetch\s*\(/],
  ['process', /\bprocess\b/],
  ['globalThis', /\bglobalThis\b/],
  ['require', /\brequire\s*\(/],
  ['Intl', /\bIntl\b/],
  ['toLocale', /\btoLocale\w*\s*\(/],
  ['localeCompare', /\blocaleCompare\b/],
];

const IMPORTS: readonly RegExp[] = [
  /^\s*(?:import|export)\b[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Resolves `spec` against the importing file; true when the target stays under `src/`. */
function staysInSrc(file: string, spec: string): boolean {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return false;
  const parts = file.split('/').slice(0, -1);
  for (const segment of spec.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts[0] === 'src' && parts.length > 1;
}

/** `file` is the path relative to the package root, e.g. `src/evaluate.ts`. */
export function purityViolations(source: string, file: string): string[] {
  const code = stripComments(source);
  const violations: string[] = [];
  for (const pattern of IMPORTS) {
    for (const match of code.matchAll(pattern)) {
      const spec = match[1] ?? '';
      if (!staysInSrc(file, spec)) violations.push(`import:${spec}`);
    }
  }
  for (const [name, pattern] of FORBIDDEN) {
    if (pattern.test(code)) violations.push(name);
  }
  return violations;
}
