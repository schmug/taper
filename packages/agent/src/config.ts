// ~/.taper/config.json (HANDOFF §6). zod-validated at the boundary; strict, so a typo fails loudly
// instead of silently falling back to a default.

import { type Config, DEFAULT_THRESHOLDS } from '@taper/core';
import { z } from 'zod';
import { readText, writeAtomic } from './fsutil.ts';

const days = z.number().positive().finite();

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    device_id: z.string().min(1),
    /** Salt for `args_hash` (HANDOFF §3.3). Never leaves the device. */
    args_salt: z.string().regex(/^[0-9a-f]{64}$/),
    enrolled_at: z.number().int().nonnegative(),
    /** C2: Read(...) members start protected. */
    protect_read_rules: z.boolean(),
    /** The local agent never keeps raw tool arguments (invariant 8); only 0 is accepted. */
    raw_retention_hours: z.literal(0),
    /** Overrides of the default thresholds for every knob on this device. */
    thresholds: z
      .object({
        t1Days: days,
        t2Days: days,
        t3Days: days,
        cooldownDays: days,
        maturityDays: z.number().nonnegative().finite(),
        deadmanWindowDays: days,
      })
      .partial()
      .strict()
      .optional(),
    /** Where `taper init` installed hooks, so `taper uninstall` can remove exactly those. */
    hooks: z
      .object({ command_prefix: z.string().min(1), files: z.array(z.string().min(1)) })
      .strict()
      .optional(),
  })
  .strict();
export type TaperConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(opts: { deviceId: string; salt: string; now: number }): TaperConfig {
  return {
    version: 1,
    device_id: opts.deviceId,
    args_salt: opts.salt,
    enrolled_at: opts.now,
    protect_read_rules: true,
    raw_retention_hours: 0,
  };
}

/** null when the file does not exist; throws when it exists but is invalid. */
export function readConfig(path: string): TaperConfig | null {
  const text = readText(path);
  if (text === null) return null;
  return ConfigSchema.parse(JSON.parse(text));
}

export function writeConfig(path: string, cfg: TaperConfig): void {
  writeAtomic(path, `${JSON.stringify(ConfigSchema.parse(cfg), null, 2)}\n`, 0o600);
}

export function coreConfig(cfg: TaperConfig): Config {
  const set = Object.entries(cfg.thresholds ?? {}).filter(([, v]) => v !== undefined);
  return { thresholds: { ...DEFAULT_THRESHOLDS, ...Object.fromEntries(set) } };
}
