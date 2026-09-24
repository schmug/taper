# ADR-0012: taperd build and packaging

Status: accepted (M3, 2026-09-23). Resolves the ADR-0001 deferral. Code:
`packages/agent/package.json` (`build`), `packages/agent/src/bin.ts`.

## Context

`taperd` is the only published package. Internal packages export TypeScript source (ADR-0001),
and Node refuses to strip types under `node_modules`, so the published CLI cannot run from
source. The hook also has a latency budget (< 50 ms typical, HANDOFF §5.3), and Node's type
stripper alone costs about 30 ms at startup.

Measured on Node 22.22.3, darwin-arm64 (`pnpm bench:hook`, median of 20–50 spawns):

| Entry | PreToolUse |
|---|---|
| `node -e 0` (floor) | 17 ms |
| `node src/bin.ts` (type stripping) | 91.5 ms |
| `node dist/taper.mjs` (bundle) | 43.9 ms |

## Decision

- **One esbuild bundle**, `dist/taper.mjs`: ESM, `--platform=node --target=node22`, with
  `@taper/core`, `@taper/backend-claude-code` and `zod` inlined. `better-sqlite3` stays external
  as the only runtime dependency (native, with N-API prebuilds). `esbuild` 0.28.2 is a pinned dev
  dependency; its install script is not needed and not run.
- `bin: { taper: ./dist/taper.mjs }`, `files: ["dist"]`, `prepack` runs the build. `dist/` is not
  committed. `test/e2e.test.ts` builds the bundle and runs the installed hook command through
  `sh -c`, as Claude Code does.
- In this repo the CLI also runs from source (`node packages/agent/src/bin.ts`). `taper init`
  installs hooks that call whichever entry ran it.

Rejected:
- **tsc emit per package, publish the internals.** Four packages on npm for one CLI, and the
  hook would still load many files.
- **Ship TypeScript.** Impossible under `node_modules` (see above).

## Consequences

- A lever not taken: Node's compile cache (`NODE_COMPILE_CACHE`) saved about 6 ms per start on
  the bundle. Using it from the package needs a two-file launcher. Revisit if the budget tightens.
- `exports` still points at `src/index.ts`, which is fine inside the workspace. `npm publish
  --dry-run` and the published `exports` map are M7.
