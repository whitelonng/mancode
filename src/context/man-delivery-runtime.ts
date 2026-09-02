import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { readCheckoutCodeHead } from '../runtime/project-runtime.js';
import { evaluateClaimScopeSubset } from '../team/conflicts.js';
import { digestCanonicalJson } from './canonical.js';
import type { ManEvidenceSubject } from './man-delivery-evidence.js';
import {
  assertManPlanPath,
  compileManDeliveryPlan,
  manProgressTaskId,
  parseManDeliveryPlan,
  parseManPlanDocument,
  replaceManDeliveryRecord,
} from './man-delivery-plan.js';
import { type ManProgressStatus, syncManProgressPage } from './man-progress.js';
import { scanSharedText } from './privacy.js';
import type { ReviewLedgerV1 } from './review-ledger.js';
import type { StoredTaskSnapshot } from './store.js';
import type { VerificationLedgerV1 } from './verification-ledger.js';
import type { WorkflowMetadataV3 } from './workflow-metadata.js';

const execFile = promisify(execFileCallback);
export const MAN_DELIVERY_POLICY = 3;

export function isManDelivery(metadata: WorkflowMetadataV3): boolean {
  return (
    metadata.workflowMode === 'man' &&
    metadata.governance.policyVersions.planning === MAN_DELIVERY_POLICY &&
    metadata.governance.planDecision !== 'solo_handoff'
  );
}

export async function manGit(root: string, args: string[]): Promise<string> {
  return (
    await execFile('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;
}

async function hasGitWorktree(root: string): Promise<boolean> {
  try {
    return (
      (await manGit(root, ['rev-parse', '--is-inside-work-tree'])).trim() ===
      'true'
    );
  } catch (error) {
    if (
      (error as { code?: unknown }).code === 128 &&
      String((error as { stderr?: unknown }).stderr).includes(
        'not a git repository',
      )
    )
      return false;
    throw error;
  }
}

export async function readManPlanFile(
  root: string,
  file: string,
): Promise<string> {
  assertManPlanPath(file);
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(path.join(root, file));
  const relative = path
    .relative(resolvedRoot, resolved)
    .split(path.sep)
    .join('/');
  assertManPlanPath(relative);
  if (relative !== file) throw new Error('MANCODE_MAN_PLAN_USE_REAL_PATH');
  if (!(await lstat(resolved)).isFile())
    throw new Error('MANCODE_MAN_PLAN_FILE_REQUIRED');
  // Planning remains available without Git; verified versioned delivery does not.
  if (!(await hasGitWorktree(root))) return readFile(resolved, 'utf8');
  // --no-index also catches an already tracked file covered by a private ignore rule.
  try {
    await manGit(root, ['check-ignore', '--no-index', '-q', '--', relative]);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1)
      return readFile(resolved, 'utf8');
    throw error;
  }
  throw new Error('MANCODE_MAN_PLAN_IGNORED');
}

export async function bindManPlan(
  root: string,
  file: string,
  document: string,
  previous: string | null,
): Promise<string> {
  if ((await readManPlanFile(root, file)) !== document)
    throw new Error('MANCODE_MAN_PLAN_FILE_CHANGED');
  const existing = previous === null ? null : parseManDeliveryPlan(previous);
  return compileManDeliveryPlan(
    {
      version: 1,
      path: file,
      baseHead: existing
        ? existing.source.baseHead
        : await readCheckoutCodeHead(root),
    },
    document,
  );
}

export async function readBoundManPlan(
  root: string,
  task: Pick<StoredTaskSnapshot, 'plan'>,
) {
  const plan = task.plan && parseManDeliveryPlan(task.plan.content);
  if (!plan) throw new Error('MANCODE_MAN_PLAN_SOURCE_REQUIRED');
  const document = await readManPlanFile(root, plan.source.path);
  if (parseManPlanDocument(document).baseline !== plan.baseline)
    throw new Error('MANCODE_MAN_PLAN_BASELINE_CHANGED');
  return { ...plan, document };
}

/** Conservative checkout content identity; no command output or credentials are stored in it. */
export async function captureManSubject(
  root: string,
  task: Pick<StoredTaskSnapshot, 'plan'>,
): Promise<ManEvidenceSubject> {
  const bound = await readBoundManPlan(root, task);
  if (!(await hasGitWorktree(root)))
    throw new Error(
      'MANCODE_MAN_DELIVERY_GIT_REQUIRED: planning is available; versioned delivery is not',
    );
  const files = [
    ...new Set(
      (
        await manGit(root, [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ])
      )
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const hashes: Array<[string, string]> = [];
  for (const file of files) {
    if (file.startsWith('.mancode/') || file === '项目进度.html') continue;
    const absolute = path.join(root, file);
    let contents: Buffer | string;
    let kind = 'deleted';
    try {
      const stat = await lstat(absolute);
      kind = `file:${stat.mode & 0o111}`;
      if (stat.isSymbolicLink()) {
        kind = 'symlink';
        const target = path.relative(
          await realpath(root),
          await realpath(absolute),
        );
        if (target.startsWith(`..${path.sep}`) || path.isAbsolute(target))
          throw new Error('MANCODE_MAN_EXTERNAL_DEPENDENCY_UNVERIFIED');
        contents = `${await readlink(absolute)}\0${await readFile(absolute, 'base64')}`;
      } else if (stat.isFile()) {
        contents =
          file === bound.source.path
            ? bound.baseline
            : await readFile(absolute);
      } else throw new Error('MANCODE_MAN_CONTENT_NODE_UNSUPPORTED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      kind = 'deleted';
      contents = '<deleted>';
    }
    hashes.push([
      file,
      createHash('sha256').update(`${kind}\0`).update(contents).digest('hex'),
    ]);
  }
  return {
    contentDigest: digestCanonicalJson(hashes),
    environment: `${process.platform}/${process.arch};node=${process.version}`,
  };
}

export function assertManReviewCoverage(
  task: StoredTaskSnapshot,
  review: ReviewLedgerV1,
  subject: ManEvidenceSubject,
): void {
  if (!isManDelivery(task.metadata)) {
    if (review.delivery) throw new Error('MANCODE_MAN_DELIVERY_MODE_REQUIRED');
    return;
  }
  for (const blocker of task.review.blockers.filter(
    (item) => item.status === 'open',
  )) {
    if (!review.blockers.some((item) => item.blockerId === blocker.blockerId))
      throw new Error(
        `MANCODE_MAN_REVIEW_FINDING_DROPPED: ${blocker.displayId}`,
      );
  }
  if (review.status === 'skipped') return; // Existing explicit skip authorization remains authoritative.
  if (!review.delivery && review.status !== 'passed') return;
  if (
    !review.delivery ||
    review.delivery.subject.contentDigest !== subject.contentDigest ||
    review.delivery.subject.environment !== subject.environment
  ) {
    throw new Error('MANCODE_MAN_REVIEW_SUBJECT_STALE');
  }
  const criteria = task.requirements.acceptanceCriteria;
  if (
    review.delivery.coverage.some(
      (row) =>
        !criteria.some((criterion) => criterion.displayId === row.acceptanceId),
    )
  )
    throw new Error('MANCODE_MAN_REVIEW_UNKNOWN_ACCEPTANCE');
  if (review.status !== 'passed') return;
  for (const criterion of criteria.filter((item) => item.required)) {
    if (
      !review.delivery.coverage.some(
        (row) =>
          row.acceptanceId === criterion.displayId && row.status === 'met',
      )
    ) {
      throw new Error(
        `MANCODE_MAN_REVIEW_ACCEPTANCE_MISSING: ${criterion.displayId}`,
      );
    }
  }
}

export function assertManVerificationSubjects(
  task: StoredTaskSnapshot,
  verification: VerificationLedgerV1,
  subject: ManEvidenceSubject,
): void {
  for (const check of verification.checks) {
    for (const evidence of [check.automated, check.manual]) {
      if (!isManDelivery(task.metadata)) {
        if (evidence?.subject)
          throw new Error('MANCODE_MAN_DELIVERY_MODE_REQUIRED');
      } else if (
        evidence?.status === 'passed' &&
        (evidence.subject?.contentDigest !== subject.contentDigest ||
          evidence.subject.environment !== subject.environment)
      ) {
        throw new Error(
          `MANCODE_MAN_VERIFICATION_SUBJECT_STALE: ${check.displayId}`,
        );
      }
    }
  }
}

export function manScopeContains(
  metadata: WorkflowMetadataV3,
  file: string,
): boolean {
  return evaluateClaimScopeSubset(
    { paths: [file], modules: [], apis: [], schemas: [] },
    metadata.implementationScope,
  ).allowed;
}

export async function inspectManDelivery(
  root: string,
  task: StoredTaskSnapshot,
) {
  if (!isManDelivery(task.metadata))
    throw new Error('MANCODE_MAN_DELIVERY_MODE_REQUIRED');
  const bound = await readBoundManPlan(root, task);
  const subject = await captureManSubject(root, task);
  const head = await readCheckoutCodeHead(root);
  const trackedDirty = (
    await manGit(
      root,
      head === null
        ? ['ls-files', '-z', '--cached']
        : ['diff', '--name-only', '--relative', '-z', 'HEAD', '--', '.'],
    )
  )
    .split('\0')
    .filter(Boolean);
  const untracked = (
    await manGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  const inTask = (file: string) =>
    file === bound.source.path || manScopeContains(task.metadata, file);
  const pendingCommit = [...new Set([...trackedDirty, ...untracked])].filter(
    inTask,
  );
  const committedChanges =
    head === null
      ? []
      : bound.source.baseHead === null
        ? (await manGit(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']))
            .split('\0')
            .filter(Boolean)
        : (
            await manGit(root, [
              'diff',
              '--name-only',
              '--relative',
              '-z',
              bound.source.baseHead,
              'HEAD',
              '--',
              '.',
            ])
          )
            .split('\0')
            .filter(Boolean);
  const outsideScope = committedChanges.filter(
    (file) => !file.startsWith('.mancode/') && !inTask(file),
  );
  const upstream =
    (
      await manGit(root, [
        'for-each-ref',
        '--format=%(upstream:short)',
        `refs/heads/${(await manGit(root, ['branch', '--show-current'])).trim()}`,
      ])
    ).trim() || null;
  return {
    subject,
    source: bound.source,
    pendingCommit,
    outsideScope,
    upstream,
    publication: upstream === null ? 'unpublished' : 'unknown',
  };
}

/** Read the actual upstream ref, never equate a cached tracking ref with publication. */
export async function inspectManPublication(root: string) {
  const head = await readCheckoutCodeHead(root);
  const branch = (await manGit(root, ['branch', '--show-current'])).trim();
  if (!head || !branch)
    return { status: 'unpublished', reason: 'no committed task branch' };
  const [remote, ref] = (
    await manGit(root, [
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)',
      `refs/heads/${branch}`,
    ])
  )
    .trim()
    .split('\0');
  if (!remote || !ref)
    return { status: 'unpublished', reason: 'no upstream configured' };
  try {
    const remoteHead = (
      await manGit(root, ['ls-remote', '--exit-code', '--', remote, ref])
    )
      .trim()
      .split(/\s+/)[0];
    if (!remoteHead)
      return { status: 'unpublished', reason: 'upstream ref absent' };
    if (remoteHead === head) return { status: 'published', head, remoteHead };
    // Do not fetch or update refs just to decide this. Unknown remote objects remain unverified.
    try {
      await manGit(root, ['merge-base', '--is-ancestor', head, remoteHead]);
      return { status: 'published', head, remoteHead };
    } catch (error) {
      if ((error as { code?: unknown }).code === 1)
        return {
          status: 'unpublished',
          head,
          remoteHead,
          reason: 'upstream does not contain this commit',
        };
      throw error;
    }
  } catch (error) {
    return {
      status: 'unverified',
      reason:
        'upstream publication could not be verified; no fetch, push or business-state change was performed',
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

export function renderManDeliveryRecord(
  task: StoredTaskSnapshot,
  subject?: ManEvidenceSubject,
): string {
  const reviewStale =
    subject &&
    task.review.delivery &&
    (task.review.delivery.subject.contentDigest !== subject.contentDigest ||
      task.review.delivery.subject.environment !== subject.environment);
  const verificationStale =
    subject &&
    task.verification.checks.some((check) =>
      [check.automated, check.manual].some(
        (item) =>
          item?.status === 'passed' &&
          (item.subject?.contentDigest !== subject.contentDigest ||
            item.subject.environment !== subject.environment),
      ),
    );
  return [
    `Task: ${task.metadata.taskRef.namespace}:${task.metadata.taskRef.taskId}`,
    `Plan version: ${task.metadata.governance.planVersion}`,
    `Review: ${reviewStale ? 'stale' : task.review.status}`,
    `Verification: ${verificationStale ? 'stale' : task.verification.status}`,
    '',
    ...(task.review.delivery
      ? [
          `Reviewer: ${task.review.delivery.reviewer}`,
          `Direction: ${task.review.delivery.direction}`,
          `Correctness: ${task.review.delivery.correctness}`,
          `Proportionality: ${task.review.delivery.proportionality}`,
          `Next: ${task.review.delivery.nextAction}`,
        ]
      : [
          'Next: finish relevant verification, then review the complete module.',
        ]),
    ...task.review.blockers.map(
      (item) => `- ${item.displayId}: ${item.status} — ${item.summary}`,
    ),
    ...(task.review.delivery?.coverage.map(
      (row) => `- ${row.acceptanceId}: ${row.status} — ${row.evidence}`,
    ) ?? []),
    ...task.verification.checks.map(
      (check) =>
        `- ${check.displayId}: automated=${check.automated?.status ?? 'n/a'}; manual=${check.manual?.status ?? 'n/a'}; ${check.automated?.summary ?? check.manual?.summary ?? 'No evidence yet.'}`,
    ),
  ].join('\n');
}

export async function syncManDeliveryRecord(
  root: string,
  task: StoredTaskSnapshot,
) {
  const bound = await readBoundManPlan(root, task);
  if (
    task.metadata.governance.planDecision === 'governed_execution' &&
    !manScopeContains(task.metadata, bound.source.path)
  )
    throw new Error('MANCODE_MAN_PLAN_OUTSIDE_SCOPE');
  const subject = (await hasGitWorktree(root))
    ? await captureManSubject(root, task)
    : undefined;
  const next = replaceManDeliveryRecord(
    bound.document,
    renderManDeliveryRecord(task, subject),
  );
  if (
    scanSharedText(next).some((finding) =>
      ['authorization', 'cookie', 'private_key', 'secret'].includes(
        finding.kind,
      ),
    )
  )
    throw new Error(
      'MANCODE_MAN_DOCUMENT_SENSITIVE: redact credential-like text before versioning',
    );
  const target = await realpath(path.join(root, bound.source.path));
  if (next !== bound.document) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, {
        flag: 'wx',
        mode: (await lstat(target)).mode,
      });
      if ((await readFile(target, 'utf8')) !== bound.document)
        throw new Error('MANCODE_MAN_PLAN_FILE_CHANGED');
      await replaceFileAtomically(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  let taskId: string;
  try {
    taskId =
      manProgressTaskId(bound.baseline) ??
      `${task.metadata.taskRef.namespace}:${task.metadata.taskRef.taskId}`;
  } catch (error) {
    return {
      status: 'manual_sync' as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const unresolved = task.requirements.blockingUnknowns.filter(
    (item) => item.status === 'open',
  );
  const reason =
    task.metadata.status === 'blocked' && unresolved.length
      ? unresolved.map((item) => item.statement).join('; ')
      : null;
  const currentEvidence =
    subject !== undefined &&
    task.verification.checks.every((check) =>
      [check.automated, check.manual].every(
        (item) =>
          item?.status !== 'passed' ||
          (item.subject?.contentDigest === subject.contentDigest &&
            item.subject.environment === subject.environment),
      ),
    );
  const verified = currentEvidence && task.verification.status === 'passed';
  const reviewed =
    task.review.status === 'skipped' ||
    (task.review.status === 'passed' &&
      task.review.delivery?.subject.contentDigest === subject?.contentDigest &&
      task.review.delivery?.subject.environment === subject?.environment);
  const status: ManProgressStatus = reason
    ? '阻塞'
    : verified && reviewed
      ? '已完成'
      : verified && task.review.status !== 'blocked'
        ? '待审核'
        : task.metadata.currentStep >= 5
          ? '进行中'
          : '未完成';
  return syncManProgressPage(
    root,
    taskId,
    status,
    reason,
    manScopeContains(task.metadata, '项目进度.html'),
  );
}

export async function assertManDeliveryReady(
  root: string,
  task: StoredTaskSnapshot,
): Promise<void> {
  if (!isManDelivery(task.metadata)) return;
  if (
    task.metadata.governance.planDecision !== 'governed_execution' ||
    !['passed', 'skipped'].includes(task.review.status) ||
    task.verification.status !== 'passed'
  )
    throw new Error('MANCODE_MAN_DELIVERY_NOT_VERIFIED');
  const result = await inspectManDelivery(root, task);
  assertManReviewCoverage(task, task.review, result.subject);
  assertManVerificationSubjects(task, task.verification, result.subject);
  const bound = await readBoundManPlan(root, task);
  if (
    parseManPlanDocument(bound.document).record !==
    renderManDeliveryRecord(task, result.subject).trim()
  )
    throw new Error('MANCODE_MAN_DELIVERY_RECORD_STALE');
  if (result.outsideScope.length)
    throw new Error(
      `MANCODE_MAN_COMMIT_OUTSIDE_SCOPE: ${result.outsideScope.join(', ')}`,
    );
  if (result.pendingCommit.length)
    throw new Error(
      `MANCODE_MAN_DELIVERY_UNCOMMITTED: ${result.pendingCommit.join(', ')}`,
    );
}
