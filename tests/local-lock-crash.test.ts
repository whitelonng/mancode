import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { resolveCoordinationEntityHomeStore } from '../src/runtime/entity-home-store.js';
import { acquireLocalLock, readLocalLock } from '../src/runtime/local-lock.js';

const OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const NEXT_OPERATION_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const entityLockKey = 'project:write';

it.each(['partial-write', 'before-publish', 'after-publish'])(
  'recovers after a real process is killed at %s',
  async (phase) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mancode-lock-crash-'));
    const home = resolveCoordinationEntityHomeStore({
      projectRoot: root,
      workspaceId: '01JZ4B6W5Z0A1B2C3D4E5F6G7H',
      checkoutId: '01JZ4B6W5Z0A1B2C3D4E5F6G7J',
      gitCommonDir: null,
      repositoryBindingId: null,
    });
    const moduleFile = path.join(root, 'lock.cjs');
    await build({
      entryPoints: ['src/runtime/local-lock.ts'],
      outfile: moduleFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    // Pause real filesystem operations inside the child at exact crash points.
    const script = `
      const fs = require('node:fs/promises');
      const [moduleFile, homeJSON, phase, operationId, key, timestamp] = process.argv.slice(1);
      const hold = () => new Promise(() => {
        process.stdout.write('ready\\n');
        setInterval(() => {}, 1000);
      });
      const write = fs.writeFile;
      fs.writeFile = async (file, data, options) => {
        if (phase === 'partial-write') {
          await write(file, data.slice(0, Math.floor(data.length / 2)), options);
          return hold();
        }
        await write(file, data, options);
        if (phase === 'before-publish') return hold();
      };
      const link = fs.link;
      fs.link = async (...args) => {
        await link(...args);
        if (phase === 'after-publish') return hold();
      };
      require(moduleFile).acquireLocalLock(JSON.parse(homeJSON), {
        operationId, entityLockKey: key, now: new Date(timestamp), leaseMs: 1000,
      }).catch(error => { console.error(error); process.exit(1); });
    `;
    const now = new Date();
    const child = spawn(
      process.execPath,
      [
        '-e',
        script,
        moduleFile,
        JSON.stringify(home),
        phase,
        OPERATION_ID,
        entityLockKey,
        now.toISOString(),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Child did not reach ${phase}: ${stderr}`)),
          5000,
        );
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Child exited early: ${stderr}`));
        });
      });
      const published = phase === 'after-publish';
      if (published) {
        await expect(readLocalLock(home, entityLockKey)).resolves.toMatchObject(
          { processId: child.pid },
        );
        // Even an expired lease must not allow stealing from the live process.
        await expect(
          acquireLocalLock(home, {
            operationId: NEXT_OPERATION_ID,
            entityLockKey,
            now: new Date(now.getTime() + 2000),
          }),
        ).rejects.toThrow('MANCODE_LOCK_HELD');
      }
      child.kill('SIGKILL');
      await exited;
      if (published) {
        await expect(
          acquireLocalLock(home, {
            operationId: NEXT_OPERATION_ID,
            entityLockKey,
            now,
          }),
        ).rejects.toThrow('MANCODE_LOCK_HELD');
      }
      const replacement = await acquireLocalLock(home, {
        operationId: NEXT_OPERATION_ID,
        entityLockKey,
        // A never-published owner cannot block even before its proposed lease ends.
        now: published ? new Date(now.getTime() + 2000) : now,
      });
      await expect(readLocalLock(home, entityLockKey)).resolves.toEqual(
        replacement.owner,
      );
      await replacement.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
