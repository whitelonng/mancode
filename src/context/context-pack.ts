import { getEncoding } from 'js-tiktoken';
import { type ArtifactRef, parseArtifactRef } from './artifact-ref.js';
import { canonicalizeJson, digestCanonicalJson } from './canonical.js';
import { assertUlid } from './ids.js';
import { scanSharedText } from './privacy.js';
import { type TaskRef, parseTaskRefValue } from './task-ref.js';

export const CONTEXT_PACK_SCHEMA_VERSION = 2;
export const CONTEXT_PACK_TOKENIZER_ID = 'cl100k_base@tiktoken-0.7.0';
export const CONTEXT_PACK_BUDGET_ALGORITHM_VERSION = 'complete-section-v1';
export const CONTEXT_PACK_DEFAULT_BUDGETS = {
  bootstrap: 1600,
  task: 5000,
} as const;

export type ContextLevel = 'bootstrap' | 'task' | 'full';
export type ContextPurpose =
  | 'orient'
  | 'plan'
  | 'implement'
  | 'review'
  | 'verify'
  | 'handoff';
export type ContextOmissionReason =
  | 'budget'
  | 'purpose_excluded'
  | 'privacy'
  | 'unavailable';
export type ProvenanceSourceKind =
  | 'entity'
  | 'artifact'
  | 'runtime'
  | 'derived';

export interface ContextPackSnapshot {
  schemaEpoch: string;
  taskRevision: number | null;
  requirementsDigest: string | null;
  reviewDigest: string | null;
  verificationDigest: string | null;
  ownershipEpoch: number | null;
  coordinationRevision: number | null;
}

export interface ContextPackTokenCounter {
  id: typeof CONTEXT_PACK_TOKENIZER_ID;
  count(canonicalJson: string): number;
}

const fixedTokenizer = getEncoding('cl100k_base');
const FIXED_CONTEXT_PACK_TOKEN_COUNTER: ContextPackTokenCounter = {
  id: CONTEXT_PACK_TOKENIZER_ID,
  count(canonicalJson: string): number {
    return fixedTokenizer.encode(canonicalJson).length;
  },
};

/** The tokenizer is fixed by schema V2; callers cannot substitute an estimate. */
export function contextPackTokenCounter(): ContextPackTokenCounter {
  return FIXED_CONTEXT_PACK_TOKEN_COUNTER;
}

export function defaultContextPackBudget(
  level: Exclude<ContextLevel, 'full'>,
): number {
  return CONTEXT_PACK_DEFAULT_BUDGETS[level];
}

export interface ProvenanceEntry {
  targetJsonPointer: string;
  sourceKind: ProvenanceSourceKind;
  taskRef: TaskRef | null;
  artifactRef: ArtifactRef | null;
  entityKey: string | null;
  sourceRevision: number | null;
  sourceDigest: string | null;
  selectedJsonPointers: string[];
  redactions: string[];
}

export interface OmissionRecord {
  targetJsonPointer: string;
  reason: ContextOmissionReason;
  omittedCount: number;
  omittedDigest: string | null;
}

export interface ContextPackSectionInput {
  targetJsonPointer: ContextPackSectionPointer;
  value: unknown;
  provenance: ProvenanceEntry[];
  /** Required items are never removed by budget trimming. */
  required?: boolean;
}

export type ContextPackSectionPointer =
  | '/session'
  | '/actor'
  | '/project'
  | '/collaboration'
  | '/activeTask'
  | '/governance/requirements'
  | '/governance/review'
  | '/governance/verification'
  | '/parentFreshness'
  | '/latestCheckpoint'
  | '/latestHandoff'
  | '/claims'
  | '/conflicts'
  | '/capabilities'
  | '/transportFreshness';

export interface ContextPackBuildInput {
  generatedAt: string;
  level: ContextLevel;
  purpose: ContextPurpose;
  snapshot: ContextPackSnapshot;
  budgetLimit: number;
  sections: ContextPackSectionInput[];
}

export interface ContextPackV2 {
  schemaVersion: 2;
  generatedAt: string;
  packDigest: string;
  level: ContextLevel;
  purpose: ContextPurpose;
  snapshot: ContextPackSnapshot;
  budget: {
    tokenizerId: typeof CONTEXT_PACK_TOKENIZER_ID;
    algorithmVersion: typeof CONTEXT_PACK_BUDGET_ALGORITHM_VERSION;
    limit: number;
    estimated: number;
    exceededByRequiredEnvelope: boolean;
  };
  session: unknown;
  actor: unknown;
  project: unknown;
  collaboration: unknown;
  activeTask: unknown;
  governance: {
    requirements: unknown;
    review: unknown;
    verification: unknown;
  };
  parentFreshness: unknown;
  latestCheckpoint: unknown;
  latestHandoff: unknown;
  claims: unknown;
  conflicts: unknown;
  capabilities: unknown;
  transportFreshness: unknown;
  provenance: ProvenanceEntry[];
  omissions: OmissionRecord[];
}

const SECTION_ORDER: ContextPackSectionPointer[] = [
  '/session',
  '/actor',
  '/project',
  '/collaboration',
  '/activeTask',
  '/governance/requirements',
  '/governance/review',
  '/governance/verification',
  '/parentFreshness',
  '/latestCheckpoint',
  '/latestHandoff',
  '/claims',
  '/conflicts',
  '/capabilities',
  '/transportFreshness',
];

const REQUIRED_ENVELOPE = new Set<ContextPackSectionPointer>([
  '/session',
  '/activeTask',
  '/conflicts',
  '/capabilities',
  '/transportFreshness',
]);

const PURPOSE_SECTIONS: Record<
  ContextPurpose,
  Set<ContextPackSectionPointer>
> = {
  orient: new Set([
    '/session',
    '/actor',
    '/activeTask',
    '/collaboration',
    '/conflicts',
    '/capabilities',
    '/transportFreshness',
  ]),
  plan: new Set([
    '/session',
    '/actor',
    '/project',
    '/activeTask',
    '/governance/requirements',
    '/parentFreshness',
    '/conflicts',
    '/capabilities',
    '/transportFreshness',
  ]),
  implement: new Set([
    '/session',
    '/activeTask',
    '/collaboration',
    '/governance/requirements',
    '/latestCheckpoint',
    '/claims',
    '/conflicts',
    '/capabilities',
    '/transportFreshness',
  ]),
  review: new Set([
    '/session',
    '/activeTask',
    '/governance/requirements',
    '/governance/review',
    '/governance/verification',
    '/conflicts',
    '/capabilities',
    '/transportFreshness',
  ]),
  verify: new Set([
    '/session',
    '/activeTask',
    '/governance/requirements',
    '/governance/verification',
    '/governance/review',
    '/conflicts',
    '/capabilities',
    '/transportFreshness',
  ]),
  handoff: new Set([
    '/session',
    '/actor',
    '/collaboration',
    '/activeTask',
    '/governance/requirements',
    '/governance/review',
    '/governance/verification',
    '/latestCheckpoint',
    '/latestHandoff',
    '/claims',
    '/conflicts',
    '/capabilities',
    '/transportFreshness',
  ]),
};

/**
 * Builds a deterministic temporary projection from one already-consistent
 * snapshot. This function deliberately performs no entity reads; a resolver
 * must retry before calling it if revisions or digests changed during reads.
 */
export function buildContextPack(input: ContextPackBuildInput): ContextPackV2 {
  assertBuildInput(input);
  const inputs = indexSections(input.sections);
  assertRequiredEnvelope(inputs);
  assertLevelAllowsSections(input.level, inputs);
  const allowed = PURPOSE_SECTIONS[input.purpose];
  const included = new Map<
    ContextPackSectionPointer,
    ContextPackSectionInput
  >();
  const omissions: OmissionRecord[] = [];

  for (const pointer of SECTION_ORDER) {
    const section = inputs.get(pointer);
    if (section === undefined) continue;
    if (!allowed.has(pointer) && !REQUIRED_ENVELOPE.has(pointer)) {
      if (section.required === true) {
        throw new Error(
          `MANCODE_CONTEXT_REQUIRED_PURPOSE_EXCLUDED: ${pointer}`,
        );
      }
      omissions.push(omissionFor(section, 'purpose_excluded'));
      continue;
    }
    if (containsSensitiveText(section.value)) {
      omissions.push(omissionFor(section, 'privacy'));
      if (isRequiredSection(section)) {
        throw new Error(`MANCODE_CONTEXT_REQUIRED_PRIVACY_BLOCKED: ${pointer}`);
      }
      continue;
    }
    included.set(pointer, section);
  }

  while (true) {
    const candidate = assemblePack(input, included, omissions, false, 0);
    const estimated = countPack(candidate);
    if (estimated <= input.budgetLimit) {
      return finalizePack(candidate, estimated, false);
    }
    const removable = findNextRemovable(included);
    if (removable === undefined) {
      return finalizePack(candidate, estimated, true);
    }
    included.delete(removable.targetJsonPointer);
    omissions.push(omissionFor(removable, 'budget'));
  }
}

export function contextPackDigest(pack: ContextPackV2): string {
  return digestCanonicalJson(packDigestProjection(pack));
}

export function parseContextPack(value: unknown): ContextPackV2 {
  if (!isRecord(value)) throw new Error('context pack must be an object');
  const keys = [
    'schemaVersion',
    'generatedAt',
    'packDigest',
    'level',
    'purpose',
    'snapshot',
    'budget',
    'session',
    'actor',
    'project',
    'collaboration',
    'activeTask',
    'governance',
    'parentFreshness',
    'latestCheckpoint',
    'latestHandoff',
    'claims',
    'conflicts',
    'capabilities',
    'transportFreshness',
    'provenance',
    'omissions',
  ];
  assertKnownKeys(value, keys, 'context pack');
  if (value.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION) {
    throw new Error('context pack schemaVersion must be 2');
  }
  assertTimestamp(value.generatedAt, 'context pack generatedAt');
  assertContextLevel(value.level);
  assertContextPurpose(value.purpose);
  const snapshot = parseSnapshot(value.snapshot);
  const budget = parseBudget(value.budget);
  if (!Array.isArray(value.provenance) || !Array.isArray(value.omissions)) {
    throw new Error('context pack provenance and omissions must be arrays');
  }
  const provenance = value.provenance.map(parseProvenance);
  assertProvenanceIsSorted(provenance);
  const pack: ContextPackV2 = {
    schemaVersion: 2,
    generatedAt: value.generatedAt,
    packDigest: parseDigest(value.packDigest, 'context pack packDigest'),
    level: value.level,
    purpose: value.purpose,
    snapshot,
    budget,
    session: value.session,
    actor: value.actor,
    project: value.project,
    collaboration: value.collaboration,
    activeTask: value.activeTask,
    governance: parseGovernance(value.governance),
    parentFreshness: value.parentFreshness,
    latestCheckpoint: value.latestCheckpoint,
    latestHandoff: value.latestHandoff,
    claims: value.claims,
    conflicts: value.conflicts,
    capabilities: value.capabilities,
    transportFreshness: value.transportFreshness,
    provenance,
    omissions: value.omissions.map(parseOmission),
  };
  canonicalizeJson(packDigestProjection(pack));
  if (pack.packDigest !== contextPackDigest(pack)) {
    throw new Error('context pack packDigest does not match canonical content');
  }
  assertPackProvenance(pack);
  assertContextPackBudget(pack);
  assertParsedPackPurposeAndLevel(pack);
  return pack;
}

function indexSections(
  sections: ContextPackSectionInput[],
): Map<ContextPackSectionPointer, ContextPackSectionInput> {
  const indexed = new Map<ContextPackSectionPointer, ContextPackSectionInput>();
  for (const section of sections) {
    assertSection(section);
    if (indexed.has(section.targetJsonPointer)) {
      throw new Error(
        `context pack section is duplicated: ${section.targetJsonPointer}`,
      );
    }
    indexed.set(section.targetJsonPointer, {
      ...section,
      provenance: sortProvenance(section.provenance.map(parseProvenance)),
    });
  }
  return indexed;
}

function assertRequiredEnvelope(
  sections: Map<ContextPackSectionPointer, ContextPackSectionInput>,
): void {
  for (const pointer of REQUIRED_ENVELOPE) {
    const section = sections.get(pointer);
    if (section === undefined || !isRequiredSection(section)) {
      throw new Error(`context pack requires envelope section ${pointer}`);
    }
  }
}

function assertLevelAllowsSections(
  level: ContextLevel,
  sections: Map<ContextPackSectionPointer, ContextPackSectionInput>,
): void {
  if (level === 'full') {
    for (const [pointer, section] of sections) {
      if (REQUIRED_ENVELOPE.has(pointer)) continue;
      if (section.required) {
        throw new Error(`MANCODE_CONTEXT_REQUIRED_LEVEL_EXCLUDED: ${pointer}`);
      }
      throw new Error(`MANCODE_CONTEXT_FULL_ARTIFACTS_ON_DEMAND: ${pointer}`);
    }
    return;
  }
  if (level !== 'bootstrap') return;
  for (const [pointer, section] of sections) {
    if (REQUIRED_ENVELOPE.has(pointer)) continue;
    if (section.required) {
      throw new Error(`MANCODE_CONTEXT_REQUIRED_LEVEL_EXCLUDED: ${pointer}`);
    }
    throw new Error(`MANCODE_CONTEXT_LEVEL_EXCLUDED: ${pointer}`);
  }
}

function isRequiredSection(section: ContextPackSectionInput): boolean {
  return (
    REQUIRED_ENVELOPE.has(section.targetJsonPointer) ||
    section.required === true
  );
}

function findNextRemovable(
  included: Map<ContextPackSectionPointer, ContextPackSectionInput>,
): ContextPackSectionInput | undefined {
  const candidates = [...included.values()]
    .filter((section) => !isRequiredSection(section))
    .sort(
      (left, right) =>
        sectionPriority(right.targetJsonPointer) -
          sectionPriority(left.targetJsonPointer) ||
        SECTION_ORDER.indexOf(right.targetJsonPointer) -
          SECTION_ORDER.indexOf(left.targetJsonPointer),
    );
  return candidates[0];
}

function assemblePack(
  input: ContextPackBuildInput,
  included: Map<ContextPackSectionPointer, ContextPackSectionInput>,
  omissions: OmissionRecord[],
  exceededByRequiredEnvelope: boolean,
  estimated: number,
): ContextPackV2 {
  const valueFor = (pointer: ContextPackSectionPointer): unknown =>
    included.get(pointer)?.value ?? defaultSectionValue(pointer);
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    packDigest: '',
    level: input.level,
    purpose: input.purpose,
    snapshot: input.snapshot,
    budget: {
      tokenizerId: CONTEXT_PACK_TOKENIZER_ID,
      algorithmVersion: CONTEXT_PACK_BUDGET_ALGORITHM_VERSION,
      limit: input.budgetLimit,
      estimated,
      exceededByRequiredEnvelope,
    },
    session: valueFor('/session'),
    actor: valueFor('/actor'),
    project: valueFor('/project'),
    collaboration: valueFor('/collaboration'),
    activeTask: valueFor('/activeTask'),
    governance: {
      requirements: valueFor('/governance/requirements'),
      review: valueFor('/governance/review'),
      verification: valueFor('/governance/verification'),
    },
    parentFreshness: valueFor('/parentFreshness'),
    latestCheckpoint: valueFor('/latestCheckpoint'),
    latestHandoff: valueFor('/latestHandoff'),
    claims: valueFor('/claims'),
    conflicts: valueFor('/conflicts'),
    capabilities: valueFor('/capabilities'),
    transportFreshness: valueFor('/transportFreshness'),
    provenance: sortProvenance(
      [snapshotProvenance(input.snapshot)].concat(
        SECTION_ORDER.flatMap(
          (pointer) => included.get(pointer)?.provenance ?? [],
        ),
      ),
    ),
    omissions: sortOmissions(omissions),
  };
}

function finalizePack(
  base: ContextPackV2,
  estimated: number,
  exceededByRequiredEnvelope: boolean,
): ContextPackV2 {
  let candidate = {
    ...base,
    budget: { ...base.budget, estimated, exceededByRequiredEnvelope },
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nextEstimated = countPack(candidate);
    if (nextEstimated === candidate.budget.estimated) break;
    candidate = {
      ...candidate,
      budget: { ...candidate.budget, estimated: nextEstimated },
    };
  }
  return { ...candidate, packDigest: contextPackDigest(candidate) };
}

function countPack(pack: ContextPackV2): number {
  const count = FIXED_CONTEXT_PACK_TOKEN_COUNTER.count(
    canonicalizeJson(packDigestProjection(pack)),
  );
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      'context pack token counter must return a non-negative safe integer',
    );
  }
  return count;
}

function packDigestProjection(
  pack: ContextPackV2,
): Omit<ContextPackV2, 'generatedAt' | 'packDigest'> {
  const {
    generatedAt: _generatedAt,
    packDigest: _packDigest,
    ...projection
  } = pack;
  return projection;
}

function omissionFor(
  section: ContextPackSectionInput,
  reason: ContextOmissionReason,
): OmissionRecord {
  return {
    targetJsonPointer: section.targetJsonPointer,
    reason,
    omittedCount: countOmittedItems(section.value),
    omittedDigest: digestCanonicalJson(section.value),
  };
}

function countOmittedItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 1;
}

function defaultSectionValue(pointer: ContextPackSectionPointer): unknown {
  return pointer === '/claims' || pointer === '/conflicts' ? [] : null;
}

function sectionPriority(pointer: ContextPackSectionPointer): number {
  return SECTION_ORDER.indexOf(pointer);
}

function containsSensitiveText(value: unknown): boolean {
  if (typeof value === 'string') return scanSharedText(value).length > 0;
  if (Array.isArray(value))
    return value.some((item) => containsSensitiveText(item));
  if (isRecord(value)) {
    return Object.values(value).some((item) => containsSensitiveText(item));
  }
  return false;
}

function assertBuildInput(input: ContextPackBuildInput): void {
  assertTimestamp(input.generatedAt, 'context pack generatedAt');
  assertContextLevel(input.level);
  assertContextPurpose(input.purpose);
  parseSnapshot(input.snapshot);
  if (!Number.isSafeInteger(input.budgetLimit) || input.budgetLimit < 0) {
    throw new Error(
      'context pack budgetLimit must be a non-negative safe integer',
    );
  }
  if (input.level === 'bootstrap' && input.purpose !== 'orient') {
    throw new Error('MANCODE_CONTEXT_BOOTSTRAP_REQUIRES_ORIENT');
  }
  if (!Array.isArray(input.sections)) {
    throw new Error('context pack sections must be an array');
  }
}

function assertSection(section: ContextPackSectionInput): void {
  if (!SECTION_ORDER.includes(section.targetJsonPointer)) {
    throw new Error('context pack section targetJsonPointer is invalid');
  }
  if (!Array.isArray(section.provenance) || section.provenance.length === 0) {
    throw new Error(
      `context pack section requires provenance: ${section.targetJsonPointer}`,
    );
  }
  canonicalizeJson(section.value);
  for (const provenance of section.provenance) {
    const parsed = parseProvenance(provenance);
    if (parsed.targetJsonPointer !== section.targetJsonPointer) {
      throw new Error(
        'context pack provenance must target its section pointer',
      );
    }
  }
}

function parseSnapshot(value: unknown): ContextPackSnapshot {
  if (!isRecord(value))
    throw new Error('context pack snapshot must be an object');
  assertKnownKeys(
    value,
    [
      'schemaEpoch',
      'taskRevision',
      'requirementsDigest',
      'reviewDigest',
      'verificationDigest',
      'ownershipEpoch',
      'coordinationRevision',
    ],
    'context pack snapshot',
  );
  assertUlid(value.schemaEpoch, 'context pack snapshot schemaEpoch');
  return {
    schemaEpoch: value.schemaEpoch,
    taskRevision: parsePositiveIntegerOrNull(
      value.taskRevision,
      'taskRevision',
    ),
    requirementsDigest: parseDigestOrNull(
      value.requirementsDigest,
      'requirementsDigest',
    ),
    reviewDigest: parseDigestOrNull(value.reviewDigest, 'reviewDigest'),
    verificationDigest: parseDigestOrNull(
      value.verificationDigest,
      'verificationDigest',
    ),
    ownershipEpoch: parseNonNegativeIntegerOrNull(
      value.ownershipEpoch,
      'ownershipEpoch',
    ),
    coordinationRevision: parseNonNegativeIntegerOrNull(
      value.coordinationRevision,
      'coordinationRevision',
    ),
  };
}

function parseBudget(value: unknown): ContextPackV2['budget'] {
  if (!isRecord(value))
    throw new Error('context pack budget must be an object');
  assertKnownKeys(
    value,
    [
      'tokenizerId',
      'algorithmVersion',
      'limit',
      'estimated',
      'exceededByRequiredEnvelope',
    ],
    'context pack budget',
  );
  if (value.tokenizerId !== CONTEXT_PACK_TOKENIZER_ID) {
    throw new Error('context pack budget tokenizerId is invalid');
  }
  if (value.algorithmVersion !== CONTEXT_PACK_BUDGET_ALGORITHM_VERSION) {
    throw new Error('context pack budget algorithmVersion is invalid');
  }
  const limit = value.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('context pack budget limit is invalid');
  }
  const estimated = value.estimated;
  if (
    typeof estimated !== 'number' ||
    !Number.isSafeInteger(estimated) ||
    estimated < 0
  ) {
    throw new Error('context pack budget estimated is invalid');
  }
  if (typeof value.exceededByRequiredEnvelope !== 'boolean') {
    throw new Error(
      'context pack budget exceededByRequiredEnvelope is invalid',
    );
  }
  return {
    tokenizerId: CONTEXT_PACK_TOKENIZER_ID,
    algorithmVersion: CONTEXT_PACK_BUDGET_ALGORITHM_VERSION,
    limit,
    estimated,
    exceededByRequiredEnvelope: value.exceededByRequiredEnvelope,
  };
}

function parseGovernance(value: unknown): ContextPackV2['governance'] {
  if (!isRecord(value))
    throw new Error('context pack governance must be an object');
  assertKnownKeys(
    value,
    ['requirements', 'review', 'verification'],
    'context pack governance',
  );
  return {
    requirements: value.requirements,
    review: value.review,
    verification: value.verification,
  };
}

function parseProvenance(value: unknown): ProvenanceEntry {
  if (!isRecord(value))
    throw new Error('context pack provenance must be an object');
  assertKnownKeys(
    value,
    [
      'targetJsonPointer',
      'sourceKind',
      'taskRef',
      'artifactRef',
      'entityKey',
      'sourceRevision',
      'sourceDigest',
      'selectedJsonPointers',
      'redactions',
    ],
    'context pack provenance',
  );
  if (
    typeof value.targetJsonPointer !== 'string' ||
    !value.targetJsonPointer.startsWith('/')
  ) {
    throw new Error('context pack provenance targetJsonPointer is invalid');
  }
  if (
    value.sourceKind !== 'entity' &&
    value.sourceKind !== 'artifact' &&
    value.sourceKind !== 'runtime' &&
    value.sourceKind !== 'derived'
  ) {
    throw new Error('context pack provenance sourceKind is invalid');
  }
  const parsed: ProvenanceEntry = {
    targetJsonPointer: value.targetJsonPointer,
    sourceKind: value.sourceKind,
    taskRef: value.taskRef === null ? null : parseTaskRef(value.taskRef),
    artifactRef:
      value.artifactRef === null ? null : parseArtifact(value.artifactRef),
    entityKey: parseStringOrNull(
      value.entityKey,
      'context pack provenance entityKey',
    ),
    sourceRevision: parseNonNegativeIntegerOrNull(
      value.sourceRevision,
      'context pack provenance sourceRevision',
    ),
    sourceDigest: parseDigestOrNull(
      value.sourceDigest,
      'context pack provenance sourceDigest',
    ),
    selectedJsonPointers: parseSortedStringSet(
      value.selectedJsonPointers,
      'context pack provenance selectedJsonPointers',
    ),
    redactions: parseSortedStringSet(
      value.redactions,
      'context pack provenance redactions',
    ),
  };
  if (parsed.sourceKind === 'entity' && parsed.entityKey === null) {
    throw new Error('entity provenance requires an entityKey');
  }
  if (parsed.sourceKind === 'artifact' && parsed.artifactRef === null) {
    throw new Error('artifact provenance requires an artifactRef');
  }
  if (parsed.sourceKind !== 'derived' && parsed.sourceDigest === null) {
    throw new Error('direct provenance requires a sourceDigest');
  }
  return parsed;
}

function parseOmission(value: unknown): OmissionRecord {
  if (!isRecord(value))
    throw new Error('context pack omission must be an object');
  assertKnownKeys(
    value,
    ['targetJsonPointer', 'reason', 'omittedCount', 'omittedDigest'],
    'context pack omission',
  );
  if (
    typeof value.targetJsonPointer !== 'string' ||
    !value.targetJsonPointer.startsWith('/')
  ) {
    throw new Error('context pack omission targetJsonPointer is invalid');
  }
  if (
    value.reason !== 'budget' &&
    value.reason !== 'purpose_excluded' &&
    value.reason !== 'privacy' &&
    value.reason !== 'unavailable'
  ) {
    throw new Error('context pack omission reason is invalid');
  }
  const omittedCount = value.omittedCount;
  if (
    typeof omittedCount !== 'number' ||
    !Number.isSafeInteger(omittedCount) ||
    omittedCount < 0
  ) {
    throw new Error('context pack omission omittedCount is invalid');
  }
  return {
    targetJsonPointer: value.targetJsonPointer,
    reason: value.reason,
    omittedCount,
    omittedDigest: parseDigestOrNull(
      value.omittedDigest,
      'context pack omission omittedDigest',
    ),
  };
}

function assertPackProvenance(pack: ContextPackV2): void {
  const available = new Set(
    pack.provenance.map((entry) => entry.targetJsonPointer),
  );
  if (!available.has('/snapshot')) {
    throw new Error('context pack snapshot lacks provenance');
  }
  for (const pointer of SECTION_ORDER) {
    if (REQUIRED_ENVELOPE.has(pointer) && !available.has(pointer)) {
      throw new Error(
        `context pack required envelope lacks provenance: ${pointer}`,
      );
    }
    if (isDefaultValue(pointer, valueAt(pack, pointer))) continue;
    if (!available.has(pointer)) {
      throw new Error(
        `context pack non-empty section lacks provenance: ${pointer}`,
      );
    }
  }
}

function assertContextPackBudget(pack: ContextPackV2): void {
  const actual = countPack(pack);
  if (actual !== pack.budget.estimated) {
    throw new Error(
      'context pack budget estimate does not match fixed tokenizer',
    );
  }
  if (
    (!pack.budget.exceededByRequiredEnvelope &&
      pack.budget.estimated > pack.budget.limit) ||
    (pack.budget.exceededByRequiredEnvelope &&
      pack.budget.estimated <= pack.budget.limit)
  ) {
    throw new Error(
      'context pack required-envelope budget flag is inconsistent',
    );
  }
}

function assertParsedPackPurposeAndLevel(pack: ContextPackV2): void {
  if (pack.level === 'bootstrap' && pack.purpose !== 'orient') {
    throw new Error('MANCODE_CONTEXT_BOOTSTRAP_REQUIRES_ORIENT');
  }
  for (const pointer of SECTION_ORDER) {
    if (REQUIRED_ENVELOPE.has(pointer)) continue;
    if (isDefaultValue(pointer, valueAt(pack, pointer))) continue;
    if (!PURPOSE_SECTIONS[pack.purpose].has(pointer)) {
      throw new Error(
        `context pack section is excluded by purpose: ${pointer}`,
      );
    }
    if (pack.level === 'bootstrap') {
      throw new Error(`context pack section is excluded by level: ${pointer}`);
    }
    if (pack.level === 'full') {
      throw new Error(`MANCODE_CONTEXT_FULL_ARTIFACTS_ON_DEMAND: ${pointer}`);
    }
  }
}

function snapshotProvenance(snapshot: ContextPackSnapshot): ProvenanceEntry {
  return {
    targetJsonPointer: '/snapshot',
    sourceKind: 'runtime',
    taskRef: null,
    artifactRef: null,
    entityKey: null,
    sourceRevision: null,
    sourceDigest: digestCanonicalJson(snapshot),
    selectedJsonPointers: [''],
    redactions: [],
  };
}

function sortProvenance(entries: ProvenanceEntry[]): ProvenanceEntry[] {
  return [...entries].sort((left, right) =>
    Buffer.from(canonicalizeJson(left), 'utf8').compare(
      Buffer.from(canonicalizeJson(right), 'utf8'),
    ),
  );
}

function assertProvenanceIsSorted(entries: ProvenanceEntry[]): void {
  const sorted = sortProvenance(entries);
  if (
    sorted.some(
      (entry, index) =>
        canonicalizeJson(entry) !== canonicalizeJson(entries[index]),
    )
  ) {
    throw new Error(
      'context pack provenance must use canonical stable ordering',
    );
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (
      canonicalizeJson(sorted[index - 1]) === canonicalizeJson(sorted[index])
    ) {
      throw new Error('context pack provenance must not contain duplicates');
    }
  }
}

function valueAt(
  pack: ContextPackV2,
  pointer: ContextPackSectionPointer,
): unknown {
  switch (pointer) {
    case '/session':
      return pack.session;
    case '/actor':
      return pack.actor;
    case '/project':
      return pack.project;
    case '/collaboration':
      return pack.collaboration;
    case '/activeTask':
      return pack.activeTask;
    case '/governance/requirements':
      return pack.governance.requirements;
    case '/governance/review':
      return pack.governance.review;
    case '/governance/verification':
      return pack.governance.verification;
    case '/parentFreshness':
      return pack.parentFreshness;
    case '/latestCheckpoint':
      return pack.latestCheckpoint;
    case '/latestHandoff':
      return pack.latestHandoff;
    case '/claims':
      return pack.claims;
    case '/conflicts':
      return pack.conflicts;
    case '/capabilities':
      return pack.capabilities;
    case '/transportFreshness':
      return pack.transportFreshness;
  }
}

function isDefaultValue(
  pointer: ContextPackSectionPointer,
  value: unknown,
): boolean {
  return (
    value === null ||
    ((pointer === '/claims' || pointer === '/conflicts') &&
      Array.isArray(value) &&
      value.length === 0)
  );
}

function sortOmissions(omissions: OmissionRecord[]): OmissionRecord[] {
  return [...omissions].sort(
    (left, right) =>
      SECTION_ORDER.indexOf(
        left.targetJsonPointer as ContextPackSectionPointer,
      ) -
        SECTION_ORDER.indexOf(
          right.targetJsonPointer as ContextPackSectionPointer,
        ) || left.reason.localeCompare(right.reason, 'en'),
  );
}

function assertContextLevel(value: unknown): asserts value is ContextLevel {
  if (value !== 'bootstrap' && value !== 'task' && value !== 'full') {
    throw new Error('context pack level is invalid');
  }
}

function assertContextPurpose(value: unknown): asserts value is ContextPurpose {
  if (
    value !== 'orient' &&
    value !== 'plan' &&
    value !== 'implement' &&
    value !== 'review' &&
    value !== 'verify' &&
    value !== 'handoff'
  ) {
    throw new Error('context pack purpose is invalid');
  }
}

function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function parseTaskRef(value: unknown): TaskRef {
  try {
    return parseTaskRefValue(value);
  } catch {
    throw new Error('context pack provenance taskRef is invalid');
  }
}

function parseArtifact(value: unknown): ArtifactRef {
  try {
    return parseArtifactRef(value);
  } catch {
    throw new Error('context pack provenance artifactRef is invalid');
  }
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return value;
}

function parseDigestOrNull(value: unknown, label: string): string | null {
  return value === null ? null : parseDigest(value, label);
}

function parseStringOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string or null`);
  }
  return value;
}

function parseSortedStringSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  const normalized = [...new Set(value)].sort((left, right) =>
    Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );
  if (
    normalized.length !== value.length ||
    normalized.some((item, index) => item !== value[index])
  ) {
    throw new Error(`${label} must be UTF-8 sorted without duplicates`);
  }
  return [...value];
}

function parsePositiveIntegerOrNull(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(
      `context pack snapshot ${label} must be a positive integer or null`,
    );
  }
  return value as number;
}

function parseNonNegativeIntegerOrNull(
  value: unknown,
  label: string,
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `context pack ${label} must be a non-negative integer or null`,
    );
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new Error(`${label} contains unknown key: ${key}`);
  }
}
