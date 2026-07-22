import { createUlid } from '../context/ids.js';
import {
  type RequirementsLedgerV1,
  parseRequirementsLedger,
  requirementsLedgerDigest,
} from '../context/requirements-ledger.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';
import {
  type RequirementsLedger as SemanticRequirementsLedger,
  parseRequirementsLedger as parseSemanticRequirementsLedger,
} from '../system/requirements-ledger.js';

/**
 * Accepts either a canonical V3 ledger or the public semantic requirements
 * format. Control identities and digests for semantic input are owned here,
 * not by the calling agent.
 */
export function normalizeRequirementsInput(
  value: unknown,
  requestedTaskRef: TaskRef,
  now: Date = new Date(),
  options: { allowIncomplete?: boolean } = {},
): RequirementsLedgerV1 {
  if (isRecord(value) && 'schemaVersion' in value) {
    return parseRequirementsLedger(value);
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('requirements input must be valid JSON');
  }
  const semantic = parseSemanticRequirementsLedger(serialized, options);
  return buildCanonicalRequirements(semantic, requestedTaskRef, now);
}

function buildCanonicalRequirements(
  semantic: SemanticRequirementsLedger,
  requestedTaskRef: TaskRef,
  now: Date,
): RequirementsLedgerV1 {
  const taskRef = parseTaskRefValue(requestedTaskRef);
  let allocatedIds = 0;
  const allocateId = () => createUlid(now.getTime() + allocatedIds++);
  const draft: RequirementsLedgerV1 = {
    schemaVersion: 1,
    canonicalizationVersion: 'mancode-jcs-v1',
    taskRef,
    revision: 1,
    status: semantic.blockingUnknowns.length === 0 ? 'confirmed' : 'draft',
    goal: semantic.goal,
    functionalScope: {
      inScope: semantic.confirmedScope,
      outOfScope: semantic.excludedScope,
    },
    technicalDecisions: semantic.technicalDecisions.map((statement, index) => ({
      displayId: `TD-${index + 1}`,
      legacyId: null,
      decisionId: allocateId(),
      statement,
    })),
    defaults: semantic.defaults.map((statement, index) => ({
      displayId: `D-${index + 1}`,
      legacyId: null,
      defaultId: allocateId(),
      statement,
    })),
    coverage: semantic.coverage.map((item) => ({
      coverageId: allocateId(),
      ...item,
    })),
    requirements: [],
    acceptanceCriteria: semantic.acceptanceCriteria.map((item) => ({
      displayId: item.id,
      legacyId: item.id,
      criterionId: allocateId(),
      requirementIds: [],
      statement: item.description,
      required: item.required,
      verificationRequirement: item.method,
    })),
    blockingUnknowns: semantic.blockingUnknowns.map((statement, index) => ({
      displayId: `U-${index + 1}`,
      legacyId: null,
      unknownId: allocateId(),
      statement,
      status: 'open',
    })),
    legacySource: null,
    contentDigest: '',
    lastOperationId: null,
    updatedAt: now.toISOString(),
  };
  return parseRequirementsLedger({
    ...draft,
    contentDigest: requirementsLedgerDigest(draft),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
