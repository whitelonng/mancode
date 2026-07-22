import { assertUlid } from '../context/ids.js';
import {
  dryRunProjectPolicyUpgrade,
  upgradeProjectPolicy,
} from '../context/project-policy-upgrade.js';
import {
  EXIT_V3_INVALID_ARGUMENT,
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';

export interface ProjectUpgradeOptions {
  policy?: string;
  dryRun?: boolean;
  session?: string;
  client?: string;
  operationId?: string;
  json?: boolean;
}

export async function projectUpgrade(
  rootDir: string,
  options: ProjectUpgradeOptions,
): Promise<number> {
  if (options.policy !== '2') {
    return printV3Error(
      options.json,
      'MANCODE_POLICY_VERSION_UNSUPPORTED',
      'project upgrade currently supports only --policy 2.',
      EXIT_V3_INVALID_ARGUMENT,
    );
  }
  try {
    if (options.operationId !== undefined) {
      assertUlid(options.operationId, 'project upgrade operationId');
    }
    if (options.dryRun === true) {
      return printV3Result(
        options.json,
        await dryRunProjectPolicyUpgrade({
          projectRoot: rootDir,
          policyVersion: 2,
          ...(options.operationId === undefined
            ? {}
            : { operationId: options.operationId }),
        }),
      );
    }
    const project = await readV3CommandProject(rootDir);
    const session = await resolveV3CommandSession(project, options);
    return printV3Result(
      options.json,
      await upgradeProjectPolicy({
        projectRoot: project.projectRoot,
        policyVersion: 2,
        sessionId: session.sessionId,
        ...(options.operationId === undefined
          ? {}
          : { operationId: options.operationId }),
      }),
    );
  } catch (error) {
    return printV3Error(
      options.json,
      v3ErrorCode(error, 'MANCODE_PROJECT_UPGRADE_FAILED'),
      error instanceof Error ? error.message : 'Project upgrade failed.',
    );
  }
}
