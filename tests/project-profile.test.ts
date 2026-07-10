import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectProjectProfile,
  primaryUiLibrary,
} from '../src/system/project-profile.js';

describe('project profile', () => {
  const dirs: string[] = [];
  afterEach(async () =>
    Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    ),
  );

  it('keeps an unknown project unknown instead of assuming a web stack', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    const profile = await detectProjectProfile(dir);
    expect(profile.projectKind).toBe('unknown');
    expect(profile.uiAssets).toBe('none');
    expect(profile.browserAutomation).toBe('unavailable');
  });

  it('recognizes a Go backend without package.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'go.mod'), 'module example\n', 'utf-8');
    await mkdir(path.join(dir, 'server'));
    const profile = await detectProjectProfile(dir);
    expect(profile.projectKind).toBe('backend');
    expect(profile.languages).toContain('Go');
    expect(profile.availableValidation).toContain('go test ./...');
  });

  it('recognizes a mobile project without treating it as a web project', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'pubspec.yaml'),
      'name: example\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'utf-8',
    );

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('mobile');
    expect(profile.languages).toContain('Dart');
    expect(profile.uiAssets).toBe('detected');
    expect(profile.browserAutomation).toBe('unavailable');
  });

  it.each([
    ['Android', 'build.gradle.kts', 'android'],
    ['iOS', 'Package.swift', 'ios'],
  ] as const)(
    'does not treat a native %s manifest as a second mixed-project backend',
    async (_, manifest, sourceDir) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
      dirs.push(dir);
      await writeFile(path.join(dir, manifest), '', 'utf-8');
      await mkdir(path.join(dir, sourceDir));

      const profile = await detectProjectProfile(dir);

      expect(profile.projectKind).toBe('mobile');
      expect(profile.uiAssets).toBe('detected');
      if (manifest === 'build.gradle.kts') {
        expect(profile.languages).toContain('JVM');
        expect(profile.availableValidation).toContain('gradle test');
      }
    },
  );

  it('recognizes a web UI and browser automation only from detected dependencies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^1.0.0', '@playwright/test': '^1.0.0' },
      }),
      'utf-8',
    );

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('web');
    expect(profile.uiAssets).toBe('detected');
    expect(profile.browserAutomation).toBe('available');
  });

  it.each([
    [
      'desktop',
      { dependencies: { electron: '^1.0.0' } },
      'desktop',
      'detected',
    ],
    ['cli', { bin: 'bin/tool.js' }, 'cli', 'none'],
    ['library', { main: 'dist/index.js' }, 'library', 'none'],
    ['data', undefined, 'data', 'none'],
  ] as const)(
    'classifies a %s project without unrelated UI assumptions',
    async (_, pkg, kind, expectedUiAssets) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
      dirs.push(dir);
      if (pkg) {
        await writeFile(
          path.join(dir, 'package.json'),
          JSON.stringify(pkg),
          'utf-8',
        );
      } else {
        await mkdir(path.join(dir, 'data'));
      }

      const profile = await detectProjectProfile(dir);

      expect(profile.projectKind).toBe(kind);
      expect(profile.uiAssets).toBe(expectedUiAssets);
    },
  );

  it('keeps a bare Go module unknown instead of assuming a backend', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'go.mod'), 'module example\n', 'utf-8');

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('unknown');
    expect(profile.confidence).toBe('low');
    expect(profile.availableValidation).toContain('go test ./...');
  });

  it('recognizes a Dart CLI without inventing Flutter or UI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'pubspec.yaml'),
      'name: dart_cli\n',
      'utf-8',
    );
    await mkdir(path.join(dir, 'bin'));

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('cli');
    expect(profile.frameworks).not.toContain('Flutter');
    expect(profile.uiAssets).toBe('none');
    expect(profile.availableValidation).toContain('dart test');
  });

  it('recognizes a mixed web and Go repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'go.mod'), 'module example\n', 'utf-8');
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^1.0.0' } }),
      'utf-8',
    );

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('mixed');
    expect(profile.languages).toEqual(
      expect.arrayContaining(['Go', 'JavaScript/TypeScript']),
    );
  });

  it('emits executable Node validation commands for the detected package manager', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
      'utf-8',
    );
    await writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const profile = await detectProjectProfile(dir);

    expect(profile.availableValidation).toEqual([
      'pnpm run build',
      'pnpm run test',
    ]);
  });

  it('detects shadcn from peer dependencies and the existing UI directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        peerDependencies: { react: '^18.0.0' },
        dependencies: { '@radix-ui/react-dialog': '^1.0.0' },
      }),
      'utf-8',
    );
    await mkdir(path.join(dir, 'src', 'components', 'ui'), {
      recursive: true,
    });

    const profile = await detectProjectProfile(dir);

    expect(profile.frameworks).toEqual(
      expect.arrayContaining(['React', 'shadcn/ui']),
    );
    expect(profile.uiAssets).toBe('detected');
    expect(primaryUiLibrary(profile)).toBe('shadcn/ui');
  });

  it('keeps a React package with an exports contract classified as a library', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        exports: { '.': './dist/index.js' },
        peerDependencies: { react: '^18.0.0' },
      }),
      'utf-8',
    );

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('library');
    expect(profile.uiAssets).toBe('detected');
  });

  it('keeps an explicit React-based terminal application classified as a CLI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mancode-profile-'));
    dirs.push(dir);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        bin: 'dist/cli.js',
        dependencies: { react: '^18.0.0', ink: '^5.0.0' },
      }),
      'utf-8',
    );

    const profile = await detectProjectProfile(dir);

    expect(profile.projectKind).toBe('cli');
    expect(profile.browserAutomation).toBe('unavailable');
  });
});
