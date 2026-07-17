import {
  type TaskNamespace,
  type TaskRef,
  parseTaskRefValue,
  sameTaskRef,
} from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type WorkflowMode = 'man' | 'manba' | 'manteam';
export type Coordination = 'single' | 'team';
export type WorkflowStatus =
  | 'in_progress'
  | 'planned'
  | 'blocked'
  | 'completed'
  | 'abandoned'
  | 'superseded';
export type WorkflowTransitionOperation = 'ordinary' | 'publish' | 'promote';

export interface ParentWorkflowDescriptor {
  taskRef: TaskRef;
  workflowMode: WorkflowMode;
  visibility: TaskNamespace;
  coordination: Coordination;
}

export interface WorkflowDescriptor {
  workflowMode: WorkflowMode;
  visibility: TaskNamespace;
  coordination: Coordination;
  parent: ParentWorkflowDescriptor | null;
}

export interface WorkflowStatusTransition {
  sourceTaskRef: TaskRef;
  from: WorkflowStatus;
  to: WorkflowStatus;
  operation: WorkflowTransitionOperation;
  successorTaskRef?: TaskRef | null;
}

const WORKFLOW_MODES = new Set<WorkflowMode>(['man', 'manba', 'manteam']);
const WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  'in_progress',
  'planned',
  'blocked',
  'completed',
  'abandoned',
  'superseded',
]);

export function parseWorkflowMode(value: unknown): WorkflowMode {
  if (typeof value !== 'string' || !WORKFLOW_MODES.has(value as WorkflowMode)) {
    throw new Error('workflowMode must be man, manba, or manteam');
  }
  return value as WorkflowMode;
}

export function parseWorkflowStatus(value: unknown): WorkflowStatus {
  if (
    typeof value !== 'string' ||
    !WORKFLOW_STATUSES.has(value as WorkflowStatus)
  ) {
    throw new Error('workflow status is invalid');
  }
  return value as WorkflowStatus;
}

/** Legacy readers may normalize mamba, but V3 writers must never emit it. */
export function normalizeLegacyWorkflowMode(
  value: unknown,
): WorkflowMode | null {
  if (value === 'mamba') return 'manba';
  return typeof value === 'string' && WORKFLOW_MODES.has(value as WorkflowMode)
    ? (value as WorkflowMode)
    : null;
}

export function parseWorkflowDescriptor(value: unknown): WorkflowDescriptor {
  assertRecord(value, 'workflow descriptor');
  assertKnownKeys(
    value,
    ['workflowMode', 'visibility', 'coordination', 'parent'],
    'workflow descriptor',
  );
  if (value.visibility !== 'local' && value.visibility !== 'shared') {
    throw new Error('workflow visibility must be local or shared');
  }
  if (value.coordination !== 'single' && value.coordination !== 'team') {
    throw new Error('workflow coordination must be single or team');
  }
  const descriptor: WorkflowDescriptor = {
    workflowMode: parseWorkflowMode(value.workflowMode),
    visibility: value.visibility,
    coordination: value.coordination,
    parent:
      value.parent === null
        ? null
        : parseParentWorkflowDescriptor(value.parent),
  };
  assertWorkflowDescriptor(descriptor);
  return descriptor;
}

export function assertWorkflowDescriptor(value: WorkflowDescriptor): void {
  const { workflowMode, visibility, coordination, parent } = value;
  if (workflowMode === 'man') {
    if (coordination !== 'single' || parent !== null) {
      throw new Error('man requires single coordination and no parent');
    }
    return;
  }
  if (workflowMode === 'manteam') {
    if (visibility !== 'shared' || coordination !== 'team' || parent !== null) {
      throw new Error(
        'manteam requires shared visibility, team coordination, and no parent',
      );
    }
    return;
  }

  if (visibility === 'local' && coordination === 'single') {
    if (parent !== null) assertMatchingParent(parent, 'man', 'local', 'single');
    return;
  }
  if (visibility === 'shared' && coordination === 'single') {
    if (parent === null) {
      throw new Error('shared single manba requires a shared man parent');
    }
    assertMatchingParent(parent, 'man', 'shared', 'single');
    return;
  }
  if (visibility === 'shared' && coordination === 'team') {
    if (parent === null) {
      throw new Error('shared team manba requires a shared manteam parent');
    }
    assertMatchingParent(parent, 'manteam', 'shared', 'team');
    return;
  }
  throw new Error('local team manba is not a legal workflow combination');
}

export function assertWorkflowStatusTransition(
  transition: WorkflowStatusTransition,
): void {
  assertWorkflowStatus(transition.from);
  assertWorkflowStatus(transition.to);
  const successor = transition.successorTaskRef ?? null;
  if (transition.from === transition.to) {
    if (successor !== null) {
      throw new Error('unchanged workflow status must not carry a successor');
    }
    return;
  }
  if (!allowedTransitions(transition.from).has(transition.to)) {
    throw new Error(
      `invalid workflow status transition: ${transition.from} -> ${transition.to}`,
    );
  }
  if (transition.to !== 'superseded') {
    if (successor !== null) {
      throw new Error('only superseded workflows may carry a successor');
    }
    return;
  }
  if (
    (transition.operation !== 'publish' &&
      transition.operation !== 'promote') ||
    successor === null
  ) {
    throw new Error(
      'superseded status requires a successful publish or promote successor',
    );
  }
  if (
    transition.sourceTaskRef.namespace !== 'local' ||
    successor.namespace !== 'shared' ||
    sameTaskRef(transition.sourceTaskRef, successor)
  ) {
    throw new Error(
      'publish/promote must supersede a local task with a new shared TaskRef',
    );
  }
}

function parseParentWorkflowDescriptor(
  value: unknown,
): ParentWorkflowDescriptor {
  assertRecord(value, 'workflow parent');
  assertKnownKeys(
    value,
    ['taskRef', 'workflowMode', 'visibility', 'coordination'],
    'workflow parent',
  );
  if (value.visibility !== 'local' && value.visibility !== 'shared') {
    throw new Error('workflow parent visibility must be local or shared');
  }
  if (value.coordination !== 'single' && value.coordination !== 'team') {
    throw new Error('workflow parent coordination must be single or team');
  }
  const taskRef = parseTaskRefValue(value.taskRef);
  if (taskRef.namespace !== value.visibility) {
    throw new Error(
      'workflow parent TaskRef namespace must match parent visibility',
    );
  }
  return {
    taskRef,
    workflowMode: parseWorkflowMode(value.workflowMode),
    visibility: value.visibility,
    coordination: value.coordination,
  };
}

function assertMatchingParent(
  parent: ParentWorkflowDescriptor,
  workflowMode: WorkflowMode,
  visibility: TaskNamespace,
  coordination: Coordination,
): void {
  if (
    parent.workflowMode !== workflowMode ||
    parent.visibility !== visibility ||
    parent.coordination !== coordination
  ) {
    throw new Error(
      'workflow parent does not match the required inheritance contract',
    );
  }
}

function assertWorkflowStatus(value: unknown): asserts value is WorkflowStatus {
  parseWorkflowStatus(value);
}

function allowedTransitions(from: WorkflowStatus): Set<WorkflowStatus> {
  switch (from) {
    case 'in_progress':
      return new Set([
        'planned',
        'blocked',
        'completed',
        'abandoned',
        'superseded',
      ]);
    case 'planned':
      return new Set(['in_progress', 'completed', 'abandoned', 'superseded']);
    case 'blocked':
      return new Set(['in_progress', 'abandoned', 'superseded']);
    case 'completed':
    case 'abandoned':
    case 'superseded':
      return new Set();
  }
}
