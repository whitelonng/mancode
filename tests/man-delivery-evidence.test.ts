import { describe, expect, it } from 'vitest';
import {
  parseManEvidenceSubject,
  parseManReviewEvidence,
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
  });
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
