import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type RequirementsLedger,
  writeRequirementsArtifacts,
} from '../src/system/requirements-ledger.js';
import {
  confirmManualVerification,
  initializeVerificationLedger,
  recordVerification,
  verificationCanAdvance,
  writeVerificationLedger,
} from '../src/system/verification-ledger.js';

describe('verification ledger', () => {
  let dir: string;
  const taskId = '20260713-120000-verification';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-verification-'));
    await mkdir(path.join(dir, '.mancode', 'workflows', taskId), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('requires both components of a hybrid acceptance criterion', () => {
    const requirements = hybridRequirements();
    const initialized = initializeVerificationLedger(requirements, 1);
    const automated = recordVerification(
      initialized,
      'AC-1',
      'automated',
      'passed',
      'browser test exited 0',
      { command: 'npm test', exitCode: 0 },
    );
    const waiting = recordVerification(
      automated,
      'AC-1',
      'manual',
      'manual_required',
      'Pointer Lock needs a foreground browser',
    );
    const confirmed = confirmManualVerification(
      waiting,
      'AC-1',
      '用户回复：交互正常',
    );

    expect(automated.status).toBe('pending');
    expect(waiting.status).toBe('manual_required');
    expect(confirmed.status).toBe('passed');
  });

  it('invalidates verification when requirements or plan version changes', async () => {
    const requirements = hybridRequirements();
    await writeRequirementsArtifacts(dir, taskId, requirements);
    let ledger = initializeVerificationLedger(requirements, 1);
    ledger = recordVerification(
      ledger,
      'AC-1',
      'automated',
      'passed',
      'browser test exited 0',
      { command: 'npm test', exitCode: 0 },
    );
    ledger = recordVerification(
      ledger,
      'AC-1',
      'manual',
      'manual_required',
      'needs foreground confirmation',
    );
    ledger = confirmManualVerification(ledger, 'AC-1', '用户回复：已通过');
    await writeVerificationLedger(dir, taskId, ledger);

    await expect(verificationCanAdvance(dir, taskId, 1)).resolves.toBe(true);
    await expect(verificationCanAdvance(dir, taskId, 2)).resolves.toBe(false);
    await writeRequirementsArtifacts(dir, taskId, {
      ...requirements,
      confirmedScope: ['Changed scope'],
    });
    await expect(verificationCanAdvance(dir, taskId, 1)).resolves.toBe(false);
  });
});

function hybridRequirements(): RequirementsLedger {
  return {
    version: 1,
    goal: 'Verify browser interaction',
    confirmedScope: ['Desktop browser'],
    excludedScope: [],
    technicalDecisions: ['Use browser automation plus manual confirmation'],
    defaults: [],
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
      dimension:
        dimension as RequirementsLedger['coverage'][number]['dimension'],
      status: 'confirmed' as const,
      rationale: `${dimension} was explicitly considered`,
    })),
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'Pointer lock movement works',
        required: true,
        method: 'hybrid',
      },
    ],
  };
}
