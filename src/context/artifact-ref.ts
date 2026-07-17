import { type Ulid, assertUlid } from './ids.js';
import {
  type TaskNamespace,
  type TaskRef,
  parseTaskRefValue,
} from './task-ref.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export type ArtifactKind =
  | 'requirements'
  | 'requirements_markdown'
  | 'plan'
  | 'review_ledger'
  | 'verification_ledger'
  | 'checkpoint'
  | 'handoff'
  | 'summary'
  | 'review_report'
  | 'evidence_summary';

export interface ArtifactRef {
  taskRef: TaskRef;
  kind: ArtifactKind;
  artifactId?: Ulid;
}

const ARTIFACT_KINDS = new Set<ArtifactKind>([
  'requirements',
  'requirements_markdown',
  'plan',
  'review_ledger',
  'verification_ledger',
  'checkpoint',
  'handoff',
  'summary',
  'review_report',
  'evidence_summary',
]);

export function parseArtifactRef(value: unknown): ArtifactRef {
  assertRecord(value, 'ArtifactRef');
  assertKnownKeys(value, ['taskRef', 'kind', 'artifactId'], 'ArtifactRef');
  if (
    typeof value.kind !== 'string' ||
    !ARTIFACT_KINDS.has(value.kind as ArtifactKind)
  ) {
    throw new Error('ArtifactRef kind is not supported');
  }
  if (value.artifactId !== undefined) {
    assertUlid(value.artifactId, 'ArtifactRef artifactId');
  }
  return {
    taskRef: parseTaskRefValue(value.taskRef),
    kind: value.kind as ArtifactKind,
    ...(value.artifactId === undefined ? {} : { artifactId: value.artifactId }),
  };
}

/**
 * Shared entities may never persist a reference into a local task namespace.
 * Local entities are allowed to refer to a shared task.
 */
export function assertReferenceNamespace(
  sourceNamespace: TaskNamespace,
  target: TaskRef | ArtifactRef,
): void {
  const targetNamespace =
    'taskRef' in target ? target.taskRef.namespace : target.namespace;
  if (sourceNamespace === 'shared' && targetNamespace !== 'shared') {
    throw new Error(
      'shared entities cannot reference local TaskRef or ArtifactRef values',
    );
  }
}
