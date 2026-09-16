import { describe, expect, it } from 'vitest';
import { MAN_REVIEW_GUIDANCE } from '../src/installers/man-review-guidance.js';

describe('Man review orchestration guidance', () => {
  const guidance = MAN_REVIEW_GUIDANCE.join('\n');

  it('uses the original task and supported evidence without manufacturing child authority', () => {
    expect(guidance).toContain('existing Man TaskRef');
    expect(guidance).toContain('review inspect --base <bound-baseHead> --json');
    expect(guidance).toContain('never add unsupported fields');
    expect(guidance).toContain('does not create a diagnostic child');
    expect(guidance).toContain('do not recreate stale children in a loop');
    expect(guidance).toContain('one module total review');
  });

  it('requires honest, proportionate TDD and platform evidence', () => {
    expect(guidance).toContain('fails for the target behavior');
    expect(guidance).toContain('documentation does not need an artificial Red');
    expect(guidance).toContain('does not prove historical test-first');
    expect(guidance).toContain('not persisted TDD gates');
    expect(guidance).toContain('newly built CLI');
    expect(guidance).toContain('never proves an unexecuted platform matrix');
    expect(guidance).toContain('governed Solo handoff');
  });
});
