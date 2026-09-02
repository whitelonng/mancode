import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertTaskCompletionGate } from '../context/aggregate.js';
import { createUlid } from '../context/ids.js';
import { parseManReviewEvidence } from '../context/man-delivery-evidence.js';
import {
  assertManDeliveryReady,
  captureManSubject,
  inspectManDelivery,
  inspectManPublication,
  isManDelivery,
  syncManDeliveryRecord,
} from '../context/man-delivery-runtime.js';
import {
  type ReviewLedgerV1,
  deriveReviewLedgerStatus,
  reviewLedgerDigest,
} from '../context/review-ledger.js';
import { applyV3ReviewLedger } from '../context/review-remediation.js';
import type { StoredTaskSnapshot } from '../context/store.js';
import { parseTaskRef } from '../context/task-ref.js';
import { assertKnownKeys, assertRecord } from '../context/validation.js';
import type { VerificationComponentEvidence } from '../context/verification-ledger.js';
import {
  deriveVerificationLedgerStatus,
  verificationLedgerDigest,
} from '../context/verification-ledger.js';
import { recordV3Verification } from '../context/verification-record.js';
import { openV3TaskOperation } from '../runtime/task-operation.js';
import {
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';
import type { WorkflowOptions } from './workflow.js';

const execFile = promisify(execFileCallback);

/** Thin CLI orchestration: canonical evidence still goes through existing journaled writers. */
export async function manDeliveryCommand(
  root: string,
  args: string[],
  options: WorkflowOptions,
): Promise<number> {
  try {
    const [ref, action] = args;
    if (
      !ref ||
      args.length !== 2 ||
      ![
        'inspect',
        'check',
        'publication',
        'sync',
        'verify',
        'confirm',
        'review',
      ].includes(action ?? '')
    ) {
      throw new Error(
        'MANCODE_MAN_DELIVERY_ARGUMENT_INVALID: delivery <TaskRef> <inspect|check|publication|sync|verify|confirm|review>',
      );
    }
    const project = await readV3CommandProject(root);
    const taskRef = parseTaskRef(ref);
    let task = await project.store.readTaskSnapshot(taskRef);
    if (!isManDelivery(task.metadata))
      throw new Error('MANCODE_MAN_DELIVERY_MODE_REQUIRED');
    if (action === 'publication')
      return printV3Result(
        options.json,
        await inspectManPublication(project.projectRoot),
      );
    if (action === 'inspect')
      return printV3Result(options.json, {
        ...(await inspectManDelivery(project.projectRoot, task)),
        acceptanceCriteria: task.requirements.acceptanceCriteria,
        review: task.review,
        verification: task.verification,
      });
    if (action === 'check') {
      await assertManDeliveryReady(project.projectRoot, task);
      assertTaskCompletionGate(
        { ...task, planDigest: task.plan?.digest ?? null },
        {
          activeChildTaskRefs:
            await project.store.listActiveChildTaskRefs(taskRef),
          hasPendingRepairOperation: false,
          activeClaimCount: 0,
        },
      );
      return printV3Result(options.json, {
        delivery: 'ready_for_complete',
        publication: 'not_checked',
        note: 'complete rechecks operation authority; upstream publication requires an actual push result',
      });
    }
    const expectedTaskRevision = Number(options.expectedRevision);
    if (!Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 1)
      throw new Error('MANCODE_EXPECTED_REVISION_REQUIRED');
    if (options.sync) throw new Error('MANCODE_GIT_REF_DEFERRED_SYNC_REQUIRED');
    const session = await resolveV3CommandSession(project, options);
    // Validate authority before executing a command or writing a document, not after it.
    const context = await openV3TaskOperation({
      projectRoot: project.projectRoot,
      taskRef,
      sessionId: session.sessionId,
      expectedTaskRevision,
    });
    const actorId = context.session.actorId;
    try {
      task = context.task;
      if (action === 'sync') {
        const progress = await syncManDeliveryRecord(project.projectRoot, task);
        return printV3Result(options.json, {
          deliveryRecord: 'synced',
          progress,
          revision: task.metadata.revision,
        });
      }
      if (
        task.metadata.governance.planDecision !== 'governed_execution' ||
        task.metadata.currentStep < 5 ||
        task.metadata.status !== 'in_progress'
      ) {
        throw new Error('MANCODE_MAN_DELIVERY_EXECUTION_REQUIRED');
      }
    } finally {
      await context.release();
    }

    if (!options.file) throw new Error('MANCODE_MAN_DELIVERY_INPUT_REQUIRED');
    const input: unknown = JSON.parse(
      await readFile(path.resolve(project.projectRoot, options.file), 'utf8'),
    );
    let output: unknown;
    if (action === 'verify' || action === 'confirm') {
      assertRecord(input, 'verification command');
      assertKnownKeys(
        input,
        action === 'verify' ? ['argv'] : ['confirmed', 'summary'],
        'verification command',
      );
      if (
        action === 'verify' &&
        (!Array.isArray(input.argv) ||
          !input.argv.length ||
          input.argv.some(
            (arg) => typeof arg !== 'string' || arg.includes('\0'),
          ) ||
          !input.argv[0])
      )
        throw new Error('MANCODE_MAN_VERIFY_ARGV_INVALID');
      if (
        action === 'confirm' &&
        (input.confirmed !== true ||
          typeof input.summary !== 'string' ||
          !input.summary.trim())
      )
        throw new Error('MANCODE_MAN_EXPLICIT_CONFIRMATION_REQUIRED');
      const checks = verificationChecks(task);
      const acceptanceIds =
        options.acceptance?.split(',').map((id) => id.trim()) ?? [];
      const component = action === 'verify' ? 'automated' : 'manual';
      if (
        !acceptanceIds.length ||
        new Set(acceptanceIds).size !== acceptanceIds.length ||
        acceptanceIds.some(
          (id) =>
            !checks.some(
              (check) => check.displayId === id && check[component] !== null,
            ),
        )
      )
        throw new Error('MANCODE_MAN_ACCEPTANCE_SLOT_REQUIRED');
      const subject = await captureManSubject(project.projectRoot, task);
      let result: { stdout: string; stderr: string; exitCode: number } = {
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
      if (action === 'verify') {
        const argv = input.argv as string[];
        try {
          const run = await execFile(argv[0] as string, argv.slice(1), {
            cwd: project.projectRoot,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
          });
          result = { ...run, exitCode: 0 };
        } catch (error) {
          const failed = error as {
            code?: unknown;
            stdout?: string;
            stderr?: string;
          };
          if (typeof failed.code !== 'number') throw error;
          result = {
            exitCode: failed.code,
            stdout: failed.stdout ?? '',
            stderr: failed.stderr ?? '',
          };
        }
      }
      if (
        (await captureManSubject(project.projectRoot, task)).contentDigest !==
        subject.contentDigest
      )
        throw new Error('MANCODE_MAN_VERIFICATION_CHANGED_DURING_RUN');
      const timestamp = new Date().toISOString();
      const invalidate = (
        evidence: VerificationComponentEvidence | null,
      ): VerificationComponentEvidence | null => {
        if (
          !evidence ||
          (evidence.subject?.contentDigest === subject.contentDigest &&
            evidence.subject.environment === subject.environment)
        )
          return evidence;
        const { subject: _oldSubject, ...rest } = evidence;
        return {
          ...rest,
          status: 'pending',
          summary: null,
          command: null,
          exitCode: null,
          artifactRef: null,
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: timestamp,
        };
      };
      const draft = {
        ...task.verification,
        requirementsDigest: task.requirements.contentDigest,
        planVersion: task.metadata.governance.planVersion,
        remediationRound: task.review.remediationRound,
        checks: checks.map((item) => {
          const next = {
            ...item,
            automated: invalidate(item.automated),
            manual: invalidate(item.manual),
          };
          const slot = item[component];
          if (acceptanceIds.includes(item.displayId) && slot)
            next[component] = {
              ...slot,
              subject,
              status: result.exitCode === 0 ? 'passed' : 'failed',
              command: action === 'verify' ? JSON.stringify(input.argv) : null,
              exitCode: action === 'verify' ? result.exitCode : null,
              summary:
                action === 'verify'
                  ? `Executed argv in project root; captured exit code ${result.exitCode}.`
                  : (input.summary as string),
              confirmedByActorId: action === 'confirm' ? actorId : null,
              confirmationSource: action === 'confirm' ? 'actor' : null,
              updatedAt: timestamp,
            };
          return next;
        }),
      };
      const current = {
        ...draft,
        status: deriveVerificationLedgerStatus(draft),
      };
      output = {
        ...(await recordV3Verification({
          projectRoot: project.projectRoot,
          taskRef,
          sessionId: session.sessionId,
          expectedTaskRevision,
          verification: {
            ...current,
            contentDigest: verificationLedgerDigest(current),
          },
        })),
        ...(action === 'verify'
          ? { commandResult: result }
          : { manualConfirmation: { actorId, summary: input.summary } }),
      };
    } else {
      output = await applyV3ReviewLedger({
        projectRoot: project.projectRoot,
        taskRef,
        sessionId: session.sessionId,
        expectedTaskRevision,
        review: reviewInput(task, input, options.reviewDepth),
      });
    }
    const updated = await project.store.readTaskSnapshot(taskRef);
    // A projection failure must not masquerade as a failed authority mutation.
    let deliveryRecord: { status: string; error?: string; progress?: unknown } =
      { status: 'synced' };
    try {
      deliveryRecord.progress = await syncManDeliveryRecord(
        project.projectRoot,
        updated,
      );
    } catch (error) {
      deliveryRecord = {
        status: 'pending',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return printV3Result(options.json, { result: output, deliveryRecord });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_MAN_DELIVERY_FAILED'),
      error instanceof Error ? error.message : String(error),
    );
  }
}

function verificationChecks(task: StoredTaskSnapshot) {
  const emptySlot = (): VerificationComponentEvidence => ({
    evidenceId: createUlid(),
    status: 'pending',
    summary: null,
    command: null,
    exitCode: null,
    artifactRef: null,
    confirmedByActorId: null,
    confirmationSource: null,
    updatedAt: null,
  });
  return task.requirements.acceptanceCriteria.map((criterion) => {
    const previous = task.verification.checks.find(
      (check) =>
        check.criterionId === criterion.criterionId &&
        check.verificationRequirement === criterion.verificationRequirement,
    );
    return (
      previous ?? {
        displayId: criterion.displayId,
        legacyId: criterion.legacyId,
        checkId: createUlid(),
        criterionId: criterion.criterionId,
        required: criterion.required,
        verificationRequirement: criterion.verificationRequirement,
        automated:
          criterion.verificationRequirement === 'manual' ? null : emptySlot(),
        manual:
          criterion.verificationRequirement === 'automated'
            ? null
            : emptySlot(),
      }
    );
  });
}

function reviewInput(
  task: StoredTaskSnapshot,
  input: unknown,
  depth: string | undefined,
): ReviewLedgerV1 {
  assertRecord(input, 'module review');
  const { findings = [], resolved = [], ...report } = input;
  const delivery = parseManReviewEvidence(report);
  if (
    !Array.isArray(findings) ||
    !Array.isArray(resolved) ||
    resolved.some((id) => typeof id !== 'string')
  )
    throw new Error('MANCODE_MAN_REVIEW_FINDINGS_INVALID');
  if (
    resolved.some(
      (id) => !task.review.blockers.some((blocker) => blocker.displayId === id),
    )
  )
    throw new Error('MANCODE_MAN_REVIEW_UNKNOWN_FINDING');
  const blockers = task.review.blockers.map((blocker) =>
    resolved.includes(blocker.displayId)
      ? { ...blocker, status: 'resolved' as const }
      : blocker,
  );
  const ids = new Set<string>();
  for (const finding of findings) {
    assertRecord(finding, 'module review finding');
    assertKnownKeys(
      finding,
      ['id', 'domain', 'severity', 'summary'],
      'module review finding',
    );
    if (
      typeof finding.id !== 'string' ||
      !finding.id.trim() ||
      ids.has(finding.id) ||
      typeof finding.summary !== 'string' ||
      !finding.summary.trim() ||
      (finding.domain !== 'quality' && finding.domain !== 'security') ||
      !['p0', 'p1', 'p2'].includes(String(finding.severity))
    )
      throw new Error('MANCODE_MAN_REVIEW_FINDINGS_INVALID');
    ids.add(finding.id);
    const previous = blockers.find((item) => item.displayId === finding.id);
    const entry: ReviewLedgerV1['blockers'][number] = {
      displayId: finding.id,
      legacyId: null,
      blockerId: previous?.blockerId ?? createUlid(),
      domain: finding.domain,
      severity: finding.severity as 'p0' | 'p1' | 'p2',
      status: 'open' as const,
      summary: finding.summary,
      waiver: null,
    };
    if (previous) blockers[blockers.indexOf(previous)] = entry;
    else blockers.push(entry);
  }
  if (depth !== undefined && depth !== 'targeted' && depth !== 'full')
    throw new Error('MANCODE_MAN_REVIEW_DEPTH_INVALID');
  const full =
    depth === 'full' ||
    task.review.depth === 'full' ||
    blockers.some((item) => item.domain === 'security');
  const requiredDomains = full
    ? (['quality', 'security'] as const)
    : (['quality'] as const);
  const covered = task.requirements.acceptanceCriteria
    .filter((item) => item.required)
    .every((criterion) =>
      delivery.coverage.some(
        (row) =>
          row.acceptanceId === criterion.displayId && row.status === 'met',
      ),
    );
  const draft: ReviewLedgerV1 = {
    ...task.review,
    delivery,
    depth: full ? 'full' : 'targeted',
    requiredDomains: [...requiredDomains],
    requirementsDigest: task.requirements.contentDigest,
    planVersion: task.metadata.governance.planVersion,
    domains: requiredDomains.map((domain) => ({
      domain,
      status:
        blockers.some(
          (item) => item.domain === domain && item.status === 'open',
        ) || !covered
          ? 'blocked'
          : 'passed',
      reportRef: null,
    })),
    blockers,
    skip: null,
    remediationRound: task.review.remediationRound + (resolved.length ? 1 : 0),
  };
  const current = { ...draft, status: deriveReviewLedgerStatus(draft) };
  return { ...current, contentDigest: reviewLedgerDigest(current) };
}
