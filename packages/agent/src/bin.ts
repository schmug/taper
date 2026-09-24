#!/usr/bin/env node
// `taper` binary: wires the real process into cli.run (HANDOFF §6). Built to dist/taper.mjs for
// installs (ADR-0012); runs from source under Node's type stripping in this repo.

import { randomBytes } from 'node:crypto';
import { readFileSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './cli.ts';

function confirm(question: string): boolean {
  process.stdout.write(question);
  const buf = Buffer.alloc(64);
  let n = 0;
  try {
    n = readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  return /^y(es)?$/i.test(buf.toString('utf8', 0, n).trim());
}

try {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    now: Date.now,
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
    stdin: () => readFileSync(0, 'utf8'),
    out: (line) => process.stdout.write(`${line}\n`),
    write: (text) => process.stdout.write(text),
    err: (line) => process.stderr.write(`${line}\n`),
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm,
    entry: [process.execPath, fileURLToPath(import.meta.url)],
  });
} catch (e) {
  process.stderr.write(`taper: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
