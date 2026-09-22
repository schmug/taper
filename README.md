# taper

Least-privilege decay for Claude Code permission rules.

Allow-lists only grow. Every "Yes, and don't ask again" adds a rule to `settings.json`, and nothing
ever takes one away. taper watches which `permissions.allow` rules actually get used and walks the
unused ones through a guarded state machine:

```
active → stale_candidate → pending_removal → removed
```

- **Nothing is deleted from your files.** A rule is tightened by adding a machine-owned `ask` or
  `deny` that overrides it, and loosened again by removing that entry.
- **Any use restores a rule instantly**, followed by a cooldown.
- **A wrong removal costs a permission prompt, not a lockout.** A `pending_removal` rule asks
  before it runs, and approving it restores the rule.
- **Decisions are deterministic.** They come from timestamps and set math, and every state can be
  explained from an append-only ledger. No LLM is involved.
- **Shadow mode is the default.** taper recommends and changes nothing until you switch a knob to
  `automatic`.

## Status

Pre-alpha. The design is in [HANDOFF.md](HANDOFF.md), and progress is tracked in
[docs/STATUS.md](docs/STATUS.md). There is nothing to install yet.

Planned pieces:

- the `taper` CLI, which works offline for one machine using Claude Code hooks
- a Cloudflare Workers control plane for teams, fed by Claude Code OpenTelemetry
- a dashboard behind Cloudflare Access

Verified Claude Code behavior that taper depends on is recorded in
[docs/claude-code-facts.md](docs/claude-code-facts.md).

## Development

Requires Node ≥ 22.18 and pnpm 10.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm probe   # re-runs the live Claude Code probes; needs a `claude` binary and spends model tokens
```

## License

[MIT](LICENSE)
