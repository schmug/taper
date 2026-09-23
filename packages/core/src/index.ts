// @taper/core — pure engine. Invariant: no I/O, no network, no randomness, no LLM,
// no imports from outside this package. evaluate() is deterministic. (CLAUDE.md invariant 1)
export { type Clock, DAY_MS, makeClock } from './clock.ts';
export { enforcement } from './enforcement.ts';
export { applyTransitions, evaluate } from './evaluate.ts';
export { type ExplainInput, type Explanation, explain } from './explain.ts';
export { type SimulationState, simulate, type Timeline, type TimelineStep } from './simulate.ts';
export { applySnapshot, memberIdFor, type Snapshot, type SnapshotOptions } from './snapshot.ts';
export { DEFAULT_THRESHOLDS, resolveThresholds } from './thresholds.ts';
export type * from './types.ts';
export {
  applyUsage,
  type RegrantRequest,
  regrant,
  type UsageContext,
  type UsageOutput,
} from './usage.ts';
