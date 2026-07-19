#!/usr/bin/env node
import { Option, program } from 'commander';
import {
  contextBeta,
  contextClose,
  contextCompact,
  contextDiagnostics,
  contextDoctor,
  contextPublish,
  contextReconcileTaskHead,
  contextResume,
  contextSessionNew,
  contextSessionSpike,
  contextShow,
  contextWorktreeRegister,
} from './commands/context.js';
import { init } from './commands/init.js';
import { install } from './commands/install.js';
import { listPlatforms } from './commands/list-platforms.js';
import { manps } from './commands/manps.js';
import { migrateContext, migrateContextResolve } from './commands/migrate.js';
import {
  operationAbort,
  operationRepair,
  operationShow,
} from './commands/operation.js';
import { refreshProject } from './commands/refresh-project.js';
import { refreshStyle } from './commands/refresh-style.js';
import { status } from './commands/status.js';
import {
  teamCheckpoint,
  teamClaim,
  teamClaimReclaim,
  teamClaimRelease,
  teamClaimRenew,
  teamClaimRevalidate,
  teamClaimTransfer,
  teamConflicts,
  teamDecisionPublish,
  teamHandoffAccept,
  teamHandoffCancel,
  teamHandoffDraft,
  teamHandoffOffer,
  teamHandoffReject,
  teamIdentityCreate,
  teamIdentityShow,
  teamJoin,
  teamPolicy,
  teamStatus,
  teamSyncPull,
  teamSyncPush,
  teamTransportMigrate,
  teamTransportRecover,
  teamTransportSet,
  teamTransportStatus,
} from './commands/team.js';
import { uninstall } from './commands/uninstall.js';
import { version } from './commands/version.js';
import { workflow } from './commands/workflow.js';
import { VERSION } from './version.js';

program
  .name('mancode')
  .description(
    'AI coding agent harness. Modes: solo, man, manba, manteam, manps.',
  )
  .version(VERSION);

program
  .command('init')
  .description('Initialize mancode in the current project')
  .option('--force', 'Reinstall even if already initialized')
  .option('--yes', 'Skip all confirmations (CI mode)')
  .option('--team', 'Force enable team mode (MVP-2)')
  .option('--no-team', 'Force disable team mode (MVP-2)')
  .option('--style <name>', 'Specify aesthetic style (MVP-2)')
  .option('--platform <platforms>', 'Adapters: comma-separated names or all')
  .option('--empty', 'Initialize a safe empty directory as a generic project')
  .addOption(new Option('--v3').hideHelp())
  .option('--legacy', 'Use the legacy state.json initializer')
  .option('--lang <locale>', 'Initialization language: zh-CN or en')
  .action(async (options) => {
    const code = await init(process.cwd(), {
      ...options,
      fromCli: true,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    process.exitCode = code;
  });

program
  .command('install [platform]')
  .description(
    'Install platform adapter (claude-code, cursor, codex, copilot, zcode)',
  )
  .option('--force', 'Reinstall even if already installed')
  .option('--minimal', 'Minimal install (MVP-2)')
  .option(
    '--shadow',
    'Stage a mancode bootstrap candidate without changing live files',
  )
  .action(async (platform, options) => {
    const code = await install(
      process.cwd(),
      platform ?? 'claude-code',
      options,
    );
    process.exitCode = code;
  });

program
  .command('status')
  .description('Show current mancode project status')
  .option('--json', 'Output as JSON (for scripts)')
  .option('--brief', 'Output compact mancode Continuity runtime status')
  .action(async (options) => {
    const code = await status(process.cwd(), options);
    process.exitCode = code;
  });

program
  .command('list-platforms')
  .description('List available and installed mancode platform adapters')
  .action(async () => {
    const code = await listPlatforms(process.cwd());
    process.exitCode = code;
  });

program
  .command('uninstall [platform]')
  .description('Remove platform adapter or all mancode artifacts')
  .option('--force', 'Skip confirmation message')
  .option('--all', 'Remove everything including .mancode/ directory')
  .action(async (platform, options) => {
    const code = await uninstall(process.cwd(), platform, options);
    process.exitCode = code;
  });

program
  .command('workflow <subcommand> [args...]')
  .description('Manage mancode workflows')
  .option('--dry-run', 'Preview clean without deleting')
  .option('--older-than <duration>', 'Clean workflows older than (e.g. 30d)')
  .option('--step <n>', 'Update workflow current step')
  .option('--status <status>', 'Update workflow status')
  .option(
    '--parent-task <taskId>',
    'Parent /man or /manteam workflow for manba',
  )
  .option('--parent <namespace:id>', 'Parent TaskRef for a manba child')
  .option(
    '--participant <actorId>',
    'Invite a joined team participant',
    collectOption,
    [],
  )
  .option('--visibility <visibility>', 'Task visibility: local or shared')
  .option('--coordination <coordination>', 'Task coordination: single or team')
  .option('--session <id>', 'mancode session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--expected-revision <n>', 'Expected task revision for mutations')
  .option('--child-revision <n>', 'Expected child task revision for merge')
  .option('--summary <text>', 'Privacy-screened child result summary')
  .option('--next-action <text>', 'Next parent action after a child merge')
  .option('--sync', 'Publish shared mutations through git-ref transport')
  .option(
    '--confirm-shared',
    'Confirm that task metadata may enter shared mancode authority',
  )
  .option('--blocking-reason <reason>', 'Explain why a workflow is blocked')
  .option('--outcome <outcome>', 'Set manba outcome when completing a task')
  .option('--plan-version <n>', 'Set the next man/manteam plan revision')
  .option(
    '--requirements-status <status>',
    'Planning readiness: ready or needs_clarification',
  )
  .option(
    '--plan-decision <decision>',
    'Plan gate choice: plan_only or governed_execution',
  )
  .option('--to <mode>', 'Workflow handoff target (solo)')
  .option('--complete', 'Complete an active solo handoff')
  .option(
    '--skipped <steps>',
    'Policy v2: clarification only; use workflow review skip for review',
  )
  .option('--review-depth <depth>', 'Review depth: targeted or full')
  .option('--review-domain <domain>', 'Review domain: quality or security')
  .option(
    '--report <path>',
    'Relative Markdown report path for a review domain',
  )
  .option('--blockers <ids>', 'Comma-separated blocker ids found by a review')
  .option(
    '--resolved <ids>',
    'Comma-separated blocker ids resolved in remediation',
  )
  .option(
    '--file <path>',
    'Semantic or canonical structured requirements JSON input file',
  )
  .option('--acceptance <id>', 'Acceptance criterion id (for example AC-1)')
  .option('--method <method>', 'Verification method: automated or manual')
  .option('--result <result>', 'Verification result')
  .option('--evidence <text>', 'Verification evidence or user confirmation')
  .option('--command <command>', 'Command used for automated verification')
  .option('--exit-code <code>', 'Exit code from automated verification')
  .option('--evidence-file <path>', 'Existing verification report or artifact')
  .option('--reason <reason>', 'Reason for an explicit review skip')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (subcommand, args, options) => {
    const code = await workflow(process.cwd(), subcommand, args ?? [], {
      ...options,
      participants:
        options.participant.length === 0 ? undefined : options.participant,
    });
    process.exitCode = code;
  });

const contextProgram = program
  .command('context')
  .description('Resolve mancode task context and manage explicit sessions');

contextProgram
  .command('show')
  .description('Resolve one mancode Context Pack')
  .option('--task <namespace:id>', 'Explicit TaskRef')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--level <level>', 'bootstrap, task, or full')
  .option(
    '--purpose <purpose>',
    'orient, plan, implement, review, verify, or handoff',
  )
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextShow(process.cwd(), options);
  });

const contextSessionProgram = contextProgram
  .command('session')
  .description('Manage mancode session identities');

contextSessionProgram
  .command('new')
  .description('Create an explicit bootstrap session')
  .requiredOption('--client <name>', 'Client identity')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextSessionNew(process.cwd(), options);
  });

contextSessionProgram
  .command('spike')
  .description('Record real-host session evidence without persisting host keys')
  .requiredOption(
    '--platform <platform>',
    'claude-code, codex, cursor, copilot, or zcode',
  )
  .requiredOption(
    '--host-session-source <source>',
    'hook_stdin, environment, or api',
  )
  .requiredOption(
    '--command-propagation <status>',
    'Real host child-command result: proven, not_proven, not_tested, or not_applicable',
  )
  .requiredOption(
    '--subagent-inheritance <status>',
    'Real host child-agent result: proven, not_proven, not_tested, or not_applicable',
  )
  .option(
    '--subagent-inheritance-reason <reason>',
    'Required when child-agent inheritance is not applicable',
  )
  .option(
    '--hook-approval <status>',
    'approved, unapproved, unknown, or not_applicable',
  )
  .requiredOption(
    '--host-version <version>',
    'Installed host version used for the spike',
  )
  .requiredOption(
    '--release-candidate <id>',
    'Immutable mancode release candidate or source commit identifier',
  )
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextSessionSpike(process.cwd(), options);
  });

contextProgram
  .command('resume <namespace:id>')
  .description('Validate and bind the current session to a mancode TaskRef')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish shared mutations through git-ref transport')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await contextResume(process.cwd(), task, options);
  });

contextProgram
  .command('close')
  .description('Close one explicit session without affecting other sessions')
  .requiredOption('--session <id>', 'Session ID')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextClose(process.cwd(), options);
  });

contextProgram
  .command('doctor')
  .description('Inspect unfinished mancode operations or repair one explicitly')
  .option(
    '--repair <operationId>',
    'Repair this operation with its original session',
  )
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextDoctor(process.cwd(), options);
  });

contextProgram
  .command('diagnostics [action]')
  .description('Show or configure local aggregate diagnostics')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (action, options) => {
    process.exitCode = await contextDiagnostics(process.cwd(), action, options);
  });

contextProgram
  .command('compact')
  .description('List and remove eligible mancode runtime retention candidates')
  .option('--task <namespace:id>', 'Compact checkpoints for one completed task')
  .option('--dry-run', 'Show the deletion list without changing files')
  .option('--apply-shared', 'Permit deletion for shared completed tasks')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextCompact(process.cwd(), options);
  });

contextProgram
  .command('beta', { hidden: true })
  .description('Evaluate internal release-evidence gates')
  .requiredOption(
    '--release-candidate <id>',
    'Release candidate that must match every platform evidence record',
  )
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextBeta(process.cwd(), options);
  });

contextProgram
  .command('publish <local:id>')
  .description('Create a privacy-screened shared man successor')
  .requiredOption('--expected-revision <n>', 'Current local task revision')
  .requiredOption(
    '--confirm-shared',
    'Confirm that the screened task authority may enter shared storage',
  )
  .option('--dry-run', 'Validate the publish preflight without writing')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await contextPublish(process.cwd(), task, options);
  });

contextProgram
  .command('reconcile-task-head <shared:id>')
  .description(
    'Adopt a Git-sourced shared aggregate through an explicit fence CAS',
  )
  .requiredOption(
    '--expected-fence-revision <n>',
    'Current shared task-head fence revision',
  )
  .requiredOption(
    '--from-git',
    'Confirm the checked-out aggregate came from Git',
  )
  .option('--dry-run', 'Validate adoption without changing the task-head fence')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await contextReconcileTaskHead(
      process.cwd(),
      task,
      options,
    );
  });

const contextWorktreeProgram = contextProgram
  .command('worktree')
  .description('Register and inspect the current mancode checkout binding');

contextWorktreeProgram
  .command('register')
  .description(
    'Register this linked worktree before using mancode coordination',
  )
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await contextWorktreeRegister(process.cwd(), options);
  });

const operationProgram = program
  .command('operation')
  .description('Inspect and recover durable mancode operations');

operationProgram
  .command('show <operationId>')
  .description('Show one operation journal and its recovery disposition')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (operationId, options) => {
    process.exitCode = await operationShow(process.cwd(), operationId, options);
  });

operationProgram
  .command('repair <operationId>')
  .description('Repair an operation using its original actor and session')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (operationId, options) => {
    process.exitCode = await operationRepair(
      process.cwd(),
      operationId,
      options,
    );
  });

operationProgram
  .command('abort <operationId>')
  .description(
    'Abort only an operation proven to have no visible business write',
  )
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (operationId, options) => {
    process.exitCode = await operationAbort(
      process.cwd(),
      operationId,
      options,
    );
  });

const teamProgram = program
  .command('team')
  .description('Manage mancode local identity and local-team membership');

teamProgram
  .command('status')
  .description('Show mancode team policy, transport, and local identity state')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamStatus(process.cwd(), options);
  });

teamProgram
  .command('policy <mode>')
  .description('Set the mancode team recommendation policy with a revision CAS')
  .requiredOption('--expected-revision <n>', 'Current team policy revision')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (policy, options) => {
    process.exitCode = await teamPolicy(process.cwd(), {
      ...options,
      policy,
    });
  });

teamProgram
  .command('conflicts')
  .description(
    'Inspect local claim conflicts and handoffs without mutating coordination',
  )
  .option('--task <namespace:id>', 'Narrow the report to one shared TaskRef')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamConflicts(process.cwd(), options);
  });

const teamTransportProgram = teamProgram
  .command('transport')
  .description('Inspect and migrate the coordination authority');

teamTransportProgram
  .command('status')
  .description('Show active coordination transport and freshness')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamTransportStatus(process.cwd(), options);
  });

teamTransportProgram
  .command('set <mode>')
  .description(
    'Switch an empty coordination authority; otherwise use transport migrate',
  )
  .requiredOption(
    '--expected-config-revision <n>',
    'Current project config revision',
  )
  .option(
    '--remote <name>',
    'Git remote for a git-ref target (default: origin)',
  )
  .option('--dry-run', 'Validate the empty-authority switch without writing')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (mode, options) => {
    process.exitCode = await teamTransportSet(process.cwd(), {
      ...options,
      mode,
    });
  });

teamTransportProgram
  .command('migrate')
  .description('Journal a single-authority local/git-ref transport switch')
  .requiredOption('--to <mode>', 'Target authority: local or git-ref')
  .requiredOption(
    '--expected-config-revision <n>',
    'Current project config revision',
  )
  .option(
    '--remote <name>',
    'Git remote for a git-ref target (default: origin)',
  )
  .option('--dry-run', 'Validate and preview without writing authority state')
  .option('--confirm', 'Explicitly confirm the authority migration')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamTransportMigrate(process.cwd(), options);
  });

teamTransportProgram
  .command('recover <operationId>')
  .description('Repair forward or safely abort a transport migration')
  .requiredOption('--to <mode>', 'Original target authority: local or git-ref')
  .option('--remote <name>', 'Original Git remote for a git-ref target')
  .option('--abort', 'Abort only before the target authority is established')
  .option('--session <id>', 'Original migration session ID')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (operationId, options) => {
    process.exitCode = await teamTransportRecover(
      process.cwd(),
      operationId,
      options,
    );
  });

const teamSyncProgram = teamProgram
  .command('sync')
  .description('Explicitly synchronize the git-ref coordination authority');

teamSyncProgram
  .command('pull')
  .description('Fetch, validate, and cache refs/mancode/team')
  .option('--task <namespace:id>', 'Narrow output to one shared TaskRef')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamSyncPull(process.cwd(), options);
  });

teamSyncProgram
  .command('push <namespace:id>')
  .description('Publish one task bundle through a fresh ownership fence CAS')
  .requiredOption(
    '--expected-task-revision <n>',
    'Current shared task revision',
  )
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await teamSyncPush(process.cwd(), {
      ...options,
      task,
    });
  });

const teamIdentityProgram = teamProgram
  .command('identity')
  .description('Manage the machine-local actor identity');

teamIdentityProgram
  .command('create')
  .description('Create one local actor identity')
  .requiredOption('--name <displayName>', 'Display name')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamIdentityCreate(process.cwd(), options);
  });

teamIdentityProgram
  .command('show')
  .description('Show local identity and whether it is joined')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamIdentityShow(process.cwd(), options);
  });

const teamDecisionProgram = teamProgram
  .command('decision')
  .description('Publish explicitly confirmed, privacy-safe shared decisions');

teamDecisionProgram
  .command('publish')
  .description('Publish one immutable confirmed decision')
  .requiredOption('--title <text>', 'Short decision title')
  .requiredOption('--statement <text>', 'Confirmed decision statement')
  .option('--task <namespace:id>', 'Optional shared TaskRef that produced it')
  .requiredOption('--confirm', 'Confirm this decision may enter shared memory')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamDecisionPublish(process.cwd(), options);
  });

teamProgram
  .command('join')
  .description(
    'Publish the approved shared actor profile after explicit confirmation',
  )
  .requiredOption('--name <displayName>', 'Must match the local actor identity')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Request explicit remote sync when transport supports it')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    process.exitCode = await teamJoin(process.cwd(), options);
  });

teamProgram
  .command('checkpoint <namespace:id>')
  .description('Create a journaled immutable checkpoint for a shared task')
  .requiredOption(
    '--expected-task-revision <n>',
    'Current shared task revision',
  )
  .requiredOption('--kind <kind>', 'Checkpoint kind')
  .requiredOption('--summary <text>', 'Privacy-safe checkpoint summary')
  .option('--next-action <text>', 'Next action for the receiving workflow')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await teamCheckpoint(process.cwd(), {
      ...options,
      task,
    });
  });

teamProgram
  .command('claim <namespace:id>')
  .description('Acquire a scoped claim for a shared task')
  .requiredOption(
    '--expected-task-revision <n>',
    'Current shared task revision',
  )
  .option('--path <glob>', 'Repository-relative path glob', collectOption, [])
  .option('--module <name>', 'Implementation module', collectOption, [])
  .option('--api <name>', 'Public API boundary', collectOption, [])
  .option('--schema <name>', 'Shared schema boundary', collectOption, [])
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await teamClaim(process.cwd(), {
      ...options,
      task,
      paths: options.path,
      modules: options.module,
      apis: options.api,
      schemas: options.schema,
    });
  });

teamProgram
  .command('renew <claimId>')
  .description('Renew one fresh claim lease')
  .requiredOption('--expected-revision <n>', 'Current claim revision')
  .option('--ttl <duration>', 'Lease duration: ms, s, m, h, or d')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (claimId, options) => {
    process.exitCode = await teamClaimRenew(process.cwd(), {
      ...options,
      claimId,
    });
  });

teamProgram
  .command('release <claimId>')
  .description('Release one claim')
  .requiredOption('--expected-revision <n>', 'Current claim revision')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (claimId, options) => {
    process.exitCode = await teamClaimRelease(process.cwd(), {
      ...options,
      claimId,
    });
  });

teamProgram
  .command('transfer <claimId>')
  .description('Transfer a claim through a new successor identity')
  .requiredOption('--to <actorId>', 'Receiving joined participant actor ID')
  .requiredOption('--expected-revision <n>', 'Current claim revision')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (claimId, options) => {
    process.exitCode = await teamClaimTransfer(process.cwd(), {
      ...options,
      claimId,
    });
  });

teamProgram
  .command('reclaim <claimId>')
  .description('Explicitly mark an expired claim terminal')
  .requiredOption('--expected-revision <n>', 'Current claim revision')
  .requiredOption('--reason <text>', 'Privacy-safe expiry reclaim reason')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (claimId, options) => {
    process.exitCode = await teamClaimReclaim(process.cwd(), {
      ...options,
      claimId,
    });
  });

teamProgram
  .command('revalidate <claimId>')
  .description('Refresh one claim after task or code snapshot drift')
  .requiredOption('--expected-revision <n>', 'Current claim revision')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (claimId, options) => {
    process.exitCode = await teamClaimRevalidate(process.cwd(), {
      ...options,
      claimId,
    });
  });

const teamHandoffProgram = teamProgram
  .command('handoff')
  .description('Create and transition journaled ownership handoffs');

teamHandoffProgram
  .command('draft <namespace:id>')
  .description('Create a checkpoint-backed named handoff draft')
  .requiredOption(
    '--expected-task-revision <n>',
    'Current shared task revision',
  )
  .requiredOption('--to <actorId>', 'Receiving joined participant actor ID')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (task, options) => {
    process.exitCode = await teamHandoffDraft(process.cwd(), {
      ...options,
      task,
    });
  });

teamHandoffProgram
  .command('offer <handoffId>')
  .description('Offer a handoff draft to its receiving actor')
  .requiredOption('--expected-revision <n>', 'Current handoff revision')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (handoffId, options) => {
    process.exitCode = await teamHandoffOffer(process.cwd(), {
      ...options,
      handoffId,
    });
  });

teamHandoffProgram
  .command('accept <handoffId>')
  .description('Accept an offered handoff and transfer ownership atomically')
  .requiredOption('--expected-revision <n>', 'Current handoff revision')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (handoffId, options) => {
    process.exitCode = await teamHandoffAccept(process.cwd(), {
      ...options,
      handoffId,
    });
  });

teamHandoffProgram
  .command('reject <handoffId>')
  .description('Reject an offered handoff with a durable reason')
  .requiredOption('--expected-revision <n>', 'Current handoff revision')
  .requiredOption('--reason <text>', 'Reason for rejecting the handoff')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (handoffId, options) => {
    process.exitCode = await teamHandoffReject(process.cwd(), {
      ...options,
      handoffId,
    });
  });

teamHandoffProgram
  .command('cancel <handoffId>')
  .description('Cancel a draft or offered handoff')
  .requiredOption('--expected-revision <n>', 'Current handoff revision')
  .option('--reason <text>', 'Optional cancellation reason')
  .option('--session <id>', 'Session ID (otherwise MANCODE_SESSION_ID)')
  .option('--client <name>', 'Client identity (default: mancode-cli)')
  .option('--sync', 'Publish through the active git-ref authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (handoffId, options) => {
    process.exitCode = await teamHandoffCancel(process.cwd(), {
      ...options,
      handoffId,
    });
  });

const migrateProgram = program
  .command('migrate')
  .description('Inspect and migrate legacy context into mancode staging');

const migrateContextProgram = migrateProgram
  .command('context')
  .description('Manage the isolated legacy-to-mancode context migration stage')
  .option('--dry-run', 'Inspect legacy authority without writing files')
  .option('--stage', 'Create or refresh an isolated local migration stage')
  .option('--status', 'Show local migration stages')
  .option('--activate', 'Attempt the journaled mancode activation')
  .option(
    '--rollback <operationId>',
    'Roll back an untouched mancode activation',
  )
  .option('--stage-id <id>', 'Migration stage ID (required if more than one)')
  .option(
    '--expected-stage-revision <n>',
    'Expected stage revision for activation',
  )
  .option('--session <id>', 'Active session required for activation')
  .option('--confirm', 'Explicitly confirm the mancode cutover')
  .option('--confirm-shared', 'Confirm promotion of staged shared authority')
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (options) => {
    const code = await migrateContext(process.cwd(), options);
    process.exitCode = code;
  });

migrateContextProgram
  .command('resolve <legacyTaskId>')
  .description('Resolve missing owner or implementation scope in one stage')
  .requiredOption(
    '--expected-stage-revision <n>',
    'Expected local migration stage revision',
  )
  .option('--stage-id <id>', 'Migration stage ID (required if more than one)')
  .option('--owner <actorId>', 'Explicit owner actor ID')
  .option(
    '--scope-file <path>',
    'JSON implementation scope {include,exclude,modules}',
  )
  .option('--json', 'Output as JSON (for scripts)')
  .action(async (legacyTaskId, options) => {
    const code = await migrateContextResolve(
      process.cwd(),
      legacyTaskId,
      options,
    );
    process.exitCode = code;
  });

program
  .command('manps [area]')
  .description('Run deterministic preseason health scan')
  .option('--json', 'Output as JSON (for scripts)')
  .option('--remediate', 'Review scan issues with y/n/skip prompts')
  .action(async (area, options) => {
    const code = await manps(process.cwd(), area ?? 'all', options);
    process.exitCode = code;
  });

program
  .command('refresh-style')
  .description('Refresh project profile and rescan applicable design tokens')
  .action(async () => {
    const code = await refreshStyle(process.cwd());
    process.exitCode = code;
  });

program
  .command('refresh-project')
  .description(
    'Refresh detected project facts after adding Git or project files',
  )
  .action(async () => {
    const code = await refreshProject(process.cwd());
    process.exitCode = code;
  });

program
  .command('version')
  .description('Show version, node version, and platform')
  .action(() => {
    version();
  });

export { program as cliProgram };

program.parse();

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
