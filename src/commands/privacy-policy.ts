import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { assertUlid } from '../context/ids.js';
import {
  previewPrivacyPolicyUpdate,
  readPrivacyPolicyOperationTarget,
  updatePrivacyPolicy,
} from '../context/privacy-policy-operation.js';
import {
  type PrivacyPolicyCandidate,
  parsePrivacyPolicyCandidate,
  readPrivacyPolicySnapshot,
} from '../context/privacy-policy.js';
import { DEFAULT_RULE_IDS, RULESET_VERSION } from '../privacy/rules.js';
import { readSession } from '../runtime/session.js';
import {
  printV3Error,
  printV3Result,
  readV3CommandProject,
  resolveV3CommandSession,
  v3ErrorCode,
} from './v3-support.js';

interface PrivacyOptions {
  expectedRevision?: string;
  operationId?: string;
  session?: string;
  client?: string;
  dryRun?: boolean;
  file?: string;
  json?: boolean;
}

export function registerPrivacyPolicyCommands(privacy: Command): void {
  const decorate = (command: Command) =>
    command
      .option(
        '--expected-revision <revision>',
        'Expected shared privacy revision; zero for first activation',
      )
      .option('--session <id>', 'Explicit active maintenance session')
      .option('--client <client>', 'Client owning the session')
      .option(
        '--operation-id <id>',
        'Idempotent operation or repair identifier',
      )
      .option('--dry-run', 'Scan activation impact without applying policy')
      .option('--json', 'Print safe structured output');
  decorate(
    privacy
      .command('enable')
      .description(
        'Enable enhanced project-shared privacy with a journaled policy upgrade',
      ),
  ).action(async (options: PrivacyOptions) => {
    process.exitCode = await privacyPolicyCommand(process.cwd(), options, true);
  });
  decorate(
    privacy
      .command('disable')
      .description(
        'Disable enhanced rules; preserve exclusions, baseline checks, and upgraded project format',
      ),
  ).action(async (options: PrivacyOptions) => {
    process.exitCode = await privacyPolicyCommand(
      process.cwd(),
      options,
      false,
    );
  });
  const policy = privacy
    .command('policy')
    .description(
      'Apply shared privacy policy through its revision and digest authority',
    );
  decorate(
    policy
      .command('upgrade')
      .description(
        'Explicitly activate shared privacy; immutable sensitive history is excluded from future output',
      ),
  ).action(async (options: PrivacyOptions) => {
    process.exitCode = await privacyPolicyCommand(process.cwd(), options, true);
  });
  decorate(
    policy
      .command('apply')
      .description(
        'Apply a candidate JSON file through the same CAS operation',
      ),
  )
    .requiredOption(
      '--file <path>',
      'Candidate file containing schemaVersion, enabled, rulesetVersion, enabledRuleIds',
    )
    .action(async (options: PrivacyOptions) => {
      process.exitCode = await privacyPolicyCommand(process.cwd(), options);
    });
}

export async function privacyPolicyCommand(
  root: string,
  options: PrivacyOptions,
  enabled?: boolean,
): Promise<number> {
  try {
    if (options.operationId !== undefined)
      assertUlid(options.operationId, 'privacy operationId');
    const retry =
      options.operationId === undefined
        ? null
        : await readPrivacyPolicyOperationTarget(root, options.operationId);
    const current =
      retry === null ? await readPrivacyPolicySnapshot(root) : null;
    const expectedRevision =
      options.expectedRevision === undefined
        ? (retry?.expectedRevision ?? current?.policy.revision ?? 0)
        : Number(options.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error('MANCODE_PRIVACY_EXPECTED_REVISION_REQUIRED');
    let candidate: PrivacyPolicyCandidate;
    if (enabled === undefined) {
      if (options.file === undefined)
        throw new Error('MANCODE_PRIVACY_CANDIDATE_REQUIRED');
      const file = path.resolve(options.file);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
        throw new Error('MANCODE_PRIVACY_CANDIDATE_INVALID');
      candidate = parsePrivacyPolicyCandidate(
        JSON.parse(await readFile(file, 'utf8')),
      );
    } else {
      candidate = parsePrivacyPolicyCandidate({
        schemaVersion: 1,
        enabled,
        rulesetVersion:
          retry?.candidate.rulesetVersion ??
          current?.policy.rulesetVersion ??
          RULESET_VERSION,
        enabledRuleIds: retry?.candidate.enabledRuleIds ??
          current?.policy.enabledRuleIds ?? [...DEFAULT_RULE_IDS],
      });
    }
    if (options.dryRun) {
      const preview = await previewPrivacyPolicyUpdate({
        projectRoot: root,
        candidate,
        expectedRevision,
      });
      printV3Result(options.json, preview);
      return preview.blocked ? 2 : 0;
    }
    if (retry === null && current === null && !candidate.enabled) {
      const preview = await previewPrivacyPolicyUpdate({
        projectRoot: root,
        candidate,
        expectedRevision,
      });
      return printV3Result(options.json, {
        schemaVersion: 1,
        state: 'unchanged',
        operationId: null,
        enabled: false,
        revision: 0,
        digest: null,
        excludedEntities: 0,
        minimumVersion: preview.minimumVersion,
        basicChecksRemainEnabled: true,
      });
    }
    const session =
      retry !== null && options.session !== undefined
        ? await readSession(root, options.session)
        : await resolveV3CommandSession(
            await readV3CommandProject(root),
            options,
          );
    if (
      session === null ||
      session.status !== 'active' ||
      (options.client !== undefined && session.client !== options.client)
    )
      throw new Error('MANCODE_SESSION_NOT_FOUND');
    const result = await updatePrivacyPolicy({
      projectRoot: root,
      candidate,
      expectedRevision,
      sessionId: session.sessionId,
      ...(options.operationId === undefined
        ? {}
        : { operationId: options.operationId }),
    });
    return printV3Result(options.json, {
      schemaVersion: 1,
      state: result.state,
      operationId: result.operationId,
      enabled: result.snapshot?.policy.enabled ?? false,
      revision: result.snapshot?.policy.revision ?? 0,
      digest: result.snapshot?.digest ?? null,
      excludedEntities: result.snapshot?.exclusions.entries.length ?? 0,
      minimumVersion: '0.6.5',
      basicChecksRemainEnabled: true,
    });
  } catch (error) {
    const code = v3ErrorCode(error, 'MANCODE_PRIVACY_POLICY_FAILED');
    return printV3Error(options.json, code, code);
  }
}
