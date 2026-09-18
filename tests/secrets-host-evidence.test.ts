import { describe, expect, it } from 'vitest';
import { verifyHostEvidence } from '../scripts/secrets-host-evidence.mjs';

const receipt = {
  time: '2026-09-18T10',
  runId: '53627c9a-494f-4bf7-949f-a623f987c58b',
  action: 'ticket-check',
  event: 'executor_succeeded',
};
const success = {
  host: 'codex',
  exit: 0,
  requests: 1,
  authorized: 1,
  auditEvents: [receipt],
  executed: true,
  reportedSuccess: true,
};

describe('Secrets host acceptance evidence', () => {
  it('accepts a zero-exit host with one authenticated request and runner receipt', () => {
    expect(() => verifyHostEvidence(success)).not.toThrow();
  });
  it('rejects the historical nonzero exit and negated success-text false positive', () => {
    expect(() =>
      verifyHostEvidence({
        ...success,
        exit: 1,
        reportedSuccess: 'Run failed: not executor_succeeded'.includes(
          'executor_succeeded',
        ),
      }),
    ).toThrow();
  });
  it.each([
    { exit: null },
    { authorized: 0 },
    { auditEvents: [{ ...receipt, event: 'EXECUTOR_FAILED' }] },
    { auditEvents: [] },
    { auditEvents: [receipt, receipt] },
    {
      auditEvents: [
        { ...receipt, event: 'EXECUTOR_FAILED', code: 'EXECUTOR_FAILED' },
      ],
    },
    { auditEvents: [{ ...receipt, action: 'another-action' }] },
    { auditEvents: [{ ...receipt, runId: 'not-a-run-id' }] },
    { auditEvents: [{ ...receipt, code: 'EXECUTOR_FAILED' }] },
    { requests: 2 },
  ])(
    'rejects unauthenticated, missing, failed or ambiguous execution: %j',
    (patch) => {
      expect(() => verifyHostEvidence({ ...success, ...patch })).toThrow();
    },
  );
});
