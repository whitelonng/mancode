import { describe, expect, it } from 'vitest';
import {
  parseManEvidenceSubject,
  parseManReviewEvidence,
  parseManVerificationSurface,
} from '../src/context/man-delivery-evidence.js';

const subject = {
  contentDigest: `sha256:${'a'.repeat(64)}`,
  environment: 'linux/x64;node=v22',
};
const report = {
  subject,
  reviewer: 'self',
  direction: 'AC-1 reaches the entry',
  correctness: 'Covered real input/output',
  proportionality: 'No speculative defenses',
  nextAction: 'Stop',
  coverage: [
    {
      acceptanceId: 'AC-1',
      status: 'met',
      evidence: 'app.run and test result',
    },
  ],
};
describe('man semantic evidence input', () => {
  it('accepts explicit self-review without inventing findings or independence', () => {
    expect(parseManReviewEvidence(report)).toEqual(report);
    expect(parseManEvidenceSubject(subject)).toEqual(subject);
    expect(parseManVerificationSurface('real_http')).toBe('real_http');
  });
  it.each([
    'unit',
    'component',
    'handler',
    'real_http',
    'browser',
    'device',
    'external_service',
    'manual_observation',
  ])('accepts the declared verification surface %s', (surface) => {
    expect(parseManVerificationSurface(surface)).toBe(surface);
  });
  it.each(['http', 'integration', '', null, 1])(
    'rejects an invented verification surface %s',
    (surface) => {
      expect(() => parseManVerificationSurface(surface)).toThrow(
        'MANCODE_MAN_VERIFICATION_SURFACE_INVALID',
      );
    },
  );
  it.each([
    { ...report, coverage: [...report.coverage, ...report.coverage] },
    { ...report, reviewer: 'guaranteed' },
    { ...report, correctness: '' },
    { ...report, subject: { ...subject, contentDigest: 'HEAD' } },
    { ...report, arbitraryApproval: true },
    {
      ...report,
      coverage: [
        { acceptanceId: 'AC-1', status: 'probably', evidence: 'guess' },
      ],
    },
  ])('rejects ambiguous or invented evidence shape', (input) => {
    expect(() => parseManReviewEvidence(input)).toThrow();
  });
});
