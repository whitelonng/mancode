import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceFileAtomically } from '../src/runtime/atomic-file.js';

describe('atomic file replacement', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('replaces an existing sibling only after the replacement is written', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mancode-atomic-file-'));
    roots.push(root);
    const target = path.join(root, 'target.json');
    const temporary = path.join(root, '.target.json.tmp');
    await writeFile(target, '{"state":"old"}\n');
    await writeFile(temporary, '{"state":"new"}\n');

    await replaceFileAtomically(temporary, target);

    await expect(readFile(target, 'utf8')).resolves.toBe('{"state":"new"}\n');
    await expect(readFile(temporary, 'utf8')).rejects.toThrow();
  });

  it('rejects invalid retry settings before changing files', async () => {
    await expect(
      replaceFileAtomically('temporary', 'target', { maxAttempts: 0 }),
    ).rejects.toThrow('MANCODE_ATOMIC_REPLACE_ATTEMPTS_INVALID');
  });
});
