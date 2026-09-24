// Hook latency (HANDOFF §5.3: < 50 ms typical). Spawns the built binary the way Claude Code runs a
// command hook and times each call end to end, including Node startup. Temp HOME only.
// Run: `pnpm bench:hook` (builds dist/taper.mjs first). Prints JSON.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Agent } from '../packages/agent/src/agent.ts';

const AGENT = resolve(import.meta.dirname, '..', 'packages', 'agent');
const BUNDLE = join(AGENT, 'dist', 'taper.mjs');
const SOURCE = join(AGENT, 'src', 'bin.ts');
if (!existsSync(BUNDLE)) throw new Error('build first: pnpm --filter taperd build');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'taper-bench-')));
const home = join(root, 'home');
const repo = join(root, 'repo');
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home };
const json = (p: string, v: unknown) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};

try {
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/bench.git'], {
    cwd: repo,
  });
  // A realistic spread of rules: 20 project, 8 local, 10 user.
  const bash = (n: number, p: string) => Array.from({ length: n }, (_, i) => `Bash(${p}${i} *)`);
  json(join(repo, '.claude', 'settings.json'), {
    permissions: {
      allow: [...bash(18, 'npm run task'), 'Edit(src/**)', 'Read(./docs/**)'],
      deny: ['Read(./.env)'],
    },
  });
  json(join(repo, '.claude', 'settings.local.json'), { permissions: { allow: bash(8, './tool') } });
  json(join(home, '.claude', 'settings.json'), {
    permissions: { allow: [...bash(9, 'git sub'), 'WebFetch(domain:docs.example.com)'] },
  });
  json(join(home, '.claude.json'), { projects: { [repo]: { hasTrustDialogAccepted: true } } });
  execFileSync(process.execPath, [BUNDLE, 'init', '--yes'], { cwd: repo, env });

  const payload = (event: string, i: number) =>
    JSON.stringify({
      session_id: 'bench',
      transcript_path: '/dev/null',
      cwd: repo,
      permission_mode: 'default',
      hook_event_name: event,
      ...(event === 'SessionStart'
        ? { source: 'startup' }
        : {
            tool_name: 'Bash',
            tool_input: { command: 'npm run task7 --x' },
            tool_use_id: `t${i}`,
          }),
    });
  const time = (args: string[], input: string): number => {
    const t = performance.now();
    const r = spawnSync(process.execPath, args, { cwd: repo, env, input, encoding: 'utf8' });
    const ms = performance.now() - t;
    if (r.status !== 0 || r.stderr !== '') throw new Error(`hook failed: ${r.stderr}`);
    return ms;
  };
  const clearTicks = () => {
    const a = Agent.open({
      env: { HOME: home },
      cwd: repo,
      now: Date.now,
      randomHex: () => '',
      stdin: () => '',
      out: () => {},
      write: () => {},
      err: () => {},
      isTTY: false,
      confirm: () => false,
      entry: [],
    });
    a.store.db.prepare('DELETE FROM ticks').run();
    a.close();
  };
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) =>
      Math.round((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0) * 10) / 10;
    return { n: s.length, median: q(0.5), p90: q(0.9), max: q(1) };
  };
  const repeat = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

  time([BUNDLE, 'hook', 'SessionStart'], payload('SessionStart', 0));
  const result = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    baseline_node_e_0: stats(repeat(30, () => time(['-e', '0'], ''))),
    bundle_pretooluse: stats(
      repeat(50, (i) => time([BUNDLE, 'hook', 'PreToolUse'], payload('PreToolUse', i))),
    ),
    bundle_pretooluse_with_tick: stats(
      repeat(20, (i) => {
        clearTicks();
        return time([BUNDLE, 'hook', 'PreToolUse'], payload('PreToolUse', i));
      }),
    ),
    bundle_posttooluse: stats(
      repeat(50, (i) => time([BUNDLE, 'hook', 'PostToolUse'], payload('PostToolUse', 1000 + i))),
    ),
    source_pretooluse: stats(
      repeat(20, (i) => time([SOURCE, 'hook', 'PreToolUse'], payload('PreToolUse', i))),
    ),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
