import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { resolveCoordinationEntityHomeStore } from '../runtime/entity-home-store.js';
import { acquireEntityLocks } from '../runtime/local-lock.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { digestCanonicalJson } from './canonical.js';
import { type Ulid, assertUlid, createUlid } from './ids.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type DesignPreset = 'preserve' | 'refine' | 'experimental';
export type DesignIconPolicy = 'existing-first' | 'lucide';
export type DesignEmojiPolicy = 'allow' | 'forbid-as-interface-icon';
export type DesignMotionPolicy = 'minimal' | 'purposeful';
export type DesignBrowserValidation = 'off' | 'when-available' | 'required';

export interface DesignPolicyV1 {
  schemaVersion: 1;
  revision: number;
  enabled: boolean;
  preset: DesignPreset;
  iconPolicy: DesignIconPolicy;
  emojiPolicy: DesignEmojiPolicy;
  motionPolicy: DesignMotionPolicy;
  browserValidation: DesignBrowserValidation;
  lastOperationId: Ulid | null;
  updatedAt: string;
}

export interface ConfigureDesignPolicyInput {
  projectRoot: string;
  expectedRevision: number;
  enabled?: boolean;
  confirmExperimental?: boolean;
  preset?: DesignPreset;
  iconPolicy?: DesignIconPolicy;
  emojiPolicy?: DesignEmojiPolicy;
  motionPolicy?: DesignMotionPolicy;
  browserValidation?: DesignBrowserValidation;
  operationId?: Ulid;
  now?: Date;
}

export const DEFAULT_DESIGN_POLICY: Readonly<DesignPolicyV1> = {
  schemaVersion: 1,
  revision: 0,
  enabled: false,
  preset: 'preserve',
  iconPolicy: 'existing-first',
  emojiPolicy: 'forbid-as-interface-icon',
  motionPolicy: 'purposeful',
  browserValidation: 'when-available',
  lastOperationId: null,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export function designPolicyPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'shared',
    'context',
    'design-policy.json',
  );
}

export function parseDesignPolicy(value: unknown): DesignPolicyV1 {
  assertRecord(value, 'design policy');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'revision',
      'enabled',
      'preset',
      'iconPolicy',
      'emojiPolicy',
      'motionPolicy',
      'browserValidation',
      'lastOperationId',
      'updatedAt',
    ],
    'design policy',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('design policy schemaVersion must be 1');
  }
  if (!isPositiveInteger(value.revision)) {
    throw new Error('design policy revision must be a positive integer');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('design policy enabled must be boolean');
  }
  if (!isDesignPreset(value.preset)) {
    throw new Error('design policy preset is invalid');
  }
  if (!isDesignIconPolicy(value.iconPolicy)) {
    throw new Error('design policy iconPolicy is invalid');
  }
  if (!isDesignEmojiPolicy(value.emojiPolicy)) {
    throw new Error('design policy emojiPolicy is invalid');
  }
  if (!isDesignMotionPolicy(value.motionPolicy)) {
    throw new Error('design policy motionPolicy is invalid');
  }
  if (!isDesignBrowserValidation(value.browserValidation)) {
    throw new Error('design policy browserValidation is invalid');
  }
  if (value.lastOperationId !== null) {
    assertUlid(value.lastOperationId, 'design policy lastOperationId');
  }
  if (
    typeof value.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new Error('design policy updatedAt must be a timestamp');
  }
  return {
    schemaVersion: 1,
    revision: value.revision,
    enabled: value.enabled,
    preset: value.preset,
    iconPolicy: value.iconPolicy,
    emojiPolicy: value.emojiPolicy,
    motionPolicy: value.motionPolicy,
    browserValidation: value.browserValidation,
    lastOperationId: value.lastOperationId,
    updatedAt: value.updatedAt,
  };
}

export async function readDesignPolicy(
  projectRoot: string,
): Promise<DesignPolicyV1 | null> {
  try {
    return parseDesignPolicy(
      JSON.parse(await readFile(designPolicyPath(projectRoot), 'utf8')),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error(
        'MANCODE_CONTEXT_ENTITY_CORRUPT: shared/context/design-policy.json',
      );
    }
    throw error;
  }
}

export async function configureDesignPolicy(
  input: ConfigureDesignPolicyInput,
): Promise<{ policy: DesignPolicyV1; operationId: Ulid; digest: string }> {
  assertNonNegativeRevision(input.expectedRevision);
  const operationId = input.operationId ?? createUlid();
  assertUlid(operationId, 'design policy operationId');
  const now = input.now ?? new Date();
  const root = path.resolve(input.projectRoot);
  const runtime = await readProjectRuntimeContext(root);
  const store = resolveCoordinationEntityHomeStore(
    runtime.entityHomeStoreContext,
  );
  const locks = await acquireEntityLocks(store, operationId, [
    `design-policy:${runtime.workspaceId}`,
  ]);
  try {
    await assertDesignPolicyPathSafe(root);
    const current = await readDesignPolicy(root);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new Error('MANCODE_EXPECTED_REVISION_CONFLICT');
    }
    const next = parseDesignPolicy({
      ...(current ?? DEFAULT_DESIGN_POLICY),
      revision: currentRevision + 1,
      enabled: input.enabled ?? current?.enabled ?? true,
      preset: input.preset ?? current?.preset ?? DEFAULT_DESIGN_POLICY.preset,
      iconPolicy:
        input.iconPolicy ??
        current?.iconPolicy ??
        DEFAULT_DESIGN_POLICY.iconPolicy,
      emojiPolicy:
        input.emojiPolicy ??
        current?.emojiPolicy ??
        DEFAULT_DESIGN_POLICY.emojiPolicy,
      motionPolicy:
        input.motionPolicy ??
        current?.motionPolicy ??
        DEFAULT_DESIGN_POLICY.motionPolicy,
      browserValidation:
        input.browserValidation ??
        current?.browserValidation ??
        DEFAULT_DESIGN_POLICY.browserValidation,
      lastOperationId: operationId,
      updatedAt: now.toISOString(),
    });
    if (
      next.enabled &&
      next.preset === 'experimental' &&
      input.confirmExperimental !== true
    ) {
      throw new Error('MANCODE_DESIGN_EXPERIMENTAL_CONFIRMATION_REQUIRED');
    }
    await writeDesignPolicy(root, next);
    return { policy: next, operationId, digest: digestCanonicalJson(next) };
  } finally {
    await Promise.allSettled(
      [...locks].reverse().map((lock) => lock.release()),
    );
  }
}

export function isDesignPreset(value: unknown): value is DesignPreset {
  return value === 'preserve' || value === 'refine' || value === 'experimental';
}

export function isDesignIconPolicy(value: unknown): value is DesignIconPolicy {
  return value === 'existing-first' || value === 'lucide';
}

export function isDesignEmojiPolicy(
  value: unknown,
): value is DesignEmojiPolicy {
  return value === 'allow' || value === 'forbid-as-interface-icon';
}

export function isDesignMotionPolicy(
  value: unknown,
): value is DesignMotionPolicy {
  return value === 'minimal' || value === 'purposeful';
}

export function isDesignBrowserValidation(
  value: unknown,
): value is DesignBrowserValidation {
  return value === 'off' || value === 'when-available' || value === 'required';
}

async function writeDesignPolicy(
  projectRoot: string,
  policy: DesignPolicyV1,
): Promise<void> {
  const target = designPolicyPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertDesignPolicyPathSafe(projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const policyPath = designPolicyPath(root);
  const contextDir = path.dirname(policyPath);
  try {
    for (const directory of [
      path.join(root, '.mancode'),
      path.join(root, '.mancode', 'shared'),
      contextDir,
    ]) {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('MANCODE_DESIGN_POLICY_PATH_UNSAFE');
      }
    }

    const [resolvedRoot, resolvedContextDir] = await Promise.all([
      realpath(root),
      realpath(contextDir),
    ]);
    const relative = path.relative(resolvedRoot, resolvedContextDir);
    if (
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error('MANCODE_DESIGN_POLICY_PATH_UNSAFE');
    }

    try {
      const info = await lstat(policyPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error('MANCODE_DESIGN_POLICY_PATH_UNSAFE');
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'MANCODE_DESIGN_POLICY_PATH_UNSAFE'
    ) {
      throw error;
    }
    throw new Error('MANCODE_DESIGN_POLICY_PATH_UNSAFE');
  }
}

function assertNonNegativeRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('MANCODE_EXPECTED_REVISION_REQUIRED');
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
