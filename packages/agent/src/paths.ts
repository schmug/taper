// Where taper and Claude Code keep things on this device (HANDOFF §6; facts doc B3, B9).
// `CLAUDE_CONFIG_DIR` relocates ~/.claude; taper assumes it also holds `.claude.json`
// (UNVERIFIED, ADR-0010).

import { join } from 'node:path';

export interface Paths {
  readonly home: string;
  readonly taperDir: string;
  readonly db: string;
  readonly config: string;
  readonly errorLog: string;
  readonly claudeDir: string;
  readonly userSettings: string;
  readonly claudeJson: string;
}

export function resolvePaths(env: Readonly<Record<string, string | undefined>>): Paths {
  const home = env.HOME;
  if (home === undefined || home === '') throw new Error('taper: HOME is not set');
  const taperDir = join(home, '.taper');
  const configDir = env.CLAUDE_CONFIG_DIR;
  const claudeDir = configDir !== undefined && configDir !== '' ? configDir : join(home, '.claude');
  return {
    home,
    taperDir,
    db: join(taperDir, 'state.db'),
    config: join(taperDir, 'config.json'),
    errorLog: join(taperDir, 'errors.log'),
    claudeDir,
    userSettings: join(claudeDir, 'settings.json'),
    claudeJson: configDir ? join(claudeDir, '.claude.json') : join(home, '.claude.json'),
  };
}
