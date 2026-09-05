import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Creates only new fixtures under the supplied directory; keeps evidence for
// inspection. Run after npm run build, never against an existing project.
const parent = process.argv[2];
assert(
  parent,
  'Usage: node scripts/verify-migration-regressions.mjs <test-directory>',
);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist/cli.js');
await access(cli);
const runRoot = await mkdtemp(path.join(path.resolve(parent), 'run-'));
const results = [];
const legacyTaskId = '20260717-120000-login-rate-limit';
let commandIndex = 0;
console.log(`Fixtures: ${runRoot}`);

async function command(root, args, expectedCode = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  await writeFile(
    path.join(runRoot, `command-${++commandIndex}.json`),
    JSON.stringify(
      {
        project: path.basename(root),
        args,
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    ),
  );
  assert.equal(
    result.status,
    expectedCode,
    `${args.join(' ')}: ${result.stdout} ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

async function fixture(name, platforms = ['claude-code']) {
  const root = path.join(runRoot, name);
  await mkdir(path.join(root, '.mancode'), { recursive: true });
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src/index.js'),
    'export const project = "legacy fixture";\n',
  );
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, '.mancode/state.json'),
    JSON.stringify(
      {
        version: '0.3.9',
        currentMode: 'man',
        lastMode: 'solo',
        currentTask: legacyTaskId,
        currentWorkflowMode: 'man',
        initializedAt: '2026-07-17T09:00:00.000Z',
        platforms,
      },
      null,
      2,
    ),
  );
  const workflow = path.join(root, '.mancode/workflows', legacyTaskId);
  await mkdir(path.join(workflow, 'reports'), { recursive: true });
  const digest = 'a'.repeat(64);
  const timestamp = '2026-07-17T11:00:00.000Z';
  const files = {
    'metadata.json': {
      taskId: legacyTaskId,
      task: 'Add login rate limits.',
      mode: 'man',
      currentStep: 9,
      skippedSteps: [],
      startedAt: timestamp,
      updatedAt: timestamp,
      status: 'in_progress',
      planVersion: 2,
      planningPolicyVersion: 2,
      reviewPolicyVersion: 1,
      verificationPolicyVersion: 1,
      requirementsStatus: 'ready',
      requirementsDigest: digest,
      planDecision: 'governed_execution',
      verificationStatus: 'passed',
    },
    'requirements.json': {
      version: 1,
      goal: 'Protect the login endpoint.',
      confirmedScope: ['Protect login.'],
      excludedScope: ['Account recovery.'],
      technicalDecisions: ['Use existing Redis.'],
      defaults: ['Use existing test runner.'],
      blockingUnknowns: [],
      coverage: [
        'platform',
        'core_scope',
        'technical_stack',
        'data_and_persistence',
        'performance',
        'compatibility',
        'security',
      ].map((dimension) => ({
        dimension,
        status: 'confirmed',
        rationale: 'Covered by the legacy contract.',
      })),
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Repeated failures are rate limited.',
          required: true,
          method: 'hybrid',
        },
      ],
    },
    'review-ledger.json': {
      version: '1.0',
      depth: 'full',
      requiredDomains: ['quality', 'security'],
      completedDomains: ['quality', 'security'],
      reports: {
        quality: 'reports/quality.md',
        security: 'reports/security.md',
      },
      blockers: [],
      remediationRounds: 0,
    },
    'verification-ledger.json': {
      version: 1,
      planVersion: 2,
      requirementsDigest: digest,
      remediationRound: 0,
      status: 'passed',
      checks: [
        {
          acceptanceId: 'AC-1',
          required: true,
          automated: {
            status: 'passed',
            evidence: 'Legacy fixture evidence.',
            updatedAt: timestamp,
            command: 'npm test',
            exitCode: 0,
            evidenceFile: 'reports/evidence.md',
          },
          manual: {
            status: 'passed',
            evidence: 'Legacy reviewer evidence.',
            updatedAt: timestamp,
          },
        },
      ],
    },
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(workflow, name), JSON.stringify(value, null, 2));
  }
  for (const name of ['quality', 'security', 'evidence']) {
    await writeFile(
      path.join(workflow, 'reports', `${name}.md`),
      `# Legacy fixture ${name}\n`,
    );
  }
  return root;
}

async function read(root, relative) {
  return readFile(path.join(root, relative), 'utf8');
}

async function missing(root, relative) {
  await assert.rejects(access(path.join(root, relative)), { code: 'ENOENT' });
}

async function session(root) {
  await command(root, [
    'team',
    'identity',
    'create',
    '--name',
    'Migration regression tester',
  ]);
  const value = await command(root, [
    'context',
    'session',
    'new',
    '--client',
    'codex',
  ]);
  const id = value.session.sessionId;
  assert.equal(typeof id, 'string');
  await command(root, [
    'team',
    'join',
    '--name',
    'Migration regression tester',
    '--session',
    id,
    '--client',
    'codex',
  ]);
  return { id, actorId: value.session.actorId };
}

try {
  for (const shared of [false, true]) {
    const platforms = shared ? ['claude-code', 'codex'] : ['claude-code'];
    const root = await fixture(
      shared ? 'shared-symlink' : 'single-platform',
      platforms,
    );
    const before = '# User rules\r\nKeep user content byte-for-byte.\r\n';
    const file = shared ? 'AGENTS.md' : 'CLAUDE.md';
    await writeFile(path.join(root, file), before);
    if (shared) await symlink('AGENTS.md', path.join(root, 'CLAUDE.md'));
    const legacy = await read(root, '.mancode/state.json');
    const report = await command(root, ['migrate', 'context', '--dry-run']);
    assert.deepEqual(
      Object.keys(report.managedAdapters).sort(),
      [...platforms].sort(),
    );
    await missing(root, '.mancode/schema.json');
    let stage = await command(root, ['migrate', 'context', '--stage']);
    const { id, actorId } = await session(root);
    stage = await command(root, [
      'migrate',
      'context',
      'resolve',
      legacyTaskId,
      '--stage-id',
      stage.stageId,
      '--expected-stage-revision',
      String(stage.revision),
      '--owner',
      actorId,
    ]);
    const activation = await command(root, [
      'migrate',
      'context',
      '--activate',
      '--confirm',
      '--stage-id',
      stage.stageId,
      '--expected-stage-revision',
      String(stage.revision),
      '--session',
      id,
    ]);
    assert.equal(activation.manifest.activationState, 'v3_active');
    assert.deepEqual(
      Object.keys(activation.manifest.managedAdapters).sort(),
      [...platforms].sort(),
    );
    assert((await read(root, file)).startsWith(before));
    if (shared) {
      assert.equal(await readlink(path.join(root, 'CLAUDE.md')), 'AGENTS.md');
      for (const name of ['codex', 'claude']) {
        assert.equal(
          (await read(root, file)).split(
            `<!-- mancode:continuity:${name}:start -->`,
          ).length,
          2,
        );
      }
    }
    await command(root, [
      'migrate',
      'context',
      '--rollback',
      activation.operation.operationId,
      '--confirm',
      '--session',
      id,
    ]);
    assert.equal(await read(root, file), before);
    assert.equal(await read(root, '.mancode/state.json'), legacy);
    await missing(root, '.claude');
    const retry = await command(root, ['migrate', 'context', '--stage']);
    assert.equal(retry.state, 'staged');
    results.push({
      name: path.basename(root),
      passed: true,
      checks: [
        'CLI inventory',
        'activation',
        'user bytes',
        'rollback',
        'restage',
      ],
    });
  }

  const empty = await fixture('explicit-empty', []);
  const noEvidence = await command(
    empty,
    ['migrate', 'context', '--dry-run'],
    3,
  );
  assert.equal(
    noEvidence.error.code,
    'MANCODE_MIGRATION_ADAPTER_INVENTORY_REQUIRED',
  );
  const emptyStage = await command(empty, [
    'migrate',
    'context',
    '--stage',
    '--platform',
    'none',
  ]);
  assert.deepEqual(emptyStage.managedAdapters, {});
  await missing(empty, 'AGENTS.md');
  await missing(empty, 'CLAUDE.md');
  results.push({ name: 'explicit-empty', passed: true });

  // The worker terminates the real CLI immediately after one successful FS
  // operation, so finally blocks and in-process recovery do not execute.
  const worker = path.join(runRoot, 'kill-worker.mjs');
  await writeFile(
    worker,
    `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [cli, method, target] = process.argv.slice(2);
const original = fs[method];
fs[method] = async (...args) => {
  const result = await original(...args);
  if (path.resolve(String(args[method === 'rename' ? 1 : 0])) === target) {
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  return result;
};
syncBuiltinESMExports();
process.argv = [process.execPath, cli, 'migrate', 'context', '--stage', '--json'];
await import(pathToFileURL(cli).href);
`,
  );
  for (const method of ['rename', 'mkdir']) {
    const root = await fixture(`sigkill-${method}`);
    const target = path.join(
      root,
      method === 'rename'
        ? '.mancode/shared/config.json'
        : '.mancode/local/migration/.bootstrap.lock',
    );
    const killed = spawnSync(process.execPath, [worker, cli, method, target], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr || killed.stdout);
    await missing(root, '.mancode/schema.json');
    if (method === 'rename') {
      const journalPath = '.mancode/local/migration/dual-read-bootstrap.json';
      const journal = await read(root, journalPath);
      const preview = await command(
        root,
        ['migrate', 'context', '--dry-run'],
        3,
      );
      assert.equal(
        preview.error.code,
        'MANCODE_MIGRATION_DUAL_READ_SHELL_RECOVERY_REQUIRED',
      );
      assert.equal(await read(root, journalPath), journal);
      const owner = JSON.parse(
        await read(root, '.mancode/local/migration/.bootstrap.lock/owner.json'),
      );
      console.log('Waiting for the killed bootstrap owner lease to expire...');
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Date.parse(owner.leaseExpiresAt) - Date.now() + 100),
        ),
      );
      await command(root, ['migrate', 'context', '--stage']);
      assert.equal(
        JSON.parse(await read(root, journalPath)).state,
        'committed',
      );
    } else {
      const rejected = await command(
        root,
        ['migrate', 'context', '--stage'],
        3,
      );
      assert.equal(
        rejected.error.code,
        'MANCODE_MIGRATION_BOOTSTRAP_LOCK_STALE_UNVERIFIED',
      );
      assert.deepEqual(await readdir(target), []);
    }
    results.push({ name: `sigkill-${method}`, passed: true });
  }
  await writeFile(
    path.join(runRoot, 'results.json'),
    JSON.stringify({ passed: true, results }, null, 2),
  );
  console.log(
    JSON.stringify(
      { passed: true, projects: results.length, runRoot },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    path.join(runRoot, 'results.json'),
    JSON.stringify({ passed: false, results, error: String(error) }, null, 2),
  );
  throw error;
}
