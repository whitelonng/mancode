import { scanSensitiveText } from './detect.js';
import type { RedactedText, RedactionSpan, SensitiveFinding } from './types.js';

/** Union overlapping ranges, including partially overlapping tails. */
export function mergeSensitiveSpans(
  findings: readonly SensitiveFinding[],
): RedactionSpan[] {
  const spans: RedactionSpan[] = [];
  for (const finding of [...findings].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    const last = spans.at(-1);
    if (last !== undefined && finding.start < last.end) {
      last.end = Math.max(last.end, finding.end);
      if (!last.ruleIds.includes(finding.ruleId))
        last.ruleIds.push(finding.ruleId);
      if (!last.categories.includes(finding.category))
        last.categories.push(finding.category);
    } else {
      spans.push({
        start: finding.start,
        end: finding.end,
        ruleIds: [finding.ruleId],
        categories: [finding.category],
      });
    }
  }
  for (const span of spans) {
    span.ruleIds.sort();
    span.categories.sort();
  }
  return spans;
}

/** Produces a separate irreversible view; it is never a persisted task rewrite. */
export function redactSensitiveText(
  value: string,
  ruleIds?: readonly string[],
): RedactedText {
  const scan = scanSensitiveText(value, ruleIds);
  if (scan.status !== 'complete') return { text: '', scan, spans: [] };
  const spans = mergeSensitiveSpans(scan.findings);
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(
      value.slice(cursor, span.start),
      `[REDACTED:${span.categories.join(',')}]`,
    );
    cursor = span.end;
  }
  parts.push(value.slice(cursor));
  return { text: parts.join(''), scan, spans };
}
