import { describe, expect, it } from 'vitest';
import {
  assertSafeSharedRelativePath,
  assertSharedTextSafe,
  redactSharedText,
  scanSharedText,
} from '../src/context/privacy.js';

describe('shared privacy contract', () => {
  it('deterministically redacts known sensitive text and preserves provenance categories', () => {
    const raw =
      'Authorization: Bearer super-secret-token; see /Users/alice/project and contact alice@example.com';
    expect(scanSharedText(raw).map((finding) => finding.kind)).toEqual([
      'authorization',
      'absolute_path',
      'email',
    ]);
    const redacted = redactSharedText(raw);
    expect(redacted.text).toContain('[REDACTED:authorization]');
    expect(redacted.text).toContain('[REDACTED:absolute_path]');
    expect(redacted.text).toContain('[REDACTED:email]');
    expect(redacted.redactions).toEqual([
      { kind: 'absolute_path', count: 1 },
      { kind: 'authorization', count: 1 },
      { kind: 'email', count: 1 },
    ]);
    expect(() =>
      assertSharedTextSafe(redacted.text, 'redacted summary'),
    ).not.toThrow();
    expect(() => assertSharedTextSafe(raw, 'raw summary')).toThrow(
      'MANCODE_PRIVACY_BLOCKED',
    );
  });

  it('only accepts controlled relative artifact paths', () => {
    expect(assertSafeSharedRelativePath('reports/login-rate-limit.md')).toBe(
      'reports/login-rate-limit.md',
    );
    for (const unsafe of [
      '../secret.md',
      '/Users/alice/secret.md',
      'C:\\Users\\alice\\secret.md',
      'file:///tmp/secret.md',
      'reports/../secret.md',
      'reports//secret.md',
    ]) {
      expect(() => assertSafeSharedRelativePath(unsafe)).toThrow(
        'MANCODE_ARTIFACT_PATH_UNSAFE',
      );
    }
  });
});
