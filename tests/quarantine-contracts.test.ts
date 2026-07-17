import { describe, expect, it } from 'vitest';
import {
  confirmQuarantineCandidate,
  createQuarantineCandidate,
  preparePromotionFromQuarantine,
  previewQuarantineCandidate,
  scanQuarantineCandidate,
  validateQuarantinePaths,
} from '../src/context/quarantine.js';

const QUARANTINE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const LOCAL_TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const SHARED_TASK_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const ACTOR_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';

describe('quarantine and promotion contract', () => {
  it('forces legacy migration through local quarantine, scan, preview, and confirmation', () => {
    const staged = candidate();
    expect(staged.candidateTaskRef.namespace).toBe('local');
    expect(() =>
      preparePromotionFromQuarantine(
        staged,
        { namespace: 'shared', taskId: SHARED_TASK_ID },
        OPERATION_ID,
      ),
    ).toThrow('MANCODE_QUARANTINE_STAGE_INVALID');

    const scanned = scanQuarantineCandidate(validateQuarantinePaths(staged), [
      'safe, reviewed content',
    ]);
    const confirmed = confirmQuarantineCandidate(
      previewQuarantineCandidate(scanned),
      ACTOR_ID,
    );
    const plan = preparePromotionFromQuarantine(
      confirmed,
      { namespace: 'shared', taskId: SHARED_TASK_ID },
      OPERATION_ID,
    );
    expect(plan.sourceTaskRef).toEqual({
      namespace: 'local',
      taskId: LOCAL_TASK_ID,
    });
    expect(plan.destinationTaskRef.namespace).toBe('shared');
    expect(plan.omittedArtifacts.map((item) => item.classification)).toEqual([
      'raw_evidence',
    ]);
  });

  it('does not silently redact a blocked scan or promote raw evidence', () => {
    const blocked = scanQuarantineCandidate(
      validateQuarantinePaths(candidate()),
      ['Authorization: Bearer super-secret'],
    );
    expect(blocked.stage).toBe('privacy_blocked');
    expect(JSON.stringify(blocked)).not.toContain('super-secret');
    expect(() => previewQuarantineCandidate(blocked)).toThrow(
      'MANCODE_PRIVACY_BLOCKED',
    );
    expect(() =>
      createQuarantineCandidate({
        ...candidateInput(),
        artifacts: [
          {
            relativePath: 'artifacts/private/raw.log',
            classification: 'raw_evidence',
            includeInPromotion: true,
            contentDigest: null,
          },
        ],
      }),
    ).toThrow('MANCODE_RAW_ARTIFACT_CANNOT_BE_PROMOTED');
  });

  it('rejects direct shared candidates and unsafe artifact paths', () => {
    expect(() =>
      createQuarantineCandidate({
        ...candidateInput(),
        candidateTaskRef: { namespace: 'shared', taskId: SHARED_TASK_ID },
      }),
    ).toThrow('MANCODE_QUARANTINE_CANDIDATE_MUST_BE_LOCAL');
    expect(() =>
      createQuarantineCandidate({
        ...candidateInput(),
        artifacts: [
          {
            relativePath: '../metadata.json',
            classification: 'authority',
            includeInPromotion: true,
            contentDigest: null,
          },
        ],
      }),
    ).toThrow('MANCODE_ARTIFACT_PATH_UNSAFE');
  });
});

function candidate() {
  return createQuarantineCandidate(candidateInput());
}

function candidateInput() {
  return {
    quarantineId: QUARANTINE_ID,
    purpose: 'legacy_migration' as const,
    sourceTaskRef: null,
    candidateTaskRef: { namespace: 'local' as const, taskId: LOCAL_TASK_ID },
    artifacts: [
      {
        relativePath: 'metadata.json',
        classification: 'authority' as const,
        includeInPromotion: true,
        contentDigest: null,
      },
      {
        relativePath: 'reports/raw.log',
        classification: 'raw_evidence' as const,
        includeInPromotion: false,
        contentDigest: null,
      },
    ],
    now: new Date('2026-07-17T10:00:00.000Z'),
  };
}
