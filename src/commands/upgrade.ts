import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertUlid } from '../context/ids.js';
import { managedAdapterNames } from '../context/manifest.js';
import { V3ContextStore } from '../context/store.js';
import {
  removeAdapterUpgradePreview,
  upgradeV3Adapters,
} from '../installers/adapter-upgrade.js';
import type { PlatformName } from '../installers/registry.js';
import {
  type V3AdapterFileTarget,
  inspectV3Adapter,
  v3AdapterTargetPath,
} from '../installers/v3-adapter.js';
import {
  executeOperationRecovery,
  inspectOperationRecovery,
  listUnfinishedOperationRecoveries,
} from '../runtime/operation-recovery-executor.js';
import {
  closeSession,
  createBootstrapSession,
  readSession,
} from '../runtime/session.js';
import {
  type UpgradeContinuation,
  clearUpgradeContinuation,
  readUpgradeContinuation,
  withUpgradeProjectLock,
  writeUpgradeContinuation,
} from '../runtime/upgrade-continuation.js';
import { detectInitLocale } from '../system/init-onboarding.js';
import { detectUpgradeInstallation } from '../system/upgrade-installation.js';
import {
  type UpgradeAction,
  type UpgradePrompter,
  createUpgradePrompter,
} from '../system/upgrade-onboarding.js';
import {
  installUpgradePackage,
  prepareUpgradeCandidate,
  resolveUpgradeTarget,
} from '../system/upgrade-package.js';
import { createLocalActor, readLocalActor } from '../team/actor.js';
import { VERSION } from '../version.js';
import { readV3CommandProject, resolveV3CommandSession } from './v3-support.js';

export interface UpgradeOptions {
  projectOnly?: boolean;
  cliOnly?: boolean;
  yes?: boolean;
  check?: boolean;
  json?: boolean;
  to?: string;
  lang?: string;
  name?: string;
  session?: string;
  client?: string;
  interactive?: boolean;
  initializedMenu?: boolean;
  prompter?: UpgradePrompter;
}

export interface UpgradeProjectState {
  root: string;
  available: boolean;
  ready: boolean;
  platforms: PlatformName[];
  reason?: string;
}
export interface UpgradeProjectPreview {
  operationId: string;
  platforms: PlatformName[];
  files: string[];
  changed: boolean;
}
interface InternalResult {
  protocol: 1;
  version: string;
  preview?: UpgradeProjectPreview;
  ready?: boolean;
}
export interface UpgradeDependencies {
  detectInstallation: typeof detectUpgradeInstallation;
  resolveTarget: typeof resolveUpgradeTarget;
  prepareCandidate: typeof prepareUpgradeCandidate;
  installPackage: typeof installUpgradePackage;
  invokeCli: typeof invokeUpgradeCli;
}
const defaults: UpgradeDependencies = {
  detectInstallation: detectUpgradeInstallation,
  resolveTarget: resolveUpgradeTarget,
  prepareCandidate: prepareUpgradeCandidate,
  installPackage: installUpgradePackage,
  invokeCli: invokeUpgradeCli,
};

export async function inspectUpgradeProject(
  root: string,
): Promise<UpgradeProjectState> {
  try {
    const project = await new V3ContextStore(root).readProjectSnapshot();
    if (project.manifest.activationState !== 'v3_active')
      throw new Error(
        `MANCODE_UPGRADE_PROJECT_NOT_ACTIVE: ${project.manifest.activationState}`,
      );
    const platforms = managedAdapterNames(project.manifest.managedAdapters);
    const states = await Promise.all(
      platforms.map((p) => inspectV3Adapter(root, p)),
    );
    return {
      root,
      available: true,
      ready: states.every((s) => s.ready),
      platforms,
    };
  } catch (error) {
    return {
      root,
      available: false,
      ready: false,
      platforms: [],
      reason: errorMessage(error),
    };
  }
}

export async function stageUpgradeProject(
  root: string,
): Promise<UpgradeProjectPreview> {
  const state = await inspectUpgradeProject(root);
  if (!state.available) throw new Error(state.reason);
  if (!state.platforms.length)
    return { operationId: '', platforms: [], files: [], changed: false };
  const preview = await upgradeV3Adapters({
    projectRoot: root,
    platforms: state.platforms,
    dryRun: true,
  });
  return {
    operationId: preview.operationId,
    platforms: preview.platforms,
    files: preview.filePlans.map((p) =>
      path.relative(
        root,
        v3AdapterTargetPath(root, p.target as V3AdapterFileTarget),
      ),
    ),
    changed: preview.filePlans.length > 0 || preview.manifest.changed,
  };
}

/** Public menu and unattended entry share the same exact-preview path. */
export async function upgrade(
  rootDir: string,
  options: UpgradeOptions = {},
  overrides: Partial<UpgradeDependencies> = {},
): Promise<number> {
  const dependencies = { ...defaults, ...overrides };
  const root = await realpath(rootDir);
  const locale = detectInitLocale(options.lang);
  const zh = locale === 'zh-CN';
  const interactive =
    !options.json &&
    (options.interactive ??
      Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const ui = options.prompter ?? createUpgradePrompter(locale ?? 'en');
  let cliState: Record<string, unknown> = {
    status: 'not_requested',
    version: VERSION,
  };
  let projectState: Record<string, unknown> = { status: 'not_requested', root };
  const statusLabel = (status: unknown) => {
    const labels: Record<string, string> = {
      not_requested: '未选择更新',
      checked: '已检查',
      ready: '已就绪',
      update_available: '可更新',
      unavailable: '无法检查',
      checking: '检查中',
      installing: '安装中',
      updated: '已更新',
    };
    return zh ? (labels[String(status)] ?? String(status)) : String(status);
  };
  const emit = (state: string, extra: Record<string, unknown> = {}) => {
    const result = {
      schemaVersion: 1,
      state,
      cli: cliState,
      project: projectState,
      ...extra,
    };
    if (options.json) console.log(JSON.stringify(result));
    else if (state !== 'cancelled') {
      console.log(
        `CLI: ${statusLabel(cliState.status)} (${String(cliState.version ?? VERSION)})`,
      );
      console.log(
        `${zh ? '项目规则与 Skills' : 'Project rules and Skills'}: ${statusLabel(projectState.status)}`,
      );
      if (cliState.targetVersion)
        console.log(
          `${zh ? '目标版本' : 'Target version'}: ${String(cliState.targetVersion)}`,
        );
      if (cliState.packageRoot)
        console.log(
          `${zh ? '安装位置' : 'Installation'}: ${String(cliState.packageRoot)} (${String(cliState.kind)})`,
        );
      if (Array.isArray(projectState.platforms))
        console.log(
          `${zh ? '已安装平台' : 'Registered platforms'}: ${projectState.platforms.join(', ') || '-'}`,
        );
      for (const detail of [
        cliState.reason,
        cliState.guidance,
        projectState.reason,
      ])
        if (detail) console.log(String(detail));
      if (state === 'completed' && projectState.status === 'updated')
        console.log(
          zh
            ? '请重新打开 Agent 会话加载新入口。'
            : 'Reopen your Agent session to load the updated entries.',
        );
      if (extra.message) console.error(extra.message);
      if (extra.nextAction) console.log(extra.nextAction);
    }
  };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (
      !locale ||
      (options.projectOnly && options.cliOnly) ||
      (options.projectOnly && options.to) ||
      (options.check && options.yes)
    )
      throw new Error('MANCODE_UPGRADE_ARGUMENT_INVALID');
    let action: UpgradeAction = options.check
      ? 'check'
      : options.projectOnly
        ? 'project'
        : options.cliOnly
          ? 'cli'
          : 'both';
    if (
      !options.projectOnly &&
      !options.cliOnly &&
      !options.check &&
      !options.yes
    ) {
      if (!interactive)
        throw new Error(
          'MANCODE_UPGRADE_INPUT_REQUIRED: use --check --json or --yes with an explicit scope.',
        );
      console.log(`${zh ? '当前项目' : 'Project'}: ${root}\nCLI: ${VERSION}`);
      action = await ui.selectAction(options.initializedMenu ?? false);
    }
    if (action === 'exit') {
      emit('cancelled');
      return 0;
    }
    const project = await inspectUpgradeProject(root);
    projectState = {
      ...project,
      status: project.available
        ? project.ready
          ? 'ready'
          : 'update_available'
        : 'unavailable',
    };
    if (action === 'check') {
      if (!options.projectOnly) {
        const installation = await dependencies.detectInstallation({
          cwd: root,
        });
        cliState = { ...installation, status: 'checked' };
        try {
          const target = await dependencies.resolveTarget({
            cwd: root,
            currentVersion: installation.version,
            to: options.to,
            signal: controller.signal,
          });
          cliState = {
            ...cliState,
            targetVersion: target.version,
            status:
              target.version === installation.version
                ? 'ready'
                : 'update_available',
          };
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const code = (error as { code?: unknown })?.code;
          if (
            typeof code === 'string' &&
            /INVALID_TARGET|INVALID_VERSION|NODE_ENGINE|DOWNGRADE|INSTALL_SCRIPTS/.test(
              code,
            )
          )
            throw error;
          cliState = {
            ...cliState,
            status: 'unavailable',
            reason: errorMessage(error),
          };
        }
      }
      emit('checked');
      return cliState.status === 'unavailable' ? 4 : 0;
    }
    if (action !== 'cli' && !project.available)
      throw new Error(
        `MANCODE_UPGRADE_PROJECT_UNAVAILABLE: ${project.reason}. Use --cli-only or the existing migration/recovery commands.`,
      );
    const work = async (): Promise<number> => {
      const previous =
        action !== 'cli' ? await readUpgradeContinuation(root) : null;
      if (previous) {
        if (
          !options.yes &&
          (!interactive ||
            !(await ui.confirm(
              zh
                ? '继续上次已确认的项目更新？'
                : 'Continue the previously confirmed project update?',
            )))
        ) {
          emit('cancelled');
          return 0;
        }
        const completed = await resumeUpgradeProject(
          root,
          previous,
          options,
          dependencies,
          controller.signal,
        );
        if (completed) {
          projectState = { ...projectState, ready: true, status: 'updated' };
          cliState = { status: 'checked', version: VERSION };
          emit('completed');
          return 0;
        }
      }
      let candidate:
        | Awaited<ReturnType<typeof prepareUpgradeCandidate>>
        | undefined;
      let preview: UpgradeProjectPreview | undefined;
      let receiptSaved = false;
      try {
        let installation:
          | Awaited<ReturnType<typeof detectUpgradeInstallation>>
          | undefined;
        let target:
          | Awaited<ReturnType<typeof resolveUpgradeTarget>>
          | undefined;
        let candidateEntry: string | undefined;
        if (action !== 'project') {
          installation = await dependencies.detectInstallation({ cwd: root });
          if (installation.kind === 'ambiguous' && interactive) {
            const choice = await ui.selectInstallation(
              installation.conflicts ?? [],
            );
            if (!choice) {
              emit('cancelled');
              return 0;
            }
            installation = await dependencies.detectInstallation({
              cwd: root,
              entryPath: choice,
              selectedInstallation: true,
            });
          }
          if (!['npm-global', 'npm-local'].includes(installation.kind))
            throw new Error(
              `MANCODE_UPGRADE_INSTALLATION_UNSUPPORTED: ${installation.reason} ${installation.guidance}`,
            );
          cliState = { ...installation, status: 'checking' };
          target = await dependencies.resolveTarget({
            cwd: root,
            currentVersion: installation.version,
            to: options.to,
            signal: controller.signal,
          });
          cliState = {
            ...cliState,
            targetVersion: target.version,
            status:
              target.version === installation.version
                ? 'ready'
                : 'update_available',
          };
          if (target.version !== installation.version) {
            candidate = await dependencies.prepareCandidate({
              target,
              cwd: root,
              signal: controller.signal,
            });
            candidateEntry = candidate.entryPath;
          } else if (
            installation.entryPath !==
            (await realpath(process.argv[1] ?? '').catch(() => ''))
          ) {
            candidateEntry = installation.entryPath;
          }
          if (candidateEntry) {
            const capability = await dependencies.invokeCli(
              candidateEntry,
              root,
              ['--protocol'],
              controller.signal,
            );
            if (
              capability.protocol !== 1 ||
              capability.version !== target.version
            )
              throw new Error('MANCODE_UPGRADE_TARGET_PROTOCOL_UNSUPPORTED');
          }
        }
        if (action !== 'cli') {
          if (candidateEntry) {
            preview = (
              await dependencies.invokeCli(
                candidateEntry,
                root,
                ['--stage'],
                controller.signal,
              )
            ).preview;
            if (!preview) throw new Error('MANCODE_UPGRADE_PREVIEW_INVALID');
          } else if (!project.ready) preview = await stageUpgradeProject(root);
        }
        if (!candidate && !preview?.changed) {
          projectState = {
            ...projectState,
            status: action === 'cli' ? 'not_requested' : 'ready',
          };
          emit('completed');
          return 0;
        }
        const summary = [
          `${zh ? '将执行更新' : 'Update summary'}:`,
          `${root}`,
          ...(installation
            ? [
                `CLI: ${installation.version} → ${target?.version}`,
                installation.packageRoot,
                ...(installation.kind === 'npm-local'
                  ? ['package.json / lockfile / node_modules']
                  : []),
              ]
            : [`CLI: ${VERSION} (${zh ? '使用当前版本' : 'current version'})`]),
          ...(preview
            ? [
                `${zh ? '平台' : 'Platforms'}: ${preview.platforms.join(', ')}`,
                ...preview.files,
              ]
            : []),
        ].join('\n');
        if (!options.yes && (!interactive || !(await ui.confirm(summary)))) {
          if (!interactive)
            throw new Error(
              'MANCODE_UPGRADE_INPUT_REQUIRED: pass --yes to apply the preview.',
            );
          emit('cancelled');
          return 0;
        }
        if (controller.signal.aborted)
          throw new Error('MANCODE_UPGRADE_CANCELLED');
        let receipt: UpgradeContinuation | undefined;
        if (preview?.changed) {
          const session = await upgradeSession(
            root,
            options,
            interactive ? ui : undefined,
          );
          if (!session) {
            emit('cancelled');
            return 0;
          }
          receipt = {
            schemaVersion: 1,
            projectRoot: root,
            operationId: preview.operationId,
            platforms: preview.platforms,
            targetVersion: target?.version ?? VERSION,
            initialVersion: installation?.version ?? VERSION,
            installationEntry: installation?.entryPath ?? null,
            sessionId: session.id,
            client: session.client,
            createdSession: session.created,
            phase: candidate ? 'installing' : 'project',
          };
          try {
            await writeUpgradeContinuation(root, receipt);
          } catch (error) {
            if (session.created) await closeSession(root, session.id);
            throw error;
          }
          receiptSaved = true;
        }
        if (candidate && installation && target) {
          cliState = { ...cliState, status: 'installing' };
          const installed = await dependencies.installPackage({
            installation,
            target,
            candidate,
            signal: controller.signal,
          });
          cliState = {
            ...cliState,
            ...(await dependencies.detectInstallation({
              cwd: root,
              entryPath: installed.entryPath,
              selectedInstallation: true,
            })),
            status: 'updated',
            version: installed.version,
          };
          candidateEntry = installed.entryPath;
          if (receipt) {
            receipt.phase = 'project';
            receipt.installationEntry = installed.entryPath;
            await writeUpgradeContinuation(root, receipt);
          }
        }
        if (receipt) {
          const completed = await resumeUpgradeProject(
            root,
            receipt,
            options,
            dependencies,
            controller.signal,
          );
          receiptSaved = false;
          if (!completed)
            throw new Error(
              'MANCODE_UPGRADE_PREVIEW_STALE: run upgrade again to prepare a fresh preview.',
            );
          projectState = { ...projectState, ready: true, status: 'updated' };
        } else
          projectState = {
            ...projectState,
            status: action === 'cli' ? 'not_requested' : 'ready',
          };
        emit('completed');
        return 0;
      } finally {
        if (!receiptSaved && preview?.operationId)
          await removeAdapterUpgradePreview(root, preview.operationId);
        await candidate?.cleanup();
      }
    };
    return action === 'cli'
      ? await work()
      : await withUpgradeProjectLock(root, work);
  } catch (error) {
    const message = errorMessage(error);
    const explicitCode = (error as { code?: unknown })?.code;
    const code =
      typeof explicitCode === 'string' && explicitCode.startsWith('MANCODE_')
        ? explicitCode
        : (message.match(/^MANCODE_[A-Z_]+/)?.[0] ?? 'MANCODE_UPGRADE_FAILED');
    const cancelled =
      controller.signal.aborted || code === 'MANCODE_UPGRADE_CANCELLED';
    emit(
      cancelled
        ? 'interrupted'
        : cliState.status === 'updated' || cliState.status === 'installing'
          ? 'partial'
          : 'failed',
      {
        code,
        message,
        nextAction:
          code === 'MANCODE_UPGRADE_PREVIEW_VERSION_CHANGED'
            ? zh
              ? 'CLI 版本已变化。请重新运行 mancode upgrade，查看新预览并确认后再更新。'
              : 'The CLI version changed. Run mancode upgrade again to review and confirm a fresh preview.'
            : code === 'MANCODE_UPGRADE_INSTALL_RESULT_UNKNOWN'
              ? zh
                ? 'CLI 安装结果未验证。请用原包管理器修复该安装，再运行 mancode upgrade --project-only 更新项目入口。'
                : 'CLI installation is unverified. Repair it with the original package manager, then run mancode upgrade --project-only for project entries.'
              : zh
                ? '检查上述原因后再次运行 mancode upgrade；项目恢复使用原操作记录。'
                : 'Resolve the cause and run mancode upgrade again; project recovery retains the original operation.',
      },
    );
    return cancelled
      ? 130
      : /ARGUMENT|INPUT_REQUIRED|INVALID_TARGET/.test(code)
        ? 2
        : /UNSUPPORTED|UNAVAILABLE|HELD|STALE|CONFLICT|SESSION|NODE_ENGINE|DOWNGRADE|INSTALL_SCRIPTS/.test(
              code,
            )
          ? 3
          : 4;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

async function upgradeSession(
  root: string,
  options: UpgradeOptions,
  ui?: UpgradePrompter,
): Promise<{ id: string; client: string; created: boolean } | null> {
  if (options.session || process.env.MANCODE_SESSION_ID) {
    const session = await resolveV3CommandSession(
      await readV3CommandProject(root),
      options,
    );
    const actor = await readLocalActor(root);
    if (!actor || session.actorId !== actor.actorId)
      throw new Error('MANCODE_UPGRADE_SESSION_ACTOR_MISMATCH');
    return { id: session.sessionId, client: session.client, created: false };
  }
  let actor = await readLocalActor(root);
  if (!actor) {
    const name = options.name?.trim() || (await ui?.displayName());
    if (!name) {
      if (ui) return null;
      throw new Error(
        'MANCODE_UPGRADE_INPUT_REQUIRED: supply --name for the first local identity.',
      );
    }
    actor = await createLocalActor(root, { displayName: name });
  }
  const { session } = await createBootstrapSession(root, {
    actorId: actor.actorId,
    client: 'mancode-cli',
  });
  return { id: session.sessionId, client: session.client, created: true };
}

async function resumeUpgradeProject(
  root: string,
  receipt: UpgradeContinuation,
  options: UpgradeOptions,
  dependencies: UpgradeDependencies,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) throw new Error('MANCODE_UPGRADE_CANCELLED');
  if (
    (options.session && options.session !== receipt.sessionId) ||
    (options.client && options.client !== receipt.client)
  )
    throw new Error('MANCODE_UPGRADE_SESSION_MISMATCH');
  const session = await readSession(root, receipt.sessionId);
  const actor = await readLocalActor(root);
  const current = await inspectUpgradeProject(root);
  if (
    !current.available ||
    JSON.stringify(current.platforms) !== JSON.stringify(receipt.platforms)
  )
    throw new Error('MANCODE_UPGRADE_PLATFORM_SELECTION_CHANGED');
  if (
    receipt.createdSession &&
    session?.status === 'closed' &&
    session.actorId === actor?.actorId &&
    session.client === receipt.client &&
    VERSION === receipt.targetVersion &&
    current.ready &&
    !(await listUnfinishedOperationRecoveries(root)).length
  ) {
    await clearUpgradeContinuation(root);
    return true;
  }
  if (
    !session ||
    session.status !== 'active' ||
    session.client !== receipt.client ||
    session.actorId !== actor?.actorId
  )
    throw new Error('MANCODE_UPGRADE_SESSION_MISMATCH');
  let journal: Awaited<ReturnType<typeof inspectOperationRecovery>> | null =
    null;
  try {
    journal = await inspectOperationRecovery(root, receipt.operationId);
  } catch (error) {
    if (errorMessage(error) !== 'MANCODE_OPERATION_JOURNAL_NOT_FOUND')
      throw error;
  }
  if (journal?.journal.state === 'aborted') {
    if (
      journal.journal.type !== 'adapter_upgrade' ||
      journal.journal.sessionId !== receipt.sessionId ||
      journal.journal.actorId !== session.actorId
    )
      throw new Error('MANCODE_UPGRADE_OPERATION_MISMATCH');
    // The original transaction proved it had no visible writes. Keep its audit
    // record and create a fresh preview through the ordinary confirmation path.
    await removeAdapterUpgradePreview(root, receipt.operationId);
    if (receipt.createdSession) await closeSession(root, receipt.sessionId);
    await clearUpgradeContinuation(root);
    return false;
  }
  try {
    if (receipt.installationEntry) {
      const installation = await dependencies.detectInstallation({
        cwd: root,
        entryPath: receipt.installationEntry,
        selectedInstallation: true,
      });
      if (
        !['npm-global', 'npm-local'].includes(installation.kind) ||
        installation.entryPath !== receipt.installationEntry
      )
        throw new Error(
          'MANCODE_UPGRADE_INSTALLATION_UNSUPPORTED: the recorded persistent CLI entry cannot be verified.',
        );
      const capability = await dependencies.invokeCli(
        receipt.installationEntry,
        root,
        ['--protocol'],
        signal,
      );
      if (
        receipt.phase === 'installing' &&
        capability.version === receipt.initialVersion &&
        !journal
      ) {
        await removeAdapterUpgradePreview(root, receipt.operationId);
        if (receipt.createdSession) await closeSession(root, receipt.sessionId);
        await clearUpgradeContinuation(root);
        return false;
      }
      if (receipt.phase === 'installing' && !options.projectOnly)
        throw new Error(
          'MANCODE_UPGRADE_INSTALL_RESULT_UNKNOWN: verify the interrupted CLI installation before continuing project updates.',
        );
      if (capability.version !== receipt.targetVersion) {
        if (receipt.phase === 'project' && !journal)
          throw new Error('MANCODE_UPGRADE_PREVIEW_VERSION_CHANGED');
        throw new Error(
          'MANCODE_UPGRADE_INSTALL_RESULT_UNKNOWN: verify or reinstall the selected CLI before resuming.',
        );
      }
      await dependencies.invokeCli(
        receipt.installationEntry,
        root,
        [
          '--commit',
          '--operation-id',
          receipt.operationId,
          '--session',
          receipt.sessionId,
          '--client',
          receipt.client,
        ],
        signal,
      );
    } else {
      if (VERSION !== receipt.targetVersion)
        throw new Error('MANCODE_UPGRADE_PREVIEW_VERSION_CHANGED');
      await commitUpgradeProject(
        root,
        receipt.operationId,
        receipt.sessionId,
        receipt.client,
        signal,
      );
    }
  } catch (error) {
    if (
      !journal &&
      [
        'MANCODE_ADAPTER_UPGRADE_PREVIEW_STALE',
        'MANCODE_UPGRADE_PREVIEW_VERSION_CHANGED',
      ].includes(errorMessage(error))
    ) {
      await removeAdapterUpgradePreview(root, receipt.operationId);
      if (receipt.createdSession) await closeSession(root, receipt.sessionId);
      await clearUpgradeContinuation(root);
    }
    throw error;
  }
  if (receipt.createdSession) await closeSession(root, receipt.sessionId);
  await clearUpgradeContinuation(root);
  return true;
}

export async function commitUpgradeProject(
  root: string,
  operationId: string,
  sessionId: string,
  client: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('MANCODE_UPGRADE_CANCELLED');
  assertUlid(operationId, 'upgrade operationId');
  const session = await resolveV3CommandSession(
    await readV3CommandProject(root),
    { session: sessionId, client },
  );
  const pending = await listUnfinishedOperationRecoveries(root);
  const own = pending.find((item) => item.journal.operationId === operationId);
  if (pending.some((item) => item.journal.operationId !== operationId))
    throw new Error('MANCODE_ADAPTER_UPGRADE_OPERATION_PENDING');
  if (own) {
    if (
      own.journal.type !== 'adapter_upgrade' ||
      own.journal.sessionId !== sessionId ||
      own.journal.actorId !== session.actorId
    )
      throw new Error('MANCODE_UPGRADE_OPERATION_MISMATCH');
    if (signal?.aborted) throw new Error('MANCODE_UPGRADE_CANCELLED');
    await executeOperationRecovery({
      projectRoot: root,
      operationId,
      sessionId,
      actorId: session.actorId,
      mode: 'repair',
    });
  } else {
    const state = await inspectUpgradeProject(root);
    if (!state.available) throw new Error(state.reason);
    if (signal?.aborted) throw new Error('MANCODE_UPGRADE_CANCELLED');
    if (!state.ready)
      await upgradeV3Adapters({
        projectRoot: root,
        platforms: state.platforms,
        operationId,
        sessionId,
        explicitConfirmation: true,
      });
  }
  const state = await inspectUpgradeProject(root);
  if (!state.available || !state.ready)
    throw new Error('MANCODE_UPGRADE_PROJECT_VERIFY_FAILED');
}

export async function upgradeInternal(
  root: string,
  options: {
    protocol?: boolean;
    stage?: boolean;
    commit?: boolean;
    operationId?: string;
    session?: string;
    client?: string;
  },
): Promise<number> {
  try {
    if (
      [options.protocol, options.stage, options.commit].filter(Boolean)
        .length !== 1
    )
      throw new Error('MANCODE_UPGRADE_ARGUMENT_INVALID');
    const result: InternalResult = { protocol: 1, version: VERSION };
    if (options.stage) result.preview = await stageUpgradeProject(root);
    if (options.commit) {
      if (!options.operationId || !options.session || !options.client)
        throw new Error('MANCODE_UPGRADE_INPUT_REQUIRED');
      await commitUpgradeProject(
        root,
        options.operationId,
        options.session,
        options.client,
      );
      result.ready = true;
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ error: errorMessage(error) }));
    return 3;
  }
}

async function invokeUpgradeCli(
  entry: string,
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<InternalResult> {
  let result: { stdout: string; stderr: string };
  try {
    result = await promisify(execFile)(
      process.execPath,
      [entry, 'upgrade-internal', ...args],
      {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        signal,
        windowsHide: true,
      },
    );
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    let detail: unknown;
    if (stdout) {
      try {
        detail = JSON.parse(stdout);
      } catch {
        /* Non-protocol failures retain the process error below. */
      }
    }
    if (
      detail &&
      typeof detail === 'object' &&
      'error' in detail &&
      typeof detail.error === 'string'
    ) {
      throw new Error(detail.error, { cause: error });
    }
    throw error;
  }
  const value = JSON.parse(result.stdout) as InternalResult;
  if (value.protocol !== 1 || typeof value.version !== 'string')
    throw new Error('MANCODE_UPGRADE_PROTOCOL_INVALID');
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
