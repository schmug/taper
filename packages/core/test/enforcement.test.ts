import { describe, expect, it } from 'vitest';
import { enforcement } from '../src/index.ts';
import { knob, member } from './helpers.ts';

describe('enforcement', () => {
  const members = [
    member({ id: 'b', state: 'removed' }),
    member({ id: 'a', state: 'pending_removal' }),
    member({ id: 'c', state: 'stale_candidate' }),
    member({ id: 'd', state: 'retired', retiredFrom: 'removed' }),
    member({ id: 'e', knobId: 'k2', state: 'removed' }),
    member({ id: 'f', knobId: 'k9', state: 'removed' }),
  ];

  it('prompts for pending_removal and blocks removed members of automatic knobs', () => {
    const knobs = [knob({ id: 'k2' }), knob()];
    expect(enforcement(knobs, members)).toEqual([
      { memberId: 'a', knobId: 'k1', rule: 'rule:a', action: 'prompt' },
      { memberId: 'b', knobId: 'k1', rule: 'rule:b', action: 'block' },
      { memberId: 'e', knobId: 'k2', rule: 'rule:e', action: 'block' },
    ]);
  });

  it('never enforces anything for a shadow knob', () => {
    const knobs = [knob({ mode: 'shadow' }), knob({ id: 'k2' })];
    expect(enforcement(knobs, members).map((a) => a.memberId)).toEqual(['e']);
  });

  it('treats a knob id listed as both shadow and automatic as shadow', () => {
    const knobs = [knob(), knob({ mode: 'shadow' })];
    expect(enforcement(knobs, members)).toEqual([]);
  });
});
