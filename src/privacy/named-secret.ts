export const NAMED_SECRET_RULE_ID = 'named-secret';

// Match one complete ASCII field name, not a credential word inside a metric.
// The two separator branches have distinct first characters, avoiding adjacent
// whitespace quantifiers when an assignment-like line has no ':' or '='.
export const NAMED_SECRET_ASSIGNMENT =
  /(?<![A-Za-z0-9_-])(?:-{1,2})?([A-Za-z][A-Za-z0-9_-]{0,127})(?:["']\s*|\s*)[=:]\s*/dg;

const CREDENTIAL_SUFFIX =
  /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)$/i;

export function namedSecretValue(
  text: string,
  match: RegExpExecArray,
): { start: number; end: number; resume: number } | null {
  if (!CREDENTIAL_SUFFIX.test(match[1] ?? '')) return null;
  const valueStart = match.index + match[0].length;
  const quote = text[valueStart];
  if (quote === '"' || quote === "'") {
    const start = valueStart + 1;
    let end = start;
    // Disjoint cursor steps read every code unit at most once. An unfinished
    // quote protects the remaining input rather than falling back to one word.
    while (end < text.length && text[end] !== quote) {
      end += text[end] === '\\' && end + 1 < text.length ? 2 : 1;
    }
    return end === start
      ? null
      : { start, end, resume: end < text.length ? end + 1 : end };
  }
  // Preserve generated multi-category markers as one candidate. Validation of
  // the exact marker remains in the scanner; a trailing suffix is still secret.
  const marker = /^\[REDACTED(?::[a-z_,]{1,256})?\]/.exec(
    text.slice(valueStart, valueStart + 270),
  );
  let end = valueStart + (marker?.[0].length ?? 0);
  while (end < text.length && !/[\s'";,]/.test(text[end] ?? '')) end += 1;
  return end === valueStart ? null : { start: valueStart, end, resume: end };
}
