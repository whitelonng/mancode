import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('recovers a killed owner and serializes two concurrent recovery contenders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-lock-'));
  const moduleFile = path.join(root, 'config.mjs');
  await build({
    entryPoints: ['src/gateway/config.ts'],
    outfile: moduleFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
  });
  const source = `import os from 'node:os'; import {writeFile,rm} from 'node:fs/promises'; import path from 'node:path'; os.homedir=()=>process.argv[2]; const {withGatewayLifecycleLock}=await import(process.argv[3]); await withGatewayLifecycleLock(process.argv[1],async()=>{const marker=path.join(process.argv[1],'critical');await writeFile(marker,'held',{flag:'wx'});process.stdout.write('locked\\n');if(process.argv[4]==='hold')await new Promise(()=>setInterval(()=>{},1000));else await new Promise(r=>setTimeout(r,30));await rm(marker);});`;
  const launch = (mode: string) =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        source,
        root,
        path.join(root, 'home'),
        pathToFileURL(moduleFile).href,
        mode,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const holder = launch('hold');
  try {
    const acquired = new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (data) => {
        if (String(data).includes('locked')) resolve();
      });
      holder.once('exit', () =>
        reject(new Error('Holder exited before acquiring')),
      );
    });
    await acquired;
    const exited = once(holder, 'exit');
    holder.kill('SIGKILL');
    await exited;
    await rm(path.join(root, 'critical'));
    const children = [launch('contender'), launch('contender')];
    const codes = await Promise.all(
      children.map(async (child) => {
        const [code] = await once(child, 'exit');
        return code;
      }),
    );
    expect(codes).toEqual([0, 0]);
  } finally {
    holder.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
