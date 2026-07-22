import { CURRENT_WRITER_CAPABILITIES } from '../context/compatibility.js';
import type { ContextLevel, ContextPurpose } from '../context/context-pack.js';
import { isUlid } from '../context/ids.js';
import { managedAdapterNames } from '../context/manifest.js';
import {
  previewV3TaskPromotion,
  promoteV3Task,
} from '../context/publish-promote.js';
import { ContextResolver } from '../context/resolver.js';
import { V3ContextStore } from '../context/store.js';
import {
  previewV3TaskHeadReconcile,
  reconcileV3TaskHead,
} from '../context/task-head-reconcile.js';
import { parseTaskRef } from '../context/task-ref.js';
import { inspectV3AdapterVersions } from '../installers/v3-adapter.js';
import { evaluateV3BetaGate } from '../runtime/beta-gate.js';
import {
  readLocalDiagnostics,
  readLocalDiagnosticsConfig,
  setLocalDiagnosticsEnabled,
} from '../runtime/diagnostics.js';
import {
  executeOperationRecovery,
  inspectOperationRecovery,
  listUnfinishedOperationRecoveries,
} from '../runtime/operation-recovery-executor.js';
import {
  listPlatformSessionSpikes,
  writePlatformSessionSpike,
} from '../runtime/platform-spike-store.js';
import {
  type HookApprovalStatus,
  type HostSessionSource,
  SESSION_SPIKE_PLATFORMS,
  type SessionSpikePlatform,
  type SpikeEvidenceStatus,
  createPlatformSessionSpike,
  evaluatePlatformSessionCapability,
  platformSpikeFreezeStatus,
} from '../runtime/platform-spike.js';
import {
  ensureProjectRuntimeContext,
  readCheckoutCodeHead,
} from '../runtime/project-runtime.js';
import {
  listProjectionIntents,
  reconcileProjectionIntents,
  supersedeProjectionIntents,
} from '../runtime/projection-outbox.js';
import {
  applyContextCompaction,
  planContextCompaction,
} from '../runtime/retention.js';
import {
  type SessionStateV1,
  closeSession,
  createBootstrapSession,
  readSession,
  resumeSession,
} from '../runtime/session.js';
import { readLocalActor } from '../team/actor.js';
import {
  capabilitiesFromGitRefCache,
  readGitRefTeamCache,
} from '../team/git-ref-cache.js';
import {
  listGitRefWorkflowRepairs,
  recoverGitRefWorkflowRepair,
} from '../team/git-ref-workflow-repair.js';
import { VERSION } from '../version.js';
import {
  EXIT_V3_BLOCKED,
  EXIT_V3_INVALID_ARGUMENT,
  EXIT_V3_OK,
  commandClient,
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  resolveV3ReadSession,
  v3ErrorCode,
} from './v3-support.js';

export interface ContextSessionNewOptions {
  client?: string;
  json?: boolean;
}

export interface ContextSessionShowOptions {
  session?: string;
  client?: string;
  json?: boolean;
}

export interface ContextSessionSpikeOptions {
  platform?: string;
  hostSessionSource?: string;
  commandPropagation?: string;
  subagentInheritance?: string;
  subagentInheritanceReason?: string;
  hookApproval?: string;
  hostVersion?: string;
  releaseCandidate?: string;
  json?: boolean;
}

export interface ContextResumeOptions {
  client?: string;
  session?: string;
  json?: boolean;
}

export interface ContextShowOptions extends ContextResumeOptions {
  task?: string;
  level?: string;
  purpose?: string;
}

export interface ContextCloseOptions {
  session?: string;
  json?: boolean;
}

export interface ContextWorktreeRegisterOptions {
  json?: boolean;
}

export interface ContextDoctorOptions extends ContextResumeOptions {
  repair?: string;
}

export interface ContextDiagnosticsOptions {
  json?: boolean;
}

export interface ContextCompactOptions {
  task?: string;
  dryRun?: boolean;
  applyShared?: boolean;
  json?: boolean;
}

export interface ContextBetaOptions {
  releaseCandidate?: string;
  json?: boolean;
}

export interface ContextPublishOptions extends ContextResumeOptions {
  expectedRevision?: string;
  confirmShared?: boolean;
  dryRun?: boolean;
}

export interface ContextReconcileTaskHeadOptions extends ContextResumeOptions {
  expectedFenceRevision?: string;
  fromGit?: boolean;
  dryRun?: boolean;
}

/** Implements `mancode context session new --client <name>`. */
export async function contextSessionNew(
  rootDir: string,
  options: ContextSessionNewOptions,
): Promise<number> {
  try {
    if (options.client === undefined) {
      return printV3Error(
        options.json,
        'MANCODE_CLIENT_REQUIRED',
        'context session new requires --client <name>.',
        EXIT_V3_INVALID_ARGUMENT,
      );
    }
    const project = await readV3CommandProject(rootDir);
    const actor = await readLocalActor(project.projectRoot);
    if (actor === null) {
      throw new Error('MANCODE_LOCAL_ACTOR_REQUIRED');
    }
    const result = await createBootstrapSession(project.projectRoot, {
      actorId: actor.actorId,
      client: commandClient(options.client),
    });
    return printV3Result(options.json, { schemaVersion: 1, ...result });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_SESSION_CREATE_FAILED'),
      error instanceof Error ? error.message : 'Unable to create a session.',
    );
  }
}

/** Implements `mancode context session show --session <id> ...`. */
export async function contextSessionShow(
  rootDir: string,
  options: ContextSessionShowOptions,
): Promise<number> {
  if (options.session === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_SESSION_REQUIRED',
      'context session show requires --session <id>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  if (!isUlid(options.session)) {
    return printV3Error(
      options.json,
      'MANCODE_SESSION_INVALID',
      'context session show requires a canonical ULID in --session <id>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await readSession(project.projectRoot, options.session);
    if (session === null) {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    if (
      options.client !== undefined &&
      session.client !== commandClient(options.client)
    ) {
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    }
    return printV3Result(options.json, { schemaVersion: 1, session });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_SESSION_SHOW_FAILED'),
      error instanceof Error ? error.message : 'Unable to show the session.',
    );
  }
}

/**
 * Records one real-host session spike without accepting or persisting host
 * keys as command-line arguments. Operators supply the two window values via
 * the process environment for this one invocation.
 */
export async function contextSessionSpike(
  rootDir: string,
  options: ContextSessionSpikeOptions,
): Promise<number> {
  try {
    const platform = parseSpikePlatform(options.platform);
    const hostSessionSource = parseHostSessionSource(options.hostSessionSource);
    if (hostSessionSource === 'none') {
      throw new Error('MANCODE_PLATFORM_SPIKE_HOST_SOURCE_REQUIRED');
    }
    const releaseCandidate = parseReleaseCandidate(options.releaseCandidate);
    const hostVersion = parseHostVersion(options.hostVersion);
    const commandPropagation = parseRequiredSpikeEvidenceStatus(
      options.commandPropagation,
      'command propagation',
    );
    const subagentInheritance = parseRequiredSpikeEvidenceStatus(
      options.subagentInheritance,
      'subagent inheritance',
    );
    const firstWindowHostSessionKey =
      process.env.MANCODE_SPIKE_HOST_SESSION_KEY ?? null;
    const secondWindowHostSessionKey =
      process.env.MANCODE_SPIKE_SECOND_WINDOW_HOST_SESSION_KEY ?? null;
    if (
      firstWindowHostSessionKey === null ||
      secondWindowHostSessionKey === null
    ) {
      throw new Error('MANCODE_PLATFORM_SPIKE_WINDOW_EVIDENCE_REQUIRED');
    }
    const project = await readV3CommandProject(rootDir);
    const spike = createPlatformSessionSpike({
      platform,
      observedAt: new Date().toISOString(),
      hostSessionSource,
      firstWindowHostSessionKey,
      secondWindowHostSessionKey,
      commandPropagation,
      subagentInheritance,
      subagentInheritanceReason: options.subagentInheritanceReason ?? null,
      hookApproval: parseHookApproval(
        options.hookApproval ??
          (hostSessionSource === 'hook_stdin' ? 'unknown' : 'not_applicable'),
      ),
      evidence: {
        releaseCandidate,
        mancodeVersion: VERSION,
        hostVersion,
        nodeVersion: process.version,
        runtimePlatform: `${process.platform}-${process.arch}`,
      },
    });
    await writePlatformSessionSpike(project.projectRoot, spike);
    const spikes = await listPlatformSessionSpikes(project.projectRoot);
    const evidenceRequirement = {
      releaseCandidate,
      mancodeVersion: VERSION,
    };
    return printV3Result(options.json, {
      schemaVersion: 1,
      spike,
      capability: evaluatePlatformSessionCapability(spike, evidenceRequirement),
      freeze: platformSpikeFreezeStatus(spikes, evidenceRequirement),
      rawHostKeysPersisted: false,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_PLATFORM_SPIKE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to record platform session evidence.',
    );
  }
}

/** Reports internal release readiness and exits non-zero until every gate passes. */
export async function contextBeta(
  rootDir: string,
  options: ContextBetaOptions,
): Promise<number> {
  try {
    const result = await evaluateV3BetaGate(rootDir, {
      releaseCandidate: parseReleaseCandidate(options.releaseCandidate),
    });
    printV3Result(options.json, result);
    return result.ready ? EXIT_V3_OK : EXIT_V3_BLOCKED;
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_BETA_GATE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to evaluate release readiness.',
    );
  }
}

/** Implements `mancode context resume <namespace:id> ...`. */
export async function contextResume(
  rootDir: string,
  task: string | undefined,
  options: ContextResumeOptions,
): Promise<number> {
  if (task === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_TASK_REQUIRED',
      'context resume requires a TaskRef in namespace:ULID form.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const taskRef = parseTaskRef(task);
    let resolution = await resolveContext(project, session, {
      taskRef,
      level: 'bootstrap',
      purpose: 'orient',
      intent: 'mutate',
    });
    if (resolution.metadata === null || resolution.aggregate === null) {
      throw new Error('MANCODE_CONTEXT_WRITE_BLOCKED');
    }
    let resumed = session;
    let packIsCurrent = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      resumed = await resumeSession(project.projectRoot, session.sessionId, {
        taskRef: resolution.taskRef,
        workflowMode: resolution.metadata.workflowMode,
        taskRevision: resolution.aggregate.taskRevision,
      });
      resolution = await resolveContext(project, resumed, {
        taskRef,
        level: 'bootstrap',
        purpose: 'orient',
        intent: 'mutate',
      });
      if (resolution.metadata === null || resolution.aggregate === null) {
        throw new Error('MANCODE_CONTEXT_WRITE_BLOCKED');
      }
      if (resolution.aggregate.taskRevision === resumed.lastSeenRevision) {
        packIsCurrent = true;
        break;
      }
    }
    if (!packIsCurrent) throw new Error('MANCODE_CONTEXT_CHANGED');
    return printV3Result(options.json, {
      schemaVersion: 1,
      session: resumed,
      taskRef: resolution.taskRef,
      taskRevision: resolution.aggregate.taskRevision,
      pack: resolution.pack,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_RESUME_FAILED'),
      error instanceof Error ? error.message : 'Unable to resume context.',
    );
  }
}

/** Implements `mancode context show [--task ...] ...`. */
export async function contextShow(
  rootDir: string,
  options: ContextShowOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3ReadSession(project, options);
    const level = parseLevel(options.level);
    const purpose = parsePurpose(options.purpose);
    const resolution = await resolveContext(project, session, {
      taskRef:
        options.task === undefined ? undefined : parseTaskRef(options.task),
      level,
      purpose,
      intent: 'read',
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: resolution.taskRef,
      mutatingAllowed: resolution.mutatingAllowed,
      repair: resolution.repair,
      writeBlockers: resolution.writeBlockers,
      pack: resolution.pack,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_SHOW_FAILED'),
      error instanceof Error ? error.message : 'Unable to resolve context.',
    );
  }
}

export async function contextClose(
  rootDir: string,
  options: ContextCloseOptions,
): Promise<number> {
  if (options.session === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_SESSION_REQUIRED',
      'context close requires --session <id>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await closeSession(project.projectRoot, options.session);
    return printV3Result(options.json, { schemaVersion: 1, session });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_CLOSE_FAILED'),
      error instanceof Error ? error.message : 'Unable to close the session.',
    );
  }
}

/**
 * Explicitly registers the current checkout against an existing V3 workspace.
 * A read path must not manufacture a checkout identity, but a linked worktree
 * needs this one-time local registration before it can safely use common-dir
 * coordination.
 */
export async function contextWorktreeRegister(
  rootDir: string,
  options: ContextWorktreeRegisterOptions,
): Promise<number> {
  try {
    const store = new V3ContextStore(rootDir);
    const project = await store.readProjectSnapshot();
    if (project.manifest.activationState !== 'v3_active') {
      throw new Error('MANCODE_MIGRATION_REQUIRED');
    }
    const runtime = await ensureProjectRuntimeContext(rootDir);
    return printV3Result(options.json, {
      schemaVersion: 1,
      workspaceId: runtime.workspaceId,
      checkoutId: runtime.checkoutId,
      repositoryBindingId: runtime.repositoryBindingId,
      gitCommonDir: runtime.gitCommonDir,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_WORKTREE_REGISTER_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to register this worktree for mancode coordination.',
    );
  }
}

/** Reports every unfinished primary operation and can repair one explicitly. */
export async function contextDoctor(
  rootDir: string,
  options: ContextDoctorOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    if (options.repair === undefined) {
      const [operations, projections, gitRefWorkflowRepairs] =
        await Promise.all([
          listUnfinishedOperationRecoveries(project.projectRoot),
          listProjectionIntents(project.projectRoot),
          listGitRefWorkflowRepairs(project.projectRoot),
        ]);
      return printV3Result(options.json, {
        schemaVersion: 1,
        operations,
        projections,
        gitRefWorkflowRepairs,
      });
    }
    const session = await resolveV3CommandSession(project, options);
    const projectionIntents = await listProjectionIntents(project.projectRoot, {
      operationId: options.repair,
      includeTerminal: true,
    });
    let operation: Awaited<ReturnType<typeof executeOperationRecovery>> | null =
      null;
    let inspection: Awaited<
      ReturnType<typeof inspectOperationRecovery>
    > | null = null;
    let gitRefWorkflowRepair: Awaited<
      ReturnType<typeof recoverGitRefWorkflowRepair>
    > | null = null;
    try {
      inspection = await inspectOperationRecovery(
        project.projectRoot,
        options.repair,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'MANCODE_OPERATION_JOURNAL_NOT_FOUND'
      ) {
        throw error;
      }
    }
    if (
      inspection?.journal.state === 'committed' ||
      inspection?.journal.state === 'aborted'
    ) {
      operation = {
        state: 'already_terminal',
        journal: inspection.journal,
        reason: 'terminal',
      };
    } else if (inspection !== null) {
      operation = await executeOperationRecovery({
        projectRoot: project.projectRoot,
        operationId: options.repair,
        actorId: session.actorId,
        sessionId: session.sessionId,
        mode: 'repair',
      });
    }
    if (inspection === null && projectionIntents.length === 0) {
      try {
        gitRefWorkflowRepair = await recoverGitRefWorkflowRepair(
          project.projectRoot,
          options.repair,
          null,
          {
            actorId: session.actorId,
            sessionId: session.sessionId,
          },
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'MANCODE_REMOTE_WORKFLOW_REPAIR_JOURNAL_NOT_FOUND'
        ) {
          throw error;
        }
        throw new Error('MANCODE_OPERATION_JOURNAL_NOT_FOUND');
      }
    }
    const projections =
      projectionIntents.length === 0
        ? null
        : operation?.journal.state === 'aborted'
          ? await supersedeProjectionIntents(
              project.projectRoot,
              options.repair,
            )
          : await reconcileProjectionIntents(
              project.projectRoot,
              options.repair,
            );
    return printV3Result(options.json, {
      schemaVersion: 1,
      operation,
      projections,
      gitRefWorkflowRepair,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_DOCTOR_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to inspect repair state.',
    );
  }
}

/** Shows or explicitly disables the local-only, aggregate diagnostics store. */
export async function contextDiagnostics(
  rootDir: string,
  action: string | undefined,
  options: ContextDiagnosticsOptions,
): Promise<number> {
  if (
    action !== undefined &&
    action !== 'show' &&
    action !== 'enable' &&
    action !== 'disable'
  ) {
    return printV3Error(
      options.json,
      'MANCODE_DIAGNOSTICS_ACTION_INVALID',
      'Use: context diagnostics [show|enable|disable].',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    if (action === 'enable' || action === 'disable') {
      const config = await setLocalDiagnosticsEnabled(
        project.projectRoot,
        action === 'enable',
      );
      return printV3Result(options.json, {
        schemaVersion: 1,
        config,
        diagnostics:
          action === 'disable'
            ? null
            : await readLocalDiagnostics(project.projectRoot),
      });
    }
    return printV3Result(options.json, {
      schemaVersion: 1,
      config: await readLocalDiagnosticsConfig(project.projectRoot),
      diagnostics: await readLocalDiagnostics(project.projectRoot),
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_DIAGNOSTICS_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to manage local diagnostics.',
    );
  }
}

/** Lists retention candidates before deleting them; shared deletion is opt-in. */
export async function contextCompact(
  rootDir: string,
  options: ContextCompactOptions,
): Promise<number> {
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef =
      options.task === undefined ? undefined : parseTaskRef(options.task);
    const plan = await planContextCompaction({
      projectRoot: project.projectRoot,
      ...(taskRef === undefined ? {} : { taskRef }),
    });
    const includesShared = plan.candidates.some(
      (candidate) => candidate.taskRef?.namespace === 'shared',
    );
    const dryRun =
      options.dryRun === true ||
      (includesShared && options.applyShared !== true);
    const result = dryRun
      ? { ...plan, deleted: [] }
      : await applyContextCompaction(plan);
    return printV3Result(options.json, result);
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_COMPACT_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to compact mancode context.',
    );
  }
}

/** Implements `mancode context publish <local:ULID> ...`. */
export async function contextPublish(
  rootDir: string,
  task: string | undefined,
  options: ContextPublishOptions,
): Promise<number> {
  if (task === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_TASK_REQUIRED',
      'context publish requires a local TaskRef in local:ULID form.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const expectedSourceRevision = parseExpectedRevision(
    options.expectedRevision,
  );
  if (expectedSourceRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'context publish requires --expected-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  if (options.confirmShared !== true) {
    return printV3Error(
      options.json,
      'MANCODE_PRIVACY_CONFIRMATION_REQUIRED',
      'context publish requires --confirm-shared before authority enters shared storage.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  if (options.dryRun === true) {
    try {
      const project = await readV3CommandProject(rootDir);
      const session = await resolveV3CommandSession(project, options);
      const preview = await previewV3TaskPromotion({
        projectRoot: project.projectRoot,
        sourceTaskRef: parseTaskRef(task),
        sessionActorId: session.actorId,
        expectedSourceRevision,
        destinationWorkflowMode: 'man',
        client: commandClient(options.client),
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        dryRun: true,
        ...preview,
      });
    } catch (error) {
      return printV3Error(
        options.json,
        v3ErrorCode(error, 'MANCODE_CONTEXT_PUBLISH_FAILED'),
        error instanceof Error
          ? error.message
          : 'Unable to preview the local mancode task publish.',
      );
    }
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result = await promoteV3Task({
      projectRoot: project.projectRoot,
      sourceTaskRef: parseTaskRef(task),
      sessionId: session.sessionId,
      expectedSourceRevision,
      destinationWorkflowMode: 'man',
      sharedPrivacyConfirmed: true,
      client: commandClient(options.client),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      sourceMetadata: result.sourceMetadata,
      taskRef: result.destinationMetadata.taskRef,
      metadata: result.destinationMetadata,
      aggregate: result.destinationAggregate,
      taskHeadFence: result.destinationTaskHead,
      quarantine: result.quarantine,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_PUBLISH_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to publish the local mancode task.',
    );
  }
}

/** Implements explicit adoption of a Git-sourced shared task aggregate. */
export async function contextReconcileTaskHead(
  rootDir: string,
  task: string | undefined,
  options: ContextReconcileTaskHeadOptions,
): Promise<number> {
  if (task === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_TASK_REQUIRED',
      'context reconcile-task-head requires a shared TaskRef in shared:ULID form.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  const expectedFenceRevision = parseExpectedRevision(
    options.expectedFenceRevision,
  );
  if (expectedFenceRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'context reconcile-task-head requires --expected-fence-revision <positive integer>.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  if (options.fromGit !== true) {
    return printV3Error(
      options.json,
      'MANCODE_GIT_SOURCE_CONFIRMATION_REQUIRED',
      'context reconcile-task-head requires --from-git.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    if (options.dryRun === true) {
      const preview = await previewV3TaskHeadReconcile({
        projectRoot: project.projectRoot,
        taskRef: parseTaskRef(task),
        sessionActorId: session.actorId,
        expectedFenceRevision,
        fromGit: true,
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        dryRun: true,
        taskRef: preview.aggregate.taskRef,
        aggregate: preview.aggregate,
        currentTaskHeadFence: preview.currentTaskHeadFence,
        proposedTaskHeadFence: preview.proposedTaskHeadFence,
      });
    }
    const result = await reconcileV3TaskHead({
      projectRoot: project.projectRoot,
      taskRef: parseTaskRef(task),
      sessionId: session.sessionId,
      expectedFenceRevision,
      fromGit: true,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.aggregate.taskRef,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_CONTEXT_RECONCILE_TASK_HEAD_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to reconcile the mancode task head.',
    );
  }
}

async function resolveContext(
  project: Awaited<ReturnType<typeof readV3CommandProject>>,
  session: SessionStateV1 | null,
  request: {
    taskRef: ReturnType<typeof parseTaskRef> | undefined;
    level: ContextLevel;
    purpose: ContextPurpose;
    intent: 'read' | 'mutate';
  },
) {
  const resolver = new ContextResolver({
    projectRoot: project.projectRoot,
    entityHomeStoreContext: project.runtime.entityHomeStoreContext,
  });
  const capabilities =
    project.project.config.transport.mode === 'git-ref'
      ? capabilitiesFromGitRefCache(
          project.project.config,
          await readGitRefTeamCache(
            project.projectRoot,
            project.project.config,
          ),
        )
      : undefined;
  const adapterVersions = await inspectV3AdapterVersions(
    project.projectRoot,
    managedAdapterNames(project.project.manifest.managedAdapters),
  );
  return resolver.resolve({
    session,
    taskRef: request.taskRef,
    level: request.level,
    purpose: request.purpose,
    intent: request.intent,
    compatibility: {
      expectedSchemaEpoch: project.project.manifest.epoch,
      readerVersion: VERSION,
      writerVersion: VERSION,
      writerCapabilities: CURRENT_WRITER_CAPABILITIES,
      adapterVersions,
    },
    codeHead: await readCheckoutCodeHead(project.projectRoot),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

function parseLevel(value: string | undefined): ContextLevel {
  const level = value ?? 'task';
  if (level !== 'bootstrap' && level !== 'task' && level !== 'full') {
    throw new Error('MANCODE_CONTEXT_LEVEL_INVALID');
  }
  return level;
}

function parsePurpose(value: string | undefined): ContextPurpose {
  const purpose = value ?? 'orient';
  if (
    purpose !== 'orient' &&
    purpose !== 'plan' &&
    purpose !== 'implement' &&
    purpose !== 'review' &&
    purpose !== 'verify' &&
    purpose !== 'handoff'
  ) {
    throw new Error('MANCODE_CONTEXT_PURPOSE_INVALID');
  }
  return purpose;
}

function parseSpikePlatform(value: string | undefined): SessionSpikePlatform {
  if (
    value === undefined ||
    !SESSION_SPIKE_PLATFORMS.includes(value as SessionSpikePlatform)
  ) {
    throw new Error('MANCODE_PLATFORM_SPIKE_PLATFORM_REQUIRED');
  }
  return value as SessionSpikePlatform;
}

function parseHostSessionSource(value: string | undefined): HostSessionSource {
  if (
    value !== 'hook_stdin' &&
    value !== 'environment' &&
    value !== 'api' &&
    value !== 'none'
  ) {
    throw new Error('MANCODE_PLATFORM_SPIKE_HOST_SOURCE_REQUIRED');
  }
  return value;
}

function parseSpikeEvidenceStatus(
  value: string,
  label: string,
): SpikeEvidenceStatus {
  if (
    value !== 'proven' &&
    value !== 'not_proven' &&
    value !== 'not_tested' &&
    value !== 'not_applicable'
  ) {
    throw new Error(
      `MANCODE_PLATFORM_SPIKE_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`,
    );
  }
  return value;
}

function parseRequiredSpikeEvidenceStatus(
  value: string | undefined,
  label: string,
): SpikeEvidenceStatus {
  if (value === undefined) {
    throw new Error(
      `MANCODE_PLATFORM_SPIKE_${label.toUpperCase().replaceAll(' ', '_')}_REQUIRED`,
    );
  }
  return parseSpikeEvidenceStatus(value, label);
}

function parseHookApproval(value: string): HookApprovalStatus {
  if (
    value !== 'approved' &&
    value !== 'unapproved' &&
    value !== 'unknown' &&
    value !== 'not_applicable'
  ) {
    throw new Error('MANCODE_PLATFORM_SPIKE_HOOK_APPROVAL_INVALID');
  }
  return value;
}

function parseReleaseCandidate(value: string | undefined): string {
  if (
    value === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:+/@-]{5,127}$/.test(value)
  ) {
    throw new Error('MANCODE_BETA_RELEASE_CANDIDATE_REQUIRED');
  }
  return value;
}

function parseHostVersion(value: string | undefined): string {
  if (
    value === undefined ||
    !value.trim() ||
    value.includes('\0') ||
    value.trim().length > 256
  ) {
    throw new Error('MANCODE_PLATFORM_SPIKE_HOST_VERSION_REQUIRED');
  }
  return value.trim();
}

function parseExpectedRevision(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export { EXIT_V3_OK };
