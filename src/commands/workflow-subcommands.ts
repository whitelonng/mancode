export const WORKFLOW_SUBCOMMANDS = [
  'create',
  'list',
  'show',
  'update',
  'requirements',
  'plan',
  'review',
  'verify',
  'complete',
  'scope',
  'reframe',
  'archive',
  'checkpoint',
  'child',
  'promote',
  'handoff',
] as const;

export type WorkflowSubcommand = (typeof WORKFLOW_SUBCOMMANDS)[number];

export const WORKFLOW_SUBCOMMAND_SET: ReadonlySet<string> = new Set(
  WORKFLOW_SUBCOMMANDS,
);

export type ContinuityCompatibilitySubcommand = 'clean';

export const CONTINUITY_COMPATIBILITY_SUBCOMMANDS: ReadonlySet<string> =
  new Set<ContinuityCompatibilitySubcommand>(['clean']);
