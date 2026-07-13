import { describe, expect, it } from 'vitest';
import {
  parseRequirementsLedger,
  renderRequirementsMarkdown,
  requirementsAreReady,
} from '../src/system/requirements-ledger.js';

describe('requirements ledger', () => {
  it('derives readiness from blocking unknowns and renders one authoritative view', () => {
    const ledger = parseRequirementsLedger(
      JSON.stringify({
        version: 1,
        goal: 'Build a voxel sandbox',
        confirmedScope: ['Desktop creative mode'],
        excludedScope: ['Survival mode'],
        technicalDecisions: ['Use the existing Vite stack'],
        defaults: ['Use a bounded world'],
        blockingUnknowns: [],
        coverage: completeCoverage(),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Pointer lock movement works',
            required: true,
            method: 'manual',
          },
        ],
      }),
    );

    expect(requirementsAreReady(ledger)).toBe(true);
    expect(renderRequirementsMarkdown(ledger)).toContain('READY');
    expect(renderRequirementsMarkdown(ledger)).toContain('AC-1');
  });

  it('rejects duplicate ids and manifests with no required acceptance', () => {
    const base = {
      version: 1,
      goal: 'Build it',
      confirmedScope: ['Confirmed first release'],
      excludedScope: [],
      technicalDecisions: ['Use the existing stack'],
      defaults: [],
      blockingUnknowns: [],
      coverage: completeCoverage(),
    };
    expect(() =>
      parseRequirementsLedger(
        JSON.stringify({
          ...base,
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'First',
              required: true,
              method: 'automated',
            },
            {
              id: 'AC-1',
              description: 'Duplicate',
              required: true,
              method: 'manual',
            },
          ],
        }),
      ),
    ).toThrow(/duplicate acceptance criterion/);
    expect(() =>
      parseRequirementsLedger(
        JSON.stringify({
          ...base,
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'Optional only',
              required: false,
              method: 'automated',
            },
          ],
        }),
      ),
    ).toThrow(/at least one required/);
  });

  it('rejects missing requirement coverage dimensions', () => {
    expect(() =>
      parseRequirementsLedger(
        JSON.stringify({
          version: 1,
          goal: 'Build it',
          confirmedScope: ['First release'],
          excludedScope: [],
          technicalDecisions: ['Use the existing stack'],
          defaults: [],
          blockingUnknowns: [],
          coverage: completeCoverage().slice(0, -1),
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The confirmed behavior works',
              required: true,
              method: 'automated',
            },
          ],
        }),
      ),
    ).toThrow(/coverage is missing/);
  });
});

function completeCoverage() {
  return [
    'platform',
    'core_scope',
    'technical_stack',
    'data_and_persistence',
    'performance',
    'compatibility',
    'security',
  ].map((dimension) => ({
    dimension,
    status: 'confirmed',
    rationale: `${dimension} was explicitly considered`,
  }));
}
