import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeV3ChildResult } from '../context/child-result-merge.js';
import { type Ulid, assertUlid } from '../context/ids.js';
import { parseSchemaManifest } from '../context/manifest.js';
import { reviseV3Plan } from '../context/plan-revision.js';
import {
  previewV3TaskPromotion,
  promoteV3Task,
} from '../context/publish-promote.js';
import { reframeV3Workflow } from '../context/reframe.js';
import { finalizeV3Requirements } from '../context/requirements-finalize.js';
import { applyV3ReviewLedger } from '../context/review-remediation.js';
import { changeV3WorkflowScope } from '../context/scope-change.js';
import {
  completeV3SoloHandoff,
  startV3SoloHandoff,
} from '../context/solo-handoff.js';
import { completeV3Task } from '../context/task-complete.js';
import { formatTaskRef, parseTaskRef } from '../context/task-ref.js';
import { recordV3Verification } from '../context/verification-record.js';
import { createV3Workflow } from '../context/workflow-create.js';
import type { WorkflowMetadataV3 } from '../context/workflow-metadata.js';
import { updateV3Workflow } from '../context/workflow-update.js';
import { detectTeamAssessmentSignals } from '../system/detect-team.js';
import {
  parseRequirementsLedger,
  readRequirementsLedger,
  requirementsAreReady,
  requirementsDigest,
  writeRequirementsArtifacts,
} from '../system/requirements-ledger.js';
import {
  type ReviewLedger,
  completeReviewDomain,
  initializeReview,
  initializeSkippedReview,
  isReviewDepth,
  isReviewDomain,
  readReviewLedger,
  remediateReviewBlockers,
  reviewLedgerPath,
} from '../system/review-ledger.js';
import { upsertActivePlan } from '../system/team-memory.js';
import {
  type VerificationLedger,
  confirmManualVerification,
  initializeVerificationLedger,
  readVerificationLedger,
  recordVerification,
  resetVerificationForRemediation,
  verificationCanAdvance,
  verificationLedgerPath,
  writeVerificationLedger,
} from '../system/verification-ledger.js';
import {
  type WorkflowMeta,
  type WorkflowMode,
  createWorkflow,
  deleteWorkflow,
  isPlanDecision,
  isRequirementsStatus,
  isTerminalWorkflowStatus,
  isValidWorkflowTaskId,
  isWorkflowOutcome,
  isWorkflowStatus,
  listWorkflows,
  maxWorkflowStep,
  readWorkflow,
  updateWorkflow,
} from '../system/workflow.js';
import { assessTeam } from '../team/assessment.js';
import {
  changeGitRefWorkflowScope,
  completeGitRefTask,
  updateGitRefWorkflow,
} from '../team/git-ref-workflow-operation.js';
import { normalizeRequirementsInput } from './requirements-input.js';
import {
  commandClient,
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';

export const EXIT_OK = 0;
export const EXIT_NOT_INITIALIZED = 1;
export const EXIT_INVALID_ARG = 2;

export interface WorkflowOptions {
  dryRun?: boolean;
  olderThan?: string;
  json?: boolean;
  step?: string;
  status?: string;
  skipped?: string;
  parentTask?: string;
  parent?: string;
  participants?: string[];
  visibility?: string;
  coordination?: string;
  session?: string;
  client?: string;
  sync?: boolean;
  confirmShared?: boolean;
  expectedRevision?: string;
  childRevision?: string;
  summary?: string;
  nextAction?: string;
  blockingReason?: string;
  outcome?: string;
  planVersion?: string;
  reviewDepth?: string;
  reviewDomain?: string;
  report?: string;
  blockers?: string;
  resolved?: string;
  requirementsStatus?: string;
  planDecision?: string;
  to?: string;
  complete?: boolean;
  file?: string;
  acceptance?: string;
  method?: string;
  result?: string;
  evidence?: string;
  command?: string;
  exitCode?: string;
  evidenceFile?: string;
  reason?: string;
  checkpointId?: string;
}

interface WorkflowView extends WorkflowMeta {
  activeChildren?: WorkflowMeta[];
}

/**
 * `mancode workflow` 子命令。
 *
 * 支持：
 * - list：列出 workflow
 * - show <taskId>：显示详情
 * - review <taskId> <action>：管理有界审查状态
 * - clean [--dry-run] [--older-than 30d]：清理 workflow
 */
export async function workflow(
  rootDir: string,
  subcommand: string,
  args: string[] = [],
  options: WorkflowOptions = {},
): Promise<number> {
  const v3Activation = await readV3ActivationState(rootDir);
  if (v3Activation === 'v3_active') {
    return workflowV3(rootDir, subcommand, args, options);
  }
  if (!(await pathExists(path.join(rootDir, '.mancode', 'state.json')))) {
    if (v3Activation !== null) {
      return printV3Error(
        options.json,
        'MANCODE_V3_WRITE_REQUIRES_ACTIVATION',
        'This project has staged mancode context but remains in dual-read migration. Use legacy workflows until activation.',
      );
    }
    if (options.json) {
      console.log(JSON.stringify({ error: 'not initialized' }, null, 2));
    } else {
      console.error('✗  mancode not initialized.');
      console.error('   Run `mancode init` to get started.');
    }
    return EXIT_NOT_INITIALIZED;
  }

  switch (subcommand) {
    case 'create':
      return workflowCreate(rootDir, args, options);
    case 'update':
      return workflowUpdate(rootDir, args[0], options);
    case 'list':
      return workflowList(rootDir, options);
    case 'show':
      return workflowShow(rootDir, args[0], options);
    case 'handoff':
      return workflowHandoff(rootDir, args[0], options);
    case 'decide':
      return workflowDecide(rootDir, args[0], options);
    case 'review':
      return workflowReview(rootDir, args, options);
    case 'requirements':
      return workflowRequirements(rootDir, args, options);
    case 'verify':
      return workflowVerify(rootDir, args, options);
    case 'clean':
      return workflowClean(rootDir, options);
    default:
      if (options.json) {
        console.log(
          JSON.stringify(
            { error: `invalid subcommand: ${subcommand}` },
            null,
            2,
          ),
        );
      } else {
        console.error(`✗  Invalid workflow subcommand: ${subcommand}`);
        console.error(
          '   Use: create <man|manba|manteam> <task> | requirements <taskId> finalize --file <path> | verify <taskId> <init|record|require-manual|confirm-manual|show> | decide <taskId> --plan-decision <plan_only|governed_execution> | handoff <taskId> --to solo | review <taskId> <init|complete|remediate|skip|show> | list | show <taskId> | clean',
        );
      }
      return EXIT_INVALID_ARG;
  }
}

async function workflowV3(
  rootDir: string,
  subcommand: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  if (subcommand === 'list') {
    return workflowListV3(rootDir, args, options);
  }
  if (subcommand === 'show') {
    return workflowShowV3(rootDir, args, options);
  }
  if (subcommand === 'clean') {
    return workflowCleanV3(options);
  }
  if (subcommand === 'create') {
    return workflowCreateV3(rootDir, args, options);
  }
  if (subcommand === 'update') {
    return workflowUpdateV3(rootDir, args, options);
  }
  if (subcommand === 'requirements') {
    return workflowRequirementsV3(rootDir, args, options);
  }
  if (subcommand === 'plan') {
    return workflowPlanV3(rootDir, args, options);
  }
  if (subcommand === 'review') {
    return workflowReviewV3(rootDir, args, options);
  }
  if (subcommand === 'verify') {
    return workflowVerifyV3(rootDir, args, options);
  }
  if (subcommand === 'complete') {
    return workflowCompleteV3(rootDir, args, options);
  }
  if (subcommand === 'scope') {
    return workflowScopeChangeV3(rootDir, args, options);
  }
  if (subcommand === 'reframe') {
    return workflowReframeV3(rootDir, args, options);
  }
  if (subcommand === 'child') {
    return workflowChildResultMergeV3(rootDir, args, options);
  }
  if (subcommand === 'promote') {
    return workflowPromoteV3(rootDir, args, options);
  }
  if (subcommand === 'handoff') {
    return workflowSoloHandoffV3(rootDir, args, options);
  }
  return printV3Error(
    options.json,
    'MANCODE_V3_OPERATION_NOT_IMPLEMENTED',
    `workflow ${subcommand} is not yet implemented for mancode authority.`,
  );
}

async function workflowListV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  if (args.length !== 0) {
    return printV3Error(
      options.json,
      'MANCODE_WORKFLOW_LIST_ARGUMENT_INVALID',
      'Use: workflow list [--json].',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const workflows = await project.store.listWorkflowMetadata();
    if (options.json) {
      return printV3Result(true, {
        schemaVersion: 1,
        workflows,
      });
    }
    if (workflows.length === 0) {
      console.log('No mancode workflows.');
      return EXIT_OK;
    }
    const active = workflows.filter((item) =>
      ['in_progress', 'planned', 'blocked'].includes(item.status),
    ).length;
    console.log(
      `mancode workflows (${workflows.length} total, ${active} active)`,
    );
    console.log('');
    for (const metadata of workflows) {
      console.log(formatV3WorkflowRow(metadata));
    }
    return EXIT_OK;
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_WORKFLOW_LIST_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to list mancode workflows.',
    );
  }
}

async function workflowShowV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const requested = args[0];
  if (!requested || args.length !== 1) {
    return printV3Error(
      options.json,
      'MANCODE_WORKFLOW_SHOW_ARGUMENT_INVALID',
      'Use: workflow show <namespace:ULID> [--json].',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const location = await project.store.locateTask(requested);
    const [snapshot, activeChildren] = await Promise.all([
      project.store.readTaskSnapshot(location.taskRef),
      project.store.listActiveChildTaskRefs(location.taskRef),
    ]);
    const result = {
      schemaVersion: 1,
      taskRef: location.taskRef,
      metadata: snapshot.metadata,
      aggregate: snapshot.aggregate,
      aggregateError: snapshot.aggregateError,
      activeChildren,
    };
    if (options.json) return printV3Result(true, result);

    const metadata = snapshot.metadata;
    console.log(`Workflow:     ${formatTaskRef(metadata.taskRef)}`);
    console.log(`Task:         ${metadata.task}`);
    console.log(`Mode:         ${metadata.workflowMode}`);
    console.log(`Status:       ${metadata.status}`);
    console.log(
      `Current step: ${metadata.currentStep}/${maxV3WorkflowStep(metadata.workflowMode)}`,
    );
    console.log(`Revision:     ${metadata.revision}`);
    console.log(`Visibility:   ${metadata.visibility}`);
    console.log(`Coordination: ${metadata.coordination}`);
    console.log(`Updated:      ${metadata.updatedAt}`);
    if (metadata.blockingReason !== null) {
      console.log(`Blocked:      ${metadata.blockingReason}`);
    }
    if (activeChildren.length > 0) {
      console.log(
        `Children:     ${activeChildren.map(formatTaskRef).join(', ')}`,
      );
    }
    if (snapshot.aggregateError !== null) {
      console.log(`Aggregate:    ${snapshot.aggregateError}`);
    }
    return EXIT_OK;
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_WORKFLOW_SHOW_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to show the mancode workflow.',
    );
  }
}

function workflowCleanV3(options: WorkflowOptions): number {
  return printV3Error(
    options.json,
    'MANCODE_V3_WORKFLOW_CLEAN_UNSUPPORTED',
    'Continuity workflow authority is durable and is not deleted by workflow clean. Use `mancode context compact --dry-run` to inspect eligible runtime retention records.',
    EXIT_INVALID_ARG,
  );
}

function formatV3WorkflowRow(metadata: WorkflowMetadataV3): string {
  return [
    formatTaskRef(metadata.taskRef),
    metadata.workflowMode,
    metadata.status,
    `Step ${metadata.currentStep}/${maxV3WorkflowStep(metadata.workflowMode)}`,
    `r${metadata.revision}`,
    metadata.task,
  ].join('  ');
}

function maxV3WorkflowStep(mode: WorkflowMetadataV3['workflowMode']): number {
  return mode === 'manba' ? 5 : 9;
}

async function workflowUpdateV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  if (!task || args.length !== 1) {
    return printV3Error(
      options.json,
      'MANCODE_WORKFLOW_UPDATE_ARGUMENT_INVALID',
      'Use: workflow update <namespace:ULID> --expected-revision <n> --status <in_progress|planned|blocked|abandoned> [--blocking-reason <text>].',
      EXIT_INVALID_ARG,
    );
  }
  if (options.status === undefined && options.blockingReason === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_WORKFLOW_UPDATE_EMPTY',
      'Workflow update requires --status or --blocking-reason.',
      EXIT_INVALID_ARG,
    );
  }
  if (
    options.step !== undefined ||
    options.outcome !== undefined ||
    options.planVersion !== undefined ||
    options.requirementsStatus !== undefined ||
    options.planDecision !== undefined ||
    options.skipped !== undefined
  ) {
    return printV3Error(
      options.json,
      'MANCODE_V3_WORKFLOW_UPDATE_FIELD_UNSUPPORTED',
      'Workflow update only changes lifecycle status and a blocked reason. Use the dedicated requirements, plan, review, verification, scope, complete, or promote command for governed fields.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Workflow update requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const taskRef = parseTaskRef(task);
    if (
      project.project.config.transport.mode === 'git-ref' &&
      taskRef.namespace === 'shared'
    ) {
      if (options.sync !== true) {
        throw new Error('MANCODE_GIT_REF_SYNC_REQUIRED');
      }
      const session = await resolveV3CommandSession(project, options);
      const result = await updateGitRefWorkflow({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision,
        status: parseV3WorkflowUpdateStatus(options.status),
        ...(options.blockingReason === undefined
          ? {}
          : { blockingReason: options.blockingReason }),
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef: result.metadata.taskRef,
        metadata: result.metadata,
        aggregate: result.aggregate,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
        materialization: result.materialization,
      });
    }
    if (options.sync === true) {
      throw new Error('MANCODE_GIT_REF_SYNC_UNAVAILABLE');
    }
    const session = await resolveV3CommandSession(project, options);
    const result = await updateV3Workflow({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      status: parseV3WorkflowUpdateStatus(options.status),
      ...(options.blockingReason === undefined
        ? {}
        : { blockingReason: options.blockingReason }),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_WORKFLOW_UPDATE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to update the mancode workflow lifecycle.',
    );
  }
}

async function workflowChildResultMergeV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const action = args[0];
  const parentTask = args[1];
  const childTask = args[2];
  if (
    action !== 'merge' ||
    !parentTask ||
    !childTask ||
    args.length !== 3 ||
    options.summary === undefined ||
    options.nextAction === undefined
  ) {
    return printV3Error(
      options.json,
      'MANCODE_CHILD_RESULT_MERGE_ARGUMENT_INVALID',
      'Use: workflow child merge <parent-namespace:ULID> <child-namespace:ULID> --expected-revision <parent-revision> --child-revision <child-revision> --summary <text> --next-action <text>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedParentRevision = parseExpectedTaskRevision(options);
  const expectedChildRevision =
    options.childRevision === undefined
      ? null
      : parseExactPositiveInteger(options.childRevision);
  if (expectedParentRevision === null || expectedChildRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Child result merge requires positive --expected-revision and --child-revision values.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result = await mergeV3ChildResult({
      projectRoot: project.projectRoot,
      parentTaskRef: parseTaskRef(parentTask),
      childTaskRef: parseTaskRef(childTask),
      sessionId: session.sessionId,
      expectedParentRevision,
      expectedChildRevision,
      summary: options.summary,
      nextAction: options.nextAction,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      checkpoint: result.checkpoint,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_CHILD_RESULT_MERGE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to merge the mancode child diagnostic result.',
    );
  }
}

async function workflowSoloHandoffV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  if (
    !task ||
    args.length !== 1 ||
    (options.complete !== true && options.to !== 'solo')
  ) {
    return printV3Error(
      options.json,
      'MANCODE_SOLO_HANDOFF_ARGUMENT_INVALID',
      'Use: workflow handoff <local:ULID> --to solo --expected-revision <n>, or workflow handoff <local:ULID> --complete --expected-revision <n>.',
      EXIT_INVALID_ARG,
    );
  }
  if (options.complete === true && options.to !== undefined) {
    return printV3Error(
      options.json,
      'MANCODE_SOLO_HANDOFF_ARGUMENT_INVALID',
      '--complete and --to cannot be combined.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Solo handoff requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result =
      options.complete === true
        ? await completeV3SoloHandoff({
            projectRoot: project.projectRoot,
            taskRef: parseTaskRef(task),
            sessionId: session.sessionId,
            expectedTaskRevision,
          })
        : await startV3SoloHandoff({
            projectRoot: project.projectRoot,
            taskRef: parseTaskRef(task),
            sessionId: session.sessionId,
            expectedTaskRevision,
          });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      aggregate: result.aggregate,
      operation: result.operation,
      sessionPointerUpdated: result.sessionPointerUpdated,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_SOLO_HANDOFF_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to run the mancode solo handoff.',
    );
  }
}

async function workflowPromoteV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  if (!task || args.length !== 1 || options.to !== 'manteam') {
    return printV3Error(
      options.json,
      'MANCODE_PROMOTION_ARGUMENT_INVALID',
      'Use: workflow promote <local:ULID> --to manteam --expected-revision <n> --confirm-shared.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedSourceRevision = parseExpectedTaskRevision(options);
  if (expectedSourceRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Workflow promote requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  if (options.confirmShared !== true) {
    return printV3Error(
      options.json,
      'MANCODE_PRIVACY_CONFIRMATION_REQUIRED',
      'Workflow promote requires --confirm-shared before authority enters shared storage.',
      EXIT_INVALID_ARG,
    );
  }
  if (options.sync === true) {
    return printV3Error(
      options.json,
      'MANCODE_GIT_REF_TRANSPORT_NOT_IMPLEMENTED',
      'Git-ref transport is not implemented for workflow promote.',
      EXIT_INVALID_ARG,
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
        destinationWorkflowMode: 'manteam',
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
        v3ErrorCode(error, 'MANCODE_V3_WORKFLOW_PROMOTE_FAILED'),
        error instanceof Error
          ? error.message
          : 'Unable to preview the mancode workflow promotion.',
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
      destinationWorkflowMode: 'manteam',
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
      v3ErrorCode(error, 'MANCODE_V3_WORKFLOW_PROMOTE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to promote the local mancode workflow.',
    );
  }
}

async function workflowScopeChangeV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const action = args[0];
  const task = args[1];
  if (action !== 'change' || !task || args.length !== 2 || !options.file) {
    return printV3Error(
      options.json,
      'MANCODE_SCOPE_CHANGE_ARGUMENT_INVALID',
      'Use: workflow scope change <shared:ULID> --expected-revision <n> --file <scope.json>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Workflow scope change requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const taskRef = parseTaskRef(task);
    const scope = await readWorkflowJsonInputFile(
      project.projectRoot,
      options.file,
    );
    if (
      project.project.config.transport.mode === 'git-ref' &&
      taskRef.namespace === 'shared'
    ) {
      if (options.sync !== true) {
        throw new Error('MANCODE_GIT_REF_SYNC_REQUIRED');
      }
      const result = await changeGitRefWorkflowScope({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision,
        scope,
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef: result.metadata.taskRef,
        metadata: result.metadata,
        checkpoint: result.checkpoint,
        terminatedClaims: result.terminatedClaims,
        successorClaims: result.successorClaims,
        aggregate: result.aggregate,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
        materialization: result.materialization,
      });
    }
    if (options.sync === true) {
      throw new Error('MANCODE_GIT_REF_SYNC_UNAVAILABLE');
    }
    const result = await changeV3WorkflowScope({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      scope,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      checkpoint: result.checkpoint,
      terminatedClaims: result.terminatedClaims,
      successorClaims: result.successorClaims,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_SCOPE_CHANGE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to change the mancode workflow scope.',
    );
  }
}

async function workflowReframeV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  if (!task || args.length !== 1) {
    return printV3Error(
      options.json,
      'MANCODE_REFRAME_ARGUMENT_INVALID',
      'Use: workflow reframe <namespace:ULID> --expected-revision <n> --checkpoint-id <ULID>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Workflow reframe requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  if (!options.checkpointId) {
    return printV3Error(
      options.json,
      'MANCODE_REFRAME_CHECKPOINT_REQUIRED',
      'Workflow reframe requires --checkpoint-id <ULID>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    assertUlid(options.checkpointId, 'checkpointId');
    const result = await reframeV3Workflow({
      projectRoot: project.projectRoot,
      taskRef: parseTaskRef(task),
      sessionId: session.sessionId,
      expectedTaskRevision,
      checkpointId: options.checkpointId,
      summary: options.summary,
      nextAction: options.nextAction,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      requirements: result.requirements,
      review: result.review,
      verification: result.verification,
      checkpoint: result.checkpoint,
      releasedClaims: result.releasedClaims,
      archive: result.archive,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_REFRAME_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to reframe the mancode workflow.',
    );
  }
}

async function workflowCompleteV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  if (!task || args.length !== 1) {
    return printV3Error(
      options.json,
      'MANCODE_COMPLETE_ARGUMENT_INVALID',
      'Use: workflow complete <namespace:ULID> --expected-revision <n> [--outcome <manba-outcome>].',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Task completion requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const taskRef = parseTaskRef(task);
    if (
      project.project.config.transport.mode === 'git-ref' &&
      taskRef.namespace === 'shared'
    ) {
      if (options.sync !== true) {
        throw new Error('MANCODE_GIT_REF_SYNC_REQUIRED');
      }
      const result = await completeGitRefTask({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision,
        outcome: parseV3Outcome(options.outcome),
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        taskRef: result.metadata.taskRef,
        metadata: result.metadata,
        releasedClaims: result.releasedClaims,
        aggregate: result.aggregate,
        remoteRevision: result.remoteRevision,
        ownershipEpoch: result.ownershipEpoch,
        receipt: result.receipt,
        materialization: result.materialization,
      });
    }
    if (options.sync === true) {
      throw new Error('MANCODE_GIT_REF_SYNC_UNAVAILABLE');
    }
    const result = await completeV3Task({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      outcome: parseV3Outcome(options.outcome),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      releasedClaims: result.releasedClaims,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_TASK_COMPLETE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to complete the mancode task.',
    );
  }
}

async function workflowVerifyV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  const action = args[1];
  if (!task || action !== 'apply' || !options.file) {
    return printV3Error(
      options.json,
      'MANCODE_VERIFICATION_ARGUMENT_INVALID',
      'Use: workflow verify <namespace:ULID> apply --expected-revision <n> --file <verification-ledger.json>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Verification mutation requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result = await recordV3Verification({
      projectRoot: project.projectRoot,
      taskRef: parseTaskRef(task),
      sessionId: session.sessionId,
      expectedTaskRevision,
      verification: await readWorkflowJsonInputFile(
        project.projectRoot,
        options.file,
      ),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      verification: result.verification,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_VERIFICATION_RECORD_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to record mancode verification.',
    );
  }
}

async function workflowReviewV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  const action = args[1];
  if (!task || action !== 'apply' || !options.file) {
    return printV3Error(
      options.json,
      'MANCODE_REVIEW_ARGUMENT_INVALID',
      'Use: workflow review <namespace:ULID> apply --expected-revision <n> --file <review-ledger.json>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Review mutation requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const result = await applyV3ReviewLedger({
      projectRoot: project.projectRoot,
      taskRef: parseTaskRef(task),
      sessionId: session.sessionId,
      expectedTaskRevision,
      review: await readWorkflowJsonInputFile(
        project.projectRoot,
        options.file,
      ),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      review: result.review,
      verification: result.verification,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_REVIEW_APPLY_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to apply the mancode review.',
    );
  }
}

async function workflowPlanV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  const action = args[1];
  if (!task || (action !== 'revise' && action !== 'confirm')) {
    return printV3Error(
      options.json,
      'MANCODE_PLAN_ARGUMENT_INVALID',
      'Use: workflow plan <namespace:ULID> revise --expected-revision <n> --file <path>, or confirm --expected-revision <n> --plan-decision <plan_only|governed_execution>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Plan mutation requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  if (action === 'revise' && !options.file) {
    return printV3Error(
      options.json,
      'MANCODE_PLAN_FILE_REQUIRED',
      'workflow plan revise requires --file <path>.',
      EXIT_INVALID_ARG,
    );
  }
  if (action === 'confirm' && options.planDecision === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_PLAN_DECISION_REQUIRED',
      'workflow plan confirm requires --plan-decision plan_only or governed_execution.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const taskRef = parseTaskRef(task);
    const plan =
      action === 'revise'
        ? await readWorkflowInputFile(
            project.projectRoot,
            options.file as string,
          )
        : (await project.store.readTaskSnapshot(taskRef)).plan?.content;
    if (plan === undefined || plan === null) {
      throw new Error('MANCODE_PLAN_FILE_REQUIRED');
    }
    const result = await reviseV3Plan({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      plan,
      planDecision: parseV3PlanDecision(options.planDecision),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      planDigest: result.planDigest,
      review: result.review,
      verification: result.verification,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_PLAN_REVISION_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to revise the mancode plan.',
    );
  }
}

async function workflowRequirementsV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const task = args[0];
  const action = args[1];
  if (!task || action !== 'finalize' || !options.file) {
    return printV3Error(
      options.json,
      'MANCODE_REQUIREMENTS_ARGUMENT_INVALID',
      'Use: workflow requirements <namespace:ULID> finalize --expected-revision <n> --file <path>.',
      EXIT_INVALID_ARG,
    );
  }
  const expectedTaskRevision = parseExpectedTaskRevision(options);
  if (expectedTaskRevision === null) {
    return printV3Error(
      options.json,
      'MANCODE_EXPECTED_REVISION_REQUIRED',
      'Requirements finalization requires --expected-revision <positive integer>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const taskRef = parseTaskRef(task);
    const requirementsInput = await readWorkflowJsonInputFile(
      project.projectRoot,
      options.file,
    );
    const requirements = normalizeRequirementsInput(requirementsInput, taskRef);
    const result = await finalizeV3Requirements({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
      requirements,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.metadata.taskRef,
      metadata: result.metadata,
      requirements: result.requirements,
      review: result.review,
      verification: result.verification,
      aggregate: result.aggregate,
      taskHeadFence: result.taskHeadFence,
      operation: result.operation,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_REQUIREMENTS_FINALIZE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to finalize mancode requirements.',
    );
  }
}

function parseExpectedTaskRevision(options: WorkflowOptions): number | null {
  return options.expectedRevision === undefined
    ? null
    : parseExactPositiveInteger(options.expectedRevision);
}

function parseV3PlanDecision(
  value: string | undefined,
): 'plan_only' | 'governed_execution' | undefined {
  if (value === undefined) return undefined;
  if (value === 'plan_only' || value === 'governed_execution') return value;
  throw new Error('MANCODE_PLAN_DECISION_INVALID');
}

function parseV3Outcome(
  value: string | undefined,
): 'fixed' | 'verified' | 'no_repro' | 'manual_test_required' | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'fixed' ||
    value === 'verified' ||
    value === 'no_repro' ||
    value === 'manual_test_required'
  ) {
    return value;
  }
  throw new Error('MANCODE_WORKFLOW_OUTCOME_INVALID');
}

function parseV3WorkflowUpdateStatus(
  value: string | undefined,
):
  | 'in_progress'
  | 'planned'
  | 'blocked'
  | 'abandoned'
  | 'completed'
  | 'superseded'
  | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'in_progress' ||
    value === 'planned' ||
    value === 'blocked' ||
    value === 'abandoned' ||
    value === 'completed' ||
    value === 'superseded'
  ) {
    return value;
  }
  throw new Error('MANCODE_WORKFLOW_STATUS_INVALID');
}

function parseV3ParticipantActorIds(
  values: string[] | undefined,
): Ulid[] | undefined {
  if (values === undefined) return undefined;
  for (const value of values) {
    assertUlid(value, 'workflow participant actorId');
  }
  return values;
}

async function readWorkflowInputFile(
  projectRoot: string,
  value: string,
): Promise<string> {
  const inputPath = path.isAbsolute(value)
    ? value
    : path.resolve(projectRoot, value);
  return readFile(inputPath, 'utf8');
}

async function readWorkflowJsonInputFile(
  projectRoot: string,
  value: string,
): Promise<unknown> {
  return JSON.parse(await readWorkflowInputFile(projectRoot, value));
}

async function workflowCreateV3(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const workflowMode = args[0];
  const task = args.slice(1).join(' ').trim();
  if (!task || workflowMode === undefined) {
    return printV3Error(
      options.json,
      'MANCODE_WORKFLOW_CREATE_ARGUMENT_INVALID',
      'Use: workflow create <man|manba|manteam> <task>.',
      EXIT_INVALID_ARG,
    );
  }
  try {
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    const parentOption = options.parent ?? options.parentTask;
    if (options.parentTask !== undefined && options.parent === undefined) {
      throw new Error(
        'MANCODE_TASK_REF_REQUIRED: use --parent local:<ULID> or shared:<ULID>',
      );
    }
    const assessment = assessTeam({
      policy: project.project.policy.policy,
      signals: await detectTeamAssessmentSignals(
        project.projectRoot,
        project.project.policy.recentDays,
      ),
      evaluatedAt: new Date().toISOString(),
    });
    const result = await createV3Workflow({
      projectRoot: project.projectRoot,
      task,
      workflowMode: parseV3WorkflowMode(workflowMode),
      sessionId: session.sessionId,
      client: commandClient(options.client),
      parentTaskRef:
        parentOption === undefined ? null : parseTaskRef(parentOption),
      visibility: parseV3Visibility(options.visibility),
      coordination: parseV3Coordination(options.coordination),
      participantActorIds: parseV3ParticipantActorIds(options.participants),
      sharedPrivacyConfirmed: options.confirmShared === true,
      assessment,
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      taskRef: result.taskRef,
      metadata: result.metadata,
      operation: result.operation,
      dimensions: result.resolution.dimensions,
      assessment: result.resolution.assessment,
      sessionResumed: result.sessionResumed,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_V3_WORKFLOW_CREATE_FAILED'),
      error instanceof Error
        ? error.message
        : 'Unable to create mancode workflow.',
    );
  }
}

async function readV3ActivationState(
  rootDir: string,
): Promise<'v3_active' | 'other' | null> {
  try {
    const manifest = parseSchemaManifest(
      JSON.parse(
        await readFile(path.join(rootDir, '.mancode', 'schema.json'), 'utf8'),
      ),
    );
    return manifest.activationState === 'v3_active' ? 'v3_active' : 'other';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseV3WorkflowMode(value: string): 'man' | 'manba' | 'manteam' {
  if (value !== 'man' && value !== 'manba' && value !== 'manteam') {
    throw new Error('MANCODE_WORKFLOW_MODE_INVALID');
  }
  return value;
}

function parseV3Visibility(
  value: string | undefined,
): 'local' | 'shared' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'local' && value !== 'shared') {
    throw new Error('MANCODE_WORKFLOW_VISIBILITY_INVALID');
  }
  return value;
}

function parseV3Coordination(
  value: string | undefined,
): 'single' | 'team' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'single' && value !== 'team') {
    throw new Error('MANCODE_WORKFLOW_COORDINATION_INVALID');
  }
  return value;
}

async function workflowRequirements(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const taskId = args[0];
  const action = args[1];
  if (!taskId || !isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId ?? ''}`);
  }
  if (action !== 'finalize' || !options.file) {
    return invalidArg(options, 'requirements requires finalize --file <path>');
  }
  const meta = await readWorkflow(rootDir, taskId);
  if (
    !meta ||
    (meta.mode !== 'man' && meta.mode !== 'manteam') ||
    meta.status !== 'in_progress' ||
    meta.currentStep > 2
  ) {
    return invalidArg(
      options,
      'requirements can only be finalized for an in-progress man or manteam workflow at step 1 or 2',
    );
  }

  const workflowPath = path.join(rootDir, '.mancode', 'workflows', taskId);
  const jsonPath = path.join(workflowPath, 'requirements.json');
  const markdownPath = path.join(workflowPath, 'requirements.md');
  const metadataPath = path.join(workflowPath, 'metadata.json');
  let originalJson: string | null | undefined;
  let originalMarkdown: string | null | undefined;
  let originalMetadata: string | undefined;
  try {
    const inputPath = path.isAbsolute(options.file)
      ? options.file
      : path.resolve(rootDir, options.file);
    const input = await readFile(inputPath, 'utf-8');
    const requirements = parseRequirementsLedger(input);
    [originalJson, originalMarkdown, originalMetadata] = await Promise.all([
      readOptionalText(jsonPath),
      readOptionalText(markdownPath),
      readFile(metadataPath, 'utf-8'),
    ]);
    await writeRequirementsArtifacts(rootDir, taskId, requirements);
    await updateWorkflow(rootDir, taskId, {
      requirementsStatus: requirementsAreReady(requirements)
        ? 'ready'
        : 'needs_clarification',
      requirementsDigest: requirementsDigest(requirements),
    });
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            requirements,
            requirementsStatus: requirementsAreReady(requirements)
              ? 'ready'
              : 'needs_clarification',
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `Finalized requirements: ${taskId} (${requirementsAreReady(requirements) ? 'ready' : 'needs_clarification'})`,
      );
    }
    return EXIT_OK;
  } catch (error) {
    let rollbackIncomplete = false;
    if (
      originalJson !== undefined &&
      originalMarkdown !== undefined &&
      originalMetadata !== undefined
    ) {
      const rollback = await Promise.allSettled([
        restoreOptionalText(jsonPath, originalJson),
        restoreOptionalText(markdownPath, originalMarkdown),
        writeFile(metadataPath, originalMetadata, 'utf-8'),
      ]);
      rollbackIncomplete = rollback.some(
        (result) => result.status === 'rejected',
      );
    }
    const message =
      error instanceof Error
        ? error.message
        : 'unable to finalize requirements';
    return invalidArg(
      options,
      rollbackIncomplete ? `${message}; rollback was incomplete` : message,
    );
  }
}

async function workflowVerify(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const taskId = args[0];
  const action = args[1];
  if (!taskId || !isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId ?? ''}`);
  }
  const meta = await readWorkflow(rootDir, taskId);
  if (!meta || (meta.mode !== 'man' && meta.mode !== 'manteam')) {
    return invalidArg(options, `verification is not valid for: ${taskId}`);
  }
  if (action === 'show') {
    const ledger = await readVerificationLedger(rootDir, taskId);
    if (!ledger) {
      return invalidArg(options, `verification not initialized: ${taskId}`);
    }
    outputVerificationLedger(ledger, options);
    return EXIT_OK;
  }
  if (
    meta.verificationPolicyVersion !== 1 ||
    (action === 'init'
      ? meta.currentStep !== 6
      : meta.currentStep !== 6 && meta.currentStep !== 9) ||
    meta.planDecision !== 'governed_execution' ||
    (meta.status !== 'in_progress' && meta.status !== 'blocked')
  ) {
    return invalidArg(
      options,
      'verification requires a governed policy-v2 workflow at step 6, or step 9 when refreshing evidence',
    );
  }

  try {
    let ledger: VerificationLedger;
    if (action === 'init') {
      if (await readVerificationLedger(rootDir, taskId)) {
        return invalidArg(
          options,
          `verification already initialized: ${taskId}`,
        );
      }
      const requirements = await readRequirementsLedger(rootDir, taskId);
      if (!requirements || !requirementsAreReady(requirements)) {
        return invalidArg(options, 'ready requirements.json is required');
      }
      ledger = initializeVerificationLedger(
        requirements,
        meta.planVersion ?? 1,
        0,
      );
    } else {
      let existing = await readVerificationLedger(rootDir, taskId);
      if (!existing) {
        return invalidArg(options, `verification not initialized: ${taskId}`);
      }
      const review = await readReviewLedger(rootDir, taskId);
      existing = resetVerificationForRemediation(
        existing,
        review?.remediationRounds ?? 0,
      );
      if (!options.acceptance || !options.evidence) {
        return invalidArg(
          options,
          `${action ?? 'verification'} requires --acceptance and --evidence`,
        );
      }
      if (action === 'record') {
        if (
          options.method !== 'automated' ||
          (options.result !== 'passed' &&
            options.result !== 'failed' &&
            options.result !== 'blocked')
        ) {
          return invalidArg(
            options,
            'record requires --method automated and --result passed|failed|blocked',
          );
        }
        let automatedDetails:
          | { command: string; exitCode: number; evidenceFile?: string }
          | undefined;
        if (options.result === 'passed' || options.result === 'failed') {
          const exitCode = parseExactInteger(options.exitCode);
          if (!options.command?.trim() || exitCode === null) {
            return invalidArg(
              options,
              'automated passed/failed verification requires --command and --exit-code',
            );
          }
          if (options.evidenceFile) {
            const evidencePath = path.isAbsolute(options.evidenceFile)
              ? options.evidenceFile
              : path.resolve(rootDir, options.evidenceFile);
            if (!(await pathExists(evidencePath))) {
              return invalidArg(
                options,
                `verification evidence file not found: ${options.evidenceFile}`,
              );
            }
          }
          automatedDetails = {
            command: options.command,
            exitCode,
            ...(options.evidenceFile
              ? { evidenceFile: options.evidenceFile }
              : {}),
          };
        }
        ledger = recordVerification(
          existing,
          options.acceptance,
          'automated',
          options.result,
          options.evidence,
          automatedDetails,
        );
      } else if (action === 'require-manual') {
        ledger = recordVerification(
          existing,
          options.acceptance,
          'manual',
          'manual_required',
          options.evidence,
        );
      } else if (action === 'confirm-manual') {
        ledger = confirmManualVerification(
          existing,
          options.acceptance,
          options.evidence,
        );
      } else {
        return invalidArg(
          options,
          `invalid verification action: ${action ?? ''}`,
        );
      }
    }

    const transitionError = await commitVerificationTransition(
      rootDir,
      meta,
      ledger,
    );
    if (transitionError) return invalidArg(options, transitionError);
    outputVerificationLedger(ledger, options);
    return EXIT_OK;
  } catch (error) {
    return invalidArg(
      options,
      error instanceof Error ? error.message : 'unable to update verification',
    );
  }
}

async function commitVerificationTransition(
  rootDir: string,
  meta: WorkflowMeta,
  ledger: VerificationLedger,
): Promise<string | null> {
  const ledgerPath = verificationLedgerPath(rootDir, meta.taskId);
  const metadataPath = path.join(
    rootDir,
    '.mancode',
    'workflows',
    meta.taskId,
    'metadata.json',
  );
  const specPath = path.join(rootDir, '.mancode', 'memory', 'spec.md');
  const [originalLedger, originalMetadata, originalSpec] = await Promise.all([
    readOptionalText(ledgerPath),
    readFile(metadataPath, 'utf-8'),
    readOptionalText(specPath),
  ]);
  const wasVerificationBlocked =
    meta.status === 'blocked' &&
    meta.blockingReason?.startsWith('[verification]');
  const shouldBlock =
    ledger.status === 'manual_required' || ledger.status === 'blocked';
  const workflowPatch: Partial<WorkflowMeta> = {
    verificationStatus: ledger.status,
    ...(shouldBlock
      ? {
          status: 'blocked',
          blockingReason: `[verification] ${ledger.status === 'manual_required' ? 'manual confirmation required' : 'verification blocked'}`,
        }
      : wasVerificationBlocked
        ? { status: 'in_progress', blockingReason: undefined }
        : {}),
  };
  try {
    await writeVerificationLedger(rootDir, meta.taskId, ledger);
    await updateWorkflow(rootDir, meta.taskId, workflowPatch, {
      allowIncompleteVerification: true,
    });
    const updated = await readWorkflow(rootDir, meta.taskId);
    if (updated) {
      await upsertActivePlan(rootDir, {
        taskId: updated.taskId,
        status: updated.status,
        planVersion: updated.planVersion ?? 1,
      });
    }
    return null;
  } catch (error) {
    const rollback = await Promise.allSettled([
      restoreOptionalText(ledgerPath, originalLedger),
      writeFile(metadataPath, originalMetadata, 'utf-8'),
      restoreOptionalText(specPath, originalSpec),
    ]);
    const message =
      error instanceof Error ? error.message : 'verification transition failed';
    return rollback.some((result) => result.status === 'rejected')
      ? `${message}; rollback was incomplete`
      : message;
  }
}

function outputVerificationLedger(
  ledger: VerificationLedger,
  options: WorkflowOptions,
): void {
  if (options.json) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }
  const passed = ledger.checks.filter((check) =>
    [check.automated, check.manual]
      .filter(Boolean)
      .every((component) => component?.status === 'passed'),
  ).length;
  console.log(
    `Verification: ${ledger.status}; criteria ${passed}/${ledger.checks.length}; plan v${ledger.planVersion}`,
  );
}

async function workflowReview(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const taskId = args[0];
  const action = args[1];
  if (!taskId || !isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId ?? ''}`);
  }
  const meta = await readWorkflow(rootDir, taskId);
  if (!meta) return invalidArg(options, `workflow not found: ${taskId}`);
  if (meta.mode !== 'man' && meta.mode !== 'manteam') {
    return invalidArg(options, 'review is only valid for man or manteam');
  }
  if (action === 'show') {
    const ledger = await readReviewLedger(rootDir, taskId);
    if (!ledger)
      return invalidArg(options, `review not initialized: ${taskId}`);
    outputReviewLedger(ledger, options);
    return EXIT_OK;
  }
  if (meta.status !== 'in_progress' || meta.currentStep < 6) {
    return invalidArg(
      options,
      'review requires an in_progress workflow at step 6 or later',
    );
  }
  if (
    (action === 'init' || action === 'skip') &&
    meta.verificationPolicyVersion === 1 &&
    !(await verificationCanAdvance(rootDir, taskId, meta.planVersion ?? 1))
  ) {
    return invalidArg(
      options,
      'workflow verification must pass before review can start',
    );
  }

  if (action === 'skip') {
    if (
      meta.reviewPolicyVersion !== 2 ||
      meta.currentStep !== 6 ||
      meta.planDecision !== 'governed_execution' ||
      !options.reason?.trim()
    ) {
      return invalidArg(
        options,
        'review skip requires a governed policy-v2 workflow at step 6 and --reason',
      );
    }
    try {
      const error = await commitReviewSkip(
        rootDir,
        meta,
        options.reason.trim(),
      );
      if (error) return invalidArg(options, error);
      const ledger = await readReviewLedger(rootDir, taskId);
      outputReviewLedger(ledger, options);
      return EXIT_OK;
    } catch (error) {
      return invalidArg(
        options,
        error instanceof Error ? error.message : 'unable to skip review',
      );
    }
  }

  try {
    let ledger: ReviewLedger;
    if (action === 'init') {
      if (!isReviewDepth(options.reviewDepth)) {
        return invalidArg(
          options,
          `invalid --review-depth: ${options.reviewDepth ?? ''}`,
        );
      }
      if (
        options.reviewDomain !== undefined &&
        !isReviewDomain(options.reviewDomain)
      ) {
        return invalidArg(
          options,
          `invalid --review-domain: ${options.reviewDomain}`,
        );
      }
      ledger = await initializeReview(
        rootDir,
        taskId,
        options.reviewDepth,
        isReviewDomain(options.reviewDomain) ? options.reviewDomain : undefined,
      );
    } else if (action === 'complete') {
      if (!isReviewDomain(options.reviewDomain) || !options.report) {
        return invalidArg(
          options,
          'review complete requires --review-domain and --report',
        );
      }
      ledger = await completeReviewDomain(
        rootDir,
        taskId,
        options.reviewDomain,
        options.report,
        parseCsv(options.blockers),
      );
    } else if (action === 'remediate') {
      ledger = await remediateReviewBlockers(
        rootDir,
        taskId,
        parseCsv(options.resolved),
      );
    } else {
      return invalidArg(
        options,
        `invalid review action: ${action ?? ''}`,
        'Use: mancode workflow review <taskId> <init|complete|remediate|skip|show>',
      );
    }
    outputReviewLedger(ledger, options);
    return EXIT_OK;
  } catch (error) {
    return invalidArg(
      options,
      error instanceof Error ? error.message : 'unable to update review',
    );
  }
}

async function commitReviewSkip(
  rootDir: string,
  meta: WorkflowMeta,
  reason: string,
): Promise<string | null> {
  const ledgerPath = reviewLedgerPath(rootDir, meta.taskId);
  const metadataPath = path.join(
    rootDir,
    '.mancode',
    'workflows',
    meta.taskId,
    'metadata.json',
  );
  const [originalLedger, originalMetadata] = await Promise.all([
    readOptionalText(ledgerPath),
    readFile(metadataPath, 'utf-8'),
  ]);
  try {
    await initializeSkippedReview(rootDir, meta.taskId, reason);
    await updateWorkflow(rootDir, meta.taskId, {
      skippedSteps: [...new Set([...meta.skippedSteps, 'review'])],
    });
    return null;
  } catch (error) {
    const rollback = await Promise.allSettled([
      restoreOptionalText(ledgerPath, originalLedger),
      writeFile(metadataPath, originalMetadata, 'utf-8'),
    ]);
    const message =
      error instanceof Error ? error.message : 'review skip failed';
    return rollback.some((result) => result.status === 'rejected')
      ? `${message}; rollback was incomplete`
      : message;
  }
}

function outputReviewLedger(
  ledger: Awaited<ReturnType<typeof readReviewLedger>>,
  options: WorkflowOptions,
): void {
  if (options.json) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }
  if (!ledger) return;
  if (ledger.skipped) {
    console.log(`Review: skipped; reason ${ledger.skipped.reason}`);
    return;
  }
  const openBlockers = ledger.blockers.filter(
    (blocker) => blocker.status === 'open',
  );
  console.log(
    `Review: ${ledger.depth}; domains ${ledger.completedDomains.length}/${ledger.requiredDomains.length}; open blockers ${openBlockers.length}; remediation ${ledger.remediationRounds}/1`,
  );
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function workflowCreate(
  rootDir: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  const requestedMode = args[0];
  const mode = parsePublicWorkflowMode(requestedMode);
  const task = args.slice(1).join(' ').trim();
  if (!mode) {
    return invalidArg(
      options,
      `invalid workflow mode: ${requestedMode ?? ''}`,
      'Use: mancode workflow create <man|manba|manteam> <task> [--parent-task <taskId>]',
    );
  }
  if (!task) {
    return invalidArg(
      options,
      'missing workflow task',
      'Use: mancode workflow create <man|manba|manteam> <task> [--parent-task <taskId>]',
    );
  }

  try {
    const meta = await createWorkflow(rootDir, task, mode, {
      parentTaskId: options.parentTask,
      planningPolicyVersion:
        mode === 'man' || mode === 'manteam' ? 2 : undefined,
    });
    if (options.json) {
      console.log(JSON.stringify(meta, null, 2));
    } else {
      console.log(`Created workflow: ${meta.taskId}`);
    }
  } catch (error) {
    return invalidArg(
      options,
      error instanceof Error ? error.message : 'unable to create workflow',
    );
  }
  return EXIT_OK;
}

async function workflowUpdate(
  rootDir: string,
  taskId: string | undefined,
  options: WorkflowOptions,
): Promise<number> {
  if (!taskId) {
    return invalidArg(
      options,
      'missing taskId',
      'Use: mancode workflow update <taskId> [--step N] [--status in_progress|planned|completed|blocked|abandoned] [--requirements-status ready|needs_clarification] [--blocking-reason <reason>] [--outcome <outcome>] [--plan-version N] [--skipped clarification]',
    );
  }
  if (!isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId}`);
  }

  const existing = await readWorkflow(rootDir, taskId);
  if (!existing) {
    return invalidArg(options, `workflow not found: ${taskId}`);
  }

  const patch: Partial<WorkflowMeta> = {};
  if (options.step !== undefined) {
    const currentStep = parseExactPositiveInteger(options.step);
    const maxStep = maxWorkflowStep(existing.mode);
    if (currentStep === null || currentStep < 1 || currentStep > maxStep) {
      return invalidArg(options, `invalid --step: ${options.step}`);
    }
    patch.currentStep = currentStep;
  }

  if (options.status !== undefined) {
    if (!isWorkflowStatus(options.status)) {
      return invalidArg(options, `invalid --status: ${options.status}`);
    }
    patch.status = options.status;
  }

  const nextStatus = patch.status ?? existing.status;

  if (options.blockingReason !== undefined) {
    if (nextStatus !== 'blocked') {
      return invalidArg(
        options,
        '--blocking-reason requires --status blocked or an already blocked workflow',
      );
    }
    patch.blockingReason = options.blockingReason;
  }

  if (options.status === 'in_progress' && existing.blockingReason) {
    patch.blockingReason = undefined;
  }

  if (options.outcome !== undefined) {
    if (!isWorkflowOutcome(options.outcome)) {
      return invalidArg(options, `invalid --outcome: ${options.outcome}`);
    }
    if (existing.mode !== 'mamba' || nextStatus !== 'completed') {
      return invalidArg(
        options,
        '--outcome is only valid when completing a manba workflow',
      );
    }
    patch.outcome = options.outcome;
  }

  if (options.planVersion !== undefined) {
    const planVersion = parseExactPositiveInteger(options.planVersion);
    const currentVersion = existing.planVersion ?? 1;
    if (
      planVersion === null ||
      (existing.mode !== 'man' && existing.mode !== 'manteam') ||
      planVersion !== currentVersion + 1 ||
      (patch.currentStep ?? existing.currentStep) !== 4
    ) {
      return invalidArg(
        options,
        `invalid --plan-version: ${options.planVersion}; expected ${currentVersion + 1} at step 4 for ${existing.mode}`,
      );
    }
    patch.planVersion = planVersion;
  }

  if (options.requirementsStatus !== undefined) {
    if (
      !isRequirementsStatus(options.requirementsStatus) ||
      (existing.mode !== 'man' && existing.mode !== 'manteam')
    ) {
      return invalidArg(
        options,
        `invalid --requirements-status: ${options.requirementsStatus}`,
      );
    }
    patch.requirementsStatus = options.requirementsStatus;
  }

  if (options.planDecision !== undefined) {
    if (
      options.planDecision !== 'governed_execution' ||
      (existing.mode !== 'man' && existing.mode !== 'manteam')
    ) {
      return invalidArg(
        options,
        `invalid --plan-decision: ${options.planDecision}`,
      );
    }
    patch.planDecision = options.planDecision;
  }

  if (options.skipped !== undefined) {
    const requestedSkipped = options.skipped
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (existing.reviewPolicyVersion === 2) {
      if (requestedSkipped.includes('review')) {
        return invalidArg(
          options,
          'policy-v2 review skips require workflow review <taskId> skip --reason <reason>',
        );
      }
      if (
        existing.currentStep > 2 ||
        requestedSkipped.some((item) => item !== 'clarification')
      ) {
        return invalidArg(
          options,
          'policy-v2 clarification can only be skipped at step 1 or 2',
        );
      }
      patch.skippedSteps = [
        ...new Set([...existing.skippedSteps, ...requestedSkipped]),
      ];
    } else {
      patch.skippedSteps = requestedSkipped;
    }
  }

  if (Object.keys(patch).length === 0) {
    return invalidArg(options, 'missing update fields');
  }

  try {
    await updateWorkflow(rootDir, taskId, patch);
  } catch (error) {
    return invalidArg(
      options,
      error instanceof Error ? error.message : 'unable to update workflow',
    );
  }

  const updated = await readWorkflow(rootDir, taskId);
  if (updated && (updated.mode === 'man' || updated.mode === 'manteam')) {
    const shouldSyncPlan =
      updated.currentStep >= 4 || updated.status !== 'in_progress';
    if (shouldSyncPlan) {
      await upsertActivePlan(rootDir, {
        taskId: updated.taskId,
        status: updated.status,
        planVersion: updated.planVersion ?? 1,
      });
    }
  }
  if (options.json) {
    console.log(JSON.stringify(updated, null, 2));
  } else {
    console.log(`Updated workflow: ${taskId}`);
  }
  return EXIT_OK;
}

async function workflowHandoff(
  rootDir: string,
  taskId: string | undefined,
  options: WorkflowOptions,
): Promise<number> {
  if (!taskId || !isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId ?? ''}`);
  }
  if (options.complete) {
    if (options.to !== undefined) {
      return invalidArg(options, '--complete cannot be combined with --to');
    }
    return workflowCompleteHandoff(rootDir, taskId, options);
  }
  if (options.to !== 'solo') {
    return invalidArg(options, 'handoff requires --to solo');
  }

  const meta = await readWorkflow(rootDir, taskId);
  if (!meta || (meta.mode !== 'man' && meta.mode !== 'manteam')) {
    return invalidArg(options, `workflow cannot be handed off: ${taskId}`);
  }
  if (
    meta.status !== 'in_progress' ||
    meta.currentStep !== 4 ||
    meta.requirementsStatus !== 'ready' ||
    meta.planDecision !== undefined
  ) {
    return invalidArg(
      options,
      'solo handoff requires an undecided in-progress workflow at step 4 with ready requirements',
    );
  }
  const workflowPath = path.join(rootDir, '.mancode', 'workflows', taskId);
  if (
    !(await pathExists(path.join(workflowPath, 'requirements.md'))) ||
    !(await pathExists(path.join(workflowPath, 'plan.md')))
  ) {
    return invalidArg(
      options,
      'solo handoff requires requirements.md and plan.md',
    );
  }

  const statePath = path.join(rootDir, '.mancode', 'state.json');
  let originalState: string;
  let state: Record<string, unknown>;
  try {
    originalState = await readFile(statePath, 'utf-8');
    state = JSON.parse(originalState) as Record<string, unknown>;
  } catch {
    return invalidArg(
      options,
      'unable to read .mancode/state.json for handoff',
    );
  }
  if (state.currentTask !== taskId) {
    return invalidArg(
      options,
      'current workflow state does not match the handoff task',
    );
  }
  const activeSoloPlan = readActiveSoloPlan(state.activeSoloPlan);
  if (activeSoloPlan && activeSoloPlan.taskId !== taskId) {
    return invalidArg(
      options,
      `another solo plan is active: ${activeSoloPlan.taskId}; complete or abandon it before handoff`,
    );
  }

  const nextState = {
    ...state,
    currentMode: 'solo',
    lastMode:
      typeof state.currentMode === 'string' ? state.currentMode : meta.mode,
    currentTask: null,
    currentWorkflowMode: null,
    skippedSteps: [],
    activeSoloPlan: {
      taskId,
      planVersion: meta.planVersion ?? 1,
    },
  };

  const transitionError = await commitPlanningTransition({
    rootDir,
    taskId,
    statePath,
    originalState,
    nextState,
    workflowPatch: {
      status: 'planned',
      planDecision: 'solo_handoff',
    },
    activePlanStatus: 'planned',
    planVersion: meta.planVersion ?? 1,
  });
  if (transitionError) {
    return invalidArg(options, transitionError);
  }

  const result = await readWorkflow(rootDir, taskId);
  if (options.json) {
    console.log(
      JSON.stringify(
        { workflow: result, activeSoloPlan: nextState.activeSoloPlan },
        null,
        2,
      ),
    );
  } else {
    console.log(`Handed off plan to solo: ${taskId}`);
  }
  return EXIT_OK;
}

async function workflowCompleteHandoff(
  rootDir: string,
  taskId: string,
  options: WorkflowOptions,
): Promise<number> {
  const meta = await readWorkflow(rootDir, taskId);
  if (
    !meta ||
    (meta.mode !== 'man' && meta.mode !== 'manteam') ||
    meta.status !== 'planned' ||
    meta.currentStep !== 4 ||
    meta.planDecision !== 'solo_handoff'
  ) {
    return invalidArg(
      options,
      `workflow is not an active solo handoff: ${taskId}`,
    );
  }

  const statePath = path.join(rootDir, '.mancode', 'state.json');
  let originalState: string;
  let state: Record<string, unknown>;
  try {
    originalState = await readFile(statePath, 'utf-8');
    state = JSON.parse(originalState) as Record<string, unknown>;
  } catch {
    return invalidArg(
      options,
      'unable to read .mancode/state.json for handoff completion',
    );
  }
  const activeSoloPlan = readActiveSoloPlan(state.activeSoloPlan);
  if (activeSoloPlan?.taskId !== taskId) {
    return invalidArg(
      options,
      'active solo plan does not match the handoff task',
    );
  }

  const nextState = {
    ...state,
    activeSoloPlan: null,
  };
  const transitionError = await commitPlanningTransition({
    rootDir,
    taskId,
    statePath,
    originalState,
    nextState,
    workflowPatch: { status: 'completed' },
    activePlanStatus: 'completed',
    planVersion: meta.planVersion ?? 1,
  });
  if (transitionError) return invalidArg(options, transitionError);

  const result = await readWorkflow(rootDir, taskId);
  if (options.json) {
    console.log(
      JSON.stringify({ workflow: result, activeSoloPlan: null }, null, 2),
    );
  } else {
    console.log(`Completed solo handoff: ${taskId}`);
  }
  return EXIT_OK;
}

async function workflowDecide(
  rootDir: string,
  taskId: string | undefined,
  options: WorkflowOptions,
): Promise<number> {
  if (!taskId || !isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId ?? ''}`);
  }
  if (
    !isPlanDecision(options.planDecision) ||
    options.planDecision === 'solo_handoff'
  ) {
    return invalidArg(
      options,
      'decide requires --plan-decision plan_only or governed_execution',
    );
  }
  if (options.planDecision === 'governed_execution') {
    return workflowUpdate(rootDir, taskId, {
      ...options,
      planDecision: 'governed_execution',
    });
  }

  const meta = await readWorkflow(rootDir, taskId);
  if (
    !meta ||
    (meta.mode !== 'man' && meta.mode !== 'manteam') ||
    meta.status !== 'in_progress' ||
    meta.currentStep !== 4 ||
    meta.requirementsStatus !== 'ready' ||
    meta.planDecision !== undefined
  ) {
    return invalidArg(
      options,
      `workflow is not ready for a plan-only decision: ${taskId}`,
    );
  }
  const workflowPath = path.join(rootDir, '.mancode', 'workflows', taskId);
  if (
    !(await pathExists(path.join(workflowPath, 'requirements.md'))) ||
    !(await pathExists(path.join(workflowPath, 'plan.md')))
  ) {
    return invalidArg(
      options,
      'plan-only requires requirements.md and plan.md',
    );
  }

  const statePath = path.join(rootDir, '.mancode', 'state.json');
  let originalState: string;
  let state: Record<string, unknown>;
  try {
    originalState = await readFile(statePath, 'utf-8');
    state = JSON.parse(originalState) as Record<string, unknown>;
  } catch {
    return invalidArg(
      options,
      'unable to read .mancode/state.json for decision',
    );
  }
  if (state.currentTask !== taskId) {
    return invalidArg(
      options,
      'current workflow state does not match the decision task',
    );
  }
  const activeSoloPlan = readActiveSoloPlan(state.activeSoloPlan);
  if (activeSoloPlan) {
    return invalidArg(
      options,
      `another solo plan is active: ${activeSoloPlan.taskId}; resolve it before plan-only`,
    );
  }

  const nextState = {
    ...state,
    currentMode: 'solo',
    lastMode:
      typeof state.currentMode === 'string' ? state.currentMode : meta.mode,
    currentTask: null,
    currentWorkflowMode: null,
    skippedSteps: [],
    activeSoloPlan: null,
  };
  const transitionError = await commitPlanningTransition({
    rootDir,
    taskId,
    statePath,
    originalState,
    nextState,
    workflowPatch: { status: 'planned', planDecision: 'plan_only' },
    activePlanStatus: 'planned',
    planVersion: meta.planVersion ?? 1,
  });
  if (transitionError) return invalidArg(options, transitionError);

  const result = await readWorkflow(rootDir, taskId);
  if (options.json) {
    console.log(
      JSON.stringify({ workflow: result, state: nextState }, null, 2),
    );
  } else {
    console.log(`Saved plan without execution: ${taskId}`);
  }
  return EXIT_OK;
}

async function commitPlanningTransition(args: {
  rootDir: string;
  taskId: string;
  statePath: string;
  originalState: string;
  nextState: Record<string, unknown>;
  workflowPatch: Partial<WorkflowMeta>;
  activePlanStatus: string;
  planVersion: number;
}): Promise<string | null> {
  const metadataPath = path.join(
    args.rootDir,
    '.mancode',
    'workflows',
    args.taskId,
    'metadata.json',
  );
  const specPath = path.join(args.rootDir, '.mancode', 'memory', 'spec.md');
  let originalMetadata: string;
  let originalSpec: string | null;
  try {
    originalMetadata = await readFile(metadataPath, 'utf-8');
    originalSpec = await readOptionalText(specPath);
  } catch (error) {
    return error instanceof Error
      ? `unable to prepare planning transition: ${error.message}`
      : 'unable to prepare planning transition';
  }

  try {
    await updateWorkflow(args.rootDir, args.taskId, args.workflowPatch);
    await writeFile(
      args.statePath,
      `${JSON.stringify(args.nextState, null, 2)}\n`,
      'utf-8',
    );
    await upsertActivePlan(args.rootDir, {
      taskId: args.taskId,
      status: args.activePlanStatus,
      planVersion: args.planVersion,
    });
    return null;
  } catch (error) {
    const rollback = await Promise.allSettled([
      writeFile(metadataPath, originalMetadata, 'utf-8'),
      writeFile(args.statePath, args.originalState, 'utf-8'),
      originalSpec === null
        ? rm(specPath, { force: true })
        : writeFile(specPath, originalSpec, 'utf-8'),
    ]);
    const message =
      error instanceof Error ? error.message : 'planning transition failed';
    return rollback.some((result) => result.status === 'rejected')
      ? `${message}; rollback was incomplete`
      : message;
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function restoreOptionalText(
  filePath: string,
  content: string | null,
): Promise<void> {
  if (content === null) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(filePath, content, 'utf-8');
}

function readActiveSoloPlan(
  value: unknown,
): { taskId: string; planVersion: number } | null {
  if (!value || typeof value !== 'object') return null;
  const plan = value as Record<string, unknown>;
  if (typeof plan.taskId !== 'string' || !Number.isInteger(plan.planVersion)) {
    return null;
  }
  return { taskId: plan.taskId, planVersion: plan.planVersion as number };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function workflowList(
  rootDir: string,
  options: WorkflowOptions,
): Promise<number> {
  const workflows = await listWorkflows(rootDir);
  const views = attachActiveChildren(workflows);
  if (options.json) {
    console.log(JSON.stringify(views, null, 2));
    return EXIT_OK;
  }

  if (workflows.length === 0) {
    console.log('No workflows.');
    return EXIT_OK;
  }

  const inProgress = workflows.filter((w) => w.status === 'in_progress').length;
  console.log(
    `mancode workflows (${workflows.length} total, ${inProgress} in_progress)`,
  );
  console.log('');
  for (const meta of views) {
    console.log(formatWorkflowRow(meta));
  }
  return EXIT_OK;
}

async function workflowShow(
  rootDir: string,
  taskId: string | undefined,
  options: WorkflowOptions,
): Promise<number> {
  if (!taskId) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'missing taskId' }, null, 2));
    } else {
      console.error('✗  Missing taskId.');
      console.error('   Use: mancode workflow show <taskId>');
    }
    return EXIT_INVALID_ARG;
  }
  if (!isValidWorkflowTaskId(taskId)) {
    return invalidArg(options, `invalid taskId: ${taskId}`);
  }

  const meta = await readWorkflow(rootDir, taskId);
  if (!meta) {
    if (options.json) {
      console.log(
        JSON.stringify({ error: `workflow not found: ${taskId}` }, null, 2),
      );
    } else {
      console.error(`✗  Workflow not found: ${taskId}`);
    }
    return EXIT_INVALID_ARG;
  }

  const children =
    meta.mode === 'man' || meta.mode === 'manteam'
      ? (attachActiveChildren(await listWorkflows(rootDir)).find(
          (workflow) => workflow.taskId === meta.taskId,
        )?.activeChildren ?? [])
      : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        children === undefined ? meta : { ...meta, activeChildren: children },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  console.log(`Workflow:    ${meta.taskId}`);
  console.log(`Task:        ${meta.task}`);
  console.log(`Mode:        ${formatPublicWorkflowMode(meta.mode)}`);
  console.log(`Status:      ${meta.status}`);
  console.log(`Current step:${meta.currentStep}/${maxWorkflowStep(meta.mode)}`);
  console.log(
    `Skipped:     ${meta.skippedSteps.length > 0 ? meta.skippedSteps.join(', ') : 'none'}`,
  );
  console.log(`Started:     ${meta.startedAt}`);
  console.log(`Updated:     ${meta.updatedAt}`);
  if (meta.parentTaskId) console.log(`Parent:      ${meta.parentTaskId}`);
  if (meta.planVersion !== undefined)
    console.log(`Plan version: ${meta.planVersion}`);
  if (meta.requirementsStatus)
    console.log(`Requirements: ${meta.requirementsStatus}`);
  if (meta.verificationStatus)
    console.log(`Verification: ${meta.verificationStatus}`);
  if (meta.planDecision) console.log(`Plan choice: ${meta.planDecision}`);
  if (meta.outcome) console.log(`Outcome:     ${meta.outcome}`);
  if (meta.blockingReason) console.log(`Blocked:     ${meta.blockingReason}`);

  // Show active diagnostic children for man/manteam workflows (plan §7).
  if (children !== undefined) {
    if (children.length > 0) {
      console.log(`Children:    ${children.length} active manba workflow(s)`);
      for (const child of children) {
        console.log(
          `  - ${child.taskId} (Step ${child.currentStep}/5, ${child.status})`,
        );
      }
    }
  }
  return EXIT_OK;
}

async function workflowClean(
  rootDir: string,
  options: WorkflowOptions,
): Promise<number> {
  const workflows = await listWorkflows(rootDir);
  const cutoff = parseOlderThan(options.olderThan);
  if (cutoff === null) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { error: `invalid --older-than: ${options.olderThan}` },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗  Invalid --older-than duration: ${options.olderThan}`);
      console.error('   Use examples like: 30d, 12h, 90m');
    }
    return EXIT_INVALID_ARG;
  }

  const eligible = workflows.filter((meta) => {
    if (!isTerminalWorkflowStatus(meta.status)) return false;
    if (!cutoff) return true;
    const started = Date.parse(meta.startedAt);
    return Number.isFinite(started) && started < cutoff.getTime();
  });
  const eligibleIds = new Set(eligible.map((meta) => meta.taskId));
  const candidates = eligible
    .filter((meta) => {
      if (meta.mode !== 'man' && meta.mode !== 'manteam') return true;
      const children = workflows.filter(
        (candidate) =>
          candidate.mode === 'mamba' && candidate.parentTaskId === meta.taskId,
      );
      return children.every((child) => eligibleIds.has(child.taskId));
    })
    // Children must be removed before their parent. This also keeps dry-run
    // output aligned with what a real clean can remove.
    .sort((a, b) => Number(a.mode !== 'mamba') - Number(b.mode !== 'mamba'));

  const removed: WorkflowMeta[] = [];
  if (!options.dryRun) {
    for (const meta of candidates) {
      const didRemove = await deleteWorkflow(rootDir, meta.taskId);
      if (didRemove) removed.push(meta);
      if (didRemove && (meta.mode === 'man' || meta.mode === 'manteam')) {
        await upsertActivePlan(rootDir, {
          taskId: meta.taskId,
          status: meta.status,
          planVersion: meta.planVersion ?? 1,
        });
      }
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: Boolean(options.dryRun),
          count: options.dryRun ? candidates.length : removed.length,
          workflows: options.dryRun ? candidates : removed,
        },
        null,
        2,
      ),
    );
  } else if ((options.dryRun ? candidates : removed).length === 0) {
    console.log('No workflows to clean.');
  } else if (options.dryRun) {
    console.log(`Would remove ${candidates.length} workflow(s):`);
    for (const meta of candidates) console.log(`  ${meta.taskId}`);
  } else {
    console.log(`Removed ${removed.length} workflow(s).`);
  }

  return EXIT_OK;
}

function formatWorkflowRow(meta: WorkflowView): string {
  const stepMax = maxWorkflowStep(meta.mode);
  const step =
    meta.status === 'in_progress'
      ? `Step ${meta.currentStep}/${stepMax}`
      : ago(meta.updatedAt);
  const details = [
    meta.planVersion !== undefined ? `plan=v${meta.planVersion}` : '',
    meta.parentTaskId ? `parent=${meta.parentTaskId}` : '',
    meta.outcome ? `outcome=${meta.outcome}` : '',
    meta.blockingReason ? `blocked=${meta.blockingReason}` : '',
    meta.activeChildren && meta.activeChildren.length > 0
      ? `children=${meta.activeChildren.map((child) => child.taskId).join(',')}`
      : '',
  ].filter(Boolean);
  return `${meta.taskId.padEnd(42)} ${formatPublicWorkflowMode(meta.mode).padEnd(7)} ${meta.status.padEnd(11)} ${step}${details.length > 0 ? ` | ${details.join(' | ')}` : ''}`;
}

function parsePublicWorkflowMode(
  value: string | undefined,
): WorkflowMode | null {
  if (value === 'manba' || value === 'mamba') return 'mamba';
  if (value === 'man' || value === 'manteam') return value;
  return null;
}

function formatPublicWorkflowMode(mode: WorkflowMode): string {
  return mode === 'mamba' ? 'manba' : mode;
}

function attachActiveChildren(workflows: WorkflowMeta[]): WorkflowView[] {
  return workflows.map((meta) => {
    if (meta.mode !== 'man' && meta.mode !== 'manteam') return meta;
    return {
      ...meta,
      activeChildren: workflows.filter(
        (candidate) =>
          candidate.mode === 'mamba' &&
          candidate.parentTaskId === meta.taskId &&
          (candidate.status === 'in_progress' ||
            candidate.status === 'blocked'),
      ),
    };
  });
}

function parseExactPositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseExactInteger(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseOlderThan(value: string | undefined): Date | undefined | null {
  if (!value) return undefined;
  const match = /^(\d+)([dhm])$/.exec(value);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'm';
  const ms =
    unit === 'd'
      ? amount * 24 * 60 * 60 * 1000
      : unit === 'h'
        ? amount * 60 * 60 * 1000
        : amount * 60 * 1000;
  return new Date(Date.now() - ms);
}

function invalidArg(
  options: WorkflowOptions,
  message: string,
  usage?: string,
): number {
  if (options.json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗  ${message}`);
    if (usage) console.error(`   ${usage}`);
  }
  return EXIT_INVALID_ARG;
}

function ago(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 'unknown';
  const delta = Math.max(0, Date.now() - time);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
