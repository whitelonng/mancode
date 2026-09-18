import {
  type ActionSpec,
  LIMITS,
  type SecretRecord,
  fail,
  record,
  text,
} from './types.js';
export function validateInput(
  spec: ActionSpec,
  input: unknown,
): Record<string, unknown> {
  record(input, Object.keys(spec.fields));
  let refs = 0;
  for (const [key, field] of Object.entries(spec.fields)) {
    const value = input[key];
    if (field.type === 'secret') {
      record(value, ['$secret']);
      if (
        Object.keys(value).length !== 1 ||
        value.$secret !== field.name ||
        ++refs > LIMITS.references
      )
        fail('INPUT_INVALID');
    } else if (field.type === 'string') text(value, field.maxBytes);
    else if (field.type === 'integer') {
      if (!Number.isSafeInteger(value)) fail('INPUT_INVALID');
    } else if (typeof value !== 'boolean') fail('INPUT_INVALID');
  }
  return input;
}
export function resolveInput(
  spec: ActionSpec,
  input: Record<string, unknown>,
  secrets: Record<string, SecretRecord>,
): Buffer {
  const data: Record<string, unknown> = Object.create(null);
  const credentials: Record<string, string> = Object.create(null);
  for (const [key, field] of Object.entries(spec.fields))
    data[key] =
      field.type === 'secret' ? secrets[field.name]?.value : input[key];
  for (const [key, n] of Object.entries(spec.credentials))
    credentials[key] = secrets[n]?.value ?? fail('SECRET_UNAVAILABLE');
  const result = Buffer.from(
    JSON.stringify({ data, credentials, fixed: spec.fixed }),
  );
  if (result.length > LIMITS.resolved) {
    result.fill(0);
    fail('INPUT_INVALID');
  }
  return result;
}
