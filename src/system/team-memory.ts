import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TeamMemorySummary {
  dir: string;
  files: {
    prd: string;
    spec: string;
    decisions: string;
  };
}

const MEMORY_FILES = {
  prd: {
    filename: 'prd.md',
    title: 'Product Requirements',
    body: 'Capture shared product goals, user-facing constraints, and release scope here.',
  },
  spec: {
    filename: 'spec.md',
    title: 'Technical Spec',
    body: 'Capture architecture, module boundaries, API contracts, and migration notes here.',
  },
  decisions: {
    filename: 'decisions.md',
    title: 'Architecture Decisions',
    body: 'Record team decisions as dated ADR-style notes. Keep entries short and linked to tasks when possible.',
  },
} as const;

export async function ensureTeamMemory(
  projectRoot: string,
): Promise<TeamMemorySummary> {
  const dir = memoryDir(projectRoot);
  await mkdir(dir, { recursive: true });

  const files = {
    prd: path.join(dir, MEMORY_FILES.prd.filename),
    spec: path.join(dir, MEMORY_FILES.spec.filename),
    decisions: path.join(dir, MEMORY_FILES.decisions.filename),
  };

  await Promise.all([
    writeIfMissing(
      files.prd,
      renderMemoryFile(MEMORY_FILES.prd.title, MEMORY_FILES.prd.body),
    ),
    writeIfMissing(
      files.spec,
      renderMemoryFile(MEMORY_FILES.spec.title, MEMORY_FILES.spec.body),
    ),
    writeIfMissing(
      files.decisions,
      renderMemoryFile(
        MEMORY_FILES.decisions.title,
        MEMORY_FILES.decisions.body,
      ),
    ),
  ]);

  return { dir, files };
}

export async function appendTeamDecision(
  projectRoot: string,
  entry: {
    title: string;
    context?: string;
    decision: string;
    taskId?: string;
    date?: Date;
  },
): Promise<void> {
  const summary = await ensureTeamMemory(projectRoot);
  const date = (entry.date ?? new Date()).toISOString().slice(0, 10);
  const taskLine = entry.taskId ? `\n- Task: ${entry.taskId}` : '';
  const contextLine = entry.context ? `\n- Context: ${entry.context}` : '';
  const block = `\n## ${date}: ${entry.title}\n\n- Decision: ${entry.decision}${contextLine}${taskLine}\n`;
  await appendFile(summary.files.decisions, block, 'utf-8');
}

function memoryDir(projectRoot: string): string {
  return path.join(projectRoot, '.mancode', 'memory');
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  // Use O_CREAT | O_EXCL (flag 'wx') for atomic creation.
  // This eliminates the TOCTOU race: two concurrent callers could both see
  // the file as missing and both writeFile, with the later write clobbering
  // content already appended by the earlier caller. With 'wx', the OS
  // guarantees only one caller wins creation; the loser gets EEXIST and
  // safely skips.
  try {
    await writeFile(file, content, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function renderMemoryFile(title: string, body: string): string {
  return `# ${title}\n\n${body}\n`;
}
