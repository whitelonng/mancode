import { describe, expect, it } from 'vitest';
import { executionCommandDigest } from '../src/runtime/execution-runner.js';

describe('execution intention identity', () => {
  it('binds cwd, literal argv and the finite command budget', () => {
    const digest = executionCommandDigest(
      '/project',
      ['node', '-e', 'literal'],
      1000,
    );
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      executionCommandDigest('/other', ['node', '-e', 'literal'], 1000),
    ).not.toBe(digest);
    expect(
      executionCommandDigest('/project', ['node', '-e', 'changed'], 1000),
    ).not.toBe(digest);
    expect(
      executionCommandDigest('/project', ['node', '-e', 'literal'], 2000),
    ).not.toBe(digest);
  });
});
