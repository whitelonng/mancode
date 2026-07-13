import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/commands/init.js';
import {
  EXIT_INVALID_ARG,
  EXIT_OK,
  workflow,
} from '../src/commands/workflow.js';
import { createWorkflow, readWorkflow } from '../src/system/workflow.js';

describe('mancode workflow command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-workflow-command-'));
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await silentInit(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('workflow list is empty on initialized project', async () => {
    const logs = await captureLog(() => workflow(dir, 'list'));
    expect(logs.code).toBe(EXIT_OK);
    expect(logs.stdout.join('\n')).toContain('No workflows');
  });

  it('workflow create creates metadata through the command path', async () => {
    const logs = await captureLog(() =>
      workflow(dir, 'create', ['man', 'add', 'oauth', 'login'], {
        json: true,
      }),
    );
    const meta = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(meta.mode).toBe('man');
    expect(meta.task).toBe('add oauth login');
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      task: 'add oauth login',
      currentStep: 1,
      planningPolicyVersion: 2,
      reviewPolicyVersion: 2,
      verificationPolicyVersion: 1,
    });
  });

  it('requires ready requirements and a plan before the plan gate', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'plan', 'a', 'feature'], { json: true }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));

    const missingRequirements = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '3' }),
    );
    expect(missingRequirements.code).toBe(EXIT_INVALID_ARG);
    expect(missingRequirements.stderr.join('\n')).toContain(
      'requirements must be ready',
    );

    const requirementsInput = await writeRequirementsInput(dir, meta.taskId);
    const finalized = await captureLog(() =>
      workflow(dir, 'requirements', [meta.taskId, 'finalize'], {
        file: requirementsInput,
      }),
    );
    expect(finalized.code).toBe(EXIT_OK);
    const ready = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '3',
      }),
    );
    expect(ready.code).toBe(EXIT_OK);

    const missingPlan = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '4' }),
    );
    expect(missingPlan.code).toBe(EXIT_INVALID_ARG);
    expect(missingPlan.stderr.join('\n')).toContain('plan.md is required');
  });

  it('hands a confirmed plan to solo without abandoning the workflow', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'build', 'a', 'prototype'], {
        json: true,
      }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await preparePlanGate(dir, meta.taskId);
    const statePath = path.join(dir, '.mancode', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          currentMode: 'man',
          currentTask: meta.taskId,
          currentWorkflowMode: 'man',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const handedOff = await captureLog(() =>
      workflow(dir, 'handoff', [meta.taskId], { to: 'solo', json: true }),
    );
    const nextState = JSON.parse(await readFile(statePath, 'utf-8'));

    expect(handedOff.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'planned',
      planDecision: 'solo_handoff',
      currentStep: 4,
    });
    expect(nextState).toMatchObject({
      currentMode: 'solo',
      currentTask: null,
      currentWorkflowMode: null,
      activeSoloPlan: { taskId: meta.taskId, planVersion: 1 },
    });
  });

  it('completes a solo handoff and removes it from Active Plans', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'deliver', 'a', 'prototype'], {
        json: true,
      }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await preparePlanGate(dir, meta.taskId);
    await pointStateAtWorkflow(dir, meta.taskId);
    expect(
      (
        await captureLog(() =>
          workflow(dir, 'handoff', [meta.taskId], {
            to: 'solo',
            json: true,
          }),
        )
      ).code,
    ).toBe(EXIT_OK);

    const completed = await captureLog(() =>
      workflow(dir, 'handoff', [meta.taskId], {
        complete: true,
        json: true,
      }),
    );
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );
    const spec = await readFile(
      path.join(dir, '.mancode', 'memory', 'spec.md'),
      'utf-8',
    );

    expect(completed.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'completed',
      currentStep: 4,
      planDecision: 'solo_handoff',
    });
    expect(state.activeSoloPlan).toBeNull();
    expect(spec).not.toContain(meta.taskId);
  });

  it('refuses to overwrite another active solo plan', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'replacement', 'plan'], { json: true }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await preparePlanGate(dir, meta.taskId);
    await pointStateAtWorkflow(dir, meta.taskId, {
      taskId: '20260713-030000-existing-plan',
      planVersion: 3,
    });

    const handedOff = await captureLog(() =>
      workflow(dir, 'handoff', [meta.taskId], { to: 'solo' }),
    );
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );

    expect(handedOff.code).toBe(EXIT_INVALID_ARG);
    expect(handedOff.stderr.join('\n')).toContain(
      'another solo plan is active',
    );
    expect(state.activeSoloPlan.taskId).toBe('20260713-030000-existing-plan');
    const unchanged = await readWorkflow(dir, meta.taskId);
    expect(unchanged?.status).toBe('in_progress');
    expect(unchanged?.planDecision).toBeUndefined();
  });

  it('applies the plan-only decision and returns state to solo together', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'plan', 'only'], { json: true }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await preparePlanGate(dir, meta.taskId);
    await pointStateAtWorkflow(dir, meta.taskId);

    const decided = await captureLog(() =>
      workflow(dir, 'decide', [meta.taskId], {
        planDecision: 'plan_only',
        json: true,
      }),
    );
    const state = JSON.parse(
      await readFile(path.join(dir, '.mancode', 'state.json'), 'utf-8'),
    );

    expect(decided.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'planned',
      planDecision: 'plan_only',
      currentStep: 4,
    });
    expect(state).toMatchObject({
      currentMode: 'solo',
      currentTask: null,
      currentWorkflowMode: null,
      activeSoloPlan: null,
    });
  });

  it('keeps blocking requirements at step 2', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'clarify', 'scope'], { json: true }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    const input = await writeRequirementsInput(dir, meta.taskId, {
      blockingUnknowns: ['Choose the deployment target'],
    });

    const finalized = await captureLog(() =>
      workflow(dir, 'requirements', [meta.taskId, 'finalize'], {
        file: input,
        json: true,
      }),
    );
    const advanced = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '3' }),
    );

    expect(finalized.code).toBe(EXIT_OK);
    expect(JSON.parse(finalized.stdout.join('\n')).requirementsStatus).toBe(
      'needs_clarification',
    );
    expect(advanced.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
      requirementsStatus: 'needs_clarification',
    });
  });

  it('blocks review and later steps until required verification passes', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'verify', 'behavior'], { json: true }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await prepareGovernedWorkflow(dir, meta.taskId, 6);

    const initialized = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'init'], { json: true }),
    );
    const earlyStep = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '7' }),
    );
    const earlyReview = await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'init'], {
        reviewDepth: 'targeted',
        reviewDomain: 'quality',
      }),
    );
    const recorded = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'record'], {
        acceptance: 'AC-1',
        method: 'automated',
        result: 'passed',
        evidence: 'npm test exited 0',
        command: 'npm test',
        exitCode: '0',
        json: true,
      }),
    );
    const advanced = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '7' }),
    );

    expect(initialized.code).toBe(EXIT_OK);
    expect(earlyStep.code).toBe(EXIT_INVALID_ARG);
    expect(earlyReview.code).toBe(EXIT_INVALID_ARG);
    expect(recorded.code).toBe(EXIT_OK);
    expect(JSON.parse(recorded.stdout.join('\n')).status).toBe('passed');
    expect(advanced.code).toBe(EXIT_OK);
  });

  it('requires explicit manual confirmation and guards the unblock path', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'verify', 'pointer', 'lock'], {
        json: true,
      }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await prepareGovernedWorkflow(dir, meta.taskId, 6, {
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Pointer lock movement works in a foreground browser',
          required: true,
          method: 'manual',
        },
      ],
    });
    await captureLog(() => workflow(dir, 'verify', [meta.taskId, 'init']));

    const required = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'require-manual'], {
        acceptance: 'AC-1',
        evidence: 'Automation cannot acquire Pointer Lock',
      }),
    );
    expect(required.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'blocked',
      verificationStatus: 'manual_required',
    });
    const bypass = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { status: 'in_progress' }),
    );
    const confirmed = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'confirm-manual'], {
        acceptance: 'AC-1',
        evidence: '用户回复：移动、视角、破坏和放置均正常',
        json: true,
      }),
    );

    expect(bypass.code).toBe(EXIT_INVALID_ARG);
    expect(confirmed.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'in_progress',
      currentStep: 6,
      verificationStatus: 'passed',
    });
  });

  it('rejects legacy step names in policy-v2 skipped steps', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'strict', 'review'], { json: true }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));

    const numeric = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { skipped: '8' }),
    );
    const film = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { skipped: 'film-2' }),
    );
    const allowed = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { skipped: 'clarification' }),
    );
    const earlyReview = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { skipped: 'review' }),
    );

    expect(numeric.code).toBe(EXIT_INVALID_ARG);
    expect(film.code).toBe(EXIT_INVALID_ARG);
    expect(allowed.code).toBe(EXIT_OK);
    expect(earlyReview.code).toBe(EXIT_INVALID_ARG);
  });

  it('requires structured automated verification evidence', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'structured', 'evidence'], {
        json: true,
      }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await prepareGovernedWorkflow(dir, meta.taskId, 6);
    await captureLog(() => workflow(dir, 'verify', [meta.taskId, 'init']));

    const missingCommand = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'record'], {
        acceptance: 'AC-1',
        method: 'automated',
        result: 'passed',
        evidence: 'ok',
      }),
    );
    const wrongExit = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'record'], {
        acceptance: 'AC-1',
        method: 'automated',
        result: 'passed',
        evidence: 'command failed',
        command: 'npm test',
        exitCode: '1',
      }),
    );

    expect(missingCommand.code).toBe(EXIT_INVALID_ARG);
    expect(wrongExit.code).toBe(EXIT_INVALID_ARG);
  });

  it('invalidates pre-remediation evidence and permits Step 9 re-verification', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'remediate', 'and', 'reverify'], {
        json: true,
      }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await prepareGovernedWorkflow(dir, meta.taskId, 6);
    await captureLog(() => workflow(dir, 'verify', [meta.taskId, 'init']));
    await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'record'], {
        acceptance: 'AC-1',
        method: 'automated',
        result: 'passed',
        evidence: 'initial test passed',
        command: 'npm test',
        exitCode: '0',
      }),
    );
    await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'init'], {
        reviewDepth: 'targeted',
        reviewDomain: 'quality',
      }),
    );
    await writeWorkflowArtifact(
      dir,
      meta.taskId,
      'film-report-1.md',
      '# Review\n',
    );
    await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'complete'], {
        reviewDomain: 'quality',
        report: 'film-report-1.md',
        blockers: 'Q1',
      }),
    );
    await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '9' }),
    );
    await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'remediate'], {
        resolved: 'Q1',
      }),
    );
    await writeWorkflowArtifact(dir, meta.taskId, 'summary.md', '# Summary\n');

    const stale = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { status: 'completed' }),
    );
    const refreshed = await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'record'], {
        acceptance: 'AC-1',
        method: 'automated',
        result: 'passed',
        evidence: 'post-remediation test passed',
        command: 'npm test',
        exitCode: '0',
        json: true,
      }),
    );
    const completed = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { status: 'completed' }),
    );

    expect(stale.code).toBe(EXIT_INVALID_ARG);
    expect(stale.stderr.join('\n')).toContain('verification');
    expect(refreshed.code).toBe(EXIT_OK);
    expect(JSON.parse(refreshed.stdout.join('\n')).remediationRound).toBe(1);
    expect(completed.code).toBe(EXIT_OK);
  });

  it('requires summary.md even when the user explicitly skips review', async () => {
    const created = await captureLog(() =>
      workflow(dir, 'create', ['man', 'finish', 'verified', 'work'], {
        json: true,
      }),
    );
    const meta = JSON.parse(created.stdout.join('\n'));
    await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { skipped: 'clarification' }),
    );
    await prepareGovernedWorkflow(dir, meta.taskId, 6);
    await captureLog(() => workflow(dir, 'verify', [meta.taskId, 'init']));
    await captureLog(() =>
      workflow(dir, 'verify', [meta.taskId, 'record'], {
        acceptance: 'AC-1',
        method: 'automated',
        result: 'passed',
        evidence: 'npm test exited 0',
        command: 'npm test',
        exitCode: '0',
      }),
    );
    await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'skip'], {
        reason: '用户明确要求跳过独立审查',
      }),
    );
    await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '9',
      }),
    );

    const missingSummary = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { status: 'completed' }),
    );
    await writeWorkflowArtifact(dir, meta.taskId, 'summary.md', '# Summary\n');
    const completed = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { status: 'completed' }),
    );

    expect(missingSummary.code).toBe(EXIT_INVALID_ARG);
    expect(missingSummary.stderr.join('\n')).toContain('summary.md');
    expect(completed.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      skippedSteps: ['clarification', 'review'],
    });
  });

  it('workflow update updates metadata through the command path', async () => {
    const meta = await createWorkflow(dir, 'fix login bug', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '9',
        status: 'completed',
        skipped: 'film-1,film-2',
        json: true,
      }),
    );
    const updated = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(updated.currentStep).toBe(9);
    expect(updated.status).toBe('completed');
    expect(updated.skippedSteps).toEqual(['film-1', 'film-2']);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 9,
      status: 'completed',
      skippedSteps: ['film-1', 'film-2'],
    });
  });

  it('workflow review enforces a bounded targeted review', async () => {
    const meta = await createWorkflow(dir, 'review login change', 'man');
    await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '6' }),
    );

    const initialized = await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'init'], {
        reviewDepth: 'targeted',
        reviewDomain: 'quality',
        json: true,
      }),
    );
    expect(initialized.code).toBe(EXIT_OK);

    await writeFile(
      path.join(dir, '.mancode', 'workflows', meta.taskId, 'film-report-1.md'),
      '# Film report\n',
      'utf-8',
    );

    const completed = await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'complete'], {
        reviewDomain: 'quality',
        report: 'film-report-1.md',
        blockers: '',
        json: true,
      }),
    );
    expect(completed.code).toBe(EXIT_OK);

    const finished = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '9',
        status: 'completed',
      }),
    );
    expect(finished.code).toBe(EXIT_OK);
  });

  it('workflow completion rejects an unfinished governed review', async () => {
    const meta = await createWorkflow(dir, 'review checkout change', 'man');
    await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '6' }),
    );
    await captureLog(() =>
      workflow(dir, 'review', [meta.taskId, 'init'], {
        reviewDepth: 'full',
      }),
    );

    const finished = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '9',
        status: 'completed',
      }),
    );
    expect(finished.code).toBe(EXIT_INVALID_ARG);
    expect(finished.stderr.join('\n')).toContain('review is incomplete');
  });

  it('workflow update rejects steps beyond the workflow mode max', async () => {
    const meta = await createWorkflow(dir, 'plan only', 'mamba');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '8' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('invalid --step: 8');
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
    });
  });

  it('workflow update rejects partially numeric steps', async () => {
    const meta = await createWorkflow(dir, 'invalid step', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { step: '2garbage' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
    });
  });

  it('workflow create reports the original invalid mode', async () => {
    const logs = await captureLog(() =>
      workflow(dir, 'create', ['unknown-mode', 'task']),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain(
      'invalid workflow mode: unknown-mode',
    );
    expect(logs.stderr.join('\n')).toContain('<man|manba|manteam>');
  });

  it('workflow update rejects a blocking reason for a non-blocked status', async () => {
    const meta = await createWorkflow(dir, 'invalid blocking reason', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        status: 'completed',
        blockingReason: 'should not be ignored',
      }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      status: 'in_progress',
    });
  });

  it('workflow update increments plan versions exactly once', async () => {
    const meta = await createWorkflow(dir, 'revise plan', 'man');

    const updated = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], {
        step: '4',
        planVersion: '2',
        json: true,
      }),
    );
    const skipped = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { planVersion: '4' }),
    );

    expect(updated.code).toBe(EXIT_OK);
    expect(skipped.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      planVersion: 2,
    });
  });

  it('workflow update rejects plan revisions before the step 4 gate', async () => {
    const meta = await createWorkflow(dir, 'premature revision', 'man');

    const logs = await captureLog(() =>
      workflow(dir, 'update', [meta.taskId], { planVersion: '2' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    await expect(readWorkflow(dir, meta.taskId)).resolves.toMatchObject({
      currentStep: 1,
      planVersion: 1,
    });
  });

  it('workflow show and update reject invalid task ids', async () => {
    const showLogs = await captureLog(() =>
      workflow(dir, 'show', ['../../outside']),
    );
    const updateLogs = await captureLog(() =>
      workflow(dir, 'update', ['../../outside'], { step: '2' }),
    );

    expect(showLogs.code).toBe(EXIT_INVALID_ARG);
    expect(showLogs.stderr.join('\n')).toContain('invalid taskId');
    expect(updateLogs.code).toBe(EXIT_INVALID_ARG);
    expect(updateLogs.stderr.join('\n')).toContain('invalid taskId');
  });

  it('adds Active Plans only after the plan reaches the step 4 gate', async () => {
    const meta = await createWorkflow(dir, 'plan timing', 'man');
    await workflow(dir, 'update', [meta.taskId], { step: '3' });

    const before = await readFile(
      path.join(dir, '.mancode', 'memory', 'spec.md'),
      'utf-8',
    );
    expect(before).not.toContain(meta.taskId);

    await workflow(dir, 'update', [meta.taskId], { step: '4' });
    const after = await readFile(
      path.join(dir, '.mancode', 'memory', 'spec.md'),
      'utf-8',
    );
    expect(after).toContain(meta.taskId);
  });

  it('workflow list shows created workflow', async () => {
    const meta = await createWorkflow(dir, 'add oauth login', 'man');

    const logs = await captureLog(() => workflow(dir, 'list'));

    expect(logs.code).toBe(EXIT_OK);
    const output = logs.stdout.join('\n');
    expect(output).toContain('mancode workflows');
    expect(output).toContain(meta.taskId);
    expect(output).toContain('man');
    expect(output).toContain('in_progress');
    expect(output).toContain('Step 1/9');
    expect(output).toContain('plan=v1');
  });

  it('workflow show displays metadata for existing workflow', async () => {
    const meta = await createWorkflow(dir, 'fix login bug', 'mamba');

    const logs = await captureLog(() => workflow(dir, 'show', [meta.taskId]));

    expect(logs.code).toBe(EXIT_OK);
    const output = logs.stdout.join('\n');
    expect(output).toContain(`Workflow:    ${meta.taskId}`);
    expect(output).toContain('Task:        fix login bug');
    expect(output).toContain('Mode:        manba');
  });

  it('workflow show displays the current plan version for governed workflows', async () => {
    const meta = await createWorkflow(dir, 'plan visibility', 'man');

    const logs = await captureLog(() => workflow(dir, 'show', [meta.taskId]));

    expect(logs.code).toBe(EXIT_OK);
    expect(logs.stdout.join('\n')).toContain('Plan version: 1');
  });

  it('workflow show --json includes active child workflows', async () => {
    const parent = await createWorkflow(dir, 'parent task', 'man');
    await workflow(dir, 'update', [parent.taskId], { step: '6' });
    const child = await createWorkflow(dir, 'child task', 'mamba', {
      parentTaskId: parent.taskId,
    });

    const logs = await captureLog(() =>
      workflow(dir, 'show', [parent.taskId], { json: true }),
    );
    const shown = JSON.parse(logs.stdout.join('\n'));

    expect(shown.activeChildren).toHaveLength(1);
    expect(shown.activeChildren[0].taskId).toBe(child.taskId);
  });

  it('creates and completes linked manba workflows through the CLI contract', async () => {
    const parentLogs = await captureLog(() =>
      workflow(dir, 'create', ['man', 'parent', 'implementation'], {
        json: true,
      }),
    );
    const parent = JSON.parse(parentLogs.stdout.join('\n'));
    await prepareGovernedWorkflow(dir, parent.taskId, 6);

    const childLogs = await captureLog(() =>
      workflow(dir, 'create', ['manba', 'verify', 'regression'], {
        parentTask: parent.taskId,
        json: true,
      }),
    );
    const child = JSON.parse(childLogs.stdout.join('\n'));
    const completedLogs = await captureLog(() =>
      workflow(dir, 'update', [child.taskId], {
        step: '5',
        status: 'completed',
        outcome: 'verified',
        json: true,
      }),
    );
    const completed = JSON.parse(completedLogs.stdout.join('\n'));

    expect(childLogs.code).toBe(EXIT_OK);
    expect(child.mode).toBe('mamba');
    expect(child.parentTaskId).toBe(parent.taskId);
    expect(completedLogs.code).toBe(EXIT_OK);
    expect(completed).toMatchObject({
      status: 'completed',
      outcome: 'verified',
      currentStep: 5,
    });
  });

  it('accepts every documented standalone manba outcome through the CLI', async () => {
    for (const outcome of [
      'fixed',
      'verified',
      'no_repro',
      'manual_test_required',
    ]) {
      const createdLogs = await captureLog(() =>
        workflow(dir, 'create', ['manba', `outcome-${outcome}`], {
          json: true,
        }),
      );
      const created = JSON.parse(createdLogs.stdout.join('\n'));
      const updatedLogs = await captureLog(() =>
        workflow(dir, 'update', [created.taskId], {
          step: '5',
          status: 'completed',
          outcome,
          json: true,
        }),
      );
      const updated = JSON.parse(updatedLogs.stdout.join('\n'));

      expect(updatedLogs.code).toBe(EXIT_OK);
      expect(updated.outcome).toBe(outcome);
    }
  });

  it('accepts the legacy mamba spelling without exposing it in text output', async () => {
    const createdLogs = await captureLog(() =>
      workflow(dir, 'create', ['mamba', 'legacy', 'spelling'], { json: true }),
    );
    const created = JSON.parse(createdLogs.stdout.join('\n'));

    const shownLogs = await captureLog(() =>
      workflow(dir, 'show', [created.taskId]),
    );

    expect(createdLogs.code).toBe(EXIT_OK);
    expect(created.mode).toBe('mamba');
    expect(shownLogs.stdout.join('\n')).toContain('Mode:        manba');
    expect(shownLogs.stdout.join('\n')).not.toContain('Mode:        mamba');
  });

  it('propagates a CLI-blocked manba child to its parent', async () => {
    const parent = await createWorkflow(dir, 'parent for blocked child', 'man');
    await captureLog(() =>
      workflow(dir, 'update', [parent.taskId], { step: '6' }),
    );
    const childLogs = await captureLog(() =>
      workflow(dir, 'create', ['manba', 'blocked-child'], {
        parentTask: parent.taskId,
        json: true,
      }),
    );
    const child = JSON.parse(childLogs.stdout.join('\n'));

    const blockedLogs = await captureLog(() =>
      workflow(dir, 'update', [child.taskId], {
        status: 'blocked',
        blockingReason: 'missing test account',
      }),
    );

    expect(blockedLogs.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, parent.taskId)).resolves.toMatchObject({
      status: 'blocked',
      blockingReason: expect.stringContaining(child.taskId),
    });
  });

  it('workflow show returns invalid arg for missing workflow', async () => {
    const logs = await captureLog(() => workflow(dir, 'show', ['nope']));

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('Workflow not found');
  });

  it('workflow clean --dry-run does not delete files', async () => {
    const meta = await createWorkflow(dir, 'temp cleanup task', 'man');
    await rewriteMetadata(dir, { ...meta, status: 'completed' });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { dryRun: true }),
    );

    expect(logs.code).toBe(EXIT_OK);
    expect(logs.stdout.join('\n')).toContain('Would remove 1 workflow');
    expect(await readWorkflow(dir, meta.taskId)).not.toBeNull();
  });

  it('workflow clean --older-than 30d only deletes old workflows', async () => {
    const oldMeta = await createWorkflow(dir, 'old task', 'man');
    const recentMeta = await createWorkflow(dir, 'recent task', 'man');
    await rewriteMetadata(dir, {
      ...oldMeta,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await rewriteMetadata(dir, { ...recentMeta, status: 'completed' });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { olderThan: '30d' }),
    );

    expect(logs.code).toBe(EXIT_OK);
    expect(await readWorkflow(dir, oldMeta.taskId)).toBeNull();
    expect(await readWorkflow(dir, recentMeta.taskId)).not.toBeNull();
  });

  it('workflow clean preserves planned and blocked workflows', async () => {
    const planned = await createWorkflow(dir, 'saved plan', 'man');
    await workflow(dir, 'update', [planned.taskId], {
      step: '4',
      status: 'planned',
    });
    const blocked = await createWorkflow(dir, 'blocked diagnosis', 'mamba');
    await workflow(dir, 'update', [blocked.taskId], {
      status: 'blocked',
      blockingReason: 'missing environment',
    });

    const logs = await captureLog(() => workflow(dir, 'clean'));

    expect(logs.code).toBe(EXIT_OK);
    await expect(readWorkflow(dir, planned.taskId)).resolves.not.toBeNull();
    await expect(readWorkflow(dir, blocked.taskId)).resolves.not.toBeNull();
  });

  it('workflow clean reports only workflows it actually removes', async () => {
    const parent = await createWorkflow(
      dir,
      'corrupted terminal parent',
      'man',
    );
    await workflow(dir, 'update', [parent.taskId], { step: '6' });
    await createWorkflow(dir, 'active child', 'mamba', {
      parentTaskId: parent.taskId,
    });
    await rewriteMetadata(dir, {
      ...parent,
      currentStep: 6,
      status: 'completed',
    });

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { json: true }),
    );
    const result = JSON.parse(logs.stdout.join('\n'));

    expect(result.count).toBe(0);
    expect(result.workflows).toEqual([]);
    await expect(readWorkflow(dir, parent.taskId)).resolves.not.toBeNull();
  });

  it('workflow clean does not orphan a newer terminal child', async () => {
    const parent = await createWorkflow(dir, 'old completed parent', 'man');
    await workflow(dir, 'update', [parent.taskId], { step: '6' });
    const child = await createWorkflow(dir, 'recent completed child', 'mamba', {
      parentTaskId: parent.taskId,
    });
    await rewriteMetadata(dir, {
      ...parent,
      currentStep: 9,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await rewriteMetadata(dir, {
      ...child,
      currentStep: 5,
      status: 'completed',
      outcome: 'verified',
    });

    const dryRunLogs = await captureLog(() =>
      workflow(dir, 'clean', [], {
        olderThan: '30d',
        dryRun: true,
        json: true,
      }),
    );
    const dryRunResult = JSON.parse(dryRunLogs.stdout.join('\n'));
    expect(dryRunResult.count).toBe(0);
    expect(dryRunResult.workflows).toEqual([]);

    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { olderThan: '30d', json: true }),
    );
    const result = JSON.parse(logs.stdout.join('\n'));

    expect(result.count).toBe(0);
    await expect(readWorkflow(dir, parent.taskId)).resolves.not.toBeNull();
    await expect(readWorkflow(dir, child.taskId)).resolves.not.toBeNull();
  });

  it('workflow list --json outputs valid JSON', async () => {
    const meta = await createWorkflow(dir, 'json task', 'mamba');

    const logs = await captureLog(() =>
      workflow(dir, 'list', [], { json: true }),
    );
    const parsed = JSON.parse(logs.stdout.join('\n'));

    expect(logs.code).toBe(EXIT_OK);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].taskId).toBe(meta.taskId);
    expect(parsed[0].mode).toBe('mamba');
  });

  it('workflow clean rejects invalid --older-than duration', async () => {
    const logs = await captureLog(() =>
      workflow(dir, 'clean', [], { olderThan: 'forever' }),
    );

    expect(logs.code).toBe(EXIT_INVALID_ARG);
    expect(logs.stderr.join('\n')).toContain('Invalid --older-than');
  });
});

async function silentInit(dir: string): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await init(dir);
    if (code !== 0) throw new Error(`silentInit failed: ${code}`);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function preparePlanGate(
  dir: string,
  taskId: string,
  requirementsOverrides: Record<string, unknown> = {},
): Promise<void> {
  const requirementsInput = await writeRequirementsInput(
    dir,
    taskId,
    requirementsOverrides,
  );
  await workflow(dir, 'requirements', [taskId, 'finalize'], {
    file: requirementsInput,
  });
  await workflow(dir, 'update', [taskId], {
    step: '3',
  });
  await writeWorkflowArtifact(dir, taskId, 'plan.md', '# Plan\n');
  await workflow(dir, 'update', [taskId], { step: '4' });
}

async function writeRequirementsInput(
  dir: string,
  taskId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const inputPath = path.join(dir, `${taskId}-requirements-input.json`);
  await writeFile(
    inputPath,
    `${JSON.stringify(
      {
        version: 1,
        goal: 'Deliver the confirmed change',
        confirmedScope: ['Implement the requested behavior'],
        excludedScope: [],
        technicalDecisions: ['Follow the existing project stack'],
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
          dimension,
          status: 'confirmed',
          rationale: `${dimension} was explicitly considered`,
        })),
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'The requested behavior works',
            required: true,
            method: 'automated',
          },
        ],
        ...overrides,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return inputPath;
}

async function pointStateAtWorkflow(
  dir: string,
  taskId: string,
  activeSoloPlan: { taskId: string; planVersion: number } | null = null,
): Promise<void> {
  const statePath = path.join(dir, '.mancode', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf-8'));
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        ...state,
        currentMode: 'man',
        currentTask: taskId,
        currentWorkflowMode: 'man',
        activeSoloPlan,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

async function prepareGovernedWorkflow(
  dir: string,
  taskId: string,
  step: number,
  requirementsOverrides: Record<string, unknown> = {},
): Promise<void> {
  await preparePlanGate(dir, taskId, requirementsOverrides);
  await workflow(dir, 'decide', [taskId], {
    planDecision: 'governed_execution',
  });
  await workflow(dir, 'update', [taskId], { step: String(step) });
}

async function writeWorkflowArtifact(
  dir: string,
  taskId: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(
    path.join(dir, '.mancode', 'workflows', taskId, filename),
    content,
    'utf-8',
  );
}

async function rewriteMetadata(
  dir: string,
  meta: Awaited<ReturnType<typeof createWorkflow>>,
): Promise<void> {
  await writeFile(
    path.join(dir, '.mancode', 'workflows', meta.taskId, 'metadata.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf-8',
  );
}

async function captureLog(
  fn: () => Promise<number>,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
