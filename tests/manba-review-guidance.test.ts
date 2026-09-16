import { describe, expect, it } from 'vitest';
import { MANBA_REVIEW_GUIDANCE } from '../src/installers/manba-review-guidance.js';

describe('manba explicit review guidance', () => {
  const guidance = MANBA_REVIEW_GUIDANCE.join('\n');
  it('keeps independent review outside the diagnostic completion protocol', () => {
    expect(guidance).toContain('Ordinary manba diagnosis retains');
    expect(guidance).toContain(
      'creates no actor, session or diagnostic TaskRef',
    );
    expect(guidance).toContain('overrides diagnostic entry steps');
    expect(guidance).toContain('not Continuity authority');
    expect(guidance).toContain(
      'never use fixed, verified, no_repro or manual_test_required',
    );
  });
  it('preserves the existing Man task authority and checks evidence readback', () => {
    expect(guidance).toContain(
      'Do not switch modes or create a child by default',
    );
    expect(guidance).toContain('plan_only');
    expect(guidance).toContain('read back the task state');
    expect(guidance).toContain('rather than adding fields to strict ledgers');
  });
  it('binds explicit scope, preserves collection failures, and does not turn review into repair permission', () => {
    expect(guidance).toContain(
      'mancode review inspect --base <explicit-ref> --json',
    );
    expect(guidance).toContain('Inventory exit 0 proves collection only');
    expect(guidance).toContain(
      'Independent review defaults to a report, not source repair',
    );
    expect(guidance).toContain(
      'Existing-code review cannot establish historical test-first development',
    );
  });
});
