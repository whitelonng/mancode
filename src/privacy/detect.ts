import { performance } from 'node:perf_hooks';
import { NAMED_SECRET_RULE_ID, namedSecretValue } from './named-secret.js';
import {
  DEFAULT_RULE_IDS,
  PRIVATE_KEY_RULE_ID,
  RULESET_VERSION,
  SENSITIVE_RULES,
} from './rules.js';
import type { ScanResult, SensitiveFinding } from './types.js';

export const MAX_SCAN_BYTES = 1024 * 1024;
export const MAX_SCAN_FINDINGS = 4096;
const SCAN_BUDGET_MS = 500;
const REDACTED_CATEGORIES = new Set<string>([
  'private_key',
  ...SENSITIVE_RULES.map((rule) => rule.category),
]);

/** No input text or secret-derived identifiers are retained in the result. */
export function scanSensitiveText(
  value: string,
  ruleIds: readonly string[] = DEFAULT_RULE_IDS,
): ScanResult {
  const failed = (reason: ScanResult['reason']): ScanResult => ({
    status: 'failed',
    rulesetVersion: RULESET_VERSION,
    findings: [],
    reason,
  });
  if (
    typeof value !== 'string' ||
    /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value,
    )
  )
    return failed('invalid_text');
  if (Buffer.byteLength(value, 'utf8') > MAX_SCAN_BYTES)
    return failed('input_too_large');
  if (ruleIds.some((id) => !DEFAULT_RULE_IDS.includes(id)))
    return failed('unknown_rule');
  const enabled = new Set(ruleIds);
  const started = performance.now();
  const findings: SensitiveFinding[] = [];
  if (enabled.has(PRIVATE_KEY_RULE_ID)) {
    // A missing END consumes the remaining text, instead of re-scanning every BEGIN.
    const begin = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/gi;
    for (
      let match = begin.exec(value);
      match !== null;
      match = begin.exec(value)
    ) {
      const closing = new RegExp(
        match[0].replace(/^-----BEGIN/i, '-----END'),
        'gi',
      );
      closing.lastIndex = begin.lastIndex;
      const close = closing.exec(value);
      const end = close === null ? value.length : close.index + close[0].length;
      findings.push({
        ruleId: PRIVATE_KEY_RULE_ID,
        category: 'private_key',
        start: match.index,
        end,
        validation: 'shape',
      });
      begin.lastIndex = end;
      if (findings.length > MAX_SCAN_FINDINGS)
        return failed('too_many_findings');
      if (performance.now() - started > SCAN_BUDGET_MS)
        return failed('scan_budget_exceeded');
    }
  }
  for (const rule of SENSITIVE_RULES) {
    if (!enabled.has(rule.id)) continue;
    const pattern = new RegExp(rule.pattern);
    for (
      let match = pattern.exec(value);
      match !== null;
      match = pattern.exec(value)
    ) {
      if (performance.now() - started > SCAN_BUDGET_MS)
        return failed('scan_budget_exceeded');
      const group = rule.group ?? 0;
      const assignment =
        rule.id === NAMED_SECRET_RULE_ID
          ? namedSecretValue(value, match)
          : undefined;
      if (assignment === null) continue;
      if (assignment !== undefined) pattern.lastIndex = assignment.resume;
      const bounds: [number, number] | undefined =
        assignment === undefined
          ? match.indices?.[group]
          : [assignment.start, assignment.end];
      const candidate =
        assignment === undefined
          ? match[group]
          : value.slice(assignment.start, assignment.end);
      if (bounds === undefined || candidate === undefined) continue;
      const markerCategories = /^\[REDACTED:([a-z_,]+)\]$/
        .exec(candidate)?.[1]
        ?.split(',');
      if (
        candidate === '[REDACTED]' ||
        markerCategories?.every((category) => REDACTED_CATEGORIES.has(category))
      )
        continue;
      if (rule.validate !== undefined && !rule.validate(candidate)) continue;
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        start: bounds[0],
        end: bounds[1],
        validation: rule.validation ?? 'shape',
      });
      if (findings.length > MAX_SCAN_FINDINGS)
        return failed('too_many_findings');
      if (performance.now() - started > SCAN_BUDGET_MS)
        return failed('scan_budget_exceeded');
    }
    if (performance.now() - started > SCAN_BUDGET_MS)
      return failed('scan_budget_exceeded');
  }
  findings.sort(
    (left, right) =>
      left.start - right.start ||
      right.end - left.end ||
      left.ruleId.localeCompare(right.ruleId, 'en'),
  );
  // A URI password followed by @host resembles an email address. Keep the
  // password capture so redaction does not consume non-secret routing fields.
  const passwords = findings.filter(
    (finding) => finding.category === 'connection_password',
  );
  const filtered = findings.filter((finding) => {
    if (finding.category !== 'email') return true;
    let low = 0;
    let high = passwords.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (
        (passwords[middle]?.start ?? Number.POSITIVE_INFINITY) <= finding.start
      )
        low = middle + 1;
      else high = middle;
    }
    const password = passwords[low - 1];
    return password === undefined || finding.start >= password.end;
  });
  if (performance.now() - started > SCAN_BUDGET_MS)
    return failed('scan_budget_exceeded');
  return {
    status: 'complete',
    rulesetVersion: RULESET_VERSION,
    findings: filtered,
  };
}
