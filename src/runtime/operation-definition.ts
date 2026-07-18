import type { AuthorizationAction } from '../team/authorization.js';
import type { OperationJournalV1, OperationType } from './operation-journal.js';

export type OperationStepVisibility =
  | 'preparation'
  | 'business_write'
  | 'commit';
export type CrashRecovery =
  | 'safe_abort'
  | 'forward_repair'
  | 'projection_retry';

export interface OperationStepDefinition {
  id: string;
  visibility: OperationStepVisibility;
  expectedRevisionPrefixes: string[];
  requiredLockPrefixes: string[];
  /** Required only when the operation's locked snapshot contains the entity. */
  optionalExpectedRevisionPrefixes: string[];
  /** Optional entities still require their own lock when they are present. */
  optionalRequiredLockPrefixes: string[];
  crashRecovery: CrashRecovery;
}

export interface OperationDefinitionV1 {
  schemaVersion: 1;
  type: OperationType;
  authorizationActions: readonly AuthorizationAction[];
  primaryCommitStep: string;
  requiresSharedTaskHeadFence: boolean;
  allowsSecondaryReservations: boolean;
  steps: OperationStepDefinition[];
}

/**
 * Authorization is bound to a concrete durable operation, rather than merely
 * to any valid active session. Local and shared variants intentionally retain
 * distinct actions where the same operation type can target either namespace.
 */
export const OPERATION_AUTHORIZATION_ACTIONS: Record<
  OperationType,
  readonly AuthorizationAction[]
> = {
  workflow_create: ['local_workflow_mutation', 'shared_create_publish_promote'],
  workflow_update: ['local_workflow_mutation', 'shared_metadata_plan_mutation'],
  requirements_finalize: [
    'local_workflow_mutation',
    'shared_metadata_plan_mutation',
  ],
  plan_revision: ['local_workflow_mutation', 'shared_metadata_plan_mutation'],
  review_remediation: [
    'local_workflow_mutation',
    'shared_ledger_evidence',
    'review_skip_or_waiver',
  ],
  verification_record: ['local_workflow_mutation', 'shared_ledger_evidence'],
  task_complete: [
    'local_workflow_mutation',
    'task_complete_scope_change_child_merge',
  ],
  publish_promote: ['shared_create_publish_promote'],
  handoff_transition: ['handoff_offer_cancel', 'handoff_accept_reject'],
  handoff_accept: ['handoff_accept_reject'],
  scope_change_reclaim: ['task_complete_scope_change_child_merge'],
  claim_create: ['claim_create'],
  claim_renew_release: ['claim_renew_release_transfer'],
  claim_transfer: ['claim_renew_release_transfer'],
  claim_reclaim: ['claim_reclaim'],
  claim_revalidation: ['claim_renew_release_transfer'],
  checkpoint_create: [
    'local_workflow_mutation',
    'shared_metadata_plan_mutation',
  ],
  solo_handoff: ['local_workflow_mutation'],
  child_result_merge: [
    'local_workflow_mutation',
    'task_complete_scope_change_child_merge',
  ],
  task_head_reconcile: ['task_head_reconcile'],
  transport_migrate: ['team_policy_config_transport'],
  greenfield_initialize: ['team_policy_config_transport'],
  v3_activate: ['team_policy_config_transport'],
};

export interface OperationCrashFixture {
  operationType: OperationType;
  crashAfter: 'prepared' | string;
  expectedRecovery: CrashRecovery;
}

const prepare = (
  id: string,
  expectedRevisionPrefixes: string[] = [],
  requiredLockPrefixes: string[] = [],
  optional: {
    expectedRevisionPrefixes?: string[];
    requiredLockPrefixes?: string[];
  } = {},
): OperationStepDefinition => ({
  id,
  visibility: 'preparation',
  expectedRevisionPrefixes,
  requiredLockPrefixes,
  optionalExpectedRevisionPrefixes: optional.expectedRevisionPrefixes ?? [],
  optionalRequiredLockPrefixes: optional.requiredLockPrefixes ?? [],
  crashRecovery: 'safe_abort',
});

const write = (
  id: string,
  expectedRevisionPrefixes: string[],
  requiredLockPrefixes: string[],
  optional: {
    expectedRevisionPrefixes?: string[];
    requiredLockPrefixes?: string[];
  } = {},
): OperationStepDefinition => ({
  id,
  visibility: 'business_write',
  expectedRevisionPrefixes,
  requiredLockPrefixes,
  optionalExpectedRevisionPrefixes: optional.expectedRevisionPrefixes ?? [],
  optionalRequiredLockPrefixes: optional.requiredLockPrefixes ?? [],
  crashRecovery: 'forward_repair',
});

const commit = (
  id: string,
  expectedRevisionPrefixes: string[],
  requiredLockPrefixes: string[],
  optional: {
    expectedRevisionPrefixes?: string[];
    requiredLockPrefixes?: string[];
  } = {},
): OperationStepDefinition => ({
  id,
  visibility: 'commit',
  expectedRevisionPrefixes,
  requiredLockPrefixes,
  optionalExpectedRevisionPrefixes: optional.expectedRevisionPrefixes ?? [],
  optionalRequiredLockPrefixes: optional.requiredLockPrefixes ?? [],
  crashRecovery: 'forward_repair',
});

export const OPERATION_DEFINITIONS: Record<
  OperationType,
  OperationDefinitionV1
> = {
  workflow_create: definition(
    'workflow_create',
    'publish-locator',
    false,
    false,
    [
      prepare('validate'),
      // The staging directory is private to this operation and has no task
      // locator/fence visibility. A crash here is compensable by deleting
      // verified staging, rather than forcing a fictitious forward repair.
      prepare('write-staging-aggregate', ['task:'], ['task:']),
      prepare('validate-aggregate', ['task:'], ['task:']),
      write('publish-task-directory', ['task:'], ['task:']),
      write('publish-locator', ['locator:'], ['task:', 'locator:']),
      commit('commit', ['task:', 'locator:'], ['task:', 'locator:']),
    ],
  ),
  workflow_update: definition(
    'workflow_update',
    'write-metadata',
    true,
    false,
    [
      prepare('validate', ['task:'], ['task:']),
      write('write-metadata', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  requirements_finalize: definition(
    'requirements_finalize',
    'update-metadata',
    true,
    false,
    [
      prepare('validate', ['task:'], ['task:']),
      write('write-requirements', ['requirements:', 'task:'], ['task:']),
      write(
        'mark-review-verification-stale',
        ['review:', 'verification:', 'task:'],
        ['task:'],
      ),
      write('update-metadata', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  plan_revision: definition('plan_revision', 'update-metadata', true, false, [
    prepare('validate', ['task:'], ['task:']),
    write('write-plan', ['plan:', 'task:'], ['task:']),
    write('update-metadata', ['task:'], ['task:']),
    write(
      'mark-review-verification-stale',
      ['review:', 'verification:', 'task:'],
      ['task:'],
    ),
    write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
    commit('commit', ['task_head:', 'task:'], ['task:']),
  ]),
  review_remediation: definition(
    'review_remediation',
    'update-metadata',
    true,
    false,
    [
      prepare('validate', ['task:', 'review:'], ['task:']),
      write('write-review-ledger', ['review:', 'task:'], ['task:']),
      write('mark-verification-stale', ['verification:', 'task:'], ['task:']),
      write('update-metadata', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  verification_record: definition(
    'verification_record',
    'update-metadata',
    true,
    false,
    [
      prepare('validate', ['task:', 'verification:'], ['task:']),
      write('write-verification-ledger', ['verification:', 'task:'], ['task:']),
      write('update-metadata', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  task_complete: definition(
    'task_complete',
    'write-completed-metadata',
    true,
    false,
    [
      prepare('validate-completion-gate', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['claim:'],
      }),
      write('mark-operation-pending', ['task:'], ['task:']),
      write('release-or-transfer-claims', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['claim:'],
        requiredLockPrefixes: ['claim:'],
      }),
      write('write-completed-metadata', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  publish_promote: definition(
    'publish_promote',
    'publish-destination',
    true,
    true,
    [
      prepare('validate-privacy-and-paths', ['task:'], ['task:']),
      // The destination staging directory remains private until its atomic
      // rename, so it is safely compensable just like workflow creation.
      prepare('stage-destination', ['task:'], ['task:']),
      write('mark-source-operation-pending', ['task:'], ['task:']),
      write(
        'publish-destination',
        ['task:', 'locator:'],
        ['task:', 'locator:'],
      ),
      write('write-source-successor', ['task:'], ['task:']),
      write('publish-destination-locator', ['locator:'], ['locator:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  handoff_transition: definition(
    'handoff_transition',
    'write-handoff',
    false,
    false,
    [
      prepare('validate', ['task:', 'handoff:'], ['task:', 'handoff:']),
      write('write-handoff', ['task:', 'handoff:'], ['task:', 'handoff:']),
      commit('commit', ['task:', 'handoff:'], ['task:', 'handoff:']),
    ],
  ),
  handoff_accept: definition('handoff_accept', 'accept-handoff', true, false, [
    prepare(
      'validate',
      ['task:', 'handoff:', 'checkpoint:'],
      ['task:', 'handoff:', 'checkpoint:'],
      {
        expectedRevisionPrefixes: ['claim:'],
        requiredLockPrefixes: ['claim:'],
      },
    ),
    write('mark-task-operation-pending', ['task:'], ['task:']),
    write('create-pending-successor-claims', ['task:'], ['task:'], {
      expectedRevisionPrefixes: ['claim:'],
      requiredLockPrefixes: ['claim:'],
    }),
    write('transfer-old-claims', ['task:'], ['task:'], {
      expectedRevisionPrefixes: ['claim:'],
      requiredLockPrefixes: ['claim:'],
    }),
    write('update-owner-and-checkpoint', ['task:', 'checkpoint:'], ['task:']),
    write('activate-successor-claims', ['task:'], ['task:'], {
      expectedRevisionPrefixes: ['claim:'],
      requiredLockPrefixes: ['claim:'],
    }),
    write('accept-handoff', ['handoff:', 'task:'], ['task:', 'handoff:']),
    write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
    commit('commit', ['task_head:', 'task:'], ['task:']),
  ]),
  scope_change_reclaim: definition(
    'scope_change_reclaim',
    'activate-successor-claims',
    true,
    false,
    [
      prepare('validate', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['claim:'],
        requiredLockPrefixes: ['claim:'],
      }),
      write('mark-task-operation-pending', ['task:'], ['task:']),
      write(
        'write-scope-changed-checkpoint',
        ['checkpoint:', 'task:'],
        ['task:'],
      ),
      write('create-pending-successor-claims', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['claim:'],
        requiredLockPrefixes: ['claim:'],
      }),
      write('terminate-old-claims', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['claim:'],
        requiredLockPrefixes: ['claim:'],
      }),
      write('update-metadata-scope', ['task:'], ['task:']),
      write('activate-successor-claims', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['claim:'],
        requiredLockPrefixes: ['claim:'],
      }),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  claim_create: definition(
    'claim_create',
    'create-active-claim',
    false,
    false,
    [
      prepare('validate', ['task:'], ['task:']),
      write('create-active-claim', ['claim:', 'task:'], ['task:', 'claim:']),
      commit('commit', ['claim:', 'task:'], ['task:', 'claim:']),
    ],
  ),
  claim_renew_release: definition(
    'claim_renew_release',
    'update-claim',
    false,
    false,
    [
      prepare('validate', ['task:', 'claim:'], ['task:', 'claim:']),
      write('update-claim', ['task:', 'claim:'], ['task:', 'claim:']),
      commit('commit', ['task:', 'claim:'], ['task:', 'claim:']),
    ],
  ),
  claim_transfer: definition(
    'claim_transfer',
    'activate-successor-claim',
    false,
    false,
    [
      prepare('validate', ['task:', 'claim:'], ['task:', 'claim:']),
      write(
        'create-pending-successor-claim',
        ['task:', 'claim:'],
        ['task:', 'claim:'],
      ),
      write(
        'transfer-predecessor-claim',
        ['task:', 'claim:'],
        ['task:', 'claim:'],
      ),
      write(
        'activate-successor-claim',
        ['task:', 'claim:'],
        ['task:', 'claim:'],
      ),
      commit('commit', ['task:', 'claim:'], ['task:', 'claim:']),
    ],
  ),
  claim_reclaim: definition('claim_reclaim', 'expire-claim', false, false, [
    prepare('validate', ['task:', 'claim:'], ['task:', 'claim:']),
    write('expire-claim', ['task:', 'claim:'], ['task:', 'claim:']),
    commit('commit', ['task:', 'claim:'], ['task:', 'claim:']),
  ]),
  claim_revalidation: definition(
    'claim_revalidation',
    'update-claim-validation',
    true,
    false,
    [
      prepare('validate', ['task:', 'claim:'], ['task:', 'claim:']),
      write('mark-task-operation-pending', ['task:'], ['task:']),
      write('write-base-changed-checkpoint', ['task:'], ['task:'], {
        expectedRevisionPrefixes: ['checkpoint:'],
      }),
      write(
        'update-claim-validation',
        ['claim:', 'task:'],
        ['task:', 'claim:'],
      ),
      write('complete-task-validation', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  checkpoint_create: definition(
    'checkpoint_create',
    'update-metadata-checkpoint-ref',
    true,
    false,
    [
      prepare('validate', ['task:'], ['task:']),
      write('mark-task-operation-pending', ['task:'], ['task:']),
      write('write-checkpoint', ['checkpoint:', 'task:'], ['task:']),
      write('update-metadata-checkpoint-ref', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  solo_handoff: definition(
    'solo_handoff',
    'write-workflow-assignment',
    false,
    false,
    [
      prepare('validate', ['task:'], ['task:']),
      write('write-workflow-assignment', ['task:'], ['task:']),
      // The session pointer is a compensable local projection, rather than
      // journaled workflow authority.  It is intentionally not part of the
      // operation CAS/lock set: a failed or later-replaced pointer must never
      // block repair of the durable solo assignment.
      write('update-session-pointer', ['task:'], ['task:']),
      commit('commit', ['task:'], ['task:']),
    ],
  ),
  child_result_merge: definition(
    'child_result_merge',
    'update-parent-metadata',
    true,
    false,
    [
      prepare('validate-parent-snapshot', ['task:', 'checkpoint:'], ['task:']),
      write('mark-parent-operation-pending', ['task:'], ['task:']),
      write('write-merge-checkpoint', ['checkpoint:', 'task:'], ['task:']),
      write('update-parent-metadata', ['task:'], ['task:']),
      write('update-task-head-fence', ['task_head:', 'task:'], ['task:']),
      commit('commit', ['task_head:', 'task:'], ['task:']),
    ],
  ),
  task_head_reconcile: definition(
    'task_head_reconcile',
    'adopt-task-head-fence',
    true,
    false,
    [
      prepare(
        'validate-clean-store-and-git-reachability',
        ['task:', 'task_head:'],
        ['task:', 'task_head:'],
      ),
      prepare(
        'confirm-adoption',
        ['task:', 'task_head:'],
        ['task:', 'task_head:'],
      ),
      write(
        'adopt-task-head-fence',
        ['task_head:', 'task:'],
        ['task:', 'task_head:'],
      ),
      commit('commit', ['task_head:', 'task:'], ['task:', 'task_head:']),
    ],
  ),
  transport_migrate: definition(
    'transport_migrate',
    'switch-config-authority',
    true,
    true,
    [
      prepare(
        'freeze-shared-coordination-writes',
        ['config:', 'task_head:'],
        ['config:'],
      ),
      prepare(
        'validate-old-authority',
        ['config:', 'task_head:', 'claim:', 'handoff:'],
        ['config:'],
      ),
      write(
        'stage-new-authority',
        ['config:', 'task_head:', 'claim:', 'handoff:'],
        ['config:'],
      ),
      write(
        'establish-new-epoch',
        ['config:', 'task_head:', 'claim:', 'handoff:'],
        ['config:'],
      ),
      write('switch-config-authority', ['config:'], ['config:']),
      commit('commit', ['config:'], ['config:']),
    ],
  ),
  greenfield_initialize: definition(
    'greenfield_initialize',
    'publish-v3-root',
    false,
    false,
    [
      prepare('verify-no-legacy-authority'),
      // The named staging root is still private and can be verified then
      // deleted before the atomic .mancode publication boundary.
      prepare(
        'write-initializing-staging-root',
        ['schema:', 'config:'],
        ['schema:'],
      ),
      prepare(
        'write-v3-config-policy-adapters',
        ['schema:', 'config:'],
        ['schema:'],
      ),
      write('publish-v3-root', ['schema:', 'config:'], ['schema:']),
      write('register-workspace-binding', ['binding:'], ['binding:']),
      write('activate-v3-manifest', ['schema:'], ['schema:']),
      commit('commit', ['schema:'], ['schema:']),
    ],
  ),
  v3_activate: definition('v3_activate', 'activate-manifest', true, true, [
    prepare(
      'validate-staged-migration',
      ['schema:', 'config:', 'stage:'],
      ['schema:', 'config:', 'stage:'],
      {
        expectedRevisionPrefixes: ['task:', 'task_head:', 'adapter:'],
        requiredLockPrefixes: ['task:', 'task_head:', 'adapter:'],
      },
    ),
    write(
      'mark-manifest-activating',
      ['schema:', 'stage:'],
      ['schema:', 'stage:'],
    ),
    write('replace-managed-adapters', ['adapter:'], ['adapter:']),
    write('promote-staged-tasks', [], [], {
      expectedRevisionPrefixes: ['task:', 'task_head:'],
      requiredLockPrefixes: ['task:', 'task_head:'],
    }),
    write(
      'record-adapter-inventory-and-baseline',
      ['schema:', 'config:'],
      ['schema:', 'config:'],
    ),
    write('activate-manifest', ['schema:', 'stage:'], ['schema:', 'stage:']),
    commit('commit', ['schema:', 'stage:'], ['schema:', 'stage:']),
  ]),
};

export const OPERATION_CRASH_FIXTURES: Record<
  OperationType,
  OperationCrashFixture[]
> = Object.fromEntries(
  Object.values(OPERATION_DEFINITIONS).map((definition) => [
    definition.type,
    [
      {
        operationType: definition.type,
        crashAfter: 'prepared',
        expectedRecovery: 'safe_abort',
      },
      ...definition.steps.map((step) => ({
        operationType: definition.type,
        crashAfter: step.id,
        expectedRecovery: step.crashRecovery,
      })),
    ],
  ]),
) as Record<OperationType, OperationCrashFixture[]>;

export function getOperationDefinition(
  operationType: OperationType,
): OperationDefinitionV1 {
  return OPERATION_DEFINITIONS[operationType];
}

export function assertOperationJournalMatchesDefinition(
  journal: OperationJournalV1,
): void {
  const definition = getOperationDefinition(journal.type);
  assertOperationAuthorizationAction(journal);
  const actualSteps = journal.steps.map((step) => step.id);
  const expectedSteps = definition.steps.map((step) => step.id);
  if (
    actualSteps.length !== expectedSteps.length ||
    actualSteps.some((step, index) => step !== expectedSteps[index])
  ) {
    throw new Error(
      `operation ${journal.type} steps do not match its machine-readable definition`,
    );
  }
  const expectedRevisionPrefixes = new Set(
    definition.steps.flatMap((step) => step.expectedRevisionPrefixes),
  );
  const lockPrefixes = new Set(
    definition.steps.flatMap((step) => step.requiredLockPrefixes),
  );
  const optionalExpectedRevisionPrefixes = new Set(
    definition.steps.flatMap((step) => step.optionalExpectedRevisionPrefixes),
  );
  const optionalLockPrefixes = new Set(
    definition.steps.flatMap((step) => step.optionalRequiredLockPrefixes),
  );
  const sharedTask = journal.entityLocks.some((key) =>
    key.startsWith('task:shared:'),
  );
  if (!sharedTask) {
    expectedRevisionPrefixes.delete('task_head:');
  }
  assertPrefixCoverage(
    Object.keys(journal.expectedRevisions),
    expectedRevisionPrefixes,
    'expected revisions',
  );
  assertPrefixCoverage(journal.entityLocks, lockPrefixes, 'entity locks');
  assertOptionalPrefixPairs(
    Object.keys(journal.expectedRevisions),
    journal.entityLocks,
    optionalExpectedRevisionPrefixes,
    optionalLockPrefixes,
  );
  if (definition.requiresSharedTaskHeadFence && sharedTask) {
    assertPrefixCoverage(
      Object.keys(journal.expectedRevisions),
      new Set(['task_head:']),
      'expected revisions',
    );
    assertPrefixCoverage(
      journal.entityLocks,
      new Set(['task_head:']),
      'entity locks',
    );
  }
}

/** A store may enforce the authorization binding before it knows every step. */
export function assertOperationAuthorizationAction(
  journal: Pick<OperationJournalV1, 'type' | 'authorizationBasis'>,
): void {
  const definition = getOperationDefinition(journal.type);
  if (
    !definition.authorizationActions.includes(journal.authorizationBasis.action)
  ) {
    throw new Error('MANCODE_OPERATION_AUTHORIZATION_ACTION_MISMATCH');
  }
}

function definition(
  type: OperationType,
  primaryCommitStep: string,
  requiresSharedTaskHeadFence: boolean,
  allowsSecondaryReservations: boolean,
  steps: OperationStepDefinition[],
): OperationDefinitionV1 {
  if (!steps.some((step) => step.id === primaryCommitStep)) {
    throw new Error(`operation ${type} has no primary commit step`);
  }
  for (const step of steps) {
    for (const prefix of step.optionalExpectedRevisionPrefixes) {
      if (step.expectedRevisionPrefixes.includes(prefix)) {
        throw new Error(
          `operation ${type} repeats optional expected revision prefix ${prefix}`,
        );
      }
    }
    for (const prefix of step.optionalRequiredLockPrefixes) {
      if (step.requiredLockPrefixes.includes(prefix)) {
        throw new Error(
          `operation ${type} repeats optional lock prefix ${prefix}`,
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    type,
    authorizationActions: OPERATION_AUTHORIZATION_ACTIONS[type],
    primaryCommitStep,
    requiresSharedTaskHeadFence,
    allowsSecondaryReservations,
    steps,
  };
}

function assertPrefixCoverage(
  values: string[],
  prefixes: Set<string>,
  label: string,
): void {
  for (const prefix of prefixes) {
    if (!values.some((value) => value.startsWith(prefix))) {
      throw new Error(`operation journal ${label} are missing ${prefix}`);
    }
  }
}

/**
 * Some operations (such as completing a team task) may have zero affected
 * claims. Once one is present, however, its revision guard and canonical lock
 * are inseparable: otherwise an operation could journal a claim CAS without
 * actually excluding a concurrent claim mutation.
 */
function assertOptionalPrefixPairs(
  expectedRevisions: string[],
  entityLocks: string[],
  optionalExpectedRevisionPrefixes: Set<string>,
  optionalLockPrefixes: Set<string>,
): void {
  for (const prefix of optionalExpectedRevisionPrefixes) {
    if (
      expectedRevisions.some((value) => value.startsWith(prefix)) &&
      !entityLocks.some((value) => value.startsWith(prefix))
    ) {
      throw new Error(
        `operation journal entity locks are missing optional ${prefix}`,
      );
    }
  }
  for (const prefix of optionalLockPrefixes) {
    if (
      entityLocks.some((value) => value.startsWith(prefix)) &&
      !expectedRevisions.some((value) => value.startsWith(prefix))
    ) {
      throw new Error(
        `operation journal expected revisions are missing optional ${prefix}`,
      );
    }
  }
}
