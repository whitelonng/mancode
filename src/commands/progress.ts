import path from 'node:path';
import type { Command } from 'commander';
import {
  type ProgressNotification,
  startProjectProgressPreview,
} from '../context/project-progress-server.js';
import {
  bindProjectProgress,
  readProjectProgressBinding,
  readProjectProgressSnapshotVersion,
  rebuildSharedProjectProgress,
  writeProjectProgressSnapshot,
} from '../context/project-progress-storage.js';
import {
  type ProgressInvalidation,
  ProjectProgressController,
} from '../context/project-progress.js';
import { readV3CommandProject } from './v3-support.js';

export interface ProgressCommandIntegration {
  createController?: (root: string) => Promise<ProjectProgressController>;
  readNotification?: (root: string) => Promise<ProgressNotification | null>;
  onBound?: (
    root: string,
    controller: ProjectProgressController,
  ) => Promise<void>;
  onRefresh?: (
    root: string,
    change: ProgressInvalidation,
    controller: ProjectProgressController,
  ) => Promise<void>;
}
export async function createProjectProgressController(
  root: string,
): Promise<ProjectProgressController> {
  const project = await readV3CommandProject(root);
  return new ProjectProgressController(project.store, {
    workspaceId: project.runtime.workspaceId,
    checkoutId: project.runtime.checkoutId,
    projectName: path.basename(project.projectRoot),
  });
}
export function registerProgressCommands(
  program: Command,
  integration: ProgressCommandIntegration = {},
): void {
  const progress = program
    .command('progress')
    .description('View a read-only project progress page');
  progress
    .command('init')
    .description(
      'Bind this project to its progress page without replacing custom HTML',
    )
    .option('--json', 'Print compact result')
    .action(async () => {
      await perform(async () => {
        const root = process.cwd();
        const binding = await bindProjectProgress(root);
        const expected = await readProjectProgressSnapshotVersion(root);
        const controller = await (
          integration.createController ?? createProjectProgressController
        )(root);
        await controller.refresh();
        const result = await writeProjectProgressSnapshot(
          root,
          controller,
          expected,
        );
        await integration.onBound?.(root, controller);
        return { binding, ...result };
      });
    });
  progress
    .command('refresh')
    .description('Explicitly rebuild the local projection and offline snapshot')
    .option('--shared', 'Safely rebuild a managed shared snapshot')
    .option('--json', 'Print compact result')
    .action(async (options: { shared?: boolean }) => {
      await perform(async () => {
        const root = process.cwd();
        if (!(await readProjectProgressBinding(root)))
          throw new Error('MANCODE_PROGRESS_NOT_BOUND');
        const expected = await readProjectProgressSnapshotVersion(root);
        const controller = await (
          integration.createController ?? createProjectProgressController
        )(root);
        controller.invalidate({ full: true, reason: 'explicit_refresh' });
        await controller.refresh();
        if (options.shared) {
          await rebuildSharedProjectProgress(root, controller, expected);
          await integration.onRefresh?.(
            root,
            { full: true, reason: 'explicit_refresh' },
            controller,
          );
          return { status: 'updated', visibility: 'shared-snapshot' };
        }
        const result = await writeProjectProgressSnapshot(
          root,
          controller,
          expected,
        );
        await integration.onRefresh?.(
          root,
          {
            full: true,
            reason: 'explicit_refresh',
          },
          controller,
        );
        return result;
      });
    });
  progress
    .command('preview')
    .description('Run a foreground loopback preview; stop with Ctrl-C')
    .option('--port <number>', 'Local port, default random')
    .option('--json', 'Print compact result')
    .action(async (options: { port?: string }) => {
      await perform(async () => {
        const root = process.cwd();
        if (!(await readProjectProgressBinding(root)))
          throw new Error('MANCODE_PROGRESS_NOT_BOUND');
        const controller = await (
          integration.createController ?? createProjectProgressController
        )(root);
        await controller.refresh();
        const preview = await startProjectProgressPreview(controller, {
          port: options.port === undefined ? undefined : Number(options.port),
          readNotification: integration.readNotification
            ? () =>
                integration.readNotification?.(root) ?? Promise.resolve(null)
            : undefined,
        });
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          void preview.close();
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        return {
          status: 'preview',
          url: preview.url,
          notifications: integration.readNotification
            ? 'connected_when_verified'
            : 'unverified',
        };
      });
    });
}
async function perform(work: () => Promise<unknown>): Promise<void> {
  try {
    console.log(JSON.stringify(await work()));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'unavailable',
        code:
          error instanceof Error &&
          /^MANCODE_[A-Z_]{1,100}$/.test(error.message)
            ? error.message
            : 'MANCODE_PROGRESS_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
