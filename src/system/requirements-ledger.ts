import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type VerificationMethod = 'automated' | 'manual' | 'hybrid';
export type RequirementCoverageStatus =
  | 'confirmed'
  | 'defaulted'
  | 'not_applicable';
export type RequirementDimension =
  | 'platform'
  | 'core_scope'
  | 'technical_stack'
  | 'data_and_persistence'
  | 'performance'
  | 'compatibility'
  | 'security';

export interface RequirementCoverage {
  dimension: RequirementDimension;
  status: RequirementCoverageStatus;
  rationale: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
  method: VerificationMethod;
}

export interface RequirementsLedger {
  version: 1;
  goal: string;
  confirmedScope: string[];
  excludedScope: string[];
  technicalDecisions: string[];
  defaults: string[];
  blockingUnknowns: string[];
  coverage: RequirementCoverage[];
  acceptanceCriteria: AcceptanceCriterion[];
}

const REQUIREMENTS_FILE = 'requirements.json';
const REQUIREMENTS_MARKDOWN_FILE = 'requirements.md';
const ACCEPTANCE_ID_PATTERN = /^AC-[A-Z0-9][A-Z0-9-]{0,27}$/;
export const REQUIREMENT_DIMENSIONS: RequirementDimension[] = [
  'platform',
  'core_scope',
  'technical_stack',
  'data_and_persistence',
  'performance',
  'compatibility',
  'security',
];

export function parseRequirementsLedger(raw: string): RequirementsLedger {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('requirements input must be valid JSON');
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('requirements version must be 1');
  }
  const stringFields = [
    'confirmedScope',
    'excludedScope',
    'technicalDecisions',
    'defaults',
    'blockingUnknowns',
  ] as const;
  if (typeof value.goal !== 'string' || !value.goal.trim()) {
    throw new Error('requirements goal is required');
  }
  for (const field of stringFields) {
    if (!isNonEmptyStringArray(value[field])) {
      if (!Array.isArray(value[field]) || value[field].length > 0) {
        throw new Error(`requirements ${field} must contain non-empty strings`);
      }
    }
  }
  if (!Array.isArray(value.coverage)) {
    throw new Error('requirements coverage is required');
  }
  const coverageDimensions = new Set<RequirementDimension>();
  const coverage = value.coverage.map((item) => {
    if (
      !isRecord(item) ||
      !isRequirementDimension(item.dimension) ||
      !isCoverageStatus(item.status) ||
      typeof item.rationale !== 'string' ||
      !item.rationale.trim()
    ) {
      throw new Error('invalid requirements coverage item');
    }
    if (coverageDimensions.has(item.dimension)) {
      throw new Error(`duplicate requirements coverage: ${item.dimension}`);
    }
    coverageDimensions.add(item.dimension);
    return {
      dimension: item.dimension,
      status: item.status,
      rationale: item.rationale.trim(),
    };
  });
  const missingDimensions = REQUIREMENT_DIMENSIONS.filter(
    (dimension) => !coverageDimensions.has(dimension),
  );
  if (missingDimensions.length > 0) {
    throw new Error(
      `requirements coverage is missing: ${missingDimensions.join(', ')}`,
    );
  }
  if ((value.confirmedScope as string[]).length === 0) {
    throw new Error('requirements confirmedScope must not be empty');
  }
  const stackCoverage = coverage.find(
    (item) => item.dimension === 'technical_stack',
  );
  if (
    stackCoverage?.status !== 'not_applicable' &&
    (value.technicalDecisions as string[]).length === 0
  ) {
    throw new Error(
      'requirements technicalDecisions are required when technical_stack applies',
    );
  }
  if (
    !Array.isArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.length === 0
  ) {
    throw new Error('requirements need at least one acceptance criterion');
  }
  const ids = new Set<string>();
  const acceptanceCriteria = value.acceptanceCriteria.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !ACCEPTANCE_ID_PATTERN.test(item.id) ||
      typeof item.description !== 'string' ||
      !item.description.trim() ||
      typeof item.required !== 'boolean' ||
      !isVerificationMethod(item.method)
    ) {
      throw new Error('invalid acceptance criterion');
    }
    if (ids.has(item.id)) {
      throw new Error(`duplicate acceptance criterion: ${item.id}`);
    }
    ids.add(item.id);
    return {
      id: item.id,
      description: item.description.trim(),
      required: item.required,
      method: item.method,
    };
  });
  if (!acceptanceCriteria.some((item) => item.required)) {
    throw new Error(
      'requirements need at least one required acceptance criterion',
    );
  }
  return {
    version: 1,
    goal: value.goal.trim(),
    confirmedScope: normalizeStrings(value.confirmedScope),
    excludedScope: normalizeStrings(value.excludedScope),
    technicalDecisions: normalizeStrings(value.technicalDecisions),
    defaults: normalizeStrings(value.defaults),
    blockingUnknowns: normalizeStrings(value.blockingUnknowns),
    coverage,
    acceptanceCriteria,
  };
}

export function requirementsAreReady(ledger: RequirementsLedger): boolean {
  return ledger.blockingUnknowns.length === 0;
}

export function requirementsDigest(ledger: RequirementsLedger): string {
  return createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
}

export async function readRequirementsLedger(
  projectRoot: string,
  taskId: string,
): Promise<RequirementsLedger | null> {
  try {
    const raw = await readFile(requirementsPath(projectRoot, taskId), 'utf-8');
    return parseRequirementsLedger(raw);
  } catch {
    return null;
  }
}

export async function writeRequirementsArtifacts(
  projectRoot: string,
  taskId: string,
  ledger: RequirementsLedger,
): Promise<void> {
  const dir = workflowDir(projectRoot, taskId);
  await writeFile(
    path.join(dir, REQUIREMENTS_FILE),
    `${JSON.stringify(ledger, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    path.join(dir, REQUIREMENTS_MARKDOWN_FILE),
    renderRequirementsMarkdown(ledger),
    'utf-8',
  );
}

export function renderRequirementsMarkdown(ledger: RequirementsLedger): string {
  const section = (title: string, items: string[]) =>
    `## ${title}\n\n${items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- 无'}\n`;
  const criteria = ledger.acceptanceCriteria
    .map(
      (item) =>
        `- **${item.id}** [${item.required ? '必需' : '可选'} / ${item.method}] ${item.description}`,
    )
    .join('\n');
  const coverage = ledger.coverage
    .map((item) => `- **${item.dimension}** [${item.status}] ${item.rationale}`)
    .join('\n');
  return `# Requirements\n\n## 用户目标\n\n${ledger.goal}\n\n${section('已确认范围', ledger.confirmedScope)}\n${section('明确排除项', ledger.excludedScope)}\n${section('技术决策', ledger.technicalDecisions)}\n${section('默认值与理由', ledger.defaults)}\n## 需求覆盖\n\n${coverage}\n\n## 验收标准\n\n${criteria}\n\n${section('阻塞性未决问题', ledger.blockingUnknowns)}\n## Readiness\n\n${requirementsAreReady(ledger) ? 'READY' : 'NEEDS_CLARIFICATION'}\n`;
}

function requirementsPath(projectRoot: string, taskId: string): string {
  return path.join(workflowDir(projectRoot, taskId), REQUIREMENTS_FILE);
}

function workflowDir(projectRoot: string, taskId: string): string {
  return path.join(projectRoot, '.mancode', 'workflows', taskId);
}

function normalizeStrings(value: unknown): string[] {
  return (value as string[]).map((item) => item.trim());
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function isVerificationMethod(value: unknown): value is VerificationMethod {
  return value === 'automated' || value === 'manual' || value === 'hybrid';
}

function isRequirementDimension(value: unknown): value is RequirementDimension {
  return REQUIREMENT_DIMENSIONS.some((dimension) => dimension === value);
}

function isCoverageStatus(value: unknown): value is RequirementCoverageStatus {
  return (
    value === 'confirmed' || value === 'defaulted' || value === 'not_applicable'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
