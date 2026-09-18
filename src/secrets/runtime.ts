import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { regularFile } from './io.js';
import { fail } from './types.js';
const exec = promisify(execFile);
/** Bind the fixed native installation, including non-system Mach-O dependencies. */
export async function runtimeIdentity(
  executable: string,
): Promise<Record<string, string>> {
  if (process.platform !== 'darwin') fail('CAPABILITY_UNAVAILABLE');
  const files: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  async function inspect(
    input: string,
    inheritedRpaths: string[] = [],
  ): Promise<void> {
    if (input.startsWith('/usr/lib/') || input.startsWith('/System/Library/'))
      return;
    if (seen.has(input)) return;
    seen.add(input);
    if (seen.size > 128) fail('CAPABILITY_UNAVAILABLE');
    const actual = await realpath(input);
    const bytes = await regularFile(actual, 256 * 1024 * 1024);
    files[input] = createHash('sha256').update(bytes).digest('hex');
    const options = {
      encoding: 'utf8' as const,
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      env: { PATH: '/usr/bin:/bin' },
    };
    const [{ stdout: links }, { stdout: load }] = await Promise.all([
      exec('/usr/bin/otool', ['-L', actual], options),
      exec('/usr/bin/otool', ['-l', actual], options),
    ]);
    const expand = (p: string) =>
      p
        .replace('@loader_path', path.dirname(actual))
        .replace('@executable_path', path.dirname(executable));
    const ownRpaths = [
      ...load.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g),
    ].map((m) => expand(m[1] as string));
    const rpaths = [...ownRpaths, ...inheritedRpaths];
    // otool -L also lists a dylib's install ID, which is not a dependency.
    const installId =
      /cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset/.exec(load)?.[1];
    for (const line of links.split('\n').slice(1)) {
      const match = /^\s+(.+?) \(compatibility version/.exec(line);
      if (!match) continue;
      if (match[1] === installId) continue;
      let dep = expand(match[1] as string);
      if (dep.startsWith('@rpath/')) {
        let resolved: string | undefined;
        for (const rpath of rpaths) {
          const candidate = path.join(rpath, dep.slice(7));
          try {
            await realpath(candidate);
            resolved = candidate;
            break;
          } catch {
            /* Try declared loader search order. */
          }
        }
        if (!resolved) fail('CAPABILITY_UNAVAILABLE');
        dep = resolved;
      }
      if (!path.isAbsolute(dep)) fail('CAPABILITY_UNAVAILABLE');
      await inspect(dep, rpaths);
    }
  }
  await inspect(executable);
  return files;
}
