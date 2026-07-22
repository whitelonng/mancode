import {
  CURRENT_WRITER_CAPABILITIES,
  evaluateCompatibilityGate,
} from '../context/compatibility.js';
import { scanLegacyAuthority } from '../context/layout.js';
import { managedAdapterNames } from '../context/manifest.js';
import { V3ContextStore } from '../context/store.js';
import type { PlatformName } from '../installers/registry.js';
import {
  type V3PlatformAdapterStatus,
  inspectV3Adapter,
  inspectV3AdapterVersions,
} from '../installers/v3-adapter.js';
import { VERSION } from '../version.js';
import { recordLocalDiagnostic } from './diagnostics.js';
import { listUnfinishedGitRefWorkflowRepairs } from './git-ref-workflow-repair-store.js';
import { listUnfinishedOperationRecoveries } from './operation-recovery-executor.js';
import { listPlatformSessionSpikes } from './platform-spike-store.js';
import {
  type PlatformSpikeFreezeStatus,
  platformSpikeFreezeStatus,
} from './platform-spike.js';
import { readProjectRuntimeContext } from './project-runtime.js';

export interface V3BetaGateResult {
  schemaVersion: 1;
  releaseCandidate: string;
  ready: boolean;
  blockers: string[];
  activationState: string;
  compatibility: ReturnType<typeof evaluateCompatibilityGate>;
  sessionEvidence: PlatformSpikeFreezeStatus;
  adapters: Record<PlatformName, V3PlatformAdapterStatus>;
  runtimeBinding: 'ready' | 'registration_required';
  unfinishedOperations: Array<{
    operationId: string;
    type: string;
    recoveryAction: string;
  }>;
  unfinishedGitRefWorkflowRepairs: Array<{
    operationId: string;
    kind: string;
    state: string;
    taskRef: { namespace: 'local' | 'shared'; taskId: string };
    remoteRevision: number;
  }>;
}

/**
 * Conservative local release readiness check. The five host spikes remain
 * operator-collected evidence, so this gate refuses to infer them from an
 * adapter installation or an environment variable alone.
 */
export async function evaluateV3BetaGate(
  projectRoot: string,
  input: { releaseCandidate: string },
): Promise<V3BetaGateResult> {
  if (!input.releaseCandidate.trim()) {
    throw new Error('MANCODE_BETA_RELEASE_CANDIDATE_REQUIRED');
  }
  const store = new V3ContextStore(projectRoot);
  const snapshot = await store.readProjectSnapshot();
  const [
    legacy,
    adapterVersions,
    adapterEntries,
    spikes,
    unfinished,
    unfinishedGitRefWorkflowRepairs,
  ] = await Promise.all([
    scanLegacyAuthority(projectRoot),
    inspectV3AdapterVersions(
      projectRoot,
      managedAdapterNames(snapshot.manifest.managedAdapters),
    ),
    Promise.all(
      BETA_PLATFORMS.map(
        async (platform) =>
          [platform, await inspectV3Adapter(projectRoot, platform)] as const,
      ),
    ),
    listPlatformSessionSpikes(projectRoot),
    listUnfinishedOperationRecoveries(projectRoot),
    listUnfinishedGitRefWorkflowRepairs(projectRoot),
  ]);
  const compatibility = evaluateCompatibilityGate({
    manifest: snapshot.manifest,
    expectedSchemaEpoch: snapshot.manifest.epoch,
    readerVersion: VERSION,
    writerVersion: VERSION,
    writerCapabilities: CURRENT_WRITER_CAPABILITIES,
    adapterVersions,
    currentLegacyBaseline: legacy.baseline,
    legacyAuthorityPresent: legacy.authorityPresent,
    operation: 'v3_business_write',
  });
  const sessionEvidence = platformSpikeFreezeStatus(spikes, {
    releaseCandidate: input.releaseCandidate,
    mancodeVersion: VERSION,
  });
  const adapters = Object.fromEntries(adapterEntries) as Record<
    PlatformName,
    V3PlatformAdapterStatus
  >;
  const runtimeBinding = await readProjectRuntimeContext(projectRoot)
    .then(() => 'ready' as const)
    .catch(() => 'registration_required' as const);
  const blockers = [
    ...(snapshot.manifest.activationState === 'v3_active'
      ? []
      : ['MANCODE_BETA_V3_ACTIVATION_REQUIRED']),
    ...compatibility.failures,
    ...(sessionEvidence.ready
      ? []
      : ['MANCODE_BETA_PLATFORM_SESSION_SPIKE_REQUIRED']),
    ...(Object.values(adapters).every((adapter) => adapter.ready)
      ? []
      : ['MANCODE_BETA_ADAPTER_SHADOW_OR_INSTALL_REQUIRED']),
    ...(runtimeBinding === 'ready'
      ? []
      : ['MANCODE_BETA_RUNTIME_BINDING_REQUIRED']),
    ...(unfinished.length === 0 && unfinishedGitRefWorkflowRepairs.length === 0
      ? []
      : ['MANCODE_BETA_OPERATION_RECOVERY_REQUIRED']),
  ];
  if (Object.values(adapters).some((adapter) => !adapter.ready)) {
    await recordLocalDiagnostic(projectRoot, {
      kind: 'adapter_capability_downgrade',
    }).catch(() => undefined);
  }
  return {
    schemaVersion: 1,
    releaseCandidate: input.releaseCandidate,
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)].sort(),
    activationState: snapshot.manifest.activationState,
    compatibility,
    sessionEvidence,
    adapters,
    runtimeBinding,
    unfinishedOperations: unfinished.map((recovery) => ({
      operationId: recovery.journal.operationId,
      type: recovery.journal.type,
      recoveryAction: recovery.recoveryAction,
    })),
    unfinishedGitRefWorkflowRepairs: unfinishedGitRefWorkflowRepairs.map(
      (repair) => ({
        operationId: repair.operationId,
        kind: repair.kind,
        state: repair.state,
        taskRef: repair.taskRef,
        remoteRevision: repair.remoteRevision,
      }),
    ),
  };
}

const BETA_PLATFORMS: PlatformName[] = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'zcode',
];
