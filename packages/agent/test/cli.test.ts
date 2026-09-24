// The solo CLI commands (HANDOFF §6): init, status, explain, regrant, protect/unprotect, mode,
// recommend, simulate, snapshot, uninstall. All against a temp $HOME and repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MemberState, memberIdFor } from '@taper/core';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.ts';
import { run } from '../src/cli.ts';
import { readConfig } from '../src/config.ts';
import type { Deps } from '../src/deps.ts';
import { DAY, type Sandbox, sandbox, T0, type TestDeps, writeJson } from './helpers.ts';

const PROJECT = 'project:github.com%2Fexample%2Fdemo:allow';
const DEVICE = '00000000000000000000000000000001';
const LOCAL = `local:${DEVICE}:github.com%2Fexample%2Fdemo:allow`;

function setup(): Sandbox {
  const s = sandbox();
  writeJson(join(s.repo, '.claude', 'settings.json'), {
    permissions: {
      allow: ['Bash(npm run lint)', 'Bash(git push *)', 'Read(./docs/**)'],
      deny: ['Read(./.env)'],
    },
  });
  writeJson(join(s.repo, '.claude', 'settings.local.json'), {
    permissions: { allow: ['Bash(./probe.sh c *)'] },
  });
  writeJson(join(s.home, '.claude', 'settings.json'), {
    permissions: { allow: ['WebFetch(domain:docs.example.com)'] },
    model: 'opus',
  });
  return s;
}

const cli = (s: Sandbox, argv: string[], over: Partial<Deps> = {}): TestDeps & { code: number } => {
  const d = s.deps(over);
  const code = run(argv, d);
  return Object.assign(d, { code });
};
const text = (d: TestDeps) => d.output.join('\n');

function setState(s: Sandbox, knob: string, rule: string, state: MemberState, unusedDays = 70) {
  const a = Agent.open(s.deps());
  const m = a.store.members({ ids: [memberIdFor(knob, rule)] })[0];
  if (m === undefined) throw new Error(`no member ${rule}`);
  a.store.saveMembers([
    {
      ...m,
      state,
      stateSince: T0 - DAY,
      declaredAt: T0 - 90 * DAY,
      lastSeenAt: T0 - unusedDays * DAY,
    },
  ]);
  a.close();
}

describe('taper init', () => {
  it('detects settings, creates the ledger, prints the plan and installs hooks with --yes', () => {
    const s = setup();
    const d = cli(s, ['init', '--yes']);
    expect(d.code).toBe(0);
    const out = text(d);
    expect(out).toContain('Project: github.com/example/demo');
    expect(out).toMatch(/project +.*settings\.json {2}allow 3, ask 0, deny 1/);
    expect(out).toContain('becomes stale_candidate on 2026-10-23');
    expect(out).toContain('pending_removal on 2026-11-07 and removed on 2026-11-22');
    expect(out).toContain('Installed hooks in');
    const user = JSON.parse(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8'));
    expect(user.permissions).toEqual({ allow: ['WebFetch(domain:docs.example.com)'] });
    expect(user.model).toBe('opus');
    expect(Object.keys(user.hooks)).toContain('PreToolUse');
    expect(readConfig(join(s.home, '.taper', 'config.json'))?.hooks?.files).toEqual([
      join(s.home, '.claude', 'settings.json'),
    ]);
  });

  it('is idempotent and keeps the device id', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    const again = cli(s, ['init', '--yes']);
    expect(text(again)).toContain(`Reusing`);
    expect(text(again)).toContain(`device ${DEVICE}`);
    expect(text(again)).toContain('Hooks already installed');
  });

  it('replaces hooks installed from an older binary path instead of adding a second set', () => {
    const s = setup();
    cli(s, ['init', '--yes'], { entry: ['/old/node', '/old/taper.mjs'] });
    cli(s, ['init', '--yes'], { entry: ['/new/node', '/new/taper.mjs'] });
    const user = JSON.parse(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8'));
    const commands = (user.hooks.PreToolUse as { hooks: { command: string }[] }[]).flatMap((e) =>
      e.hooks.map((h) => h.command),
    );
    expect(commands).toEqual([`'/new/node' '/new/taper.mjs' hook PreToolUse`]);
    expect(cli(s, ['uninstall'], { entry: ['/other/node', '/other/taper.mjs'] }).code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8')).hooks).toBe(
      undefined,
    );
  });

  it('asks before installing hooks, and never installs without a yes', () => {
    const s = setup();
    const user = join(s.home, '.claude', 'settings.json');
    const before = readFileSync(user, 'utf8');
    expect(text(cli(s, ['init']))).toContain('Hooks not installed');
    expect(readFileSync(user, 'utf8')).toBe(before);
    let asked = '';
    const d = cli(s, ['init'], {
      isTTY: true,
      confirm: (q) => {
        asked = q;
        return true;
      },
    });
    expect(asked).toContain('Install hooks?');
    expect(text(d)).toContain('Installed hooks');
  });

  it('TAPER_DOGFOOD=1 installs into the project settings only, and uninstall restores it', () => {
    const s = setup();
    const project = join(s.repo, '.claude', 'settings.json');
    const user = join(s.home, '.claude', 'settings.json');
    const before = { project: readFileSync(project, 'utf8'), user: readFileSync(user, 'utf8') };
    const env = { HOME: s.home, TAPER_DOGFOOD: '1' };
    expect(cli(s, ['init', '--yes'], { env }).code).toBe(0);
    const installed = JSON.parse(readFileSync(project, 'utf8'));
    expect(Object.keys(installed.hooks)).toContain('SessionStart');
    expect(installed.permissions).toEqual(JSON.parse(before.project).permissions);
    expect(readFileSync(user, 'utf8')).toBe(before.user);
    const un = cli(s, ['uninstall'], { env });
    expect(un.code).toBe(0);
    expect(readFileSync(project, 'utf8')).toBe(before.project);
  });
});

describe('taper uninstall', () => {
  it('removes the hooks it installed and, with --purge, the local state', () => {
    const s = setup();
    const user = join(s.home, '.claude', 'settings.json');
    const before = readFileSync(user, 'utf8');
    cli(s, ['init', '--yes']);
    const un = cli(s, ['uninstall']);
    expect(text(un)).toContain('Removed 7 taper hook handler(s)');
    expect(readFileSync(user, 'utf8')).toBe(before);
    expect(existsSync(join(s.home, '.taper', 'state.db'))).toBe(true);
    expect(cli(s, ['uninstall', '--purge']).code).toBe(0);
    expect(existsSync(join(s.home, '.taper'))).toBe(false);
  });
});

describe('taper status', () => {
  it('lists knobs and members as JSON, all shadow at first', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    const d = cli(s, ['status', '--json']);
    const report = JSON.parse(text(d)) as {
      knobs: { id: string; mode: string; protected: boolean; members: { rule: string }[] }[];
    };
    const byId = new Map(report.knobs.map((k) => [k.id, k]));
    expect(byId.get(PROJECT)?.members.map((m) => m.rule)).toEqual([
      'Bash(git push *)',
      'Bash(npm run lint)',
      'Read(./docs/**)',
    ]);
    expect(report.knobs.every((k) => k.mode === 'shadow')).toBe(true);
    expect(byId.get('project:github.com%2Fexample%2Fdemo:deny')?.protected).toBe(true);
    expect(byId.get(LOCAL)?.members.map((m) => m.rule)).toEqual(['Bash(./probe.sh c *)']);
  });

  it('prints a readable table', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    const out = text(cli(s, ['status']));
    expect(out).toContain('project allow github.com/example/demo  [shadow');
    expect(out).toMatch(/active +Bash\(npm run lint\) {2}never used/);
  });
});

describe('taper explain / regrant', () => {
  it('explains a rule from its ledger and guards', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    const out = text(cli(s, ['explain', 'Bash(npm run lint)']));
    expect(out).toContain('"Bash(npm run lint)" in project allow github.com/example/demo');
    expect(out).toContain('state: active');
    expect(out).toContain('(new) → active  declared by system shadow');
    expect(out).toContain('next: stale_candidate at 30 days unused');
    expect(cli(s, ['explain', 'Bash(nope)']).code).toBe(1);
  });

  it('re-grants a removed rule now, with a cooldown, through restored', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    setState(s, PROJECT, 'Bash(git push *)', 'removed');
    const d = cli(s, ['regrant', 'Bash(git push *)'], { now: () => T0 + 1000 });
    expect(d.code).toBe(0);
    expect(text(d)).toContain('Re-granted "Bash(git push *)"');
    expect(text(d)).toContain('cooldown 14d until 2026-10-07');
    const a = Agent.open(s.deps());
    const id = memberIdFor(PROJECT, 'Bash(git push *)');
    expect(a.store.members({ ids: [id] })[0]).toMatchObject({
      state: 'active',
      cooldownUntil: T0 + 1000 + 14 * DAY,
    });
    expect(
      a.store
        .ledger([id])
        .slice(-2)
        .map((t) => `${t.from}>${t.to}:${t.reason}:${t.actor}`),
    ).toEqual(['removed>restored:regrant:user', 'restored>active:restored:user']);
    a.close();
    expect(text(cli(s, ['regrant', 'Bash(git push *)']))).toContain('Nothing to re-grant');
  });
});

describe('taper protect / unprotect', () => {
  it('protecting a decayed rule re-grants it first (ADR-0013)', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    setState(s, PROJECT, 'Bash(npm run lint)', 'pending_removal', 50);
    const d = cli(s, ['protect', 'Bash(npm run lint)']);
    expect(text(d)).toContain('Re-granted "Bash(npm run lint)"');
    expect(text(d)).toContain('Protected 1 member(s)');
    const a = Agent.open(s.deps());
    expect(a.store.members({ ids: [memberIdFor(PROJECT, 'Bash(npm run lint)')] })[0]).toMatchObject(
      { state: 'active', protected: true },
    );
    a.close();
  });

  it('refuses to unprotect deny/ask knobs, managed knobs and inert rules (C1)', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    expect(cli(s, ['unprotect', 'project:github.com%2Fexample%2Fdemo:deny']).code).toBe(1);
    expect(cli(s, ['unprotect', 'Read(./.env)']).code).toBe(1);
    const ok = cli(s, ['unprotect', 'Read(./docs/**)']);
    expect(ok.code).toBe(0);
    expect(text(ok)).toContain('Read rule, low-confidence evidence (C2)');
  });

  it('protects a whole knob by alias', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    expect(text(cli(s, ['protect', 'local']))).toContain(`Protected knob ${LOCAL}`);
  });
});

describe('taper mode', () => {
  it('previews what switching would enforce and requires --yes', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    setState(s, PROJECT, 'Bash(git push *)', 'removed');
    const refused = cli(s, ['mode', 'project', 'automatic']);
    expect(refused.code).toBe(1);
    expect(text(refused)).toContain('deny: "Bash(git push *)"');
    expect(cli(s, ['mode', 'project', 'automatic', '--yes']).code).toBe(0);
    expect(text(cli(s, ['mode', PROJECT, 'shadow']))).toContain('is now shadow');
  });

  it('requires the C3 opt-in for cli knobs', () => {
    const s = setup();
    writeJson(join(s.repo, 'ci', 'claude.json'), { permissions: { allow: ['Bash(make test)'] } });
    mkdirSync(join(s.repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(s.repo, '.github', 'workflows', 'claude.yml'),
      'jobs:\n  a:\n    steps:\n      - run: claude -p "x" --settings ci/claude.json\n',
    );
    cli(s, ['init', '--yes']);
    const knob = 'cli:github.com%2Fexample%2Fdemo:.github%2Fworkflows%2Fclaude.yml:allow';
    const refused = cli(s, ['mode', knob, 'automatic']);
    expect(refused.code).toBe(1);
    expect(refused.errors.join('\n')).toContain('C3:');
    expect(cli(s, ['mode', knob, 'automatic', '--ci-opt-in']).code).toBe(0);
  });
});

describe('taper recommend', () => {
  it('lists decayed rules as advice and never edits a file', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    setState(s, PROJECT, 'Bash(git push *)', 'removed');
    setState(s, PROJECT, 'Bash(npm run lint)', 'stale_candidate', 35);
    const out = text(cli(s, ['recommend']));
    expect(out).toContain('Advisory only');
    expect(out).toMatch(/Removed.*\n {2}- "Bash\(git push \*\)"/);
    expect(out).toContain(`in ${join(s.repo, '.claude', 'settings.json')}`);
    expect(out).toMatch(/Stale candidates:\n {2}- "Bash\(npm run lint\)"/);
  });

  it('emits a unified diff that deletes removed rules and still parses', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    const file = join(s.repo, '.claude', 'settings.json');
    const before = readFileSync(file, 'utf8');
    setState(s, PROJECT, 'Bash(git push *)', 'removed');
    const out = text(cli(s, ['recommend', '--format', 'diff']));
    expect(out).toContain(`--- a/${file}`);
    expect(out).toContain('-      "Bash(git push *)",');
    expect(out).not.toMatch(/^\+.*git push/m);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(cli(s, ['recommend', '--format', 'pr']).code).toBe(2);
  });
});

describe('taper simulate / snapshot', () => {
  it('dry-runs the clock forward without saving anything', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    const out = text(cli(s, ['simulate', '--days', '61']));
    expect(out).toContain('Nothing is saved');
    expect(out).toMatch(/day 30 \(2026-10-23\): "Bash\(npm run lint\)" active → stale_candidate/);
    expect(out).toMatch(/day 45 .*"Bash\(npm run lint\)" stale_candidate → pending_removal/);
    expect(out).toMatch(/day 60 .*"Bash\(npm run lint\)" pending_removal → removed .*\[shadow\]/);
    expect(out).not.toContain('Read(./docs/**)" active');
    const a = Agent.open(s.deps());
    expect(a.store.members().every((m) => m.state === 'active')).toBe(true);
    a.close();
  });

  it('declares a rule added since the last snapshot', () => {
    const s = setup();
    cli(s, ['init', '--yes']);
    writeJson(join(s.repo, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(./probe.sh c *)', 'Bash(make *)'] },
    });
    const out = text(cli(s, ['snapshot'], { now: () => T0 + DAY }));
    expect(out).toContain('1 rule(s) declared, 0 retired.');
  });
});

describe('cli knobs (ADR-0007 deferral)', () => {
  const workflow = (s: Sandbox, settingsArg: string) => {
    mkdirSync(join(s.repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(s.repo, '.github', 'workflows', 'claude.yml'),
      `jobs:\n  a:\n    steps:\n      - run: claude -p "x" ${settingsArg}\n`,
    );
  };
  const cliKnob = 'cli:github.com%2Fexample%2Fdemo:.github%2Fworkflows%2Fclaude.yml:allow';
  const state = (s: Sandbox) => {
    const a = Agent.open(s.deps());
    const m = a.store.members({ ids: [memberIdFor(cliKnob, 'Bash(make test)')] })[0];
    a.close();
    return m?.state;
  };

  it('retires the members of a workflow that no longer passes --settings', () => {
    const s = setup();
    writeJson(join(s.repo, 'ci', 'claude.json'), { permissions: { allow: ['Bash(make test)'] } });
    workflow(s, '--settings ci/claude.json');
    cli(s, ['init', '--yes']);
    expect(state(s)).toBe('active');
    workflow(s, '');
    cli(s, ['snapshot'], { now: () => T0 + DAY });
    expect(state(s)).toBe('retired');
  });

  it('keeps them while any cli source fails to load (a half-read CI config retires nothing)', () => {
    const s = setup();
    writeJson(join(s.repo, 'ci', 'claude.json'), { permissions: { allow: ['Bash(make test)'] } });
    workflow(s, '--settings ci/claude.json');
    cli(s, ['init', '--yes']);
    // A GitHub expression taper cannot resolve (literal `$` + `{{`, not a JS template).
    workflow(s, `--settings $${'{{'} inputs.settings }}`);
    cli(s, ['snapshot'], { now: () => T0 + DAY });
    expect(state(s)).toBe('active');
  });
});

describe('errors', () => {
  it('needs init first, and rejects unknown commands and flags', () => {
    const s = setup();
    const d = cli(s, ['status']);
    expect(d.code).toBe(1);
    expect(d.errors.join('')).toContain('taper init');
    expect(cli(s, ['frobnicate']).code).toBe(2);
    cli(s, ['init', '--yes']);
    expect(cli(s, ['status', '--bogus']).code).toBe(2);
    expect(cli(s, ['simulate', '--days', 'x']).code).toBe(2);
  });
});
