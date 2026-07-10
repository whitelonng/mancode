import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type ProjectKind =
  | 'backend'
  | 'web'
  | 'mobile'
  | 'desktop'
  | 'cli'
  | 'library'
  | 'data'
  | 'mixed'
  | 'unknown';

export interface ProjectProfile {
  version: '1.0';
  projectKind: ProjectKind;
  languages: string[];
  frameworks: string[];
  sourceRoots: string[];
  manifests: string[];
  availableValidation: string[];
  uiAssets: 'none' | 'detected';
  browserAutomation: 'available' | 'unavailable' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
}

export const PROJECT_MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Package.swift',
  'pubspec.yaml',
] as const;

export async function detectProjectProfile(
  projectRoot: string,
): Promise<ProjectProfile> {
  const entries = await readdir(projectRoot).catch(() => [] as string[]);
  const manifests = PROJECT_MANIFESTS.filter((file) => entries.includes(file));
  const sourceRoots = await existingDirs(projectRoot, [
    'src',
    'app',
    'apps',
    'packages',
    'web',
    'lib',
    'Sources',
    'cmd',
    'server',
    'backend',
    'mobile',
    'ios',
    'android',
    'data',
    'notebooks',
  ]);
  const packageJson = await readJson(path.join(projectRoot, 'package.json'));
  const [pubspec, pythonManifests] = await Promise.all([
    readText(path.join(projectRoot, 'pubspec.yaml')),
    Promise.all([
      readText(path.join(projectRoot, 'pyproject.toml')),
      readText(path.join(projectRoot, 'requirements.txt')),
    ]).then((parts) => parts.filter(Boolean).join('\n')),
  ]);
  const deps = Object.keys({
    ...(packageJson?.dependencies as Record<string, unknown> | undefined),
    ...(packageJson?.devDependencies as Record<string, unknown> | undefined),
    ...(packageJson?.peerDependencies as Record<string, unknown> | undefined),
  });
  const flutter = isFlutterProject(pubspec);
  const shadcn =
    entries.includes('components.json') ||
    (deps.some((dep) => dep.startsWith('@radix-ui/')) &&
      (await isDirectory(path.join(projectRoot, 'src', 'components', 'ui'))));
  const languages = inferLanguages(manifests, entries);
  const frameworks = inferFrameworks(
    deps,
    manifests,
    pythonManifests,
    flutter,
    shadcn,
  );
  const uiAssets = hasUiAssets(deps, entries, flutter) ? 'detected' : 'none';
  const projectKind = inferKind(
    deps,
    manifests,
    entries,
    packageJson,
    uiAssets,
    flutter,
    pythonManifests,
  );
  const availableValidation = inferValidation(
    packageJson,
    manifests,
    entries,
    flutter,
    pythonManifests,
  );

  return {
    version: '1.0',
    projectKind,
    languages,
    frameworks,
    sourceRoots,
    manifests,
    availableValidation,
    uiAssets,
    browserAutomation:
      deps.some((dep) => dep.includes('playwright')) ||
      entries.some((entry) => /^playwright\.config\./.test(entry))
        ? 'available'
        : projectKind === 'web' || projectKind === 'mixed'
          ? 'unknown'
          : 'unavailable',
    confidence:
      projectKind === 'unknown'
        ? 'low'
        : manifests.length > 0
          ? 'high'
          : 'medium',
  };
}

async function existingDirs(
  root: string,
  candidates: string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(path.join(root, candidate))).isDirectory())
        found.push(candidate);
    } catch {}
  }
  return found;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

function inferLanguages(manifests: string[], entries: string[]): string[] {
  const languages: string[] = [];
  if (manifests.includes('package.json'))
    languages.push('JavaScript/TypeScript');
  if (
    manifests.includes('pyproject.toml') ||
    manifests.includes('requirements.txt')
  )
    languages.push('Python');
  if (manifests.includes('go.mod')) languages.push('Go');
  if (manifests.includes('Cargo.toml')) languages.push('Rust');
  if (
    manifests.includes('pom.xml') ||
    manifests.includes('build.gradle') ||
    manifests.includes('build.gradle.kts')
  )
    languages.push('JVM');
  if (manifests.includes('Package.swift')) languages.push('Swift');
  if (manifests.includes('pubspec.yaml')) languages.push('Dart');
  if (entries.includes('Dockerfile') && languages.length === 0)
    languages.push('Containerized');
  return languages;
}

function inferFrameworks(
  deps: string[],
  manifests: string[],
  pythonManifests: string,
  flutter: boolean,
  shadcn: boolean,
): string[] {
  const result: string[] = [];
  for (const [dep, name] of [
    ['react', 'React'],
    ['vue', 'Vue'],
    ['svelte', 'Svelte'],
    ['next', 'Next.js'],
    ['nuxt', 'Nuxt'],
    ['astro', 'Astro'],
    ['solid-js', 'SolidJS'],
    ['preact', 'Preact'],
    ['@angular/core', 'Angular'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['electron', 'Electron'],
    ['@tauri-apps/api', 'Tauri'],
    ['tailwindcss', 'Tailwind CSS'],
    ['@mui/material', 'MUI'],
    ['antd', 'Ant Design'],
    ['@headlessui/react', 'Headless UI'],
  ] as const) {
    if (deps.includes(dep)) result.push(name);
  }
  if (manifests.includes('go.mod')) result.push('Go modules');
  if (manifests.includes('Cargo.toml')) result.push('Cargo');
  if (flutter) result.push('Flutter');
  if (shadcn) result.push('shadcn/ui');
  else if (deps.some((dep) => dep.startsWith('@radix-ui/')))
    result.push('Radix UI');
  for (const [pattern, name] of [
    [/\bdjango\b/i, 'Django'],
    [/\bfastapi\b/i, 'FastAPI'],
    [/\bflask\b/i, 'Flask'],
  ] as const) {
    if (pattern.test(pythonManifests)) result.push(name);
  }
  return result;
}

function hasUiAssets(
  deps: string[],
  entries: string[],
  flutter: boolean,
): boolean {
  return (
    deps.some(
      (dep) =>
        [
          'react',
          'vue',
          'svelte',
          'solid-js',
          'preact',
          '@angular/core',
          'tailwindcss',
          '@mui/material',
          'antd',
          '@headlessui/react',
          'electron',
          '@tauri-apps/api',
        ].includes(dep) || dep.startsWith('@radix-ui/'),
    ) ||
    entries.includes('index.html') ||
    entries.some((entry) => /^tailwind\.config\./.test(entry)) ||
    entries.includes('ios') ||
    entries.includes('android') ||
    flutter
  );
}

export function primaryUiLibrary(profile: ProjectProfile): string | null {
  const preferred = [
    'shadcn/ui',
    'MUI',
    'Ant Design',
    'Headless UI',
    'Radix UI',
    'Tailwind CSS',
    'Flutter',
  ];
  return preferred.find((name) => profile.frameworks.includes(name)) ?? null;
}

function inferKind(
  deps: string[],
  manifests: string[],
  entries: string[],
  packageJson: Record<string, unknown> | null,
  uiAssets: 'none' | 'detected',
  flutter: boolean,
  pythonManifests: string,
): ProjectKind {
  const hasBackendFramework =
    deps.includes('express') ||
    deps.includes('fastify') ||
    /\b(django|fastapi|flask)\b/i.test(pythonManifests);
  const hasBackendLayout =
    entries.includes('server') || entries.includes('backend');
  const hasPackageLibraryContract =
    manifests.includes('package.json') &&
    ['main', 'module', 'exports', 'types'].some((field) =>
      Object.hasOwn(packageJson ?? {}, field),
    );
  const hasCliSignal =
    entries.includes('bin') ||
    entries.includes('cmd') ||
    typeof packageJson?.bin === 'string' ||
    (typeof packageJson?.bin === 'object' && packageJson.bin !== null);
  const hasWebApplicationSignal =
    entries.some((entry) =>
      ['app', 'pages', 'public', 'web', 'index.html'].includes(entry),
    ) || deps.some((dep) => ['next', 'nuxt', 'astro'].includes(dep));
  const hasNonWebManifest = manifests.some((manifest) =>
    [
      'pyproject.toml',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
    ].includes(manifest),
  );
  if (entries.includes('ios') || entries.includes('android') || flutter)
    return hasBackendFramework || hasBackendLayout ? 'mixed' : 'mobile';
  if (deps.some((dep) => ['electron', '@tauri-apps/api'].includes(dep)))
    return hasBackendFramework || hasBackendLayout ? 'mixed' : 'desktop';
  if (hasCliSignal && !hasWebApplicationSignal)
    return hasBackendFramework || hasBackendLayout ? 'mixed' : 'cli';
  if (
    hasPackageLibraryContract &&
    !hasWebApplicationSignal &&
    !hasBackendFramework &&
    !hasBackendLayout &&
    !hasNonWebManifest
  )
    return 'library';
  if (uiAssets === 'detected')
    return hasBackendFramework || hasBackendLayout || hasNonWebManifest
      ? 'mixed'
      : 'web';
  if (entries.includes('data') || entries.includes('notebooks')) return 'data';
  if (hasPackageLibraryContract) return 'library';
  if (manifests.includes('pubspec.yaml') && entries.includes('lib'))
    return 'library';
  if (hasBackendFramework || hasBackendLayout) return 'backend';
  if (
    manifests.filter((manifest) => manifest !== 'requirements.txt').length > 1
  )
    return 'mixed';
  return 'unknown';
}

function inferValidation(
  pkg: Record<string, unknown> | null,
  manifests: string[],
  entries: string[],
  flutter: boolean,
  pythonManifests: string,
): string[] {
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  const packageRunner = entries.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : entries.includes('yarn.lock')
      ? 'yarn'
      : entries.includes('bun.lock') || entries.includes('bun.lockb')
        ? 'bun'
        : 'npm';
  return Array.from(
    new Set(
      ['build', 'lint', 'test', 'typecheck']
        .filter((name) => typeof scripts[name] === 'string')
        .map((name) => `${packageRunner} run ${name}`)
        .concat(
          manifests.includes('go.mod') ? ['go test ./...'] : [],
          manifests.includes('Cargo.toml') ? ['cargo test'] : [],
          /\bpytest\b/i.test(pythonManifests) || entries.includes('pytest.ini')
            ? ['python -m pytest']
            : [],
          manifests.includes('pom.xml')
            ? [entries.includes('mvnw') ? './mvnw test' : 'mvn test']
            : [],
          manifests.includes('build.gradle') ||
            manifests.includes('build.gradle.kts')
            ? [entries.includes('gradlew') ? './gradlew test' : 'gradle test']
            : [],
          manifests.includes('Package.swift') ? ['swift test'] : [],
          manifests.includes('pubspec.yaml')
            ? [flutter ? 'flutter test' : 'dart test']
            : [],
        ),
    ),
  );
}

function isFlutterProject(pubspec: string): boolean {
  return /(^|\n)\s*sdk\s*:\s*flutter\s*($|\n)/m.test(pubspec);
}
