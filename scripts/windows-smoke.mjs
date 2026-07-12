import { spawnSync } from 'node:child_process';
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

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: noToolPath,
  });
  assert(
    result.status === 0,
    `CLI failed (${result.status}): ${result.stderr || result.stdout}`,
  );
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}
