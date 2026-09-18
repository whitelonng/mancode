import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliProgram } from '../src/cli.js';
import { privacyStatus } from '../src/commands/privacy.js';
import { initializeV3Project } from '../src/commands/v3-init.js';

afterEach(() => vi.restoreAllMocks());
describe('model gateway retirement', () => {
  it.each(['enable', 'disable', 'status', 'doctor', 'run', 'print-config'])(
    'rejects the retired gateway %s command before actions',
    async (action) => {
      const cli = createCliProgram()
        .exitOverride()
        .configureOutput({ writeErr: () => {} });
      for (const command of cli.commands)
        command.exitOverride().configureOutput({ writeErr: () => {} });
      await expect(
        cli.parseAsync(['privacy', 'gateway', action], { from: 'user' }),
      ).rejects.toMatchObject({ code: 'commander.unknownCommand' });
    },
  );
  it.each(['--gateway-privacy', '--no-gateway-privacy'])(
    'rejects %s before initialization',
    async (flag) => {
      const cli = createCliProgram()
        .exitOverride()
        .configureOutput({ writeErr: () => {} });
      for (const command of cli.commands)
        command.exitOverride().configureOutput({ writeErr: () => {} });
      await expect(
        cli.parseAsync(['init', flag, '--empty', '--yes'], { from: 'user' }),
      ).rejects.toMatchObject({ code: 'commander.unknownOption' });
    },
  );
  it('does not consult retired user settings or network state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retirement-'));
    try {
      await initializeV3Project({ projectRoot: root });
      const home = vi.spyOn(os, 'homedir').mockImplementation(() => {
        throw new Error('old directory inaccessible');
      });
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('unexpected probe'));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await privacyStatus(root, { json: true })).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        schemaVersion: 2,
      });
      expect(home).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('ignores a live obsolete endpoint and preserves shared errors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retirement-port-'));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      await initializeV3Project({ projectRoot: root });
      const old = path.join(root, 'home/.mancode/privacy-gateway/obsolete');
      await fs.mkdir(old, { recursive: true });
      await fs.writeFile(
        path.join(old, 'runtime.json'),
        JSON.stringify({ port: (server.address() as { port: number }).port }),
      );
      vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await privacyStatus(root, { json: true })).toBe(0);
      expect(requests).toBe(0);
      await fs.writeFile(path.join(root, '.mancode/schema.json'), '{}');
      expect(await privacyStatus(root, { json: true })).toBe(2);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
