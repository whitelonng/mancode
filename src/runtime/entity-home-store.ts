import path from 'node:path';
import { type Ulid, assertUlid } from '../context/ids.js';
import { type TaskRef, parseTaskRefValue } from '../context/task-ref.js';

export type EntityHomeStoreKind =
  | 'checkout_local'
  | 'workspace_common_dir'
  | 'non_git_shared';

export interface EntityHomeStoreContext {
  projectRoot: string;
  workspaceId: Ulid;
  checkoutId: Ulid;
  gitCommonDir: string | null;
  repositoryBindingId: Ulid | null;
}

export interface EntityHomeStore {
  kind: EntityHomeStoreKind;
  storeId: string;
  root: string;
  workspaceId: Ulid;
  checkoutId: Ulid | null;
  repositoryBindingId: Ulid | null;
}

export function resolveTaskEntityHomeStore(
  context: EntityHomeStoreContext,
  taskRef: TaskRef,
): EntityHomeStore {
  const normalized = normalizeContext(context);
  const task = parseTaskRefValue(taskRef);
  return task.namespace === 'local'
    ? localTaskHomeStore(normalized)
    : coordinationEntityHomeStore(normalized);
}

/** The checkout-local operation store is addressable without a TaskRef. */
export function resolveLocalEntityHomeStore(
  context: EntityHomeStoreContext,
): EntityHomeStore {
  return localTaskHomeStore(normalizeContext(context));
}

/** Claims, handoffs, shared task operations, and task-head fences share this home. */
export function resolveCoordinationEntityHomeStore(
  context: EntityHomeStoreContext,
): EntityHomeStore {
  return coordinationEntityHomeStore(normalizeContext(context));
}

export function operationDirectory(store: EntityHomeStore): string {
  return path.join(store.root, 'operations');
}

export function reservationDirectory(store: EntityHomeStore): string {
  return path.join(store.root, 'reservations');
}

export function lockDirectory(store: EntityHomeStore): string {
  return path.join(store.root, 'locks');
}

export function claimDirectory(store: EntityHomeStore): string {
  assertCoordinationStore(store, 'claim');
  return path.join(store.root, 'claims');
}

export function handoffDirectory(store: EntityHomeStore): string {
  assertCoordinationStore(store, 'handoff');
  return path.join(store.root, 'handoffs');
}

export function taskHeadDirectory(store: EntityHomeStore): string {
  assertCoordinationStore(store, 'task head fence');
  return path.join(store.root, 'task-heads');
}

function normalizeContext(
  context: EntityHomeStoreContext,
): EntityHomeStoreContext {
  assertUlid(context.workspaceId, 'entity home store workspaceId');
  assertUlid(context.checkoutId, 'entity home store checkoutId');
  if (typeof context.projectRoot !== 'string' || !context.projectRoot.trim()) {
    throw new Error('entity home store projectRoot is required');
  }
  if (context.gitCommonDir === null) {
    if (context.repositoryBindingId !== null) {
      assertUlid(
        context.repositoryBindingId,
        'entity home store repositoryBindingId',
      );
    }
    return {
      ...context,
      projectRoot: path.resolve(context.projectRoot),
      gitCommonDir: null,
    };
  }
  if (
    typeof context.gitCommonDir !== 'string' ||
    !context.gitCommonDir.trim()
  ) {
    throw new Error('entity home store gitCommonDir must be a path or null');
  }
  if (context.repositoryBindingId === null) {
    throw new Error(
      'git coordination requires an entity home store repositoryBindingId',
    );
  }
  assertUlid(
    context.repositoryBindingId,
    'entity home store repositoryBindingId',
  );
  return {
    ...context,
    projectRoot: path.resolve(context.projectRoot),
    gitCommonDir: path.resolve(context.gitCommonDir),
  };
}

function localTaskHomeStore(context: EntityHomeStoreContext): EntityHomeStore {
  return {
    kind: 'checkout_local',
    storeId: `checkout:${context.checkoutId}:${context.workspaceId}`,
    root: path.join(context.projectRoot, '.mancode', 'local', 'runtime'),
    workspaceId: context.workspaceId,
    checkoutId: context.checkoutId,
    repositoryBindingId: context.repositoryBindingId,
  };
}

function coordinationEntityHomeStore(
  context: EntityHomeStoreContext,
): EntityHomeStore {
  if (context.gitCommonDir === null) {
    return {
      kind: 'non_git_shared',
      storeId: `non-git:${context.workspaceId}`,
      root: path.join(
        context.projectRoot,
        '.mancode',
        'runtime',
        'non-git',
        context.workspaceId,
      ),
      workspaceId: context.workspaceId,
      checkoutId: null,
      repositoryBindingId: context.repositoryBindingId,
    };
  }
  if (context.repositoryBindingId === null) {
    throw new Error('git coordination requires a repositoryBindingId');
  }
  return {
    kind: 'workspace_common_dir',
    storeId: `workspace:${context.repositoryBindingId}:${context.workspaceId}`,
    root: path.join(
      context.gitCommonDir,
      'mancode',
      'workspaces',
      context.workspaceId,
    ),
    workspaceId: context.workspaceId,
    checkoutId: null,
    repositoryBindingId: context.repositoryBindingId,
  };
}

function assertCoordinationStore(store: EntityHomeStore, entity: string): void {
  if (store.kind === 'checkout_local') {
    throw new Error(
      `${entity} requires a shared coordination entity home store`,
    );
  }
}
