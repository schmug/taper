// M0 live probes against a real `claude` binary (HANDOFF.md §9 M0 probes a–e).
//
// Spends model tokens: 12 headless + 1 interactive session on TAPER_PROBE_MODEL (default haiku),
// each capped at --max-turns 3 and PROBE_TIMEOUT_MS. Run: `pnpm probe [scenario ...]`.
//
// Workspace trust: headless runs ignore permissions.allow in an untrusted workspace's
// .claude/settings.json, so scenarios marked trusted get the trust dialog accepted once, in a
// promptless interactive session driven through tmux. That writes
// projects[<repo>].hasTrustDialogAccepted to ~/.claude.json via Claude Code itself. Scenario repos
// live at stable paths under TAPER_PROBE_WORKDIR (default ~/.cache/taper-probe) so trust persists
// across runs instead of accumulating entries.
//
// Isolation: each scenario runs in a freshly re-created git repo with
// --setting-sources project,local (user settings excluded), --strict-mcp-config,
// --disable-slash-commands, --tools Bash, --permission-mode manual. The probed command is a
// repo-local script (./probe.sh) so no built-in read-only auto-approval can mask a rule.
// Telemetry goes to an in-process OTLP/HTTP JSON receiver. OTEL_LOG_USER_PROMPTS is never set.
//
// Outputs (sanitized: home dir, temp dir, email, account/org ids, host name):
//   fixtures/headless/<scenario>.stream.jsonl   --output-format stream-json transcript
//   fixtures/hooks/<scenario>/<n>-<Event>.json   hook stdin; *.out.json = what the hook printed
//   fixtures/otel/<scenario>.jsonl               one OTLP request body per line
//   fixtures/probe-results.json                  per-scenario observations
// Interpretation lives in docs/claude-code-facts.md, written by hand from these files.

import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const FIX = join(REPO, 'fixtures');
const MODEL = process.env.TAPER_PROBE_MODEL ?? 'haiku';
const PROBE_TIMEOUT_MS = 120_000;
const HOME = homedir();
const ROOT = process.env.TAPER_PROBE_WORKDIR ?? join(HOME, '.cache', 'taper-probe');

// Hook events whose stdin we record. Only events the docs list for this version: an unknown key
// could invalidate the settings file and silently drop its permission rules.
const HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
  'ConfigChange',
] as const;
const TOOL_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
]);

type Rules = { allow?: string[]; ask?: string[]; deny?: string[] };
type Scenario = {
  name: string;
  purpose: string;
  command: string; // exact Bash command, or for tool 'Read' the file path, the model is told to use
  tool?: 'Bash' | 'Read'; // default Bash
  project?: Rules;
  local?: Rules;
  cli?: Rules; // written to a file outside the repo, passed via --settings
  hooks?: boolean;
  trusted?: boolean; // default true
  extraArgs?: string[];
  interactive?: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'a0-allow-control',
    purpose: '(a) control: project allow alone lets the command run with source=config',
    command: './probe.sh a',
    project: { allow: ['Bash(./probe.sh a)'] },
  },
  {
    name: 'a1-local-ask-over-project-allow',
    purpose: '(a) identical-specifier ask in settings.local.json overrides allow in settings.json',
    command: './probe.sh a',
    project: { allow: ['Bash(./probe.sh a)'] },
    local: { ask: ['Bash(./probe.sh a)'] },
  },
  {
    name: 'a2-cli-ask-over-project-allow',
    purpose: '(a) identical-specifier ask in a --settings file overrides allow in settings.json',
    command: './probe.sh a',
    project: { allow: ['Bash(./probe.sh a)'] },
    cli: { ask: ['Bash(./probe.sh a)'] },
  },
  {
    name: 'a3-cli-deny-over-project-allow',
    purpose: '(a) identical-specifier deny in a --settings file overrides allow in settings.json',
    command: './probe.sh a',
    project: { allow: ['Bash(./probe.sh a)'] },
    cli: { deny: ['Bash(./probe.sh a)'] },
  },
  {
    name: 'u0-untrusted-project-allow',
    purpose: 'trust: project allow alone in a workspace whose trust dialog was never accepted',
    command: './probe.sh u',
    project: { allow: ['Bash(./probe.sh u)'] },
    trusted: false,
  },
  {
    name: 'u1-untrusted-local-allow',
    purpose: 'trust: settings.local.json allow alone in an untrusted workspace',
    command: './probe.sh u',
    local: { allow: ['Bash(./probe.sh u)'] },
    trusted: false,
  },
  {
    name: 'u2-untrusted-cli-allow',
    purpose: 'trust: --settings file allow alone in an untrusted workspace',
    command: './probe.sh u',
    cli: { allow: ['Bash(./probe.sh u)'] },
    trusted: false,
  },
  {
    name: 'r0-read-in-workdir',
    purpose: 'C2: does an in-workdir Read with no rule emit tool_decision, and with which source',
    command: './probe.sh',
    tool: 'Read',
  },
  {
    name: 'e0-headless-unmatched',
    purpose: '(e) headless -p, no rule matches, manual mode: prompt with no permission host',
    command: './probe.sh e',
  },
  {
    name: 'b0-hook-passthrough',
    purpose: '(b) hook prints nothing; allow rule applies; records every hook stdin shape',
    command: './probe.sh b-pass',
    project: { allow: ['Bash(./probe.sh:*)'] },
    hooks: true,
  },
  {
    name: 'b1-hook-deny',
    purpose: '(b) PreToolUse permissionDecision=deny against a matching allow rule',
    command: './probe.sh hook-deny',
    project: { allow: ['Bash(./probe.sh:*)'] },
    hooks: true,
  },
  {
    name: 'b2-hook-ask',
    purpose: '(b)+(e) PreToolUse permissionDecision=ask against a matching allow rule, headless',
    command: './probe.sh hook-ask',
    project: { allow: ['Bash(./probe.sh:*)'] },
    hooks: true,
  },
  {
    name: 'c0-dont-ask-again',
    purpose: '(c) interactive "Yes, and don\'t ask again": which file gets the new allow rule',
    command: './probe.sh c',
    hooks: true,
    interactive: true,
  },
];

// ---------- OTLP/HTTP JSON receiver ----------

const otlp: { scenario: string; path: string; contentType: string; body: unknown }[] = [];
let currentScenario = '';

function startReceiver(): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = { nonJson: true, bytes: raw.length };
      }
      otlp.push({ scenario: currentScenario, path: req.url ?? '', contentType, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.unref();
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)),
  );
}

// ---------- environment ----------

function childEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Drop the parent session's Claude Code/desktop wiring and any pre-set telemetry config.
    if (/^(CLAUDE|OTEL_)/.test(k) || k === 'ANTHROPIC_BASE_URL') continue;
    env[k] = v;
  }
  Object.assign(env, {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOGS_EXPORT_INTERVAL: '500',
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
  });
  return env;
}

// ---------- scenario setup ----------

const HOOK_SCRIPT = `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [, , event, outDir] = process.argv;
const input = readFileSync(0, 'utf8');
mkdirSync(outDir, { recursive: true });
const stem = \`\${outDir}/\${process.hrtime.bigint()}-\${event}\`;
writeFileSync(\`\${stem}.json\`, input);
let out = null;
if (event === 'PreToolUse') {
  const cmd = JSON.parse(input).tool_input?.command ?? '';
  for (const d of ['deny', 'ask', 'allow']) {
    if (cmd.includes(\`hook-\${d}\`)) {
      out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d,
        permissionDecisionReason: \`taper-probe: hook \${d}\` } };
    }
  }
}
if (out) {
  writeFileSync(\`\${stem}.out.json\`, JSON.stringify(out));
  process.stdout.write(JSON.stringify(out));
}
`;

function hooksConfig(hookPath: string, outDir: string) {
  const cfg: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) {
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command: `node '${hookPath}' ${ev} '${outDir}'`, timeout: 10 }],
    };
    if (TOOL_EVENTS.has(ev)) entry.matcher = '*';
    cfg[ev] = [entry];
  }
  return cfg;
}

function setup(s: Scenario) {
  const dir = join(ROOT, s.name);
  const repo = join(dir, 'repo');
  const hookOut = join(dir, 'hooks');
  rmSync(dir, { recursive: true, force: true }); // same path every run: trust is keyed by path
  mkdirSync(join(repo, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'probe.sh'), '#!/bin/sh\necho "taper-probe ran: $*"\n');
  chmodSync(join(repo, 'probe.sh'), 0o755);
  const hookPath = join(dir, 'hook.mjs');
  writeFileSync(hookPath, HOOK_SCRIPT);
  const project: Record<string, unknown> = {};
  if (s.project) project.permissions = s.project;
  if (s.hooks) project.hooks = hooksConfig(hookPath, hookOut);
  writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify(project, null, 2));
  if (s.local)
    writeFileSync(
      join(repo, '.claude/settings.local.json'),
      JSON.stringify({ permissions: s.local }, null, 2),
    );
  let cliPath: string | undefined;
  if (s.cli) {
    cliPath = join(dir, 'cli-settings.json');
    writeFileSync(cliPath, JSON.stringify({ permissions: s.cli }, null, 2));
  }
  return { dir, repo, hookOut, cliPath };
}

function prompt(s: Scenario) {
  if (s.tool === 'Read')
    return `Use the Read tool once to read the file ${s.command}, then reply with its first line.`;
  return (
    `Use the Bash tool to run exactly this command, verbatim, once: ${s.command}\n` +
    'Do not run any other command. If the command is denied or blocked, do not retry; ' +
    'reply with the single word DENIED. Otherwise reply with the command output.'
  );
}

function baseArgs(s: Scenario, cliPath: string | undefined) {
  const args = [
    '--model',
    MODEL,
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools',
    s.tool ?? 'Bash',
    '--permission-mode',
    'manual',
    ...(s.extraArgs ?? []),
  ];
  if (cliPath) args.push('--settings', cliPath);
  return args;
}

// ---------- runners ----------

function runHeadless(s: Scenario, env: NodeJS.ProcessEnv, repo: string, cliPath?: string) {
  const args = [
    '-p',
    prompt(s),
    '--max-turns',
    '3',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    ...baseArgs(s, cliPath),
  ];
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (ok) => {
      const child = spawn('claude', args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      const t = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, PROBE_TIMEOUT_MS);
      child.on('close', (code) => {
        clearTimeout(t);
        ok({ code, stdout, stderr, timedOut });
      });
    },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmux(...args: string[]) {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

type Send = (...keys: string[]) => void;
// Returns 'done' to stop driving. Called with the visible pane text every 1.5 s.
type Step = (screen: string, send: Send) => 'done' | undefined;

async function driveTmux(repo: string, env: NodeJS.ProcessEnv, argv: string[], step: Step) {
  const session = `taper-probe-${process.pid}`;
  const q = (x: string) => `'${x.replaceAll("'", `'\\''`)}'`;
  // env -i so the tmux server's inherited environment (the parent session's) does not leak in.
  // The trailing sleep keeps the pane readable after claude exits.
  const launcher = join(repo, '..', 'run-interactive.sh');
  writeFileSync(
    launcher,
    `#!/bin/sh\nenv -i ${Object.entries(env)
      .map(([k, v]) => q(`${k}=${v ?? ''}`))
      .join(' ')} ${argv.map(q).join(' ')}\nsleep 30\n`,
  );
  tmux(
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '220',
    '-y',
    '60',
    '-c',
    repo,
    `sh ${q(launcher)}`,
  );
  const send: Send = (...keys) => tmux('send-keys', '-t', session, ...keys);
  let screen = '';
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(1500);
      screen = tmux('capture-pane', '-p', '-t', session);
      if (step(screen, send) === 'done') return { screen, completed: true };
    }
    return { screen, completed: false };
  } finally {
    try {
      send('C-c');
      await sleep(500);
      send('C-c');
      await sleep(1500);
      tmux('kill-session', '-t', session);
    } catch {}
  }
}

const TRUST_PROMPT = /Yes, I trust this folder/;

// The dialog defaults to "No, exit" when the folder pre-approves permissions. Move the cursor to
// the "Yes" option before confirming. Returns true once Enter was sent on "Yes".
function answerTrust(screen: string, send: Send): boolean {
  if (/❯\s*Yes, I trust this folder/.test(screen)) {
    send('Enter');
    return true;
  }
  send('Down');
  return false;
}

function isTrusted(repo: string): boolean {
  const cfg = JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8')) as {
    projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
  };
  return cfg.projects?.[repo]?.hasTrustDialogAccepted === true;
}

// Accept the workspace trust dialog in a promptless interactive session (no model turn).
async function ensureTrusted(s: Scenario, env: NodeJS.ProcessEnv, repo: string) {
  if (isTrusted(repo)) return;
  let acceptedAt = 0;
  const r = await driveTmux(repo, env, ['claude', ...baseArgs(s, undefined)], (screen, send) => {
    if (!acceptedAt && TRUST_PROMPT.test(screen)) {
      if (answerTrust(screen, send)) acceptedAt = Date.now();
      return undefined;
    }
    return acceptedAt && Date.now() - acceptedAt > 4000 ? 'done' : undefined;
  });
  if (!isTrusted(repo))
    throw new Error(`trust not recorded for ${repo}; last screen:\n${scrubString(r.screen)}`);
}

async function runDontAskAgain(s: Scenario, env: NodeJS.ProcessEnv, repo: string) {
  const log: string[] = [];
  let permissionScreen = '';
  const argv = ['claude', ...baseArgs(s, undefined), prompt(s)];
  const r = await driveTmux(repo, env, argv, (screen, send) => {
    if (TRUST_PROMPT.test(screen) && !log.includes('trust')) {
      if (answerTrust(screen, send)) log.push('trust');
      return undefined;
    }
    const m = screen.match(/(\d)\.\s+Yes, and don.t ask again[^\n]*/i);
    if (m && !permissionScreen) {
      permissionScreen = screen;
      log.push(`selected option ${m[1]}: ${m[0].trim()}`);
      send(m[1] as string);
      return undefined;
    }
    if (permissionScreen && /taper-probe ran: c/.test(screen)) {
      log.push('command ran');
      return 'done';
    }
    return undefined;
  });
  return { log, completed: r.completed, permissionScreen, finalScreen: r.screen };
}

// ---------- sanitizing ----------

const REDACT_KEYS: Record<string, string> = {
  'user.email': 'user@example.com',
  'user.id': 'redacted-user-id',
  'user.account_uuid': '00000000-0000-0000-0000-000000000001',
  'user.account_id': 'redacted-account-id',
  'organization.id': '00000000-0000-0000-0000-000000000002',
  'host.name': 'probe-host',
};

// Transcript dirs embed the cwd as a slug (non-alphanumerics → '-').
const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

function scrubString(s: string): string {
  return s
    .replaceAll(slug(ROOT), '-probe')
    .replaceAll(slug(HOME), '-home-user')
    .replaceAll(`/private${ROOT}`, '/probe')
    .replaceAll(ROOT, '/probe')
    .replaceAll(HOME, '/home/user')
    .replaceAll(hostname(), 'probe-host')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com');
}

function scrub(v: unknown): unknown {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // OTLP attribute: { key, value: { stringValue } }
    if (typeof o.key === 'string' && o.key in REDACT_KEYS && o.value && typeof o.value === 'object')
      return { key: o.key, value: { stringValue: REDACT_KEYS[o.key] } };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o))
      out[k] = k in REDACT_KEYS ? REDACT_KEYS[k] : scrub(val);
    return out;
  }
  return v;
}

const jsonl = (xs: unknown[]) => `${xs.map((x) => JSON.stringify(scrub(x))).join('\n')}\n`;

// ---------- observation helpers ----------

type StreamMsg = Record<string, unknown>;

function parseStream(stdout: string): StreamMsg[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as StreamMsg);
}

function toolActivity(msgs: StreamMsg[]) {
  const uses: unknown[] = [];
  const results: unknown[] = [];
  for (const m of msgs) {
    const content = (m.message as { content?: unknown[] } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Record<string, unknown>[]) {
      if (c.type === 'tool_use') uses.push({ name: c.name, input: c.input });
      if (c.type === 'tool_result') results.push({ is_error: c.is_error, content: c.content });
    }
  }
  const result = msgs.find((m) => m.type === 'result');
  return { uses, results, permission_denials: result?.permission_denials, result: result?.result };
}

function otelLogEvents(scenario: string) {
  const events: { name: unknown; attrs: Record<string, unknown> }[] = [];
  for (const r of otlp.filter((x) => x.scenario === scenario && x.path.includes('logs'))) {
    const body = r.body as {
      resourceLogs?: { scopeLogs?: { logRecords?: Record<string, unknown>[] }[] }[];
    };
    for (const rl of body.resourceLogs ?? [])
      for (const sl of rl.scopeLogs ?? [])
        for (const lr of sl.logRecords ?? []) {
          const attrs: Record<string, unknown> = {};
          for (const a of (lr.attributes as { key: string; value: Record<string, unknown> }[]) ??
            [])
            attrs[a.key] = Object.values(a.value)[0];
          events.push({
            name: attrs['event.name'] ?? (lr.body as { stringValue?: string })?.stringValue,
            attrs,
          });
        }
  }
  return events;
}

// ---------- main ----------

async function main() {
  const only = process.argv.slice(2);
  const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const port = await startReceiver();
  const env = childEnv(port);
  const resultsPath = join(FIX, 'probe-results.json');
  const results: Record<string, unknown> = existsSync(resultsPath)
    ? (JSON.parse(readFileSync(resultsPath, 'utf8')) as { scenarios: Record<string, unknown> })
        .scenarios
    : {};
  for (const dir of ['headless', 'hooks', 'otel']) mkdirSync(join(FIX, dir), { recursive: true });

  for (const s of scenarios) {
    currentScenario = s.name;
    process.stderr.write(`probe ${s.name} ... `);
    const { repo, hookOut, cliPath } = setup(s);
    const obs: Record<string, unknown> = {
      purpose: s.purpose,
      command: s.command,
      rules: {
        project: s.project,
        local: s.local,
        cli: s.cli,
      },
    };

    if (s.trusted !== false && !s.interactive) {
      await ensureTrusted(s, env, repo);
      rmSync(hookOut, { recursive: true, force: true }); // drop the trust session's hook payloads
    }
    obs.trustedBeforeRun = isTrusted(repo);
    if (s.interactive) {
      const r = await runDontAskAgain(s, env, repo);
      obs.interactive = { log: r.log, completed: r.completed };
      obs.permissionScreen = scrubString(r.permissionScreen);
      obs.finalScreen = scrubString(r.finalScreen);
    } else {
      const r = await runHeadless(s, env, repo, cliPath);
      const msgs = parseStream(r.stdout);
      writeFileSync(join(FIX, 'headless', `${s.name}.stream.jsonl`), jsonl(msgs));
      Object.assign(
        obs,
        { exitCode: r.code, timedOut: r.timedOut, stderr: scrubString(r.stderr.slice(0, 2000)) },
        scrub(toolActivity(msgs)) as object,
      );
    }
    await sleep(2500); // let the OTLP exporters flush after exit

    // settings files after the run (probe c: where did the new allow rule land?)
    const after: Record<string, unknown> = {};
    for (const f of ['settings.json', 'settings.local.json']) {
      const p = join(repo, '.claude', f);
      if (existsSync(p)) after[f] = scrub(JSON.parse(readFileSync(p, 'utf8')));
    }
    obs.settingsAfter = after;

    // hook payloads
    const hookFix = join(FIX, 'hooks', s.name);
    rmSync(hookFix, { recursive: true, force: true });
    if (existsSync(hookOut)) {
      mkdirSync(hookFix, { recursive: true });
      const files = readdirSync(hookOut).sort();
      const seq: string[] = [];
      let n = 0;
      for (const f of files.filter((x) => !x.endsWith('.out.json'))) {
        const ev = f.replace(/^\d+-/, '').replace(/\.json$/, '');
        const stem = `${String(n++).padStart(2, '0')}-${ev}`;
        seq.push(ev);
        const payload = JSON.parse(readFileSync(join(hookOut, f), 'utf8'));
        writeFileSync(
          join(hookFix, `${stem}.json`),
          `${JSON.stringify(scrub(payload), null, 2)}\n`,
        );
        const outFile = join(hookOut, f.replace(/\.json$/, '.out.json'));
        if (existsSync(outFile))
          writeFileSync(join(hookFix, `${stem}.out.json`), `${readFileSync(outFile, 'utf8')}\n`);
      }
      obs.hookSequence = seq;
    }

    // telemetry
    const reqs = otlp.filter((x) => x.scenario === s.name);
    writeFileSync(join(FIX, 'otel', `${s.name}.jsonl`), jsonl(reqs));
    obs.otelContentTypes = [...new Set(reqs.map((r) => `${r.path} ${r.contentType}`))];
    obs.otelEvents = scrub(
      otelLogEvents(s.name).filter((e) => /tool|permission|hook|session/i.test(String(e.name))),
    );

    results[s.name] = obs;
    process.stderr.write('done\n');
  }

  writeFileSync(
    resultsPath,
    `${JSON.stringify({ claudeVersion: version, model: MODEL, ranAt: new Date().toISOString(), scenarios: results }, null, 2)}\n`,
  );
  process.stderr.write(`wrote ${resultsPath}\n`);
}

await main();
