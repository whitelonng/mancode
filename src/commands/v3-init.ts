import {
  type GreenfieldInitializationJournalV1,
  initializeGreenfield,
} from '../context/greenfield-init.js';
import { type Ulid, createUlid } from '../context/ids.js';
import type { ManagedAdapterInventory } from '../context/manifest.js';
import { createProjectFacts } from '../context/project-facts.js';
import {
  type ProjectRuntimeContext,
  ensureProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import { detectProjectProfile } from '../system/project-profile.js';
import type {
  ProjectConfigV1,
  TeamPolicyV1,
  TeamRecommendationPolicy,
} from '../team/policy.js';
import { VERSION } from '../version.js';

export interface InitializeV3ProjectInput {
  projectRoot: string;
  operationId?: Ulid;
  workspaceId?: Ulid;
  schemaEpoch?: Ulid;
  managedAdapters?: ManagedAdapterInventory;
  /** Explicit init preference; omitted keeps V3's evidence-based auto mode. */
  teamPolicy?: TeamRecommendationPolicy;
  now?: Date;
}

export interface InitializeV3ProjectResult {
  journal: GreenfieldInitializationJournalV1;
  runtime: ProjectRuntimeContext;
}

/**
 * The greenfield command path deliberately has no legacy fallback. If legacy
 * authority exists, `initializeGreenfield` refuses it and the caller must use
 * migration staging instead.
 */
export async function initializeV3Project(
  input: InitializeV3ProjectInput,
): Promise<InitializeV3ProjectResult> {
  const now = input.now ?? new Date();
  const workspaceId = input.workspaceId ?? createUlid();
  const operationId = input.operationId ?? createUlid();
  const schemaEpoch = input.schemaEpoch ?? createUlid();
  const timestamp = now.toISOString();
  const projectConfig: ProjectConfigV1 = {
    schemaVersion: 1,
    revision: 1,
    workspaceId,
    transport: { mode: 'local', remote: null, epoch: 1 },
    lastOperationId: null,
    updatedAt: timestamp,
  };
  const teamPolicy: TeamPolicyV1 = {
    schemaVersion: 1,
    revision: 1,
    workspaceId,
    policy: input.teamPolicy ?? 'auto',
    recentDays: 30,
    defaultVisibility: 'local',
    shareConfirmedDecisions: false,
    retention: {
      localRawArtifactDays: 7,
      localCacheDays: 7,
      completedSessionDays: 30,
    },
    lastOperationId: null,
    updatedAt: timestamp,
  };
  let runtime: ProjectRuntimeContext | null = null;
  const projectFacts = createProjectFacts(
    await detectProjectProfile(input.projectRoot),
    { now, operationId },
  );
  const journal = await initializeGreenfield(
    {
      projectRoot: input.projectRoot,
      operationId,
      workspaceId,
      schemaEpoch,
      minReaderVersion: VERSION,
      minWriterVersion: VERSION,
      managedAdapters: input.managedAdapters ?? {},
      projectConfig,
      teamPolicy,
      projectFacts,
      now,
    },
    {
      registerWorkspaceBinding: async () => {
        runtime = await ensureProjectRuntimeContext(input.projectRoot, now);
      },
      now,
    },
  );
  if (runtime === null) {
    throw new Error('MANCODE_WORKSPACE_BINDING_MISMATCH');
  }
  return { journal, runtime };
}
