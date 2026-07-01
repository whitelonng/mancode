import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PreseasonSeverity = 'P0' | 'P1' | 'P2';
export type PreseasonIssueType =
  | 'scripts'
  | 'dependency'
  | 'todo'
  | 'tests'
  | 'config'
  | 'aesthetics'
  | 'security';

export interface PreseasonIssue {
  id: string;
  severity: PreseasonSeverity;
  type: PreseasonIssueType;
  title: string;
  file?: string;
  detail: string;
  recommendation: string;
}

export interface PreseasonReport {
  generatedAt: string;
  area: string;
  issues: PreseasonIssue[];
  commandsChecked: string[];
  reportPath: string;
  issueDbPath: string;
}

export type PreseasonIssueStatus = 'open' | 'not-found';
export type PreseasonRemediationStatus = 'accepted' | 'skipped';

export interface PreseasonRemediationState {
  status: PreseasonRemediationStatus;
  decidedAt: string;
  sourceRunId: string;
  response: 'y' | 'n' | 'skip';
}

export interface PreseasonIssueRecord extends PreseasonIssue {
  key: string;
  status: PreseasonIssueStatus;
  firstSeen: string;
  lastSeen: string;
  lastArea: string;
  occurrences: number;
  sourceReports: string[];
  remediation?: PreseasonRemediationState;
}

export interface PreseasonIssueRun {
  id: string;
  generatedAt: string;
  area: string;
  reportPath: string;
  issueCount: number;
  issueKeys: string[];
}

export interface PreseasonIssueDatabase {
  version: '1.0.0';
  updatedAt: string;
  latestRunId: string;
  runs: PreseasonIssueRun[];
  issues: PreseasonIssueRecord[];
}

export interface PreseasonRemediationOptions {
  answers?: string[];
  ask?: (question: string) => Promise<string>;
  write?: (message: string) => void;
  now?: string;
}

export interface PreseasonRemediationResult {
  issueDbPath: string;
  reviewed: number;
  accepted: number;
  skipped: number;
  shown: number;
}

type PreseasonArea = 'all' | 'deps' | 'security' | 'dead-code' | 'config';
export const PRESEASON_AREAS: PreseasonArea[] = [
  'all',
  'deps',
  'security',
  'dead-code',
  'config',
];

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const IGNORE_DIRS = new Set([
  '.git',
  '.mancode',
  '.claude',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.vue',
  '.svelte',
  '.css',
  '.md',
]);

export async function runPreseasonScan(
  projectRoot: string,
  area = 'all',
): Promise<PreseasonReport> {
  const generatedAt = new Date().toISOString();
  const normalizedArea = normalizeArea(area);
  const pkg = await readPackageJson(projectRoot);
  const needsFiles =
    normalizedArea === 'all' ||
    normalizedArea === 'dead-code' ||
    normalizedArea === 'config';
  const files = needsFiles ? await listProjectFiles(projectRoot) : [];
  const issues = scanArea(projectRoot, normalizedArea, pkg, files).slice(0, 20);

  const reportDir = path.join(projectRoot, '.mancode', 'preseason-reports');
  await mkdir(reportDir, { recursive: true });
  const issueDbPath = path.join(
    projectRoot,
    '.mancode',
    'preseason-issues.json',
  );
  const reportPath = await allocateReportPath(
    reportDir,
    `${generatedAt.replace(/[:.]/g, '-')}-${normalizedArea}`,
  );
  const report: PreseasonReport = {
    generatedAt,
    area: normalizedArea,
    issues,
    commandsChecked: inferCommands(pkg),
    reportPath,
    issueDbPath,
  };
  await writeFile(reportPath, renderPreseasonReport(report), 'utf-8');
  await writeFile(
    path.join(projectRoot, '.mancode', 'preseason-report.md'),
    renderPreseasonReport(report),
    'utf-8',
  );
  await writeIssueDatabase(projectRoot, report);
  return report;
}

export async function runPreseasonRemediation(
  projectRoot: string,
  issues: PreseasonIssue[],
  options: PreseasonRemediationOptions = {},
): Promise<PreseasonRemediationResult> {
  const issueDbPath = path.join(
    projectRoot,
    '.mancode',
    'preseason-issues.json',
  );
  const database = await readIssueDatabase(issueDbPath);
  const keys = new Set(issues.map((issue) => issueKey(issue)));
  const targets = database.issues.filter(
    (issue) => keys.has(issue.key) && issue.status === 'open',
  );
  const write = options.write ?? ((message: string) => console.log(message));
  const answerQueue = [...(options.answers ?? [])];
  const now = options.now ?? new Date().toISOString();
  let reviewed = 0;
  let accepted = 0;
  let skipped = 0;
  let shown = 0;

  if (targets.length === 0) {
    write('No open preseason issues to review.');
  }

  for (let index = 0; index < targets.length; index++) {
    const issue = targets[index];
    write('');
    write(
      `${index + 1}. ${issue.severity} ${issue.id}: ${issue.title}${issue.file ? ` (${issue.file})` : ''}`,
    );
    write(`   Recommendation: ${issue.recommendation}`);

    while (true) {
      const raw = await nextRemediationAnswer(
        answerQueue,
        options.ask,
        '   Fix this item? [y/n/skip/show files] ',
      );
      const answer = normalizeRemediationAnswer(raw);

      if (answer === 'show') {
        shown++;
        write(`   File: ${issue.file ?? 'n/a'}`);
        write(`   Detail: ${issue.detail}`);
        continue;
      }

      if (answer === 'y') {
        issue.remediation = {
          status: 'accepted',
          decidedAt: now,
          sourceRunId: database.latestRunId,
          response: 'y',
        };
        accepted++;
        reviewed++;
        write('   Decision: accepted for remediation.');
        break;
      }

      issue.remediation = {
        status: 'skipped',
        decidedAt: now,
        sourceRunId: database.latestRunId,
        response: answer,
      };
      skipped++;
      reviewed++;
      write('   Decision: skipped.');
      break;
    }
  }

  database.updatedAt = now;
  await writeFile(
    issueDbPath,
    `${JSON.stringify(database, null, 2)}\n`,
    'utf-8',
  );

  return {
    issueDbPath,
    reviewed,
    accepted,
    skipped,
    shown,
  };
}

function normalizeArea(area: string): PreseasonArea {
  if (PRESEASON_AREAS.includes(area as PreseasonArea)) {
    return area as PreseasonArea;
  }
  throw new Error(
    `invalid area: ${area}. Supported areas: ${PRESEASON_AREAS.join(', ')}`,
  );
}

function scanArea(
  projectRoot: string,
  area: PreseasonArea,
  pkg: PackageJson | null,
  files: string[],
): PreseasonIssue[] {
  switch (area) {
    case 'deps':
      return scanDependencyOverlap(pkg);
    case 'security':
      return scanSecurity(pkg);
    case 'dead-code':
      return [...scanTodos(projectRoot, files), ...scanTestGaps(files)];
    case 'config':
      return [...scanScripts(pkg), ...scanConfig(projectRoot, files)];
    case 'all':
      return [
        ...scanScripts(pkg),
        ...scanDependencyOverlap(pkg),
        ...scanSecurity(pkg),
        ...scanTodos(projectRoot, files),
        ...scanTestGaps(files),
        ...scanConfig(projectRoot, files),
        ...scanAestheticDrift(projectRoot, files),
      ];
  }
}

async function allocateReportPath(
  reportDir: string,
  baseName: string,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = path.join(reportDir, `${baseName}${suffix}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`unable to allocate preseason report path: ${baseName}`);
}

export function renderPreseasonReport(report: PreseasonReport): string {
  const bySeverity = (severity: PreseasonSeverity) =>
    report.issues.filter((issue) => issue.severity === severity);

  return `# mancode preseason report

Generated: ${report.generatedAt}
Area: ${report.area}

## Summary

- Total issues: ${report.issues.length}
- P0: ${bySeverity('P0').length}
- P1: ${bySeverity('P1').length}
- P2: ${bySeverity('P2').length}

${renderSection('P0: Must Fix Before Shipping', bySeverity('P0'))}

${renderSection('P1: Should Fix Soon', bySeverity('P1'))}

${renderSection('P2: Cleanup Backlog', bySeverity('P2'))}

## Suggested Order

${report.issues.length === 0 ? '- No P0/P1 issues found. Keep normal validation in place.' : report.issues.map((issue, index) => `${index + 1}. ${issue.id}: ${issue.recommendation}`).join('\n')}

## Commands Checked

${report.commandsChecked.length === 0 ? '- No package scripts found.' : report.commandsChecked.map((cmd) => `- ${cmd}`).join('\n')}
`;
}

async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const results: string[] = [];
  await walk(projectRoot, projectRoot, results);
  return results.sort();
}

async function walk(
  root: string,
  current: string,
  results: string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const abs = path.join(current, entry);
    const rel = path.relative(root, abs);
    let info: Stats;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await walk(root, abs, results);
    } else if (
      SOURCE_EXTENSIONS.has(path.extname(entry)) ||
      entry === 'package.json'
    ) {
      results.push(rel);
    }
  }
}

async function readPackageJson(
  projectRoot: string,
): Promise<PackageJson | null> {
  try {
    const raw = await readFile(path.join(projectRoot, 'package.json'), 'utf-8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function scanScripts(pkg: PackageJson | null): PreseasonIssue[] {
  if (!pkg) {
    return [
      {
        id: 'config-001',
        severity: 'P1',
        type: 'config',
        title: 'package.json not found',
        file: 'package.json',
        detail:
          'No package.json was found, so mancode cannot infer validation commands.',
        recommendation:
          'Add package.json scripts or document validation commands in README.',
      },
    ];
  }

  const scripts = pkg.scripts ?? {};
  const issues: PreseasonIssue[] = [];
  for (const name of ['test', 'lint', 'build']) {
    if (!scripts[name]) {
      issues.push({
        id: `scripts-${name}`,
        severity: name === 'test' ? 'P1' : 'P2',
        type: 'scripts',
        title: `Missing npm ${name} script`,
        file: 'package.json',
        detail: `package.json has no "${name}" script.`,
        recommendation: `Add an npm "${name}" script or document why this project does not need one.`,
      });
    }
  }
  return issues;
}

function scanDependencyOverlap(pkg: PackageJson | null): PreseasonIssue[] {
  if (!pkg) return [];
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const pairs = [
    ['moment', 'dayjs'],
    ['lodash', 'underscore'],
    ['axios', 'ky'],
    ['jest', 'vitest'],
  ];
  return pairs
    .filter(([a, b]) => deps.has(a) && deps.has(b))
    .map(([a, b], index) => ({
      id: `dependency-${index + 1}`,
      severity: 'P2' as const,
      type: 'dependency' as const,
      title: `Overlapping dependencies: ${a} and ${b}`,
      file: 'package.json',
      detail: `Both ${a} and ${b} are installed. They may overlap in purpose.`,
      recommendation:
        'Choose one default for new code and plan removal if the other is unused.',
    }));
}

function scanSecurity(pkg: PackageJson | null): PreseasonIssue[] {
  if (!pkg) return [];
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const risky = [
    {
      name: 'serialize-javascript',
      detail:
        'Historically security-sensitive package. Version should be audited.',
    },
    {
      name: 'node-sass',
      detail:
        'Deprecated native dependency. Prefer sass unless the project is pinned intentionally.',
    },
    {
      name: 'request',
      detail:
        'Deprecated HTTP client. Prefer a maintained client for new code.',
    },
  ];
  return risky
    .filter((item) => deps.has(item.name))
    .map((item, index) => ({
      id: `security-${index + 1}`,
      severity: 'P1' as const,
      type: 'security' as const,
      title: `Security review needed: ${item.name}`,
      file: 'package.json',
      detail: item.detail,
      recommendation:
        'Run the project vulnerability scanner and plan replacement or pinning if needed.',
    }));
}

function scanTodos(projectRoot: string, files: string[]): PreseasonIssue[] {
  const matches: PreseasonIssue[] = [];
  for (const file of files) {
    if (matches.length >= 7) break;
    const abs = path.join(projectRoot, file);
    matches.push(...readTodoIssues(abs, file, matches.length));
  }
  return matches.slice(0, 7);
}

function readTodoIssues(
  abs: string,
  rel: string,
  offset: number,
): PreseasonIssue[] {
  try {
    const content = readFileSyncSafe(abs);
    const lines = content.split('\n');
    const issues: PreseasonIssue[] = [];
    for (let i = 0; i < lines.length && issues.length < 2; i++) {
      if (
        /\b(TODO|FIXME|HACK|XXX|deprecated|legacy|temporary|workaround)\b/i.test(
          lines[i] ?? '',
        )
      ) {
        issues.push({
          id: `todo-${offset + issues.length + 1}`,
          severity: 'P2',
          type: 'todo',
          title: 'Stale maintenance marker',
          file: `${rel}:${i + 1}`,
          detail: (lines[i] ?? '').trim().slice(0, 160),
          recommendation:
            'Turn this marker into a tracked issue, fix it, or remove it if stale.',
        });
      }
    }
    return issues;
  } catch {
    return [];
  }
}

function scanTestGaps(files: string[]): PreseasonIssue[] {
  const sourceFiles = files.filter(
    (file) =>
      file.startsWith('src/') &&
      /\.(ts|tsx|js|jsx)$/.test(file) &&
      !file.endsWith('.d.ts') &&
      !file.includes('/templates/'),
  );
  if (sourceFiles.length === 0) return [];

  const tests = new Set(files.filter((file) => file.startsWith('tests/')));
  const missing = sourceFiles
    .filter((file) => {
      const base = path.basename(file).replace(/\.(ts|tsx|js|jsx)$/, '');
      return !Array.from(tests).some((test) => test.includes(base));
    })
    .slice(0, 4);

  return missing.map((file, index) => ({
    id: `tests-${index + 1}`,
    severity: 'P1',
    type: 'tests',
    title: 'Core source file has no obvious test',
    file,
    detail: `No matching test file was found for ${path.basename(file)}.`,
    recommendation:
      'Add focused coverage for the public behavior or document why this module is exercised indirectly.',
  }));
}

function scanConfig(projectRoot: string, files: string[]): PreseasonIssue[] {
  const issues: PreseasonIssue[] = [];
  if (
    !files.includes('.gitignore') &&
    !pathExistsSync(path.join(projectRoot, '.gitignore'))
  ) {
    issues.push({
      id: 'config-gitignore',
      severity: 'P1',
      type: 'config',
      title: 'Missing .gitignore',
      file: '.gitignore',
      detail: 'No .gitignore found at the project root.',
      recommendation:
        'Add a .gitignore that excludes dependencies, build output, coverage, and local env files.',
    });
  }
  return issues;
}

function scanAestheticDrift(
  projectRoot: string,
  files: string[],
): PreseasonIssue[] {
  const issues: PreseasonIssue[] = [];
  const frontendFiles = files.filter((file) => /\.(tsx|jsx|css)$/.test(file));
  for (const file of frontendFiles) {
    const content = readFileSyncSafe(path.join(projectRoot, file));
    if (containsHardcodedColor(content)) {
      issues.push({
        id: 'aesthetics-hardcoded-color',
        severity: 'P2',
        type: 'aesthetics',
        title: 'Hardcoded color found',
        file,
        detail: 'A frontend file contains a raw hex color.',
        recommendation:
          'Use project design tokens or CSS variables instead of raw colors.',
      });
      break;
    }
  }
  return issues;
}

function containsHardcodedColor(content: string): boolean {
  return content
    .split('\n')
    .some(
      (line) =>
        /#[0-9a-fA-F]{3,8}\b/.test(line) &&
        !/^\s*--[a-zA-Z0-9-_]+\s*:/.test(line),
    );
}

function inferCommands(pkg: PackageJson | null): string[] {
  const scripts = pkg?.scripts ?? {};
  return ['lint', 'test', 'build']
    .filter((name) => scripts[name])
    .map((name) => `npm run ${name}`);
}

async function writeIssueDatabase(
  projectRoot: string,
  report: PreseasonReport,
): Promise<void> {
  const reportRef = path.relative(projectRoot, report.reportPath);
  const run: PreseasonIssueRun = {
    id: path.basename(report.reportPath, '.md'),
    generatedAt: report.generatedAt,
    area: report.area,
    reportPath: reportRef,
    issueCount: report.issues.length,
    issueKeys: report.issues.map((issue) => issueKey(issue)),
  };
  const existing = await readIssueDatabase(report.issueDbPath);
  const currentKeys = new Set(run.issueKeys);
  const records = new Map(
    existing.issues.map((issue) => [issue.key, { ...issue }]),
  );

  for (const issue of report.issues) {
    const key = issueKey(issue);
    const previous = records.get(key);
    records.set(key, {
      ...issue,
      key,
      status: 'open',
      firstSeen: previous?.firstSeen ?? report.generatedAt,
      lastSeen: report.generatedAt,
      lastArea: report.area,
      occurrences: (previous?.occurrences ?? 0) + 1,
      sourceReports: appendUnique(previous?.sourceReports ?? [], reportRef, 5),
    });
  }

  for (const [key, issue] of records) {
    if (
      !currentKeys.has(key) &&
      issue.status === 'open' &&
      areaCoversIssueType(report.area, issue.type)
    ) {
      records.set(key, { ...issue, status: 'not-found' });
    }
  }

  const database: PreseasonIssueDatabase = {
    version: '1.0.0',
    updatedAt: report.generatedAt,
    latestRunId: run.id,
    runs: [...existing.runs, run].slice(-50),
    issues: Array.from(records.values()).sort(compareIssueRecords),
  };

  await writeFile(
    report.issueDbPath,
    `${JSON.stringify(database, null, 2)}\n`,
    'utf-8',
  );
}

async function readIssueDatabase(
  issueDbPath: string,
): Promise<PreseasonIssueDatabase> {
  try {
    const raw = await readFile(issueDbPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PreseasonIssueDatabase>;
    if (
      parsed.version === '1.0.0' &&
      Array.isArray(parsed.runs) &&
      Array.isArray(parsed.issues)
    ) {
      return {
        version: '1.0.0',
        updatedAt: parsed.updatedAt ?? '',
        latestRunId: parsed.latestRunId ?? '',
        runs: parsed.runs,
        issues: parsed.issues,
      };
    }
  } catch {
    // Missing/corrupt issue database should not block generating a fresh scan.
  }
  return {
    version: '1.0.0',
    updatedAt: '',
    latestRunId: '',
    runs: [],
    issues: [],
  };
}

function issueKey(issue: PreseasonIssue): string {
  const stableParts = [
    issue.type,
    issue.title,
    issue.file ?? '',
    issue.detail,
  ].join('\0');
  return createHash('sha1').update(stableParts).digest('hex').slice(0, 12);
}

function areaCoversIssueType(area: string, type: PreseasonIssueType): boolean {
  if (area === 'all') return true;
  if (area === 'deps') return type === 'dependency';
  if (area === 'security') return type === 'security';
  if (area === 'dead-code') return type === 'todo' || type === 'tests';
  if (area === 'config') return type === 'scripts' || type === 'config';
  return false;
}

function appendUnique(values: string[], next: string, limit: number): string[] {
  return [...values.filter((value) => value !== next), next].slice(-limit);
}

function compareIssueRecords(
  a: PreseasonIssueRecord,
  b: PreseasonIssueRecord,
): number {
  const severityOrder: Record<PreseasonSeverity, number> = {
    P0: 0,
    P1: 1,
    P2: 2,
  };
  return (
    severityOrder[a.severity] - severityOrder[b.severity] ||
    a.type.localeCompare(b.type) ||
    a.title.localeCompare(b.title) ||
    a.key.localeCompare(b.key)
  );
}

async function nextRemediationAnswer(
  answerQueue: string[],
  ask: PreseasonRemediationOptions['ask'],
  question: string,
): Promise<string> {
  if (answerQueue.length > 0) {
    return answerQueue.shift() ?? '';
  }
  if (!ask) return 'skip';
  return ask(question);
}

function normalizeRemediationAnswer(
  answer: string,
): 'y' | 'n' | 'skip' | 'show' {
  const normalized = answer.trim().toLowerCase();
  if (['y', 'yes'].includes(normalized)) return 'y';
  if (['n', 'no'].includes(normalized)) return 'n';
  if (['show', 'show files', 'files', 'file', '?'].includes(normalized)) {
    return 'show';
  }
  return 'skip';
}

function renderSection(title: string, issues: PreseasonIssue[]): string {
  if (issues.length === 0) return `## ${title}\n\nNone.`;
  return `## ${title}\n\n${issues
    .map(
      (issue) => `### ${issue.id}: ${issue.title}

- Type: ${issue.type}
- File: ${issue.file ?? 'n/a'}
- Detail: ${issue.detail}
- Recommendation: ${issue.recommendation}`,
    )
    .join('\n\n')}`;
}

function readFileSyncSafe(file: string): string {
  return readFileSync(file, 'utf-8');
}

function pathExistsSync(file: string): boolean {
  return existsSync(file);
}
