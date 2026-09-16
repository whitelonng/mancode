import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeRequirementsInput } from '../../src/commands/requirements-input.js';
import { initializeV3Project } from '../../src/commands/v3-init.js';
import { createUlid } from '../../src/context/ids.js';
import { reviseV3Plan } from '../../src/context/plan-revision.js';
import { finalizeV3Requirements } from '../../src/context/requirements-finalize.js';
import { REQUIREMENT_DIMENSIONS } from '../../src/context/requirements-ledger.js';
import { V3ContextStore } from '../../src/context/store.js';
import { createV3Workflow } from '../../src/context/workflow-create.js';
import { createSession } from '../../src/runtime/session.js';
import { createLocalActor } from '../../src/team/actor.js';
const execFile = promisify(execFileCallback);
export const roots: string[] = [];
export const argv = ['node', '-e', 'process.exit(0)'];
export const policy = {
  version: 1,
  budget: {
    maxRuns: 1,
    maxExecutionMs: 10000,
    maxRepairAttempts: 2,
    commandTimeoutMs: 2000,
    ciTimeoutMs: 2000,
  },
  checks: [
    {
      id: 'check',
      acceptanceIds: ['AC-1'],
      argv,
      cwd: '.',
      surface: 'component',
    },
  ],
  scenarios: [],
  delivery: 'local',
  ci: null,
};
export async function fixture(enabled = true, executionPolicy = policy) {
  const root = await mkdtemp(path.join(tmpdir(), 'mancode-execution-cli-'));
  roots.push(root);
  const git = (args: string[]) => execFile('git', args, { cwd: root });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.test']);
  await mkdir(path.join(root, 'docs'));
  const plan =
    '<!-- mancode:plan-baseline:start -->\n# Gate fixture\nAC-1 command succeeds.\n<!-- mancode:plan-baseline:end -->\n<!-- mancode:delivery-record:start -->\nPending.\n<!-- mancode:delivery-record:end -->\n';
  await writeFile(path.join(root, 'docs/plan.md'), plan);
  await writeFile(path.join(root, '.gitignore'), '.mancode/\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'fixture']);
  await initializeV3Project({ projectRoot: root });
  const actorId = createUlid();
  await createLocalActor(root, { actorId, displayName: 'Fixture' });
  const session = await createSession(root, {
    actorId,
    client: 'vitest',
    identitySource: 'explicit',
  });
  const created = await createV3Workflow({
    projectRoot: root,
    workflowMode: 'man',
    task: 'Gate fixture',
    delivery: true,
    sessionId: session.sessionId,
    client: 'vitest',
    ...(enabled ? { executionPolicy } : {}),
  });
  const taskRef = created.taskRef;
  const ready = await finalizeV3Requirements({
    projectRoot: root,
    taskRef,
    sessionId: session.sessionId,
    expectedTaskRevision: created.metadata.revision,
    requirements: normalizeRequirementsInput(
      {
        version: 1,
        goal: 'Gate fixture',
        confirmedScope: ['Run check'],
        excludedScope: [],
        technicalDecisions: [],
        defaults: [],
        blockingUnknowns: [],
        coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
          dimension,
          status:
            dimension === 'technical_stack' ? 'not_applicable' : 'confirmed',
          rationale: 'Fixture.',
        })),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'Command succeeds',
            required: true,
            method: 'automated',
            verificationSurfaces: { automated: 'component' },
          },
        ],
      },
      taskRef,
    ),
  });
  await reviseV3Plan({
    projectRoot: root,
    taskRef,
    sessionId: session.sessionId,
    expectedTaskRevision: ready.metadata.revision,
    plan,
    planSource: 'docs/plan.md',
    implementationScope: {
      include: ['docs/plan.md'],
      exclude: [],
      modules: [],
    },
    planDecision: 'governed_execution',
  });
  const store = new V3ContextStore(root);
  return { root, store, taskRef, session };
}
