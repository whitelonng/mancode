import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { visit } from 'jsonc-parser';
import { LIMITS, fail } from './types.js';

export function strictJson(bytes: Uint8Array, max = LIMITS.input): unknown {
  if (bytes.byteLength > max) fail('INPUT_INVALID');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('INPUT_INVALID');
  }
  const objects: Set<string>[] = [];
  let depth = 0;
  try {
    visit(
      source,
      {
        onObjectBegin() {
          if (++depth > LIMITS.depth) fail('INPUT_INVALID');
          objects.push(new Set());
        },
        onObjectProperty(key) {
          const keys = objects.at(-1);
          if (
            !keys ||
            keys.has(key) ||
            ['__proto__', 'constructor', 'prototype'].includes(key)
          )
            fail('INPUT_INVALID');
          keys.add(key);
        },
        onObjectEnd() {
          objects.pop();
          depth--;
        },
        onArrayBegin() {
          if (++depth > LIMITS.depth) fail('INPUT_INVALID');
        },
        onArrayEnd() {
          depth--;
        },
        onComment() {
          fail('INPUT_INVALID');
        },
        onError() {
          fail('INPUT_INVALID');
        },
      },
      { disallowComments: true, allowTrailingComma: false },
    );
    return JSON.parse(source);
  } catch {
    return fail('INPUT_INVALID');
  }
}
export async function regularFile(
  file: string,
  max: number,
  privateFile = false,
): Promise<Buffer> {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > max
  )
    fail('INPUT_INVALID');
  if (
    privateFile &&
    ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.())
  )
    fail('STORAGE_UNAVAILABLE');
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await handle.stat();
    if (
      st.ino !== before.ino ||
      st.dev !== before.dev ||
      !st.isFile() ||
      st.size > max
    )
      fail('INPUT_INVALID');
    // Read one extra byte to reject growth instead of accepting a truncated file.
    const data = Buffer.alloc(st.size + 1);
    let total = 0;
    while (total < data.length) {
      const { bytesRead } = await handle.read(
        data,
        total,
        data.length - total,
        null,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > st.size) fail('INPUT_INVALID');
    // A subarray would retain the original allocation even if the file shrank.
    return Buffer.from(data.subarray(0, total));
  } finally {
    await handle.close();
  }
}
export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const st = await lstat(directory);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== path.resolve(directory)
  )
    fail('STORAGE_UNAVAILABLE');
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    const dir = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
