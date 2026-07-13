import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type RequirementsLedger,
  readRequirementsLedger,
  requirementsDigest,
} from './requirements-ledger.js';
import { readReviewLedger } from './review-ledger.js';

export type VerificationComponentStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'manual_required'
  | 'blocked';
export type VerificationOverallStatus = VerificationComponentStatus;
export type VerificationComponent = 'automated' | 'manual';

export interface VerificationEvidence {
  status: VerificationComponentStatus;
  evidence?: string;
  updatedAt?: string;
  command?: string;
  exitCode?: number;
  evidenceFile?: string;
}

export interface VerificationCheck {
  acceptanceId: string;
  required: boolean;
  automated?: VerificationEvidence;
  manual?: VerificationEvidence;
}

export interface VerificationLedger {
  version: 1;
  planVersion: number;
  requirementsDigest: string;
  remediationRound: number;
  status: VerificationOverallStatus;
  checks: VerificationCheck[];
}

const VERIFICATION_FILE = 'verification-ledger.json';

export function initializeVerificationLedger(
  requirements: RequirementsLedger,
  planVersion: number,
  remediationRound = 0,
): VerificationLedger {
  const checks = requirements.acceptanceCriteria.map((criterion) => ({
    acceptanceId: criterion.id,
    required: criterion.required,
    ...(criterion.method === 'automated' || criterion.method === 'hybrid'
      ? { automated: { status: 'pending' as const } }
      : {}),
    ...(criterion.method === 'manual' || criterion.method === 'hybrid'
      ? { manual: { status: 'pending' as const } }
      : {}),
  }));
  return {
    version: 1,
    planVersion,
    requirementsDigest: requirementsDigest(requirements),
    remediationRound,
    status: deriveVerificationStatus(checks),
    checks,
  };
}

export function recordVerification(
  ledger: VerificationLedger,
  acceptanceId: string,
  component: VerificationComponent,
  result: VerificationComponentStatus,
  evidence: string,
  automatedDetails?: {
    command: string;
    exitCode: number;
    evidenceFile?: string;
  },
): VerificationLedger {
  if (!evidence.trim()) throw new Error('verification evidence is required');
  if (component === 'automated' && result === 'manual_required') {
    throw new Error('automated verification cannot be manual_required');
  }
  if (
    component === 'automated' &&
    (result === 'passed' || result === 'failed')
  ) {
    if (
      !automatedDetails?.command.trim() ||
      !Number.isInteger(automatedDetails.exitCode)
    ) {
      throw new Error(
        'automated passed/failed verification requires command and exit code',
      );
    }
    if (result === 'passed' && automatedDetails.exitCode !== 0) {
      throw new Error('passed verification requires exit code 0');
    }
    if (result === 'failed' && automatedDetails.exitCode === 0) {
      throw new Error('failed verification requires a non-zero exit code');
    }
  }
  if (component === 'manual' && result !== 'manual_required') {
    throw new Error(
      'manual verification must use require-manual or confirm-manual',
    );
  }
  const index = ledger.checks.findIndex(
    (check) => check.acceptanceId === acceptanceId,
  );
  if (index < 0)
    throw new Error(`unknown acceptance criterion: ${acceptanceId}`);
  const check = ledger.checks[index];
  if (!check) throw new Error(`unknown acceptance criterion: ${acceptanceId}`);
  if (!check[component]) {
    throw new Error(
      `${acceptanceId} does not require ${component} verification`,
    );
  }
  const checks = [...ledger.checks];
  checks[index] = {
    ...check,
    [component]: {
      status: result,
      evidence: evidence.trim(),
      updatedAt: new Date().toISOString(),
      ...(component === 'automated' && automatedDetails
        ? {
            command: automatedDetails.command.trim(),
            exitCode: automatedDetails.exitCode,
            ...(automatedDetails.evidenceFile
              ? { evidenceFile: automatedDetails.evidenceFile }
              : {}),
          }
        : {}),
    },
  };
  return { ...ledger, status: deriveVerificationStatus(checks), checks };
}

export function resetVerificationForRemediation(
  ledger: VerificationLedger,
  remediationRound: number,
): VerificationLedger {
  if (
    !Number.isInteger(remediationRound) ||
    remediationRound < ledger.remediationRound
  ) {
    throw new Error('invalid verification remediation round');
  }
  if (remediationRound === ledger.remediationRound) return ledger;
  const checks = ledger.checks.map((check) => ({
    acceptanceId: check.acceptanceId,
    required: check.required,
    ...(check.automated ? { automated: { status: 'pending' as const } } : {}),
    ...(check.manual ? { manual: { status: 'pending' as const } } : {}),
  }));
  return {
    ...ledger,
    remediationRound,
    status: deriveVerificationStatus(checks),
    checks,
  };
}

export function confirmManualVerification(
  ledger: VerificationLedger,
  acceptanceId: string,
  evidence: string,
): VerificationLedger {
  if (!evidence.trim())
    throw new Error('manual confirmation evidence is required');
  const index = ledger.checks.findIndex(
    (check) => check.acceptanceId === acceptanceId,
  );
  if (index < 0)
    throw new Error(`unknown acceptance criterion: ${acceptanceId}`);
  const check = ledger.checks[index];
  if (!check) throw new Error(`unknown acceptance criterion: ${acceptanceId}`);
  if (!check.manual) {
    throw new Error(`${acceptanceId} does not require manual verification`);
  }
  if (check.manual.status !== 'manual_required') {
    throw new Error(`${acceptanceId} is not awaiting manual confirmation`);
  }
  const checks = [...ledger.checks];
  checks[index] = {
    ...check,
    manual: {
      status: 'passed',
      evidence: evidence.trim(),
      updatedAt: new Date().toISOString(),
    },
  };
  return { ...ledger, status: deriveVerificationStatus(checks), checks };
}

export function deriveVerificationStatus(
  checks: VerificationCheck[],
): VerificationOverallStatus {
  const statuses = checks
    .filter((check) => check.required)
    .flatMap((check) => [check.automated?.status, check.manual?.status])
    .filter((status): status is VerificationComponentStatus => Boolean(status));
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('manual_required')) return 'manual_required';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.every((status) => status === 'passed')) return 'passed';
  return 'pending';
}

export async function readVerificationLedger(
  projectRoot: string,
  taskId: string,
): Promise<VerificationLedger | null> {
  try {
    const raw = await readFile(verificationPath(projectRoot, taskId), 'utf-8');
    const value = JSON.parse(raw) as VerificationLedger;
    return isVerificationLedger(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeVerificationLedger(
  projectRoot: string,
  taskId: string,
  ledger: VerificationLedger,
): Promise<void> {
  await writeFile(
    verificationPath(projectRoot, taskId),
    `${JSON.stringify(ledger, null, 2)}\n`,
    'utf-8',
  );
}

export async function verificationCanAdvance(
  projectRoot: string,
  taskId: string,
  planVersion: number,
): Promise<boolean> {
  const [ledger, requirements, review] = await Promise.all([
    readVerificationLedger(projectRoot, taskId),
    readRequirementsLedger(projectRoot, taskId),
    readReviewLedger(projectRoot, taskId),
  ]);
  return Boolean(
    ledger &&
      requirements &&
      ledger.status === 'passed' &&
      ledger.planVersion === planVersion &&
      ledger.remediationRound === (review?.remediationRounds ?? 0) &&
      ledger.requirementsDigest === requirementsDigest(requirements) &&
      ledgerMatchesRequirements(ledger, requirements),
  );
}

export function verificationLedgerPath(
  projectRoot: string,
  taskId: string,
): string {
  return verificationPath(projectRoot, taskId);
}

function verificationPath(projectRoot: string, taskId: string): string {
  return path.join(
    projectRoot,
    '.mancode',
    'workflows',
    taskId,
    VERIFICATION_FILE,
  );
}

function isVerificationLedger(value: unknown): value is VerificationLedger {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('planVersion' in value) ||
    !Number.isInteger(value.planVersion) ||
    !('requirementsDigest' in value) ||
    typeof value.requirementsDigest !== 'string' ||
    !('remediationRound' in value) ||
    typeof value.remediationRound !== 'number' ||
    !Number.isInteger(value.remediationRound) ||
    value.remediationRound < 0 ||
    !('status' in value) ||
    !isComponentStatus(value.status) ||
    !('checks' in value) ||
    !Array.isArray(value.checks)
  ) {
    return false;
  }
  const ids = new Set<string>();
  const validChecks = value.checks.every((check) => {
    if (
      typeof check !== 'object' ||
      check === null ||
      !('acceptanceId' in check) ||
      typeof check.acceptanceId !== 'string' ||
      !('required' in check) ||
      typeof check.required !== 'boolean'
    ) {
      return false;
    }
    if (ids.has(check.acceptanceId)) return false;
    ids.add(check.acceptanceId);
    return ['automated', 'manual'].every((component) => {
      const evidence = check[component as keyof typeof check];
      if (evidence === undefined) return true;
      const valid =
        typeof evidence === 'object' &&
        evidence !== null &&
        'status' in evidence &&
        isComponentStatus(evidence.status);
      if (!valid) return false;
      if (evidence.status === 'pending') {
        return !('evidence' in evidence) && !('updatedAt' in evidence);
      }
      const baseEvidenceIsValid =
        'evidence' in evidence &&
        typeof evidence.evidence === 'string' &&
        evidence.evidence.trim().length > 0 &&
        'updatedAt' in evidence &&
        typeof evidence.updatedAt === 'string';
      if (!baseEvidenceIsValid) return false;
      if (
        component === 'automated' &&
        (evidence.status === 'passed' || evidence.status === 'failed')
      ) {
        return (
          'command' in evidence &&
          typeof evidence.command === 'string' &&
          evidence.command.trim().length > 0 &&
          'exitCode' in evidence &&
          Number.isInteger(evidence.exitCode) &&
          (evidence.status === 'passed'
            ? evidence.exitCode === 0
            : evidence.exitCode !== 0)
        );
      }
      return true;
    });
  });
  return validChecks && value.status === deriveVerificationStatus(value.checks);
}

function ledgerMatchesRequirements(
  ledger: VerificationLedger,
  requirements: RequirementsLedger,
): boolean {
  if (ledger.checks.length !== requirements.acceptanceCriteria.length) {
    return false;
  }
  return requirements.acceptanceCriteria.every((criterion) => {
    const check = ledger.checks.find(
      (candidate) => candidate.acceptanceId === criterion.id,
    );
    if (!check || check.required !== criterion.required) return false;
    const needsAutomated =
      criterion.method === 'automated' || criterion.method === 'hybrid';
    const needsManual =
      criterion.method === 'manual' || criterion.method === 'hybrid';
    return (
      Boolean(check.automated) === needsAutomated &&
      Boolean(check.manual) === needsManual
    );
  });
}

function isComponentStatus(
  value: unknown,
): value is VerificationComponentStatus {
  return (
    value === 'pending' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'manual_required' ||
    value === 'blocked'
  );
}
