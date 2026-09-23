// The machine-owned construct, derived from state (HANDOFF §5.4, P8): `pending_removal` → an
// in-context prompt (tier 1), `removed` → a block that only a re-grant lifts (tier 2). Shadow
// knobs yield nothing, so no enforcement writer can act on them (invariant 7). A knob id listed
// with conflicting modes counts as shadow.

import { cmp } from './order.ts';
import type { EnforcementAction, Knob, Member } from './types.ts';

export function enforcement(
  knobs: readonly Knob[],
  members: readonly Member[],
): EnforcementAction[] {
  const automatic = (knobId: string) => {
    const matching = knobs.filter((k) => k.id === knobId);
    return matching.length > 0 && matching.every((k) => k.mode === 'automatic');
  };
  const actions: EnforcementAction[] = [];
  for (const m of members) {
    const action =
      m.state === 'pending_removal' ? 'prompt' : m.state === 'removed' ? 'block' : null;
    if (action === null || !automatic(m.knobId)) continue;
    actions.push({ memberId: m.id, knobId: m.knobId, rule: m.rule, action });
  }
  return actions.sort((a, b) => cmp(a.knobId, b.knobId) || cmp(a.memberId, b.memberId));
}
