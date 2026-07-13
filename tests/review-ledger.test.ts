import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completeReviewDomain,
  initializeReview,
  initializeSkippedReview,
  readReviewLedger,
  remediateReviewBlockers,
  reviewCanComplete,
} from '../src/system/review-ledger.js';

describe('review ledger', () => {
  let dir: string;
  const taskId = '20260711-120000-review-policy';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-review-ledger-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tracks one targeted domain and completes without blockers', async () => {
    await initializeReview(dir, taskId, 'targeted', 'quality');
    await writeReviewReport('film-report-1.md');
    await completeReviewDomain(dir, taskId, 'quality', 'film-report-1.md', []);

    await expect(reviewCanComplete(dir, taskId)).resolves.toBe(true);
    await expect(readReviewLedger(dir, taskId)).resolves.toMatchObject({
      depth: 'targeted',
      requiredDomains: ['quality'],
      completedDomains: ['quality'],
      remediationRounds: 0,
    });
  });

  it('requires both independent domains for full review', async () => {
    await initializeReview(dir, taskId, 'full');
    await writeReviewReport('film-report-1.md');
    await writeReviewReport('film-report-2.md');
    await expect(
      completeReviewDomain(dir, taskId, 'security', 'film-report-2.md', []),
    ).rejects.toThrow(/quality review must complete first/);
    await completeReviewDomain(dir, taskId, 'quality', 'film-report-1.md', []);
    await expect(reviewCanComplete(dir, taskId)).resolves.toBe(false);

    await completeReviewDomain(dir, taskId, 'security', 'film-report-2.md', []);
    await expect(reviewCanComplete(dir, taskId)).resolves.toBe(true);
  });

  it('records an explicit review skip as a completed review decision', async () => {
    const ledger = await initializeSkippedReview(
      dir,
      taskId,
      '用户明确要求跳过独立审查',
    );

    expect(ledger.skipped?.reason).toContain('用户明确要求');
    await expect(reviewCanComplete(dir, taskId)).resolves.toBe(true);
  });

  it('allows one remediation round and keeps unresolved blockers open', async () => {
    await initializeReview(dir, taskId, 'targeted', 'quality');
    await writeReviewReport('film-report-1.md');
    await completeReviewDomain(dir, taskId, 'quality', 'film-report-1.md', [
      'Q1',
      'Q2',
    ]);

    await remediateReviewBlockers(dir, taskId, ['Q1']);
    await expect(reviewCanComplete(dir, taskId)).resolves.toBe(false);
    await expect(remediateReviewBlockers(dir, taskId, ['Q2'])).rejects.toThrow(
      /one remediation round/,
    );
  });

  it('rejects duplicate review domains, blocker ids, and unsafe reports', async () => {
    await initializeReview(dir, taskId, 'full');
    await writeReviewReport('film-report-1.md');
    await completeReviewDomain(dir, taskId, 'quality', 'film-report-1.md', [
      'Q1',
    ]);

    await expect(
      completeReviewDomain(dir, taskId, 'quality', 'film-report-repeat.md', []),
    ).rejects.toThrow(/already completed/);
    await expect(
      completeReviewDomain(dir, taskId, 'security', 'missing-report.md', []),
    ).rejects.toThrow(/report not found/);
    await expect(
      completeReviewDomain(dir, taskId, 'security', '../outside.md', ['Q1']),
    ).rejects.toThrow(/report path/);
  });

  async function writeReviewReport(name: string): Promise<void> {
    await writeFile(
      path.join(dir, '.mancode', 'workflows', taskId, name),
      '# Review\n',
      'utf-8',
    );
  }
});
