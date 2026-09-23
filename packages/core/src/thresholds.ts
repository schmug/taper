import type { Config, Knob, Thresholds } from './types.ts';

/** HANDOFF §4.1 defaults; a backend or org overrides them via Config, a knob via its thresholds. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  t1Days: 30,
  t2Days: 45,
  t3Days: 60,
  cooldownDays: 14,
  maturityDays: 14,
  deadmanWindowDays: 7,
};

export function resolveThresholds(config: Config, knob: Knob): Thresholds {
  return { ...config.thresholds, ...knob.thresholds };
}
