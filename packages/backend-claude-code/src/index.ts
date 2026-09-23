// @taper/backend-claude-code — pure entry point (Worker-safe: no node: imports).
// The node-only settings loader is the `./loader` subpath (src/loader.ts).
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
