import { describe, expect, it } from 'vitest';
import {
  assertRequirementsScopeConsistent,
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
            verificationSurfaces: { manual: 'browser' },
          },
        ],
      }),
    );

    expect(requirementsAreReady(ledger)).toBe(true);
    expect(renderRequirementsMarkdown(ledger)).toContain('READY');
    expect(renderRequirementsMarkdown(ledger)).toContain('AC-1');
    expect(renderRequirementsMarkdown(ledger)).toContain('manual=browser');
    expect(ledger.acceptanceCriteria[0]?.verificationSurfaces).toEqual({
      manual: 'browser',
    });
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

  it('rejects invalid or method-incompatible verification surfaces', () => {
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
    const parseWithSurfaces = (verificationSurfaces: unknown) =>
      parseRequirementsLedger(
        JSON.stringify({
          ...base,
          acceptanceCriteria: [
            {
              id: 'AC-1',
              description: 'The confirmed behavior works',
              required: true,
              method: 'manual',
              verificationSurfaces,
            },
          ],
        }),
      );

    expect(() => parseWithSurfaces({ automated: 'component' })).toThrow(
      /invalid acceptance verificationSurfaces/,
    );
    expect(() => parseWithSurfaces({ manual: 'mock_http' })).toThrow(
      /invalid acceptance verification surface/,
    );
  });

  it('reads old contradictory scope but rejects it as a new confirmation', () => {
    const ledger = parseRequirementsLedger(
      JSON.stringify({
        version: 1,
        goal: 'Change login behavior',
        confirmedScope: ['Update the login form'],
        excludedScope: ['Update the login form'],
        technicalDecisions: ['Use the existing stack'],
        defaults: [],
        blockingUnknowns: [],
        coverage: completeCoverage(),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'The authorized login behavior works',
            required: true,
            method: 'automated',
          },
        ],
      }),
    );

    expect(ledger.confirmedScope).toEqual(['Update the login form']);
    expect(() => assertRequirementsScopeConsistent(ledger)).toThrow(
      /both confirmed and excluded/,
    );
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
