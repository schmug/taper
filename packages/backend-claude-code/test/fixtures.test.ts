// One fixture file per documented rule form (HANDOFF §9 M2). Each case runs the matcher on the
// fixture's settings and checks outcome, decisive set, and every matching allow rule (C5).

import { describe, expect, it } from 'vitest';
import { buildPolicy, match } from '../src/index.ts';
import { fillDeep, loadFixtures, refOf, sourcesFor, UNIT_PATHS } from './fixture-harness.ts';

const fixtures = loadFixtures();
const P = UNIT_PATHS;

describe('fixtures/settings', () => {
  it('has one fixture per rule form', () => {
    const forms = fixtures.map((f) => f.fixture.form);
    expect(new Set(forms).size).toBe(forms.length);
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
  });

  it('marks differential cases only where the job can write the settings', () => {
    for (const { file, fixture } of fixtures) {
      if (!fixture.cases.some((c) => c.diff)) continue;
      const scopes = Object.keys(fixture.settings);
      const writable = scopes.every((s) => s === 'local' || s === 'cli' || s === 'project');
      // Project allow rules need workspace trust; the job's scratch repos are never trusted.
      const trustOk = !scopes.includes('project') || fixture.workspaceTrusted === false;
      expect({ file, writable, trustOk }).toEqual({ file, writable: true, trustOk: true });
    }
  });

  it('gives every non-differential case a reason', () => {
    for (const { file, fixture } of fixtures) {
      const scopes = Object.keys(fixture.settings);
      const jobCanRun = scopes.every((s) => s === 'local' || s === 'cli');
      for (const c of fixture.cases) {
        if (c.diff || !jobCanRun) continue;
        const note = c.diffNote ?? fixture.diffNote;
        expect({ file, name: c.name, diffNote: typeof note }).toEqual({
          file,
          name: c.name,
          diffNote: 'string',
        });
      }
    }
  });
});

for (const { file, fixture } of fixtures) {
  describe(`${file}: ${fixture.form}`, () => {
    const policy = buildPolicy({
      sources: sourcesFor(fixture, P),
      home: P.home,
      workspaceTrusted: fixture.workspaceTrusted,
    });
    it.each(fixture.cases)('$name', (c) => {
      const input = fillDeep(c.input, P) as Record<string, unknown>;
      const r = match(policy, { tool: c.tool, input, cwd: P.cwd });
      expect({
        outcome: r.outcome,
        decisive: r.decisiveRules.map(refOf),
        allowMatches: r.allMatchingAllowRules.map(refOf),
      }).toEqual({
        outcome: c.expect.outcome,
        decisive: c.expect.decisive,
        allowMatches: c.expect.allowMatches,
      });
      if (c.expect.basis) expect(r.basis).toBe(c.expect.basis);
    });
  });
}
