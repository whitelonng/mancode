import { assertUlid } from '../context/ids.js';
import { V3ContextStore } from '../context/store.js';
import { upgradeV3Adapters } from '../installers/adapter-upgrade.js';
import {
  type PlatformName,
  getPlatformInstaller,
} from '../installers/registry.js';
import {
  V3_ADAPTER_PLATFORMS,
  inspectV3Adapter,
} from '../installers/v3-adapter.js';
import {
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';

export interface AdapterStatusOptions {
  platform?: string;
  json?: boolean;
}

export interface AdapterUpgradeOptions extends AdapterStatusOptions {
  all?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  operationId?: string;
  session?: string;
  client?: string;
}

export async function adapterStatus(
  rootDir: string,
  options: AdapterStatusOptions,
): Promise<number> {
  try {
    const platforms = selectStatusPlatforms(options.platform);
    const project = await new V3ContextStore(rootDir).readProjectSnapshot();
    const entries = await Promise.all(
      platforms.map(
        async (platform) =>
          [platform, await inspectV3Adapter(rootDir, platform)] as const,
      ),
    );
    const adapters = Object.fromEntries(entries);
    return printV3Result(options.json, {
      schemaVersion: 1,
      renderer: 'mancode-adapter-digest-v1',
      ready: entries.every(([, status]) => status.ready),
      manifestAdapters: Object.fromEntries(
        platforms.map((platform) => [
          platform,
          project.manifest.managedAdapters[platform],
        ]),
      ),
      adapters,
    });
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_ADAPTER_STATUS_FAILED'),
      error instanceof Error ? error.message : 'Unable to inspect adapters.',
    );
  }
}

export async function adapterUpgrade(
  rootDir: string,
  options: AdapterUpgradeOptions,
): Promise<number> {
  try {
    const platforms = selectUpgradePlatforms(options);
    if (options.operationId !== undefined) {
      assertUlid(options.operationId, 'adapter upgrade operationId');
    }
    let sessionId: string | undefined;
    if (options.dryRun !== true && options.confirm === true) {
      const project = await readV3CommandProject(rootDir);
      sessionId = (
        await resolveV3CommandSession(project, {
          session: options.session,
          client: options.client,
        })
      ).sessionId;
    }
    const result = await upgradeV3Adapters({
      projectRoot: rootDir,
      platforms,
      dryRun: options.dryRun,
      explicitConfirmation: options.confirm,
      ...(options.operationId === undefined
        ? {}
        : { operationId: options.operationId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return printV3Result(options.json, result);
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_ADAPTER_UPGRADE_FAILED'),
      error instanceof Error ? error.message : 'Unable to upgrade adapters.',
    );
  }
}

function selectStatusPlatforms(platform: string | undefined): PlatformName[] {
  if (platform === undefined) return [...V3_ADAPTER_PLATFORMS];
  const installer = getPlatformInstaller(platform);
  if (installer === null) {
    throw new Error('MANCODE_ADAPTER_UPGRADE_PLATFORM_INVALID');
  }
  return [installer.name];
}

function selectUpgradePlatforms(
  options: AdapterUpgradeOptions,
): PlatformName[] {
  if ((options.all === true) === (options.platform !== undefined)) {
    throw new Error(
      'MANCODE_ADAPTER_UPGRADE_SELECTION_REQUIRED: choose exactly one of --all or --platform.',
    );
  }
  return options.all === true
    ? [...V3_ADAPTER_PLATFORMS]
    : selectStatusPlatforms(options.platform);
}
