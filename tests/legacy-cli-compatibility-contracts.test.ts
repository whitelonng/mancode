import {
  type ExecFileException,
  execFile as execFileCallback,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeV3Project } from '../src/commands/v3-init.js';
import { type Ulid, createUlid } from '../src/context/ids.js';
import { createSession } from '../src/runtime/session.js';
import {
  createLocalActor,
  createSharedActorProfile,
  publishSharedActorProfile,
} from '../src/team/actor.js';

const NOW = new Date('2026-07-22T08:00:00.000Z');
const LEGACY_FIXTURE = fileURLToPath(
  new URL('./fixtures/legacy-cli/mancode-0.3.18.tgz', import.meta.url),
);
const LEGACY_INTEGRITY =
  'sha512-7jqphIAgW+XlTZWFwK06ekPOt//g4q9A+3KZJeSjZCdh3d4Rsb0Akgn3ku5Ayc1URZAtPJVPqLdqgxfCaszlWg==';

describe('published 0.3.18 CLI compatibility boundary', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('rejects a V2 authority mutation before changing any authority bytes', async () => {
    await expectRootBinUnregistered();
    const fixture = await readFile(LEGACY_FIXTURE);
    expect(
      `sha512-${createHash('sha512').update(fixture).digest('base64')}`,
    ).toBe(LEGACY_INTEGRITY);
    const extractionRoot = await mkdtemp(
      path.join(process.cwd(), 'node_modules', '.mancode-legacy-cli-'),
    );
    roots.push(extractionRoot);
    const legacyPackageRoot = path.join(extractionRoot, 'package');
    await extractLegacyPackage(fixture, extractionRoot);
    const legacyCli = path.join(legacyPackageRoot, 'dist', 'cli.js');
    const packageMetadata = JSON.parse(
      await readFile(path.join(legacyPackageRoot, 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      exports: Record<string, string>;
    };
    expect(packageMetadata).toMatchObject({
      name: 'mancode',
      version: '0.3.18',
      bin: { mancode: 'dist/cli.js' },
      exports: { '.': './dist/index.js' },
    });
    expect(legacyCli).toBe(
      path.join(legacyPackageRoot, packageMetadata.bin.mancode),
    );
    await expect(
      readFile(path.join(legacyPackageRoot, 'dist', 'index.js'), 'utf8'),
    ).resolves.toContain('VERSION');
    const version = await runLegacyCli(legacyCli, ['--version'], process.cwd());
    expect(version).toMatchObject({
      exitCode: 0,
      signal: null,
      stderr: '',
    });
    expect(version.stdout.trim()).toBe('0.3.18');

    const root = await mkdtemp(
      path.join(tmpdir(), 'mancode-legacy-cli-compatibility-'),
    );
    roots.push(root);
    await initializeV3Project({
      projectRoot: root,
      operationId: id(1),
      workspaceId: id(2),
      schemaEpoch: id(3),
      now: NOW,
    });
    const actorId = id(4);
    const sessionId = id(5);
    const actor = await createLocalActor(root, {
      actorId,
      displayName: 'Legacy CLI Fixture',
      now: NOW,
    });
    await publishSharedActorProfile(root, createSharedActorProfile(actor, NOW));
    await createSession(root, {
      actorId,
      sessionId,
      client: 'legacy-cli-contract',
      identitySource: 'explicit',
      now: NOW,
    });

    const manifest = JSON.parse(
      await readFile(path.join(root, '.mancode', 'schema.json'), 'utf8'),
    ) as { manifestVersion: number; minWriterVersion: string };
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      minWriterVersion: '0.4.0',
    });
    const authorityBefore = await snapshotTree(path.join(root, '.mancode'));

    const result = await runLegacyCli(
      legacyCli,
      [
        'team',
        'policy',
        'off',
        '--expected-revision',
        '1',
        '--session',
        sessionId,
        '--client',
        'legacy-cli-contract',
        '--json',
      ],
      root,
    );

    expect(result).toMatchObject({ exitCode: 3, signal: null, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      error: {
        code: 'MANCODE_TEAM_POLICY_UPDATE_FAILED',
        message:
          'schema manifest contains unknown field(s): workflowPolicyDefaults',
      },
    });
    expect(await snapshotTree(path.join(root, '.mancode'))).toEqual(
      authorityBefore,
    );
  });
});

interface CliResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runLegacyCli(
  legacyCli: string,
  args: string[],
  cwd: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      process.execPath,
      [legacyCli, ...args],
      { cwd, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        const processError = error as ExecFileException | null;
        resolve({
          exitCode:
            processError !== null && typeof processError.code === 'number'
              ? processError.code
              : 0,
          signal: processError?.signal ?? null,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function expectRootBinUnregistered(): Promise<void> {
  for (const name of ['mancode', 'mancode.cmd', 'mancode.ps1']) {
    await expect(
      lstat(path.join(process.cwd(), 'node_modules', '.bin', name)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }
}

async function extractLegacyPackage(
  fixture: Buffer,
  destination: string,
): Promise<void> {
  const entries = readTarFiles(gunzipSync(fixture));
  const selected = [...entries].filter(
    ([name]) =>
      name === 'package/package.json' ||
      (name.startsWith('package/dist/') && name.endsWith('.js')),
  );
  if (selected.length < 2) {
    throw new Error('legacy CLI fixture does not contain its published dist');
  }
  for (const [name, bytes] of selected) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

function readTarFiles(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const entryName = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarText(header.subarray(124, 136));
    if (!/^[0-7]+$/.test(sizeText)) {
      throw new Error(
        `legacy CLI fixture has an invalid tar size: ${entryName}`,
      );
    }
    const size = Number.parseInt(sizeText, 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new Error('legacy CLI fixture tar entry exceeds the archive');
    }
    const type = header[156];
    if (type === 0 || type === 48) {
      if (
        !entryName.startsWith('package/') ||
        entryName.split('/').includes('..')
      ) {
        throw new Error('legacy CLI fixture contains an unsafe tar path');
      }
      entries.set(entryName, Buffer.from(archive.subarray(dataStart, dataEnd)));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function tarText(field: Buffer): string {
  const end = field.indexOf(0);
  return field
    .subarray(0, end === -1 ? field.length : end)
    .toString()
    .trim();
}

interface TreeEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  bytes?: string;
  target?: string;
}

async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const snapshot: TreeEntry[] = [];
  await visit(root, '');
  return snapshot;

  async function visit(absoluteDirectory: string, relativeDirectory: string) {
    const names = (await readdir(absoluteDirectory)).sort();
    for (const name of names) {
      const absolute = path.join(absoluteDirectory, name);
      const relative = path.join(relativeDirectory, name);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        snapshot.push({ path: relative, type: 'directory' });
        await visit(absolute, relative);
      } else if (stats.isFile()) {
        snapshot.push({
          path: relative,
          type: 'file',
          bytes: (await readFile(absolute)).toString('base64'),
        });
      } else if (stats.isSymbolicLink()) {
        snapshot.push({
          path: relative,
          type: 'symlink',
          target: await readlink(absolute),
        });
      } else {
        snapshot.push({ path: relative, type: 'other' });
      }
    }
  }
}

function id(offset: number): Ulid {
  return createUlid(NOW.getTime() + offset, new Uint8Array(10).fill(offset));
}
