import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../src/context/canonical.js';
import {
  readContextIndexCache,
  writeContextIndexCache,
} from '../src/context/context-index-cache.js';
import type { ContextIndexSnapshot } from '../src/context/context-index.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe('disposable context index cache', () => {
  it('binds visibility, checkout and candidate versions through the verified key', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mancode-context-cache-'));
    roots.push(root);
    const key = digestCanonicalJson({
      checkout: 'a',
      privacy: 1,
      candidates: ['v1'],
    });
    const snapshot: ContextIndexSnapshot = {
      identity: 'a',
      records: [],
      task: null,
      gaps: [],
    };
    expect(await readContextIndexCache(root, key)).toBeNull();
    await writeContextIndexCache(root, key, snapshot);
    expect(await readContextIndexCache(root, key)).toEqual(snapshot);
    expect(
      await readContextIndexCache(
        root,
        digestCanonicalJson({ checkout: 'b', privacy: 1, candidates: ['v1'] }),
      ),
    ).toBeNull();
    expect(
      await readContextIndexCache(
        root,
        digestCanonicalJson({ checkout: 'a', privacy: 2, candidates: ['v1'] }),
      ),
    ).toBeNull();
    expect(
      await readContextIndexCache(
        root,
        digestCanonicalJson({
          checkout: 'a',
          privacy: 1,
          candidates: ['v1', 'v2'],
        }),
      ),
    ).toBeNull();
    const file = path.join(
      root,
      '.mancode/local/cache/context-index/current.json',
    );
    await writeFile(file, 'broken');
    expect(await readContextIndexCache(root, key)).toBeNull();
    await writeContextIndexCache(root, key, snapshot);
    await rm(path.dirname(file), { recursive: true });
    expect(await readContextIndexCache(root, key)).toBeNull();
    await writeContextIndexCache(root, key, snapshot);
    expect(await readContextIndexCache(root, key)).toEqual(snapshot);
  });
});
