import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ProjectKind,
  type ProjectProfile,
  primaryUiLibrary,
} from '../system/project-profile.js';
import { type Ulid, assertUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export interface ProjectFactsV1 {
  schemaVersion: 1;
  revision: number;
  trust: 'detected';
  profile: ProjectProfile;
  uiLibrary: string | null;
  detectedAt: string;
  lastOperationId: Ulid | null;
}

const PROJECT_KINDS = new Set<ProjectKind>([
  'backend',
  'web',
  'mobile',
  'desktop',
  'cli',
  'library',
  'data',
  'mixed',
  'unknown',
]);
const UI_ASSET_VALUES = new Set<ProjectProfile['uiAssets']>([
  'none',
  'detected',
]);
const BROWSER_AUTOMATION_VALUES = new Set<ProjectProfile['browserAutomation']>([
  'available',
  'unavailable',
  'unknown',
]);
const CONFIDENCE_VALUES = new Set<ProjectProfile['confidence']>([
  'high',
  'medium',
  'low',
]);

export function createProjectFacts(
  profile: ProjectProfile,
  options: {
    revision?: number;
    now?: Date;
    operationId?: Ulid | null;
  } = {},
): ProjectFactsV1 {
  const facts: ProjectFactsV1 = {
    schemaVersion: 1,
    revision: options.revision ?? 1,
    trust: 'detected',
    profile: parseProjectProfile(profile),
    uiLibrary: primaryUiLibrary(profile),
    detectedAt: (options.now ?? new Date()).toISOString(),
    lastOperationId: options.operationId ?? null,
  };
  return parseProjectFacts(facts);
}

export function unknownProjectFacts(
  options: {
    now?: Date;
    operationId?: Ulid | null;
  } = {},
): ProjectFactsV1 {
  return createProjectFacts(
    {
      version: '1.0',
      projectKind: 'unknown',
      languages: [],
      frameworks: [],
      sourceRoots: [],
      manifests: [],
      availableValidation: [],
      uiAssets: 'none',
      browserAutomation: 'unknown',
      confidence: 'low',
    },
    options,
  );
}

export function parseProjectFacts(value: unknown): ProjectFactsV1 {
  assertRecord(value, 'project facts');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'revision',
      'trust',
      'profile',
      'uiLibrary',
      'detectedAt',
      'lastOperationId',
    ],
    'project facts',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('project facts schemaVersion must be 1');
  }
  const revision = value.revision;
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error('project facts revision must be a positive integer');
  }
  if (value.trust !== 'detected') {
    throw new Error('project facts trust must be detected');
  }
  const uiLibrary = parseTextOrNull(value.uiLibrary, 'project facts uiLibrary');
  return {
    schemaVersion: 1,
    revision,
    trust: 'detected',
    profile: parseProjectProfile(value.profile),
    uiLibrary,
    detectedAt: parseTimestamp(value.detectedAt, 'project facts detectedAt'),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'project facts lastOperationId',
    ),
  };
}

export function projectFactsPath(projectRoot: string): string {
  return path.join(
    path.resolve(projectRoot),
    '.mancode',
    'shared',
    'context',
    'project.json',
  );
}

export async function readProjectFacts(
  projectRoot: string,
): Promise<ProjectFactsV1 | null> {
  try {
    return parseProjectFacts(
      JSON.parse(await readFile(projectFactsPath(projectRoot), 'utf8')),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof SyntaxError) {
      throw new Error(
        'MANCODE_CONTEXT_ENTITY_CORRUPT: shared/context/project.json',
      );
    }
    throw error;
  }
}

/** Facts are detected/rebuildable, so a refresh safely replaces the whole record. */
export async function writeProjectFacts(
  projectRoot: string,
  facts: ProjectFactsV1,
): Promise<ProjectFactsV1> {
  const parsed = parseProjectFacts(facts);
  const target = projectFactsPath(projectRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return parsed;
}

function parseProjectProfile(value: unknown): ProjectProfile {
  assertRecord(value, 'project facts profile');
  assertKnownKeys(
    value,
    [
      'version',
      'projectKind',
      'languages',
      'frameworks',
      'sourceRoots',
      'manifests',
      'availableValidation',
      'uiAssets',
      'browserAutomation',
      'confidence',
    ],
    'project facts profile',
  );
  if (value.version !== '1.0') {
    throw new Error('project facts profile version must be 1.0');
  }
  if (
    typeof value.projectKind !== 'string' ||
    !PROJECT_KINDS.has(value.projectKind as ProjectKind)
  ) {
    throw new Error('project facts profile projectKind is invalid');
  }
  if (
    typeof value.uiAssets !== 'string' ||
    !UI_ASSET_VALUES.has(value.uiAssets as ProjectProfile['uiAssets'])
  ) {
    throw new Error('project facts profile uiAssets is invalid');
  }
  if (
    typeof value.browserAutomation !== 'string' ||
    !BROWSER_AUTOMATION_VALUES.has(
      value.browserAutomation as ProjectProfile['browserAutomation'],
    )
  ) {
    throw new Error('project facts profile browserAutomation is invalid');
  }
  if (
    typeof value.confidence !== 'string' ||
    !CONFIDENCE_VALUES.has(value.confidence as ProjectProfile['confidence'])
  ) {
    throw new Error('project facts profile confidence is invalid');
  }
  return {
    version: '1.0',
    projectKind: value.projectKind as ProjectKind,
    languages: parseTextArray(
      value.languages,
      'project facts profile languages',
    ),
    frameworks: parseTextArray(
      value.frameworks,
      'project facts profile frameworks',
    ),
    sourceRoots: parseSafeRelativePathArray(
      value.sourceRoots,
      'project facts profile sourceRoots',
    ),
    manifests: parseSafeRelativePathArray(
      value.manifests,
      'project facts profile manifests',
    ),
    availableValidation: parseTextArray(
      value.availableValidation,
      'project facts profile availableValidation',
    ),
    uiAssets: value.uiAssets as ProjectProfile['uiAssets'],
    browserAutomation:
      value.browserAutomation as ProjectProfile['browserAutomation'],
    confidence: value.confidence as ProjectProfile['confidence'],
  };
}

function parseTextArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => parseText(item, label));
}

function parseSafeRelativePathArray(value: unknown, label: string): string[] {
  return parseTextArray(value, label).map((item) => {
    if (
      path.isAbsolute(item) ||
      item.includes('\\') ||
      item.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`${label} must contain safe relative paths`);
    }
    return item;
  });
}

function parseText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must contain non-empty text`);
  }
  assertSharedTextSafe(value, label);
  return value;
}

function parseTextOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  return parseText(value, label);
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
