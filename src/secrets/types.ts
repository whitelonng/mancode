export const LIMITS = {
  secret: 16 * 1024,
  input: 64 * 1024,
  resolved: 256 * 1024,
  depth: 16,
  references: 16,
  output: 256 * 1024,
  vault: 8 * 1024 * 1024,
} as const;
export type SecretCode =
  | 'KEYSTORE_UNAVAILABLE'
  | 'SECRET_UNAVAILABLE'
  | 'ACTION_NOT_APPROVED'
  | 'ACTION_CHANGED'
  | 'INPUT_INVALID'
  | 'EXECUTOR_FAILED'
  | 'EXECUTOR_TIMEOUT'
  | 'CANCELLED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'OUTPUT_LIMIT'
  | 'STORAGE_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED';
export class SecretError extends Error {
  constructor(
    readonly code: SecretCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
export function fail(code: SecretCode): never {
  throw new SecretError(code);
}
export function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].includes(value)
  )
    fail('INPUT_INVALID');
  return value;
}
export function record(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail('INPUT_INVALID');
}
export function text(value: unknown, max = 1024): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.includes('\0') ||
    Buffer.byteLength(value) > max ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    fail('INPUT_INVALID');
  return value;
}
export type SecretType =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'account'
  | 'password'
  | 'api-key'
  | 'text';
export const SECRET_TYPES: readonly SecretType[] = [
  'email',
  'phone',
  'name',
  'address',
  'account',
  'password',
  'api-key',
  'text',
];
export interface SecretRecord {
  entryId: string;
  revision: number;
  name: string;
  type: SecretType;
  description: string;
  value: string;
}
export type Field =
  | { type: 'string'; maxBytes: number }
  | { type: 'integer' | 'boolean' }
  | { type: 'secret'; name: string };
export interface ActionSpec {
  schemaVersion: 1;
  name: string;
  version: string;
  executable: string;
  packagePath: string;
  entry: string;
  fields: Record<string, Field>;
  credentials: Record<string, string>;
  fixed: Record<string, string>;
  target: string;
  effects: string;
  output: 'status-only';
  timeoutMs: number;
  outputBytes: number;
}
export interface ApprovedAction {
  spec: ActionSpec;
  revision: number;
  workspaceId: string;
  installId: string;
  executableDigest: string;
  runtimeFiles: Record<string, string>;
  files: Record<string, string>;
  bindings: Record<string, { entryId: string; revision: number }>;
}
export interface Receipt {
  schemaVersion: 1;
  runId: string;
  action: string;
  status: 'executor_succeeded' | 'outcome_unknown' | 'rejected';
  code?: SecretCode;
}
