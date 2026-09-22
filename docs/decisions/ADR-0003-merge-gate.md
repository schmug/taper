# ADR-0003: Default-branch merge gate

Status: accepted (2026-09-22). The owner approved adding a ruleset and making the repo public.

## Decision

The repository ruleset `main: required CI` targets `~DEFAULT_BRANCH` with enforcement `active` and
**no bypass actors**. It enables these rules:

- `deletion` and `non_fast_forward`
- `pull_request`: 0 required approvals, squash is the only allowed merge method
- `required_status_checks`: context `check` from GitHub Actions (integration 15368), with
  `strict_required_status_checks_policy: true`

Repo settings allow squash merges only. They also enable auto-merge and delete branches on merge.
Private vulnerability reporting, secret scanning with push protection, and Dependabot alerts and
security updates are all on. The default `GITHUB_TOKEN` is read-only. Workflow runs from fork PRs
need approval for every external contributor. Actions are pinned by SHA, and Dependabot bumps them.

The ruleset departs from the owner's `shipofclaudius` ruleset, which has no `pull_request` rule
and `strict: false`. A second opinion (Grok 4.6 xhigh and Astra, both independently) recommended
this shape, for two reasons:

- Without a PR rule, any SHA that passed `check` on some branch can be pushed straight to `main`,
  which skips PR provenance.
- With `strict: false`, a PR tested against an older `main` can land.

## Consequences

- With `strict: true`, a PR must be up to date with `main` before it merges. Auto-merge does not
  update a PR branch by itself, so parallel PRs are rebased in order (`stacked-merge-walk`).
- The CI job must stay named `check` (see the comment in `.github/workflows/ci.yml`). Renaming it
  either blocks every merge or removes the gate.
- **Residual risk, not closed here.** Agents act with the owner's admin credential. They can edit
  or delete this ruleset, or weaken `ci.yml` inside a PR, and GitHub cannot tell the agent from the
  owner. Only policy stands in the way: gate changes need the owner's approval (global CLAUDE.md).
  Closing the gap mechanically requires a separate non-admin identity for agents, which is the
  owner's call.
- `check` runs lint, typecheck, and tests only. It does not prove build or package integrity.
