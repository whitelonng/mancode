import { digestCanonicalJson, sortUtf8StringSet } from './canonical.js';
import { type Ulid, assertUlid } from './ids.js';
import { assertSharedTextSafe } from './privacy.js';
import { type TaskRef, parseTaskRefValue, sameTaskRef } from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type VerificationRequirement = 'automated' | 'manual' | 'hybrid';
export type RequirementCoverageStatus =
  | 'confirmed'
  | 'defaulted'
  | 'not_applicable';
export type RequirementDimension =
  | 'platform'
  | 'core_scope'
  | 'technical_stack'
  | 'data_and_persistence'
  | 'performance'
  | 'compatibility'
  | 'security';

export interface ItemIdentity {
  displayId: string;
  legacyId: string | null;
}

export interface RequirementsLedgerV1 {
  schemaVersion: 1;
  canonicalizationVersion: 'mancode-jcs-v1';
  taskRef: TaskRef;
  revision: number;
  status: 'draft' | 'confirmed';
  goal: string;
  functionalScope: {
    inScope: string[];
    outOfScope: string[];
  };
  technicalDecisions: Array<
    ItemIdentity & { decisionId: Ulid; statement: string }
  >;
  defaults: Array<ItemIdentity & { defaultId: Ulid; statement: string }>;
  coverage: Array<{
    coverageId: Ulid;
    dimension: RequirementDimension;
    status: RequirementCoverageStatus;
    rationale: string;
  }>;
  requirements: Array<
    ItemIdentity & {
      requirementId: Ulid;
      statement: string;
      priority: 'must' | 'should' | 'could';
    }
  >;
  acceptanceCriteria: Array<
    ItemIdentity & {
      criterionId: Ulid;
      requirementIds: Ulid[];
      statement: string;
      required: boolean;
      verificationRequirement: VerificationRequirement;
    }
  >;
  blockingUnknowns: Array<
    ItemIdentity & {
      unknownId: Ulid;
      statement: string;
      status: 'open' | 'resolved' | 'accepted_risk';
    }
  >;
  legacySource: {
    sourceSchema: 'requirements-v1';
    sourceDigest: string;
    fieldMapVersion: 1;
  } | null;
  contentDigest: string;
  lastOperationId: Ulid | null;
  updatedAt: string;
}

export const REQUIREMENT_DIMENSIONS: RequirementDimension[] = [
  'platform',
  'core_scope',
  'technical_stack',
  'data_and_persistence',
  'performance',
  'compatibility',
  'security',
];

const COVERAGE_STATUSES = new Set<RequirementCoverageStatus>([
  'confirmed',
  'defaulted',
  'not_applicable',
]);
const VERIFICATION_REQUIREMENTS = new Set<VerificationRequirement>([
  'automated',
  'manual',
  'hybrid',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseRequirementsLedger(value: unknown): RequirementsLedgerV1 {
  assertRecord(value, 'requirements ledger');
  assertKnownKeys(
    value,
    [
      'schemaVersion',
      'canonicalizationVersion',
      'taskRef',
      'revision',
      'status',
      'goal',
      'functionalScope',
      'technicalDecisions',
      'defaults',
      'coverage',
      'requirements',
      'acceptanceCriteria',
      'blockingUnknowns',
      'legacySource',
      'contentDigest',
      'lastOperationId',
      'updatedAt',
    ],
    'requirements ledger',
  );
  if (value.schemaVersion !== 1) {
    throw new Error('requirements ledger schemaVersion must be 1');
  }
  if (value.canonicalizationVersion !== 'mancode-jcs-v1') {
    throw new Error('requirements ledger canonicalizationVersion is invalid');
  }
  if (value.status !== 'draft' && value.status !== 'confirmed') {
    throw new Error('requirements ledger status is invalid');
  }
  const ledger: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef: parseTaskRefValue(value.taskRef),
    revision: parsePositiveInteger(
      value.revision,
      'requirements ledger revision',
    ),
    status: value.status,
    goal: parseNonEmptyString(value.goal, 'requirements ledger goal'),
    functionalScope: parseFunctionalScope(value.functionalScope),
    technicalDecisions: parseTechnicalDecisions(value.technicalDecisions),
    defaults: parseDefaults(value.defaults),
    coverage: parseCoverage(value.coverage),
    requirements: parseRequirements(value.requirements),
    acceptanceCriteria: parseAcceptanceCriteria(value.acceptanceCriteria),
    blockingUnknowns: parseBlockingUnknowns(value.blockingUnknowns),
    legacySource: parseLegacySource(value.legacySource),
    contentDigest: parseDigest(
      value.contentDigest,
      'requirements ledger contentDigest',
    ),
    lastOperationId: parseUlidOrNull(
      value.lastOperationId,
      'requirements ledger lastOperationId',
    ),
    updatedAt: parseTimestamp(value.updatedAt, 'requirements ledger updatedAt'),
  };
  assertUniqueDisplayIds(ledger);
  assertAcceptanceRequirementRefs(ledger);
  assertRequirementsPrivacy(ledger);
  if (ledger.contentDigest !== requirementsLedgerDigest(ledger)) {
    throw new Error(
      'requirements ledger contentDigest does not match canonical content',
    );
  }
  if (ledger.status === 'confirmed') assertRequirementsReady(ledger);
  return ledger;
}

export function requirementsLedgerDigest(ledger: RequirementsLedgerV1): string {
  return digestCanonicalJson({
    schemaVersion: ledger.schemaVersion,
    canonicalizationVersion: ledger.canonicalizationVersion,
    taskRef: ledger.taskRef,
    status: ledger.status,
    goal: ledger.goal,
    functionalScope: ledger.functionalScope,
    technicalDecisions: ledger.technicalDecisions,
    defaults: ledger.defaults,
    coverage: ledger.coverage,
    requirements: ledger.requirements,
    acceptanceCriteria: ledger.acceptanceCriteria,
    blockingUnknowns: ledger.blockingUnknowns,
    legacySource: ledger.legacySource,
  });
}

/**
 * Requirements are revised as a whole authority record. A confirmed record
 * may deliberately return to draft when a later edit reopens clarification,
 * so the invariant here is revision and identity, not a one-way status.
 */
export function assertRequirementsLedgerTransition(
  previous: RequirementsLedgerV1,
  next: RequirementsLedgerV1,
): void {
  if (next.revision !== previous.revision + 1) {
    throw new Error(
      'requirements ledger revision must increase exactly once per mutation',
    );
  }
  if (
    previous.schemaVersion !== next.schemaVersion ||
    previous.canonicalizationVersion !== next.canonicalizationVersion ||
    !sameTaskRef(previous.taskRef, next.taskRef)
  ) {
    throw new Error('requirements ledger schema and TaskRef are immutable');
  }
  if (previous.legacySource === null && next.legacySource !== null) {
    throw new Error('requirements ledger cannot introduce a legacy source');
  }
}

export function requirementsAreReady(ledger: RequirementsLedgerV1): boolean {
  try {
    assertRequirementsReady(ledger);
    return true;
  } catch {
    return false;
  }
}

export function assertRequirementsReady(ledger: RequirementsLedgerV1): void {
  if (!ledger.goal.trim())
    throw new Error('requirements ledger goal is required');
  if (ledger.functionalScope.inScope.length === 0) {
    throw new Error('requirements ledger requires at least one in-scope item');
  }
  if (ledger.coverage.length !== REQUIREMENT_DIMENSIONS.length) {
    throw new Error(
      'requirements ledger must cover every requirement dimension',
    );
  }
  const dimensions = new Set(ledger.coverage.map((item) => item.dimension));
  if (dimensions.size !== REQUIREMENT_DIMENSIONS.length) {
    throw new Error('requirements ledger coverage dimensions must be unique');
  }
  for (const dimension of REQUIREMENT_DIMENSIONS) {
    if (!dimensions.has(dimension)) {
      throw new Error(`requirements ledger coverage is missing ${dimension}`);
    }
  }
  const technicalStack = ledger.coverage.find(
    (item) => item.dimension === 'technical_stack',
  );
  if (
    technicalStack?.status !== 'not_applicable' &&
    ledger.technicalDecisions.length === 0
  ) {
    throw new Error(
      'requirements ledger technicalDecisions are required when technical_stack applies',
    );
  }
  if (ledger.acceptanceCriteria.length === 0) {
    throw new Error('requirements ledger requires acceptance criteria');
  }
  if (!ledger.acceptanceCriteria.some((criterion) => criterion.required)) {
    throw new Error(
      'requirements ledger requires at least one required acceptance criterion',
    );
  }
  if (ledger.blockingUnknowns.some((unknown) => unknown.status === 'open')) {
    throw new Error('requirements ledger has unresolved blocking unknowns');
  }
}

function assertRequirementsPrivacy(ledger: RequirementsLedgerV1): void {
  if (ledger.taskRef.namespace !== 'shared') return;
  const values = [
    ['goal', ledger.goal],
    ...ledger.functionalScope.inScope.map(
      (value, index) => [`functionalScope.inScope[${index}]`, value] as const,
    ),
    ...ledger.functionalScope.outOfScope.map(
      (value, index) =>
        [`functionalScope.outOfScope[${index}]`, value] as const,
    ),
    ...ledger.technicalDecisions.map(
      (item, index) =>
        [`technicalDecisions[${index}]`, item.statement] as const,
    ),
    ...ledger.defaults.map(
      (item, index) => [`defaults[${index}]`, item.statement] as const,
    ),
    ...ledger.coverage.map(
      (item, index) => [`coverage[${index}]`, item.rationale] as const,
    ),
    ...ledger.requirements.map(
      (item, index) => [`requirements[${index}]`, item.statement] as const,
    ),
    ...ledger.acceptanceCriteria.map(
      (item, index) =>
        [`acceptanceCriteria[${index}]`, item.statement] as const,
    ),
    ...ledger.blockingUnknowns.map(
      (item, index) => [`blockingUnknowns[${index}]`, item.statement] as const,
    ),
  ];
  for (const [label, value] of values) {
    assertSharedTextSafe(value, `requirements ledger ${label}`);
  }
}

function parseFunctionalScope(
  value: unknown,
): RequirementsLedgerV1['functionalScope'] {
  assertRecord(value, 'requirements ledger functionalScope');
  assertKnownKeys(
    value,
    ['inScope', 'outOfScope'],
    'requirements ledger functionalScope',
  );
  return {
    inScope: parseStringList(
      value.inScope,
      'requirements ledger functionalScope inScope',
    ),
    outOfScope: parseStringList(
      value.outOfScope,
      'requirements ledger functionalScope outOfScope',
    ),
  };
}

function parseTechnicalDecisions(
  value: unknown,
): RequirementsLedgerV1['technicalDecisions'] {
  if (!Array.isArray(value)) {
    throw new Error('requirements ledger technicalDecisions must be an array');
  }
  return value.map((item) => {
    const identity = parseItemIdentity(
      item,
      'requirements ledger technical decision',
    );
    assertRecord(item, 'requirements ledger technical decision');
    assertKnownKeys(
      item,
      ['displayId', 'legacyId', 'decisionId', 'statement'],
      'requirements ledger technical decision',
    );
    assertUlid(item.decisionId, 'requirements ledger decisionId');
    return {
      ...identity,
      decisionId: item.decisionId,
      statement: parseNonEmptyString(
        item.statement,
        'requirements ledger technical decision statement',
      ),
    };
  });
}

function parseDefaults(value: unknown): RequirementsLedgerV1['defaults'] {
  if (!Array.isArray(value))
    throw new Error('requirements ledger defaults must be an array');
  return value.map((item) => {
    const identity = parseItemIdentity(item, 'requirements ledger default');
    assertRecord(item, 'requirements ledger default');
    assertKnownKeys(
      item,
      ['displayId', 'legacyId', 'defaultId', 'statement'],
      'requirements ledger default',
    );
    assertUlid(item.defaultId, 'requirements ledger defaultId');
    return {
      ...identity,
      defaultId: item.defaultId,
      statement: parseNonEmptyString(
        item.statement,
        'requirements ledger default statement',
      ),
    };
  });
}

function parseCoverage(value: unknown): RequirementsLedgerV1['coverage'] {
  if (!Array.isArray(value))
    throw new Error('requirements ledger coverage must be an array');
  const dimensions = new Set<string>();
  return value.map((item) => {
    assertRecord(item, 'requirements ledger coverage item');
    assertKnownKeys(
      item,
      ['coverageId', 'dimension', 'status', 'rationale'],
      'requirements ledger coverage item',
    );
    assertUlid(item.coverageId, 'requirements ledger coverageId');
    if (!isRequirementDimension(item.dimension)) {
      throw new Error('requirements ledger coverage dimension is invalid');
    }
    if (dimensions.has(item.dimension)) {
      throw new Error('requirements ledger coverage dimensions must be unique');
    }
    dimensions.add(item.dimension);
    if (
      typeof item.status !== 'string' ||
      !COVERAGE_STATUSES.has(item.status as RequirementCoverageStatus)
    ) {
      throw new Error('requirements ledger coverage status is invalid');
    }
    return {
      coverageId: item.coverageId,
      dimension: item.dimension,
      status: item.status as RequirementCoverageStatus,
      rationale: parseNonEmptyString(
        item.rationale,
        'requirements ledger coverage rationale',
      ),
    };
  });
}

function parseRequirements(
  value: unknown,
): RequirementsLedgerV1['requirements'] {
  if (!Array.isArray(value))
    throw new Error('requirements ledger requirements must be an array');
  return value.map((item) => {
    const identity = parseItemIdentity(item, 'requirements ledger requirement');
    assertRecord(item, 'requirements ledger requirement');
    assertKnownKeys(
      item,
      ['displayId', 'legacyId', 'requirementId', 'statement', 'priority'],
      'requirements ledger requirement',
    );
    assertUlid(item.requirementId, 'requirements ledger requirementId');
    if (
      item.priority !== 'must' &&
      item.priority !== 'should' &&
      item.priority !== 'could'
    ) {
      throw new Error('requirements ledger requirement priority is invalid');
    }
    return {
      ...identity,
      requirementId: item.requirementId,
      statement: parseNonEmptyString(
        item.statement,
        'requirements ledger requirement statement',
      ),
      priority: item.priority,
    };
  });
}

function parseAcceptanceCriteria(
  value: unknown,
): RequirementsLedgerV1['acceptanceCriteria'] {
  if (!Array.isArray(value)) {
    throw new Error('requirements ledger acceptanceCriteria must be an array');
  }
  return value.map((item) => {
    const identity = parseItemIdentity(
      item,
      'requirements ledger acceptance criterion',
    );
    assertRecord(item, 'requirements ledger acceptance criterion');
    assertKnownKeys(
      item,
      [
        'displayId',
        'legacyId',
        'criterionId',
        'requirementIds',
        'statement',
        'required',
        'verificationRequirement',
      ],
      'requirements ledger acceptance criterion',
    );
    assertUlid(item.criterionId, 'requirements ledger criterionId');
    if (typeof item.required !== 'boolean') {
      throw new Error('requirements ledger criterion required must be boolean');
    }
    if (
      typeof item.verificationRequirement !== 'string' ||
      !VERIFICATION_REQUIREMENTS.has(
        item.verificationRequirement as VerificationRequirement,
      )
    ) {
      throw new Error(
        'requirements ledger criterion verificationRequirement is invalid',
      );
    }
    return {
      ...identity,
      criterionId: item.criterionId,
      requirementIds: parseUlidSet(
        item.requirementIds,
        'requirements ledger criterion requirementIds',
      ),
      statement: parseNonEmptyString(
        item.statement,
        'requirements ledger criterion statement',
      ),
      required: item.required,
      verificationRequirement:
        item.verificationRequirement as VerificationRequirement,
    };
  });
}

function parseBlockingUnknowns(
  value: unknown,
): RequirementsLedgerV1['blockingUnknowns'] {
  if (!Array.isArray(value)) {
    throw new Error('requirements ledger blockingUnknowns must be an array');
  }
  return value.map((item) => {
    const identity = parseItemIdentity(
      item,
      'requirements ledger blocking unknown',
    );
    assertRecord(item, 'requirements ledger blocking unknown');
    assertKnownKeys(
      item,
      ['displayId', 'legacyId', 'unknownId', 'statement', 'status'],
      'requirements ledger blocking unknown',
    );
    assertUlid(item.unknownId, 'requirements ledger unknownId');
    if (
      item.status !== 'open' &&
      item.status !== 'resolved' &&
      item.status !== 'accepted_risk'
    ) {
      throw new Error('requirements ledger blocking unknown status is invalid');
    }
    return {
      ...identity,
      unknownId: item.unknownId,
      statement: parseNonEmptyString(
        item.statement,
        'requirements ledger unknown statement',
      ),
      status: item.status,
    };
  });
}

function parseItemIdentity(value: unknown, label: string): ItemIdentity {
  assertRecord(value, label);
  if (typeof value.displayId !== 'string' || !value.displayId.trim()) {
    throw new Error(`${label} displayId is required`);
  }
  if (
    value.legacyId !== null &&
    (typeof value.legacyId !== 'string' || !value.legacyId.trim())
  ) {
    throw new Error(`${label} legacyId must be a non-empty string or null`);
  }
  return { displayId: value.displayId, legacyId: value.legacyId };
}

function parseLegacySource(
  value: unknown,
): RequirementsLedgerV1['legacySource'] {
  if (value === null) return null;
  assertRecord(value, 'requirements ledger legacySource');
  assertKnownKeys(
    value,
    ['sourceSchema', 'sourceDigest', 'fieldMapVersion'],
    'requirements ledger legacySource',
  );
  if (value.sourceSchema !== 'requirements-v1' || value.fieldMapVersion !== 1) {
    throw new Error('requirements ledger legacySource is invalid');
  }
  return {
    sourceSchema: 'requirements-v1',
    sourceDigest: parseDigest(
      value.sourceDigest,
      'requirements ledger legacySource sourceDigest',
    ),
    fieldMapVersion: 1,
  };
}

function assertUniqueDisplayIds(ledger: RequirementsLedgerV1): void {
  const displayIds = new Set<string>();
  const groups: Array<Array<ItemIdentity>> = [
    ledger.technicalDecisions,
    ledger.defaults,
    ledger.requirements,
    ledger.acceptanceCriteria,
    ledger.blockingUnknowns,
  ];
  for (const group of groups) {
    for (const item of group) {
      if (displayIds.has(item.displayId)) {
        throw new Error(
          'requirements ledger displayIds must be unique within a task',
        );
      }
      displayIds.add(item.displayId);
    }
  }
}

function assertAcceptanceRequirementRefs(ledger: RequirementsLedgerV1): void {
  const requirementIds = new Set(
    ledger.requirements.map((item) => item.requirementId),
  );
  for (const criterion of ledger.acceptanceCriteria) {
    for (const requirementId of criterion.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        throw new Error(
          'requirements ledger criterion references an unknown requirementId',
        );
      }
    }
  }
}

function parseStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (seen.has(item)) throw new Error(`${label} must not contain duplicates`);
    seen.add(item);
  }
  return [...value] as string[];
}

function parseUlidSet(value: unknown, label: string): Ulid[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) assertUlid(item, label);
  const normalized = sortUtf8StringSet(value);
  if (normalized.length !== value.length)
    throw new Error(`${label} must not contain duplicates`);
  return normalized as Ulid[];
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseUlidOrNull(value: unknown, label: string): Ulid | null {
  if (value === null) return null;
  assertUlid(value, label);
  return value;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} is required`);
  return value;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function isRequirementDimension(value: unknown): value is RequirementDimension {
  return (
    typeof value === 'string' &&
    REQUIREMENT_DIMENSIONS.includes(value as RequirementDimension)
  );
}
