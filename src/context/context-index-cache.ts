import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { replaceFileAtomically } from '../runtime/atomic-file.js';
import { digestCanonicalJson } from './canonical.js';
import type { ContextIndexSnapshot } from './context-index.js';

const relative = '.mancode/local/cache/context-index';
const keyPattern = /^sha256:[a-f0-9]{64}$/;
interface CacheEnvelope {
  schemaVersion: 1;
  key: string;
  snapshot: ContextIndexSnapshot;
  digest: string;
}

async function cachePath(root: string): Promise<string> {
  const folder = path.join(root, relative);
  await mkdir(folder, { recursive: true });
  if ((await realpath(folder)) !== path.join(await realpath(root), relative)) {
    throw new Error('MANCODE_CONTEXT_CACHE_PATH_UNSAFE');
  }
  return path.join(folder, 'current.json');
}

/** The key must be computed from freshly verified authority, privacy and document versions. */
export async function readContextIndexCache(
  root: string,
  key: string,
): Promise<ContextIndexSnapshot | null> {
  if (!keyPattern.test(key))
    throw new Error('MANCODE_CONTEXT_CACHE_KEY_INVALID');
  const target = await cachePath(root);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('MANCODE_CONTEXT_CACHE_PATH_UNSAFE');
    const value = JSON.parse(await readFile(target, 'utf8')) as CacheEnvelope;
    if (
      value.schemaVersion !== 1 ||
      value.key !== key ||
      value.digest !==
        digestCanonicalJson({ key: value.key, snapshot: value.snapshot }) ||
      !value.snapshot ||
      typeof value.snapshot.identity !== 'string' ||
      !Array.isArray(value.snapshot.records) ||
      !Array.isArray(value.snapshot.gaps) ||
      value.snapshot.records.some(
        (record) =>
          [
            'ref',
            'kind',
            'title',
            'version',
            'state',
            'reason',
            'source',
            'content',
          ].some(
            (field) => typeof record[field as keyof typeof record] !== 'string',
          ) || typeof record.required !== 'boolean',
      )
    ) {
      return null;
    }
    return value.snapshot;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    )
      return null;
    throw error;
  }
}

/** One replaceable checkout-local file bounds disk growth. Concurrent keys never share content. */
export async function writeContextIndexCache(
  root: string,
  key: string,
  snapshot: ContextIndexSnapshot,
): Promise<void> {
  if (!keyPattern.test(key))
    throw new Error('MANCODE_CONTEXT_CACHE_KEY_INVALID');
  const target = await cachePath(root);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('MANCODE_CONTEXT_CACHE_PATH_UNSAFE');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        schemaVersion: 1,
        key,
        snapshot,
        digest: digestCanonicalJson({ key, snapshot }),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await replaceFileAtomically(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
