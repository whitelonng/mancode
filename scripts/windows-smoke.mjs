import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const root = await mkdtemp(path.join(tmpdir(), 'mancode-windows-smoke-'));
const noToolPath = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
);
noToolPath.PATH = '';

try {
  const emptyProject = path.join(root, 'empty-project');
  await mkdir(emptyProject, { recursive: true });
  runCli(emptyProject, [
    'init',
    '--empty',
    '--platform',
    'codex,cursor',
    '--lang',
    'en',
  ]);
  const emptyConfig = await readJson(
    path.join(emptyProject, '.mancode', 'config.json'),
  );
  assert(
    JSON.stringify(emptyConfig.platforms) ===
      JSON.stringify(['codex', 'cursor']),
    'empty multi-platform init did not preserve adapter selection',
  );
  await readFile(path.join(emptyProject, 'AGENTS.md'), 'utf8');
  await readFile(
    path.join(emptyProject, '.cursor', 'rules', 'mancode-solo.mdc'),
    'utf8',
  );
  await writeFile(
    path.join(emptyProject, 'package.json'),
    `${JSON.stringify({ name: 'empty-project', dependencies: { react: 'latest' } })}\n`,
    'utf8',
  );
  runCli(emptyProject, ['refresh-project']);
  const refreshedAgents = await readFile(
    path.join(emptyProject, 'AGENTS.md'),
    'utf8',
  );
  assert(
    refreshedAgents.includes('React'),
    'refresh-project did not regenerate static adapter context',
  );

  if (process.platform === 'win32') {
    const systemLocale = readWindowsUiCulture();
    const normalizedSystemLocale = systemLocale.toLowerCase().replace('_', '-');
    const isChinese =
      normalizedSystemLocale === 'zh' || normalizedSystemLocale.startsWith('zh-');
    const isEnglish =
      normalizedSystemLocale === 'en' || normalizedSystemLocale.startsWith('en-');
    if (isChinese || isEnglish) {
      const opposingLocale = isChinese ? 'en_US.UTF-8' : 'zh_CN.UTF-8';
      const localeProject = await createProject('locale-project');
      const localeResult = runCli(
        localeProject,
        ['init', '--platform', 'codex'],
        {
          ...process.env,
          LANGUAGE: opposingLocale,
          LC_ALL: opposingLocale,
          LC_MESSAGES: opposingLocale,
          LANG: opposingLocale,
        },
      );
      assert(
        localeResult.stdout.includes(
          isChinese ? '检测系统依赖' : 'Checking system dependencies',
        ),
        `init did not prefer Windows UI culture ${systemLocale}: ${localeResult.stdout}`,
      );
    } else {
      console.log(
        `Skipping locale priority assertion for unsupported Windows UI culture ${systemLocale}.`,
      );
    }
  }

  const codexProject = await createProject('codex-project');
  runCli(codexProject, ['init', '--platform', 'codex']);
  const codexState = await readJson(
    path.join(codexProject, '.mancode', 'state.json'),
  );
  assert(codexState.platform === 'codex', 'Codex init did not complete');
  assert(
    codexState.teamModeAutoDetected === false,
    'missing Git did not degrade to solo mode',
  );
  await readFile(path.join(codexProject, 'AGENTS.md'), 'utf8');

  const claudeProject = await createProject('claude-project');
  runCli(claudeProject, ['init', '--platform', 'claude-code']);
  const settings = await readJson(
    path.join(claudeProject, '.claude', 'settings.json'),
  );
  const commands = Object.values(settings.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
  assert(commands.every((command) => command.startsWith('node ')));
  assert(commands.every((command) => !command.includes('bash')));

  runHook(claudeProject, 'session-start.mjs');
  runHook(
    claudeProject,
    'user-prompt-submit.mjs',
    JSON.stringify({ prompt: 'update README' }),
  );

  await assertV3SessionEvidenceRenameUnderOpenWindowsHandle();

  console.log('Windows shell smoke passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createProject(name) {
  const project = path.join(root, name);
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0' })}\n`,
    'utf8',
  );
  return project;
}

function runCli(cwd, args, env = noToolPath) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
  assert(
    result.status === 0,
    `CLI failed (${result.status}): ${result.stderr || result.stdout}`,
  );
  return result;
}

function readWindowsUiCulture() {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Globalization.CultureInfo]::CurrentUICulture.Name',
    ],
    { encoding: 'utf8' },
  );
  assert(
    result.status === 0,
    `could not read Windows UI culture: ${result.stderr || result.stdout}`,
  );
  const locale = result.stdout.replace(/^\uFEFF/, '').trim();
  assert(locale, 'Windows UI culture was empty');
  return locale;
}

function runHook(cwd, fileName, input = '') {
  const hookPath = path.join(cwd, '.mancode', 'hooks', fileName);
  const result = spawnSync(process.execPath, [hookPath], {
    cwd,
    encoding: 'utf8',
    env: noToolPath,
    input,
  });
  assert(
    result.status === 0,
    `hook failed (${result.status}): ${result.stderr || result.stdout}`,
  );
}

async function assertV3SessionEvidenceRenameUnderOpenWindowsHandle() {
  if (process.platform !== 'win32') {
    console.log('Skipping Windows open-file rename assertion outside Windows.');
    return;
  }
  const project = await createProject('v3-open-file-rename-project');
  const spikeEnv = {
    ...noToolPath,
    MANCODE_SPIKE_HOST_SESSION_KEY: 'windows-smoke-host-a',
    MANCODE_SPIKE_SECOND_WINDOW_HOST_SESSION_KEY: 'windows-smoke-host-b',
  };
  runCli(project, ['init', '--v3'], spikeEnv);
  const spikeArgs = [
    'context',
    'session',
    'spike',
    '--platform',
    'codex',
    '--host-session-source',
    'api',
  ];
  runCli(project, spikeArgs, spikeEnv);
  const evidenceTarget = path.join(
    project,
    '.mancode',
    'local',
    'evidence',
    'platform-session',
    'codex.json',
  );
  await assertReplaceAfterOpenWindowsHandle(evidenceTarget, () =>
    runCli(project, spikeArgs, spikeEnv),
  );
  const evidence = await readFile(evidenceTarget, 'utf8');
  assert(
    evidence.includes('"platform": "codex"'),
    'V3 session evidence was not atomically replaced after the Windows handle closed',
  );

  runCli(project, ['team', 'identity', 'create', '--name', 'Windows Smoke']);
  const sessionResult = runCli(project, [
    'context',
    'session',
    'new',
    '--client',
    'windows-smoke',
  ]);
  const sessionId = JSON.parse(sessionResult.stdout).session.sessionId;
  const workflowResult = runCli(project, [
    'workflow',
    'create',
    'man',
    'Exercise a locked Windows session authority replacement.',
    '--session',
    sessionId,
    '--client',
    'windows-smoke',
  ]);
  const taskRef = JSON.parse(workflowResult.stdout).taskRef;
  const sessionTarget = path.join(
    project,
    '.mancode',
    'local',
    'sessions',
    `${sessionId}.json`,
  );
  await assertReplaceAfterOpenWindowsHandle(sessionTarget, () =>
    runCli(project, [
      'context',
      'resume',
      `${taskRef.namespace}:${taskRef.taskId}`,
      '--session',
      sessionId,
      '--client',
      'windows-smoke',
    ]),
  );
  const session = await readJson(sessionTarget);
  assert(
    session.activeTaskRef?.taskId === taskRef.taskId,
    'V3 session authority was not atomically replaced after the Windows handle closed',
  );
}

async function assertReplaceAfterOpenWindowsHandle(target, replace) {
  const lock = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$path = [Environment]::GetEnvironmentVariable("MANCODE_RENAME_TARGET"); $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); Write-Output "locked"; Start-Sleep -Milliseconds 500; $stream.Dispose()',
    ],
    {
      env: { ...process.env, MANCODE_RENAME_TARGET: target },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const lockExit = waitForExit(lock);
  try {
    await waitForLock(lock);
    replace();
  } finally {
    await lockExit;
  }
}

function waitForLock(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for Windows file lock: ${stderr}`));
    }, 5_000);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('locked')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Windows file lock exited early (${code}): ${stderr}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows file lock failed with exit code ${code}`));
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}
