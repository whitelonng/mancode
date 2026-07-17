import path from 'node:path';

export type SharedPrivacyFindingKind =
  | 'authorization'
  | 'cookie'
  | 'private_key'
  | 'secret'
  | 'absolute_path'
  | 'email';

export interface SharedPrivacyFinding {
  kind: SharedPrivacyFindingKind;
  start: number;
  end: number;
}

export interface SharedTextRedaction {
  text: string;
  redactions: Array<{ kind: SharedPrivacyFindingKind; count: number }>;
}

const FINDING_PATTERNS: Array<{
  kind: SharedPrivacyFindingKind;
  pattern: RegExp;
}> = [
  {
    kind: 'private_key',
    pattern:
      /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  },
  {
    kind: 'authorization',
    pattern:
      /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+[^\s,;]+/gi,
  },
  {
    kind: 'cookie',
    pattern: /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi,
  },
  {
    kind: 'secret',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\s*[=:]\s*['"]?[^\s'";,]+/gi,
  },
  {
    kind: 'absolute_path',
    pattern:
      /(?:\b[A-Z]:\\|\/(?:Users|home|private|var\/folders|tmp|etc)\/)[^\s'"`]+/g,
  },
  {
    kind: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
];

export function scanSharedText(value: string): SharedPrivacyFinding[] {
  assertText(value, 'shared text');
  const findings: SharedPrivacyFinding[] = [];
  for (const { kind, pattern } of FINDING_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      if (match.index === undefined) continue;
      findings.push({
        kind,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return removeNestedFindings(findings);
}

/**
 * Applies only deterministic substitutions. The result carries categories and
 * counts for provenance; it never preserves a raw sensitive value in metadata.
 */
export function redactSharedText(value: string): SharedTextRedaction {
  assertText(value, 'shared text');
  const findings = scanSharedText(value);
  if (findings.length === 0) return { text: value, redactions: [] };
  let redacted = '';
  let cursor = 0;
  const counts = new Map<SharedPrivacyFindingKind, number>();
  for (const finding of findings) {
    redacted += value.slice(cursor, finding.start);
    redacted += `[REDACTED:${finding.kind}]`;
    cursor = finding.end;
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  redacted += value.slice(cursor);
  if (scanSharedText(redacted).length > 0) {
    throw new Error('MANCODE_PRIVACY_BLOCKED');
  }
  return {
    text: redacted,
    redactions: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([kind, count]) => ({ kind, count })),
  };
}

export function assertSharedTextSafe(value: string, label: string): void {
  assertText(value, label);
  if (scanSharedText(value).length > 0) {
    throw new Error(`MANCODE_PRIVACY_BLOCKED: ${label}`);
  }
}

/** Safe relative paths are the only custom report-path representation. */
export function assertSafeSharedRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  const normalized = value.split(/[\\/]/);
  if (
    normalized.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('MANCODE_ARTIFACT_PATH_UNSAFE');
  }
  return normalized.join('/');
}

function removeNestedFindings(
  findings: SharedPrivacyFinding[],
): SharedPrivacyFinding[] {
  const nonOverlapping: SharedPrivacyFinding[] = [];
  let end = -1;
  for (const finding of findings.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    if (finding.start < end) continue;
    nonOverlapping.push(finding);
    end = finding.end;
  }
  return nonOverlapping;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`${label} must be a NUL-free string`);
  }
}
