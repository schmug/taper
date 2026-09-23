// @taper/backend-claude-code — pure entry point (Worker-safe: no node: imports).
// The node-only settings loader is the `./loader` subpath (src/loader.ts).
export {
  type Event,
  EventSchema,
  type HookToolInput,
  HookToolInputSchema,
  type PermissionMode,
  PermissionModeSchema,
  permissionModeOf,
  toolCallFromHook,
  toSignal,
  toUsageEvent,
} from './event.ts';
export {
  type Attribution,
  applySettingsSnapshots,
  attribute,
  isProtectedByDefault,
  isTaperOwned,
  type KnobOptions,
  type KnobPlan,
  knobIdFor,
  planKnobs,
  policyFromSnapshots,
  TAPER_MANAGED_FILE,
} from './knobs.ts';
export {
  MAX_COMMAND_LENGTH,
  type MatchBasis,
  type MatchResult,
  match,
  type ToolCall,
} from './match.ts';
export {
  buildPolicy,
  type EffectivePolicy,
  type PermissionArrays,
  type PolicyInput,
  type PolicyRule,
  type PolicySource,
  SCOPES,
  type Scope,
  type Trust,
} from './policy.ts';
export { canonicalTool, normalizeRule, type ParsedRule, type Polarity, parseRule } from './rule.ts';
export {
  findSettingsRefs,
  invokesClaudeCode,
  type ParsedSettings,
  parseSettingsText,
  type SettingsRef,
  type SettingsSnapshot,
  SettingsSnapshotSchema,
} from './settings.ts';
