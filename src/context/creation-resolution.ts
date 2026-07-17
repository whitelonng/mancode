import type { TeamAssessment } from '../team/assessment.js';
import type { TeamPolicyV1 } from '../team/policy.js';
import {
  type Coordination,
  type ParentWorkflowDescriptor,
  type WorkflowDescriptor,
  type WorkflowMode,
  assertWorkflowDescriptor,
  parseWorkflowMode,
} from './schema.js';
import type { TaskNamespace } from './task-ref.js';

export type DimensionSource =
  | 'mode_constraint'
  | 'parent'
  | 'explicit'
  | 'policy_default';

export interface WorkflowCreationRequest {
  workflowMode: WorkflowMode;
  parent: ParentWorkflowDescriptor | null;
  visibility?: TaskNamespace;
  coordination?: Coordination;
  policy: Pick<TeamPolicyV1, 'defaultVisibility'> | null;
  assessment: TeamAssessment | null;
}

export interface WorkflowCreationResolution {
  descriptor: WorkflowDescriptor;
  dimensions: {
    workflowMode: { value: WorkflowMode; source: 'mode_constraint' };
    visibility: { value: TaskNamespace; source: DimensionSource };
    coordination: { value: Coordination; source: DimensionSource };
  };
  sharedPrivacyConfirmationRequired: boolean;
  assessment: TeamAssessment | null;
}

/**
 * Applies the fixed creation precedence: mode → parent → explicit parameters
 * → policy default. An assessment is returned for presentation but never
 * changes a resolved dimension.
 */
export function resolveWorkflowCreation(
  request: WorkflowCreationRequest,
): WorkflowCreationResolution {
  const workflowMode = parseWorkflowMode(request.workflowMode);
  validateOptionalDimensions(request.visibility, request.coordination);
  if (workflowMode !== 'manba' && request.parent !== null) {
    throw new Error('only manba workflows may declare a parent');
  }
  if (workflowMode === 'manteam') {
    rejectConflict(request.visibility, 'shared', 'manteam visibility');
    rejectConflict(request.coordination, 'team', 'manteam coordination');
    return buildResolution(
      workflowMode,
      'shared',
      'team',
      null,
      'mode_constraint',
      'mode_constraint',
      request.assessment,
    );
  }
  if (workflowMode === 'manba') {
    return resolveManba(request, workflowMode);
  }
  if (request.coordination !== undefined && request.coordination !== 'single') {
    throw new Error('man workflows require single coordination');
  }
  const visibility =
    request.visibility ?? request.policy?.defaultVisibility ?? 'local';
  const visibilitySource: DimensionSource =
    request.visibility === undefined
      ? request.policy === null
        ? 'mode_constraint'
        : 'policy_default'
      : 'explicit';
  return buildResolution(
    workflowMode,
    visibility,
    'single',
    null,
    visibilitySource,
    request.coordination === undefined ? 'mode_constraint' : 'explicit',
    request.assessment,
  );
}

function resolveManba(
  request: WorkflowCreationRequest,
  workflowMode: WorkflowMode,
): WorkflowCreationResolution {
  const parent = request.parent;
  if (parent === null) {
    rejectConflict(request.visibility, 'local', 'standalone manba visibility');
    rejectConflict(
      request.coordination,
      'single',
      'standalone manba coordination',
    );
    return buildResolution(
      workflowMode,
      'local',
      'single',
      null,
      'mode_constraint',
      'mode_constraint',
      request.assessment,
    );
  }
  if (
    request.visibility !== undefined &&
    request.visibility !== parent.visibility
  ) {
    throw new Error('child manba visibility must inherit its parent');
  }
  if (
    request.coordination !== undefined &&
    request.coordination !== parent.coordination
  ) {
    throw new Error('child manba coordination must inherit its parent');
  }
  return buildResolution(
    workflowMode,
    parent.visibility,
    parent.coordination,
    parent,
    'parent',
    'parent',
    request.assessment,
  );
}

function buildResolution(
  workflowMode: WorkflowMode,
  visibility: TaskNamespace,
  coordination: Coordination,
  parent: ParentWorkflowDescriptor | null,
  visibilitySource: DimensionSource,
  coordinationSource: DimensionSource,
  assessment: TeamAssessment | null,
): WorkflowCreationResolution {
  const descriptor: WorkflowDescriptor = {
    workflowMode,
    visibility,
    coordination,
    parent,
  };
  assertWorkflowDescriptor(descriptor);
  return {
    descriptor,
    dimensions: {
      workflowMode: { value: workflowMode, source: 'mode_constraint' },
      visibility: { value: visibility, source: visibilitySource },
      coordination: { value: coordination, source: coordinationSource },
    },
    sharedPrivacyConfirmationRequired: visibility === 'shared',
    assessment,
  };
}

function validateOptionalDimensions(
  visibility: TaskNamespace | undefined,
  coordination: Coordination | undefined,
): void {
  if (
    visibility !== undefined &&
    visibility !== 'local' &&
    visibility !== 'shared'
  ) {
    throw new Error('workflow create visibility is invalid');
  }
  if (
    coordination !== undefined &&
    coordination !== 'single' &&
    coordination !== 'team'
  ) {
    throw new Error('workflow create coordination is invalid');
  }
}

function rejectConflict<T>(
  provided: T | undefined,
  expected: T,
  label: string,
): void {
  if (provided !== undefined && provided !== expected) {
    throw new Error(`${label} conflicts with its mode constraint`);
  }
}
