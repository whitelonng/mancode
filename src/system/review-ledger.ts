import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ReviewDepth = 'targeted' | 'full';
export type ReviewDomain = 'quality' | 'security';

export interface ReviewBlocker {
  id: string;
  domain: ReviewDomain;
  status: 'open' | 'resolved';
}

export interface ReviewLedger {
  version: '1.0';
  depth: ReviewDepth;
  requiredDomains: ReviewDomain[];
  completedDomains: ReviewDomain[];
  reports: Partial<Record<ReviewDomain, string>>;
  blockers: ReviewBlocker[];
  remediationRounds: number;
  skipped?: {
    reason: string;
    recordedAt: string;
  };
}

const REVIEW_FILE = 'review-ledger.json';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BLOCKER_ID_PATTERN = /^[A-Z][A-Z0-9-]{0,31}$/;

export function isReviewDepth(value: unknown): value is ReviewDepth {
  return value === 'targeted' || value === 'full';
}

export function isReviewDomain(value: unknown): value is ReviewDomain {
  return value === 'quality' || value === 'security';
}

export async function initializeReview(
  projectRoot: string,
  taskId: string,
  depth: ReviewDepth,
  targetDomain?: ReviewDomain,
): Promise<ReviewLedger> {
  assertValidTaskId(taskId);
  const existing = await readReviewLedger(projectRoot, taskId);
  if (existing) throw new Error(`review already initialized: ${taskId}`);
  if (depth === 'targeted' && !targetDomain) {
    throw new Error('targeted review requires a review domain');
  }

  const ledger: ReviewLedger = {
    version: '1.0',
    depth,
    requiredDomains:
      depth === 'full'
        ? ['quality', 'security']
        : [targetDomain as ReviewDomain],
    completedDomains: [],
    reports: {},
    blockers: [],
    remediationRounds: 0,
  };
  await writeReviewLedger(projectRoot, taskId, ledger);
  return ledger;
}

export async function initializeSkippedReview(
  projectRoot: string,
  taskId: string,
  reason: string,
): Promise<ReviewLedger> {
  assertValidTaskId(taskId);
  if (!reason.trim()) throw new Error('review skip reason is required');
  const existing = await readReviewLedger(projectRoot, taskId);
  if (existing) throw new Error(`review already initialized: ${taskId}`);
  const ledger: ReviewLedger = {
    version: '1.0',
    depth: 'targeted',
    requiredDomains: [],
    completedDomains: [],
    reports: {},
    blockers: [],
    remediationRounds: 0,
    skipped: {
      reason: reason.trim(),
      recordedAt: new Date().toISOString(),
    },
  };
  await writeReviewLedger(projectRoot, taskId, ledger);
  return ledger;
}

export async function completeReviewDomain(
  projectRoot: string,
  taskId: string,
  domain: ReviewDomain,
  report: string,
  blockerIds: string[],
): Promise<ReviewLedger> {
  const ledger = await requireReviewLedger(projectRoot, taskId);
  if (!ledger.requiredDomains.includes(domain)) {
    throw new Error(`review domain is not required: ${domain}`);
  }
  if (ledger.completedDomains.includes(domain)) {
    throw new Error(`review domain already completed: ${domain}`);
  }
  if (domain === 'security' && !ledger.completedDomains.includes('quality')) {
    throw new Error('quality review must complete first');
  }
  assertSafeReportPath(report);
  await assertReportExists(projectRoot, taskId, report);
  const uniqueIds = new Set(blockerIds);
  if (uniqueIds.size !== blockerIds.length) {
    throw new Error('review blocker ids must be unique');
  }
  for (const id of blockerIds) {
    if (!BLOCKER_ID_PATTERN.test(id)) {
      throw new Error(`invalid review blocker id: ${id}`);
    }
    if (ledger.blockers.some((blocker) => blocker.id === id)) {
      throw new Error(`duplicate review blocker id: ${id}`);
    }
  }

  const updated: ReviewLedger = {
    ...ledger,
    completedDomains: [...ledger.completedDomains, domain],
    reports: { ...ledger.reports, [domain]: report },
    blockers: [
      ...ledger.blockers,
      ...blockerIds.map((id) => ({
        id,
        domain,
        status: 'open' as const,
      })),
    ],
  };
  await writeReviewLedger(projectRoot, taskId, updated);
  return updated;
}

export async function remediateReviewBlockers(
  projectRoot: string,
  taskId: string,
  resolvedIds: string[],
): Promise<ReviewLedger> {
  const ledger = await requireReviewLedger(projectRoot, taskId);
  if (ledger.remediationRounds >= 1) {
    throw new Error('review allows only one remediation round');
  }
  if (resolvedIds.length === 0) {
    throw new Error('review remediation requires resolved blocker ids');
  }
  const uniqueIds = new Set(resolvedIds);
  if (uniqueIds.size !== resolvedIds.length) {
    throw new Error('resolved review blocker ids must be unique');
  }
  for (const id of resolvedIds) {
    const blocker = ledger.blockers.find((item) => item.id === id);
    if (!blocker || blocker.status !== 'open') {
      throw new Error(`review blocker is not open: ${id}`);
    }
  }

  const updated: ReviewLedger = {
    ...ledger,
    remediationRounds: ledger.remediationRounds + 1,
    blockers: ledger.blockers.map((blocker) =>
      uniqueIds.has(blocker.id) ? { ...blocker, status: 'resolved' } : blocker,
    ),
  };
  await writeReviewLedger(projectRoot, taskId, updated);
  return updated;
}

export async function reviewCanComplete(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  const ledger = await readReviewLedger(projectRoot, taskId);
  if (!ledger) return false;
  if (ledger.skipped) return true;
  return (
    ledger.requiredDomains.every((domain) =>
      ledger.completedDomains.includes(domain),
    ) && ledger.blockers.every((blocker) => blocker.status === 'resolved')
  );
}

export async function readReviewLedger(
  projectRoot: string,
  taskId: string,
): Promise<ReviewLedger | null> {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  try {
    const raw = await readFile(reviewPath(projectRoot, taskId), 'utf-8');
    const value = JSON.parse(raw) as unknown;
    return isReviewLedger(value) ? value : null;
  } catch {
    return null;
  }
}

function isReviewLedger(value: unknown): value is ReviewLedger {
  if (!isRecord(value)) return false;
  if (
    value.version !== '1.0' ||
    !isReviewDepth(value.depth) ||
    !isDomainArray(value.requiredDomains) ||
    !isDomainArray(value.completedDomains) ||
    !isRecord(value.reports) ||
    !Array.isArray(value.blockers) ||
    (value.remediationRounds !== 0 && value.remediationRounds !== 1)
  ) {
    return false;
  }
  const requiredDomains = value.requiredDomains as ReviewDomain[];
  const completedDomains = value.completedDomains as ReviewDomain[];
  const reports = value.reports as Record<string, unknown>;
  const blockers = value.blockers as unknown[];
  const expectedDomains: ReviewDomain[] =
    value.depth === 'full' ? ['quality', 'security'] : requiredDomains;
  if (value.skipped !== undefined) {
    return (
      isRecord(value.skipped) &&
      typeof value.skipped.reason === 'string' &&
      value.skipped.reason.trim().length > 0 &&
      typeof value.skipped.recordedAt === 'string' &&
      requiredDomains.length === 0 &&
      completedDomains.length === 0 &&
      Object.keys(reports).length === 0 &&
      blockers.length === 0 &&
      value.remediationRounds === 0
    );
  }
  if (
    (value.depth === 'targeted' && requiredDomains.length !== 1) ||
    requiredDomains.length !== expectedDomains.length ||
    !expectedDomains.every((domain) => requiredDomains.includes(domain)) ||
    new Set(completedDomains).size !== completedDomains.length ||
    completedDomains.some((domain) => !requiredDomains.includes(domain)) ||
    completedDomains.some((domain) => {
      const report = reports[domain];
      return typeof report !== 'string' || !isSafeReportPath(report);
    })
  ) {
    return false;
  }
  const blockerIds = new Set<string>();
  return blockers.every(
    (blocker) =>
      isRecord(blocker) &&
      typeof blocker.id === 'string' &&
      BLOCKER_ID_PATTERN.test(blocker.id) &&
      !blockerIds.has(blocker.id) &&
      blockerIds.add(blocker.id) &&
      isReviewDomain(blocker.domain) &&
      completedDomains.includes(blocker.domain) &&
      (blocker.status === 'open' || blocker.status === 'resolved'),
  );
}

function isDomainArray(value: unknown): value is ReviewDomain[] {
  return Array.isArray(value) && value.every(isReviewDomain);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requireReviewLedger(
  projectRoot: string,
  taskId: string,
): Promise<ReviewLedger> {
  assertValidTaskId(taskId);
  const ledger = await readReviewLedger(projectRoot, taskId);
  if (!ledger) throw new Error(`review not initialized: ${taskId}`);
  return ledger;
}

async function writeReviewLedger(
  projectRoot: string,
  taskId: string,
  ledger: ReviewLedger,
): Promise<void> {
  const dir = path.join(projectRoot, '.mancode', 'workflows', taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, REVIEW_FILE),
    `${JSON.stringify(ledger, null, 2)}\n`,
    'utf-8',
  );
}

export function reviewLedgerPath(projectRoot: string, taskId: string): string {
  assertValidTaskId(taskId);
  return reviewPath(projectRoot, taskId);
}

function reviewPath(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, '.mancode', 'workflows', taskId, REVIEW_FILE);
}

function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`invalid workflow taskId: ${taskId}`);
  }
}

function assertSafeReportPath(report: string): void {
  if (!isSafeReportPath(report)) {
    throw new Error(`invalid review report path: ${report}`);
  }
}

async function assertReportExists(
  projectRoot: string,
  taskId: string,
  report: string,
): Promise<void> {
  const reportPath = path.join(
    projectRoot,
    '.mancode',
    'workflows',
    taskId,
    report,
  );
  try {
    if ((await stat(reportPath)).isFile()) return;
  } catch {
    // Report is missing or unreadable.
  }
  throw new Error(`review report not found: ${report}`);
}

function isSafeReportPath(report: string): boolean {
  const normalized = path.posix.normalize(report.replaceAll('\\', '/'));
  return Boolean(
    report.trim() &&
      !path.isAbsolute(report) &&
      normalized !== '..' &&
      !normalized.startsWith('../') &&
      normalized.endsWith('.md'),
  );
}
