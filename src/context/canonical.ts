import { createHash } from 'node:crypto';

export const CANONICALIZATION_VERSION = 'mancode-jcs-v1';

export type CanonicalNumberPolicy = 'safe-integer' | 'finite';

export interface CanonicalizationOptions {
  numberPolicy?: CanonicalNumberPolicy;
}

/**
 * RFC 8785-compatible JSON serialization for values that have already passed
 * their entity schema. Schema parsers own field allowlists; this layer rejects
 * non-JSON and unsafe scalar values before hashing.
 */
export function canonicalizeJson(
  value: unknown,
  options: CanonicalizationOptions = {},
): string {
  return canonicalizeValue(value, options.numberPolicy ?? 'safe-integer');
}

export function digestCanonicalJson(
  value: unknown,
  options: CanonicalizationOptions = {},
): string {
  const canonical = canonicalizeJson(value, options);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Collection fields in the V3 contracts are deduplicated and ordered by UTF-8 bytes. */
export function sortUtf8StringSet(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    assertCanonicalString(value, 'set item');
    unique.add(value);
  }
  return [...unique].sort((left, right) =>
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );
}

function canonicalizeValue(
  value: unknown,
  numberPolicy: CanonicalNumberPolicy,
): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    assertCanonicalString(value, 'string');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(
        'canonical JSON numbers must be finite and must not be negative zero',
      );
    }
    if (numberPolicy === 'safe-integer' && !Number.isSafeInteger(value)) {
      throw new Error(
        'canonical JSON numbers must be safe integers for this schema',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertCanonicalArray(value);
    return `[${value
      .map((item) => canonicalizeValue(item, numberPolicy))
      .join(',')}]`;
  }
  if (isPlainObject(value)) {
    assertCanonicalObject(value);
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        assertCanonicalString(key, 'object key');
        return `${JSON.stringify(key)}:${canonicalizeValue(value[key], numberPolicy)}`;
      })
      .join(',')}}`;
  }
  throw new Error('canonical JSON only accepts plain JSON values');
}

/** Sparse arrays and hidden/symbol properties are not JSON values. */
function assertCanonicalArray(value: unknown[]): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error('canonical JSON arrays must not be sparse');
    }
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.some((key) => !/^(0|[1-9]\d*)$/.test(key))) {
    throw new Error('canonical JSON arrays must not have non-index properties');
  }
  if (
    Object.getOwnPropertyNames(value).some(
      (key) => key !== 'length' && !ownKeys.includes(key),
    ) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error('canonical JSON arrays must not have hidden properties');
  }
}

function assertCanonicalObject(value: Record<string, unknown>): void {
  const ownKeys = Object.keys(value);
  if (
    Object.getOwnPropertyNames(value).some((key) => !ownKeys.includes(key)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new Error('canonical JSON objects must not have hidden properties');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCanonicalString(value: string, label: string): void {
  if (value.includes('\0')) {
    throw new Error(`canonical JSON ${label} must not contain NUL`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue;
    const next = value.charCodeAt(index + 1);
    const isHigh = codeUnit <= 0xdbff;
    const isLowNext = next >= 0xdc00 && next <= 0xdfff;
    if (!isHigh || !isLowNext) {
      throw new Error(
        `canonical JSON ${label} must not contain a lone surrogate`,
      );
    }
    index += 1;
  }
}
