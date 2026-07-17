import type { TeamRecommendationPolicy } from './policy.js';

export type TeamRecommendation = 'single' | 'team';
export type TeamAssessmentConfidence = 'high' | 'medium' | 'low';
export type TeamAssessmentSource = 'explicit' | 'task' | 'auto' | 'fallback';

export interface TeamAssessmentSignals {
  isGitRepository: boolean;
  remoteCount: number;
  contributorsAllTime: number;
  contributorsRecent: number;
  hasTrackedUpstream: boolean;
  hasCodeowners: boolean;
  hasPullRequestTemplate: boolean;
}

export interface TeamAssessment {
  recommendation: TeamRecommendation;
  confidence: TeamAssessmentConfidence;
  source: TeamAssessmentSource;
  signals: TeamAssessmentSignals;
  reasons: string[];
  evaluatedAt: string;
}

export interface TeamAssessmentInput {
  policy: TeamRecommendationPolicy;
  signals: TeamAssessmentSignals | null;
  evaluatedAt: string;
  explicitRecommendation?: TeamRecommendation;
  taskRecommendation?: TeamRecommendation;
}

/**
 * Assessment never mutates workflow mode, visibility, or coordination. The
 * caller may surface this recommendation only after creation resolution has
 * honored mode, parent, and explicit user constraints.
 */
export function assessTeam(input: TeamAssessmentInput): TeamAssessment {
  assertTimestamp(input.evaluatedAt);
  if (input.explicitRecommendation !== undefined) {
    assertRecommendation(
      input.explicitRecommendation,
      'explicit recommendation',
    );
    return buildAssessment(
      input.explicitRecommendation,
      'high',
      'explicit',
      input.signals,
      [`explicit recommendation: ${input.explicitRecommendation}`],
      input.evaluatedAt,
    );
  }
  if (input.taskRecommendation !== undefined) {
    assertRecommendation(input.taskRecommendation, 'task recommendation');
    return buildAssessment(
      input.taskRecommendation,
      'high',
      'task',
      input.signals,
      [`task constraint: ${input.taskRecommendation}`],
      input.evaluatedAt,
    );
  }
  if (input.policy === 'on' || input.policy === 'off') {
    const recommendation: TeamRecommendation =
      input.policy === 'on' ? 'team' : 'single';
    return buildAssessment(
      recommendation,
      'high',
      'explicit',
      input.signals,
      [`team policy: ${input.policy}`],
      input.evaluatedAt,
    );
  }
  if (input.policy !== 'auto') {
    throw new Error('team assessment policy is invalid');
  }
  if (input.signals === null) {
    return buildAssessment(
      'single',
      'low',
      'fallback',
      null,
      ['team signals are unavailable'],
      input.evaluatedAt,
    );
  }
  const signals = parseSignals(input.signals);
  const hasCoordinationPath =
    signals.remoteCount > 0 || signals.hasTrackedUpstream;
  const qualifiesForTeam =
    signals.contributorsRecent > 1 && hasCoordinationPath;
  if (!qualifiesForTeam) {
    const reasons = [
      signals.contributorsRecent > 1
        ? 'no Git remote or tracked upstream'
        : 'fewer than two recent contributors',
    ];
    if (signals.contributorsAllTime > 1) {
      reasons.push('historical contributors do not trigger team mode alone');
    }
    if (signals.hasCodeowners || signals.hasPullRequestTemplate) {
      reasons.push('repository templates do not trigger team mode alone');
    }
    return buildAssessment(
      'single',
      signals.isGitRepository ? 'medium' : 'low',
      'auto',
      signals,
      reasons,
      input.evaluatedAt,
    );
  }
  const reasons = [
    `${signals.contributorsRecent} recent contributors`,
    signals.hasTrackedUpstream ? 'tracked upstream' : 'Git remote available',
  ];
  if (signals.hasCodeowners) reasons.push('CODEOWNERS present');
  if (signals.hasPullRequestTemplate)
    reasons.push('pull request template present');
  if (signals.contributorsAllTime > signals.contributorsRecent) {
    reasons.push(`${signals.contributorsAllTime} all-time contributors`);
  }
  const confidence: TeamAssessmentConfidence =
    signals.hasTrackedUpstream ||
    signals.hasCodeowners ||
    signals.hasPullRequestTemplate
      ? 'high'
      : 'medium';
  return buildAssessment(
    'team',
    confidence,
    'auto',
    signals,
    reasons,
    input.evaluatedAt,
  );
}

function buildAssessment(
  recommendation: TeamRecommendation,
  confidence: TeamAssessmentConfidence,
  source: TeamAssessmentSource,
  signals: TeamAssessmentSignals | null,
  reasons: string[],
  evaluatedAt: string,
): TeamAssessment {
  return {
    recommendation,
    confidence,
    source,
    signals:
      signals === null
        ? {
            isGitRepository: false,
            remoteCount: 0,
            contributorsAllTime: 0,
            contributorsRecent: 0,
            hasTrackedUpstream: false,
            hasCodeowners: false,
            hasPullRequestTemplate: false,
          }
        : signals,
    reasons,
    evaluatedAt,
  };
}

function parseSignals(value: TeamAssessmentSignals): TeamAssessmentSignals {
  const numericKeys = [
    'remoteCount',
    'contributorsAllTime',
    'contributorsRecent',
  ] as const;
  for (const key of numericKeys) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`team assessment ${key} must be a non-negative integer`);
    }
  }
  const booleanKeys = [
    'isGitRepository',
    'hasTrackedUpstream',
    'hasCodeowners',
    'hasPullRequestTemplate',
  ] as const;
  for (const key of booleanKeys) {
    if (typeof value[key] !== 'boolean') {
      throw new Error(`team assessment ${key} must be boolean`);
    }
  }
  return { ...value };
}

function assertRecommendation(
  value: unknown,
  label: string,
): asserts value is TeamRecommendation {
  if (value !== 'single' && value !== 'team') {
    throw new Error(`${label} must be single or team`);
  }
}

function assertTimestamp(value: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error('team assessment evaluatedAt must be an ISO timestamp');
  }
}
