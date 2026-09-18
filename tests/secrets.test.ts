import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseHiddenCodePoint, secretExit } from '../src/commands/secret.js';
import { createUlid } from '../src/context/ids.js';
import {
  installAction,
  parseAction,
  prepareAction,
} from '../src/secrets/actions.js';
import { regularFile, strictJson } from '../src/secrets/io.js';
import {
  type KeyProvider,
  MacKeyProvider,
} from '../src/secrets/key-provider.js';
import { validateInput } from '../src/secrets/resolve.js';
import { runSecret } from '../src/secrets/run.js';
import {
  type ActionSpec,
  LIMITS,
  SecretError,
  name,
  text,
} from '../src/secrets/types.js';
import { Vault, type VaultContext, catalogue } from '../src/secrets/vault.js';

class MemoryKeys implements KeyProvider {
  values = new Map<string, Buffer>();
  async get(id: string, create: boolean) {
    if (!this.values.has(id)) {
      if (!create) throw new SecretError('KEYSTORE_UNAVAILABLE');
      this.values.set(id, randomBytes(32));
    }
    return Buffer.from(this.values.get(id) ?? Buffer.alloc(0));
  }
}
let root: string;
let context: VaultContext;
let keys: MemoryKeys;
let spec: ActionSpec;
const canary = 'synthetic-秘密-0123456789';
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'mancode-secrets-')),
  );
  keys = new MemoryKeys();
  context = {
    directory: path.join(root, 'vault'),
    workspaceId: createUlid(),
    keys,
  };
  await mkdir(path.join(root, 'package'));
  await writeFile(
    path.join(root, 'package', 'main.cjs'),
    `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const v=JSON.parse(s);console.log(v.credentials.token);console.error(Buffer.from(v.credentials.token).toString('base64'));if(v.data.subject!=='test'||!v.credentials.token)process.exitCode=1;});`,
  );
  spec = {
    schemaVersion: 1,
    name: 'notice',
    version: '1',
    executable: await realpath(process.execPath),
    packagePath: path.join(root, 'package'),
    entry: 'main.cjs',
    fields: {
      subject: { type: 'string', maxBytes: 100 },
      recipient: { type: 'secret', name: 'contact' },
    },
    credentials: { token: 'contact' },
    fixed: { target: 'local-test' },
    target: 'synthetic local test',
    effects: 'No external effects',
    output: 'status-only',
    timeoutMs: 2000,
    outputBytes: 4096,
  };
  await writeFile(
    path.join(root, 'input.json'),
    JSON.stringify({ subject: 'test', recipient: { $secret: 'contact' } }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const transaction = <T>(body: (v: Vault) => Promise<T>) =>
  Vault.transaction(context, true, body);
async function setup() {
  await transaction((v) => v.set('contact', 'text', 'Test value', canary));
  await transaction(async (v) =>
    installAction(v, await prepareAction(v, parseAction(spec))),
  );
}
const run = (signal?: AbortSignal) =>
  runSecret(context, 'notice', path.join(root, 'input.json'), signal);

describe.skipIf(process.platform === 'win32')(
  'Secrets authenticated storage',
  () => {
    it('keeps values encrypted and lists only minimal metadata without asking the keystore', async () => {
      await transaction((v) => v.set('contact', 'text', 'neutral', canary));
      const raw = await readFile(
        path.join(context.directory, 'vault.json'),
        'utf8',
      );
      expect(raw).not.toContain(canary);
      expect(await catalogue(context)).toMatchObject({
        items: [
          {
            name: 'contact',
            type: 'text',
            description: 'neutral',
            actions: [],
          },
        ],
      });
      const unavailable = {
        ...context,
        keys: {
          get: async () => {
            throw new SecretError('KEYSTORE_UNAVAILABLE');
          },
        },
      };
      expect(await catalogue(unavailable)).toMatchObject({
        items: [{ name: 'contact' }],
      });
      await expect(
        Vault.transaction(unavailable, false, async (v) => v.secret('contact')),
      ).rejects.toThrow('KEYSTORE_UNAVAILABLE');
      expect(
        await readFile(path.join(context.directory, 'vault.json'), 'utf8'),
      ).toBe(raw);
    });
    it.each([
      'email',
      'phone',
      'name',
      'address',
      'account',
      'password',
      'api-key',
      'text',
    ] as const)('stores %s including bounded Unicode', async (type) => {
      const value =
        type === 'email'
          ? 'fixture@example.test'
          : type === 'phone'
            ? '+1 555 0100'
            : '合成\n多行';
      await transaction((v) => v.set('contact', type, 'neutral', value));
      await transaction(async (v) =>
        expect(v.secret('contact').value).toBe(value),
      );
    });
    it.each(['tag', 'data', 'nonce', 'entryId'])(
      'rejects tampered %s without partial plaintext',
      async (field) => {
        await transaction((v) => v.set('contact', 'text', 'neutral', canary));
        const file = path.join(context.directory, 'vault.json');
        const v = JSON.parse(await readFile(file, 'utf8'));
        v.records.contact[field] = 'AAAAAAAAAAAAAAAAAAAAAA==';
        await writeFile(file, JSON.stringify(v));
        await expect(
          transaction(async (v) => v.secret('contact')),
        ).rejects.toThrow('AUTHENTICATION_FAILED');
      },
    );
    it.skipIf(process.platform !== 'darwin')(
      'changes nonce and revision, making old approval unusable after update',
      async () => {
        await setup();
        const before = JSON.parse(
          await readFile(path.join(context.directory, 'vault.json'), 'utf8'),
        );
        await transaction((v) =>
          v.set('contact', 'text', 'neutral', 'new synthetic'),
        );
        const after = JSON.parse(
          await readFile(path.join(context.directory, 'vault.json'), 'utf8'),
        );
        expect(after.records.contact.nonce).not.toBe(
          before.records.contact.nonce,
        );
        expect(await run()).toMatchObject({
          status: 'rejected',
          code: 'ACTION_CHANGED',
        });
        expect((await catalogue(context)).actions).toEqual([]);
      },
    );
    it.skipIf(process.platform !== 'darwin')(
      'removes bindings and rejects absent or cross-project records',
      async () => {
        await setup();
        await transaction((v) => v.remove('contact'));
        expect(await run()).toMatchObject({ code: 'ACTION_NOT_APPROVED' });
        await expect(
          Vault.transaction(
            { ...context, workspaceId: createUlid() },
            false,
            async () => {},
          ),
        ).rejects.toThrow('AUTHENTICATION_FAILED');
      },
    );
    it('rejects competing writes instead of losing updates', async () => {
      await transaction(async () => {
        await expect(
          transaction((v) => v.set('other', 'text', 'neutral', 'value')),
        ).rejects.toThrow('MANCODE_LOCK_HELD');
      });
    });
    it('retains the previous authority when ciphertext cannot be written', async () => {
      await transaction((v) => v.set('contact', 'text', 'neutral', canary));
      const before = await readFile(path.join(context.directory, 'vault.json'));
      await transaction(async (v) => {
        await chmod(context.directory, 0o500);
        try {
          await expect(
            v.set('contact', 'text', 'neutral', 'replacement'),
          ).rejects.toMatchObject({ code: 'EACCES' });
        } finally {
          await chmod(context.directory, 0o700);
        }
      });
      expect(
        await readFile(path.join(context.directory, 'vault.json')),
      ).toEqual(before);
      await writeFile(
        path.join(context.directory, 'vault.json.interrupted.tmp'),
        '{"partial":"ciphertext-only',
      );
      await transaction(async (v) =>
        expect(v.secret('contact').value).toBe(canary),
      );
    });
    it('keeps committed authority when registry refresh fails and rebuilds the cache', async () => {
      await transaction((v) => v.set('contact', 'text', 'neutral', canary));
      const registry = path.join(context.directory, 'registry.json');
      await rm(registry);
      await mkdir(registry, { mode: 0o700 });
      await expect(
        transaction((v) => v.set('contact', 'text', 'neutral', 'replacement')),
      ).rejects.toBeDefined();
      await transaction(async (v) =>
        expect(v.secret('contact').value).toBe('replacement'),
      );
      await rm(registry, { recursive: true });
      await transaction((v) => v.set('second', 'text', 'neutral', 'another'));
      expect((await catalogue(context)).items).toHaveLength(2);
    });
    it.skipIf(process.platform !== 'darwin')(
      'never authorizes from a forged catalogue or unauthenticated action',
      async () => {
        await setup();
        await writeFile(
          path.join(context.directory, 'registry.json'),
          JSON.stringify({
            workspaceId: context.workspaceId,
            items: [],
            actions: [{ name: 'forged', approved: true }],
          }),
        );
        expect(
          await runSecret(context, 'forged', path.join(root, 'input.json')),
        ).toMatchObject({ code: 'ACTION_NOT_APPROVED' });
        const file = path.join(context.directory, 'vault.json');
        const value = JSON.parse(await readFile(file, 'utf8'));
        value.actions.notice.data = 'e30=';
        await writeFile(file, JSON.stringify(value));
        expect(await run()).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      },
    );
    it('fails before plaintext fallback when the key backend fails', async () => {
      context.keys = {
        get: async () => {
          throw new SecretError('KEYSTORE_UNAVAILABLE');
        },
      };
      await expect(
        transaction((v) => v.set('contact', 'text', 'neutral', canary)),
      ).rejects.toThrow('KEYSTORE_UNAVAILABLE');
      await expect(
        readFile(path.join(context.directory, 'vault.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);

describe('Secrets parser and fixed template boundary', () => {
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,}',
    '{/*x*/"a":1}',
    '{"__proto__":{}}',
    '{"constructor":1}',
    '[',
    JSON.stringify('x'.repeat(LIMITS.input)),
  ])('rejects invalid JSON before use %#', (source) =>
    expect(() => strictJson(Buffer.from(source))).toThrow('INPUT_INVALID'),
  );
  it('rejects malformed UTF-8 and excessive depth', () => {
    expect(() => strictJson(Buffer.from([0xff]))).toThrow();
    expect(() =>
      strictJson(Buffer.from(`${'['.repeat(17)}0${']'.repeat(17)}`)),
    ).toThrow();
  });
  it('rejects links and non-ordinary input files', async () => {
    await symlink(path.join(root, 'input.json'), path.join(root, 'link'));
    await expect(regularFile(path.join(root, 'link'), 100)).rejects.toThrow();
    await expect(regularFile(root, 100)).rejects.toThrow();
  });
  it.each([
    { subject: { $secret: 'contact' }, recipient: { $secret: 'contact' } },
    { subject: 'test', recipient: { $secret: 'other' } },
    { subject: 'test', recipient: { $secret: 'contact', extra: 1 } },
    {
      subject: 'test',
      recipient: { $secret: 'contact' },
      url: 'https://example.test',
    },
    { subject: 'test' },
  ])('rejects unapproved input %#', (input) =>
    expect(() => validateInput(spec, input)).toThrow(),
  );
  it.skipIf(process.platform === 'win32')(
    'rejects arbitrary shell/eval and extra specification fields',
    async () => {
      expect(() => parseAction({ ...spec, args: ['-e', 'evil'] })).toThrow();
      await transaction((v) => v.set('contact', 'text', 'neutral', canary));
      await expect(
        transaction((v) =>
          prepareAction(v, { ...spec, executable: '/bin/sh' }),
        ),
      ).rejects.toThrow('CAPABILITY_UNAVAILABLE');
      expect(() => parseAction({ ...spec, entry: '../evil' })).toThrow();
      expect(() => parseAction({ ...spec, timeoutMs: 300001 })).toThrow();
    },
  );
  it('erases a full UTF-8 character without exposing buffered input', () => {
    const chunks = [...Buffer.from('a中')].map((byte) => Buffer.from([byte]));
    expect(eraseHiddenCodePoint(chunks)).toBe(3);
    expect(Buffer.concat(chunks).toString()).toBe('a');
  });
  it.skipIf(process.platform === 'win32')(
    'keeps unrelated ciphertext unopened during management updates',
    async () => {
      await transaction((v) => v.set('contact', 'text', 'neutral', canary));
      const file = path.join(context.directory, 'vault.json');
      const value = JSON.parse(await readFile(file, 'utf8'));
      value.records.contact.tag = 'AAAAAAAAAAAAAAAAAAAAAA==';
      await writeFile(file, JSON.stringify(value));
      await transaction((v) =>
        v.set('second', 'text', 'neutral', 'synthetic-other'),
      );
      await expect(
        transaction(async (v) => v.secret('contact')),
      ).rejects.toThrow('AUTHENTICATION_FAILED');
    },
  );
  it('validates bounded names and secret strings', () => {
    for (const n of ['../bad', 'A', 'prototype', 'constructor', 'x'.repeat(65)])
      expect(() => name(n)).toThrow();
    expect(() => text('x'.repeat(16385), 16384)).toThrow();
    expect(() => text('\ud800')).toThrow();
    expect(name('contact-email')).toBe('contact-email');
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'Secrets executor lifecycle',
  () => {
    it('uses stdin, suppresses all raw output, and returns only a fixed receipt', async () => {
      await setup();
      const receipt = await run();
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        action: 'notice',
        status: 'executor_succeeded',
      });
      expect(JSON.stringify(receipt)).not.toContain(canary);
      expect(
        await readFile(path.join(context.directory, 'audit.jsonl'), 'utf8'),
      ).not.toContain(canary);
    });
    it('uses the installed snapshot when the original candidate changes', async () => {
      await setup();
      await writeFile(
        path.join(root, 'package/main.cjs'),
        'throw new Error("changed");',
      );
      expect(await run()).toMatchObject({ status: 'executor_succeeded' });
    });
    it('invalidates a changed installed dependency', async () => {
      await setup();
      await transaction(async (v) => {
        const a = v.action('notice');
        const file = path.join(
          context.directory,
          'executors',
          a.installId,
          'package/main.cjs',
        );
        await chmod(file, 0o600);
        await writeFile(file, 'process.exit(0)');
      });
      expect(await run()).toMatchObject({ code: 'ACTION_CHANGED' });
    });
    it.each(['node', 'libidentity.dylib'])(
      'rejects a changed native runtime identity: %s',
      async (changed) => {
        const native = path.join(root, 'native');
        await mkdir(native);
        await writeFile(
          path.join(native, 'identity.c'),
          'int identity(void){return 0;}',
        );
        await writeFile(
          path.join(native, 'main.c'),
          'int identity(void); int main(void){return identity();}',
        );
        execFileSync(
          '/usr/bin/clang',
          [
            '-dynamiclib',
            'identity.c',
            '-o',
            'libidentity.dylib',
            '-Wl,-install_name,@rpath/libidentity.dylib',
          ],
          { cwd: native, stdio: 'pipe' },
        );
        execFileSync(
          '/usr/bin/clang',
          [
            'main.c',
            '-L.',
            '-lidentity',
            '-Wl,-rpath,@executable_path',
            '-o',
            'node',
          ],
          { cwd: native, stdio: 'pipe' },
        );
        spec.executable = path.join(native, 'node');
        await setup();
        await appendFile(path.join(native, changed), Buffer.from([0]));
        expect(await run()).toMatchObject({
          status: 'rejected',
          code: 'ACTION_CHANGED',
        });
      },
    );
    it('does not pass unrelated credentials or raw errors through the runner', async () => {
      const previous = process.env.MANCODE_SYNTHETIC_CANARY;
      process.env.MANCODE_SYNTHETIC_CANARY = canary;
      try {
        await writeFile(
          path.join(root, 'package/main.cjs'),
          `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const value=JSON.parse(s).credentials.token;if(process.env.MANCODE_SYNTHETIC_CANARY||JSON.stringify(process.argv).includes(value)||JSON.stringify(process.env).includes(value))process.exit(1);console.error('synthetic-error');});`,
        );
        await setup();
        expect(await run()).toMatchObject({ status: 'executor_succeeded' });
      } finally {
        // biome-ignore lint/performance/noDelete: assigning undefined creates the literal environment value "undefined".
        if (previous === undefined) delete process.env.MANCODE_SYNTHETIC_CANARY;
        else process.env.MANCODE_SYNTHETIC_CANARY = previous;
      }
    });
    it.each([
      ['timeout', 'setInterval(()=>{},1000)', 'EXECUTOR_TIMEOUT'],
      [
        'output',
        "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)",
        'OUTPUT_LIMIT',
      ],
      [
        'failure',
        "throw new Error('synthetic-private-detail')",
        'EXECUTOR_FAILED',
      ],
    ] as const)(
      'handles %s without retries or raw exceptions',
      async (_case, code, expected) => {
        await writeFile(path.join(root, 'package/main.cjs'), code);
        spec.timeoutMs = 200;
        await setup();
        expect(await run()).toMatchObject({
          status: 'outcome_unknown',
          code: expected,
        });
      },
    );
    it('honors cancellation before decrypting', async () => {
      await setup();
      const c = new AbortController();
      c.abort();
      expect(await run(c.signal)).toMatchObject({
        status: 'rejected',
        code: 'CANCELLED',
      });
    });
    it('revokes an approved action', async () => {
      await setup();
      await transaction((v) => v.removeAction('notice'));
      expect(await run()).toMatchObject({ code: 'ACTION_NOT_APPROVED' });
    });
    it('returns stable exit classes', () => {
      expect(secretExit()).toBe(0);
      expect(secretExit('INPUT_INVALID')).toBe(2);
      expect(secretExit('EXECUTOR_FAILED')).toBe(3);
      expect(secretExit('CANCELLED')).toBe(4);
      expect(secretExit('KEYSTORE_UNAVAILABLE')).toBe(5);
    });
    it('does not claim non-macOS Keychain support', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      await expect(new MacKeyProvider().get('id', false)).rejects.toThrow(
        'CAPABILITY_UNAVAILABLE',
      );
    });
  },
);

describe.skipIf(process.platform !== 'darwin')(
  'Secrets concurrency and explicit limits',
  () => {
    it.each(['update', 'remove'])(
      'serializes %s against a running authorized snapshot',
      async (operation) => {
        const marker = path.join(root, 'started');
        await writeFile(
          path.join(root, 'package/main.cjs'),
          `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{if(JSON.parse(s).credentials.token!==${JSON.stringify(canary)})process.exitCode=1;},500);});`,
        );
        await setup();
        const pending = run();
        await vi.waitFor(
          async () => expect(await readFile(marker, 'utf8')).toBe('started'),
          { timeout: 5000 },
        );
        const mutate = (v: Vault) =>
          operation === 'update'
            ? v.set('contact', 'text', 'neutral', 'rotated')
            : v.remove('contact');
        await expect(transaction(mutate)).rejects.toThrow('MANCODE_LOCK_HELD');
        expect(await pending).toMatchObject({ status: 'executor_succeeded' });
        await transaction(mutate);
        expect(await run()).toMatchObject({
          status: 'rejected',
          code:
            operation === 'update' ? 'ACTION_CHANGED' : 'ACTION_NOT_APPROVED',
        });
      },
    );
    it('reports unknown after an external effect and leaves later target readback outside protection', async () => {
      let submitted = '';
      let writes = 0;
      const server = createServer((req, res) => {
        if (req.method === 'POST') {
          writes++;
          let body = '';
          req.on('data', (b) => {
            body += b;
          });
          req.on('end', () => {
            submitted = JSON.parse(body).credentials.token;
            res.end('ok');
          });
        } else res.end(submitted);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        await writeFile(
          path.join(root, 'package/main.cjs'),
          `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',async()=>{await fetch(${JSON.stringify(url)},{method:'POST',body:s,redirect:'error'});setInterval(()=>{},1000);});`,
        );
        spec.timeoutMs = 400;
        await setup();
        expect(await run()).toMatchObject({
          status: 'outcome_unknown',
          code: 'EXECUTOR_TIMEOUT',
        });
        expect(writes).toBe(1);
        expect(await (await fetch(url)).text()).toBe(canary);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      }
    });
    it('uses its input snapshot after the file is replaced', async () => {
      await setup();
      const original = keys.get.bind(keys);
      keys.get = async (id, create) => {
        await writeFile(path.join(root, 'input.json'), '{}');
        return original(id, create);
      };
      expect(await run()).toMatchObject({ status: 'executor_succeeded' });
    });
    it('cancels a running executor and its ordinary child group', async () => {
      const marker = path.join(root, 'child-marker');
      const ready = path.join(root, 'child-ready');
      await writeFile(
        path.join(root, 'package/main.cjs'),
        `const {spawn}=require('node:child_process');process.stdin.resume();process.stdin.on('end',()=>{spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1500)`)}],{stdio:'inherit'});setInterval(()=>{},1000);});`,
      );
      spec.timeoutMs = 10000;
      await setup();
      const c = new AbortController();
      const pending = run(c.signal);
      try {
        await vi.waitFor(
          async () => expect(await readFile(ready, 'utf8')).toBe('ready'),
          { timeout: 5000 },
        );
        c.abort();
        expect(await pending).toMatchObject({
          status: 'outcome_unknown',
          code: 'CANCELLED',
        });
        await new Promise((resolve) => setTimeout(resolve, 1700));
        await expect(readFile(marker)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        c.abort();
        await pending;
      }
    });
    it('does not claim stdout suppression prevents an executor writing plaintext', async () => {
      const output = path.join(root, 'intentional-boundary.txt');
      await writeFile(
        path.join(root, 'package/main.cjs'),
        `let x='';process.stdin.on('data',b=>x+=b);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.parse(x).credentials.token);});`,
      );
      await setup();
      expect(await run()).toMatchObject({ status: 'executor_succeeded' });
      expect(await readFile(output, 'utf8')).toBe(canary); // S19: explicit non-sandbox boundary.
    });
    it('declares authenticated old-snapshot rollback outside V1 protection', async () => {
      await setup();
      const file = path.join(context.directory, 'vault.json');
      const old = await readFile(file);
      await transaction((v) => v.removeAction('notice'));
      expect(await run()).toMatchObject({ code: 'ACTION_NOT_APPROVED' });
      await writeFile(file, old);
      expect(await run()).toMatchObject({ status: 'executor_succeeded' });
    });
  },
);
