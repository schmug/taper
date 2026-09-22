# ADR-0001: Toolchain and workspace shape

Status: accepted (M0, 2026-09-22)

## Decision

- **Node ≥ 22.18, no build step for scripts.** Node 22.18+ strips TypeScript types natively, so
  `scripts/*.ts` run as `node scripts/x.ts`. Consequence: all TS must be erasable
  (`erasableSyntaxOnly`: no enums, namespaces, parameter properties) and relative imports carry
  `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, for the
  eventual `taperd` build).
- **Internal packages export source.** `@taper/core`, `@taper/shared`, `@taper/backend-claude-code`
  have `exports: ./src/index.ts`; vitest, tsc, and wrangler's bundler consume TS directly. Only
  `taperd` (published to npm at M7) gets a build; that choice is deferred to M3.
- **Per-package test and typecheck scripts; root fans out with `pnpm -r`.** Each package owns its
  vitest config so `apps/control-plane` can use `@cloudflare/vitest-pool-workers` at M4 without a
  shared config. `core` and `shared` compile with `types: []`, so a Node global in either fails
  typecheck (backs invariant 1). Import-boundary lint for `core` is added at M1.
- **Biome** (one dependency) for lint + format instead of ESLint + Prettier. Recommended preset.
  `fixtures/` and Markdown are excluded.
- **TypeScript 7.0.2, vitest 5.0.1, Biome 2.5.14** pinned exactly; `@types/node` tracks Node 22.
- **Apps are not scaffolded at M0.** `apps/control-plane` and `apps/dashboard` are created at M4/M5
  with their real dependencies. Empty placeholders would exist only to look complete.
- **`.env.example` is not committed.** The owner's global Claude Code settings deny
  `Read(.env.example)` and block writing it. Environment variables are documented in
  `docs/SETUP.md` instead; the owner can create the file by hand if wanted.

## Consequences

- If `@cloudflare/vitest-pool-workers` lags vitest 5 at M4, `apps/control-plane` pins its own
  vitest; per-package configs make that a local change.
- Anything relying on Node type stripping cannot use TS features that emit code.
