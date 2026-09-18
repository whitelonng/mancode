import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalizeJson } from '../context/canonical.js';
import { createUlid } from '../context/ids.js';
import { acquireLocalLock } from '../runtime/local-lock.js';
import { readProjectRuntimeContext } from '../runtime/project-runtime.js';
import { atomicJson, privateDirectory, regularFile, strictJson } from './io.js';
import { type KeyProvider, MacKeyProvider } from './key-provider.js';
import {
  type ApprovedAction,
  LIMITS,
  SECRET_TYPES,
  SecretError,
  type SecretRecord,
  type SecretType,
  fail,
  name,
  record,
  text,
} from './types.js';

interface Envelope {
  entryId: string;
  nonce: string;
  tag: string;
  data: string;
}
type SecretMetadata = Omit<SecretRecord, 'value'>;
interface VaultData {
  schemaVersion: 1;
  vaultId: string;
  keyId: string;
  workspaceId: string;
  records: Record<string, Envelope>;
  actions: Record<string, Envelope>;
  catalogue: Envelope | null;
}
export interface VaultContext {
  directory: string;
  workspaceId: string;
  keys: KeyProvider;
}
export async function vaultContext(root: string): Promise<VaultContext> {
  if (process.platform !== 'darwin') fail('CAPABILITY_UNAVAILABLE');
  const runtime = await readProjectRuntimeContext(root);
  const home = await realpath(os.homedir());
  return {
    directory: path.join(
      home,
      'Library/Application Support/mancode/secrets',
      runtime.workspaceId,
    ),
    workspaceId: runtime.workspaceId,
    keys: new MacKeyProvider(),
  };
}
function aad(v: VaultData, kind: string, name: string, id: string): Buffer {
  return Buffer.from(
    canonicalizeJson({
      schemaVersion: 1,
      vaultId: v.vaultId,
      keyId: v.keyId,
      workspaceId: v.workspaceId,
      kind,
      name,
      entryId: id,
    }),
  );
}
function encrypt(
  v: VaultData,
  key: Buffer,
  kind: string,
  n: string,
  id: string,
  value: unknown,
): Envelope {
  const nonce = randomBytes(12);
  const plain = Buffer.from(JSON.stringify(value));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(v, kind, n, id));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      entryId: id,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  } finally {
    plain.fill(0);
  }
}
function decrypt<T>(
  v: VaultData,
  key: Buffer,
  kind: string,
  n: string,
  e: Envelope,
): T {
  const parts: Buffer[] = [];
  try {
    record(e, ['entryId', 'nonce', 'tag', 'data']);
    const nonce = Buffer.from(e.nonce, 'base64');
    const tag = Buffer.from(e.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) fail('AUTHENTICATION_FAILED');
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(v, kind, n, e.entryId));
    cipher.setAuthTag(tag);
    parts.push(cipher.update(Buffer.from(e.data, 'base64')));
    parts.push(cipher.final());
    const plain = Buffer.concat(parts);
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(plain),
      ) as T;
    } finally {
      plain.fill(0);
    }
  } catch (error) {
    throw new SecretError('AUTHENTICATION_FAILED', { cause: error });
  } finally {
    for (const b of parts) b.fill(0);
  }
}
export class Vault {
  private constructor(
    readonly context: VaultContext,
    private data: VaultData,
    private key: Buffer,
  ) {}
  private metadataTable(): Record<string, SecretMetadata> {
    if (!this.data.catalogue) {
      if (Object.keys(this.data.records).length) fail('AUTHENTICATION_FAILED');
      return {};
    }
    return decrypt(
      this.data,
      this.key,
      'catalogue',
      'catalogue',
      this.data.catalogue,
    );
  }
  metadata(n: string): SecretMetadata {
    name(n);
    const item = this.metadataTable()[n];
    if (!item || !this.data.records[n]) fail('SECRET_UNAVAILABLE');
    return item;
  }
  private saveMetadata(table: Record<string, SecretMetadata>): void {
    this.data.catalogue = encrypt(
      this.data,
      this.key,
      'catalogue',
      'catalogue',
      this.data.vaultId,
      table,
    );
  }
  static async transaction<T>(
    context: VaultContext,
    create: boolean,
    body: (vault: Vault) => Promise<T>,
  ): Promise<T> {
    await privateDirectory(context.directory);
    await privateDirectory(path.join(context.directory, 'locks'));
    const lock = await acquireLocalLock(
      {
        kind: 'checkout_local',
        storeId: `secrets:${context.workspaceId}`,
        root: context.directory,
        workspaceId: context.workspaceId as ReturnType<typeof createUlid>,
        checkoutId: null,
        repositoryBindingId: null,
      },
      {
        operationId: createUlid(),
        entityLockKey: 'secrets:vault',
        leaseMs: 300000,
      },
    );
    let vault: Vault | undefined;
    try {
      let data: VaultData;
      let fresh = false;
      try {
        data = strictJson(
          await regularFile(
            path.join(context.directory, 'vault.json'),
            LIMITS.vault,
            true,
          ),
          LIMITS.vault,
        ) as VaultData;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create)
          throw error;
        data = {
          schemaVersion: 1,
          vaultId: randomUUID(),
          keyId: randomUUID(),
          workspaceId: context.workspaceId,
          records: {},
          actions: {},
          catalogue: null,
        };
        fresh = true;
      }
      record(data, [
        'schemaVersion',
        'vaultId',
        'keyId',
        'workspaceId',
        'records',
        'actions',
        'catalogue',
      ]);
      if (
        data.schemaVersion !== 1 ||
        data.workspaceId !== context.workspaceId ||
        !data.records ||
        !data.actions ||
        !/^[-a-f0-9]{36}$/.test(data.keyId) ||
        !/^[-a-f0-9]{36}$/.test(data.vaultId)
      )
        fail('AUTHENTICATION_FAILED');
      const key = await context.keys.get(data.keyId, fresh);
      if (key.length !== 32) fail('KEYSTORE_UNAVAILABLE');
      vault = new Vault(context, data, key);
      return await body(vault);
    } finally {
      vault?.key.fill(0);
      await lock.release();
    }
  }
  secret(n: string): SecretRecord {
    name(n);
    const entry = this.data.records[n];
    if (!entry) fail('SECRET_UNAVAILABLE');
    const result = decrypt<SecretRecord>(
      this.data,
      this.key,
      'secret',
      n,
      entry,
    );
    if (
      result.name !== n ||
      result.entryId !== entry.entryId ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 1
    )
      fail('AUTHENTICATION_FAILED');
    return result;
  }
  action(n: string): ApprovedAction {
    name(n);
    const entry = this.data.actions[n];
    if (!entry) fail('ACTION_NOT_APPROVED');
    const a = decrypt<ApprovedAction>(this.data, this.key, 'action', n, entry);
    if (a.spec.name !== n || a.workspaceId !== this.context.workspaceId)
      fail('ACTION_NOT_APPROVED');
    return a;
  }
  async set(
    n: string,
    type: SecretType,
    description: string,
    value: string,
  ): Promise<void> {
    name(n);
    text(value, LIMITS.secret);
    text(description, 512);
    if (!SECRET_TYPES.includes(type)) fail('INPUT_INVALID');
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      fail('INPUT_INVALID');
    if (type === 'phone' && !/^\+?[0-9 ()-]{3,40}$/.test(value))
      fail('INPUT_INVALID');
    const metadata = this.metadataTable();
    const old = metadata[n];
    const next: SecretRecord = {
      entryId: old?.entryId ?? randomUUID(),
      revision: (old?.revision ?? 0) + 1,
      name: n,
      type,
      description,
      value,
    };
    this.data.records[n] = encrypt(
      this.data,
      this.key,
      'secret',
      n,
      next.entryId,
      next,
    );
    const { value: _value, ...summary } = next;
    metadata[n] = summary;
    this.saveMetadata(metadata);
    await this.commit();
  }
  async remove(n: string): Promise<void> {
    this.metadata(n);
    const metadata = this.metadataTable();
    delete metadata[n];
    this.saveMetadata(metadata);
    delete this.data.records[n];
    for (const id of Object.keys(this.data.actions)) {
      if (this.action(id).bindings[n]) delete this.data.actions[id];
    }
    await this.commit();
  }
  async approve(a: ApprovedAction): Promise<void> {
    const old = this.data.actions[a.spec.name];
    a.revision = old ? this.action(a.spec.name).revision + 1 : 1;
    this.data.actions[a.spec.name] = encrypt(
      this.data,
      this.key,
      'action',
      a.spec.name,
      randomUUID(),
      a,
    );
    await this.commit();
  }
  async removeAction(n: string): Promise<void> {
    this.action(n);
    delete this.data.actions[n];
    await this.commit();
  }
  checkBindings(a: ApprovedAction): void {
    for (const [n, binding] of Object.entries(a.bindings)) {
      const s = this.metadata(n);
      if (s.entryId !== binding.entryId || s.revision !== binding.revision)
        fail('ACTION_CHANGED');
    }
  }
  check(a: ApprovedAction): Record<string, SecretRecord> {
    this.checkBindings(a);
    const result: Record<string, SecretRecord> = Object.create(null);
    for (const [n, binding] of Object.entries(a.bindings)) {
      const s = this.secret(n);
      if (s.entryId !== binding.entryId || s.revision !== binding.revision)
        fail('ACTION_CHANGED');
      result[n] = s;
    }
    return result;
  }
  private async commit(): Promise<void> {
    const metadata = this.metadataTable();
    const items = Object.keys(this.data.records).map((n) => {
      const s = metadata[n];
      if (!s) fail('AUTHENTICATION_FAILED');
      return {
        name: n,
        type: s.type,
        description: s.description,
        actions: [] as string[],
      };
    });
    const actions = [];
    for (const n of Object.keys(this.data.actions)) {
      const a = this.action(n);
      try {
        this.checkBindings(a);
      } catch (error) {
        if (
          error instanceof SecretError &&
          ['ACTION_CHANGED', 'SECRET_UNAVAILABLE'].includes(error.code)
        )
          continue;
        throw error;
      }
      actions.push({
        name: n,
        version: a.spec.version,
        fields: a.spec.fields,
        output: 'status-only',
      });
      for (const item of items) if (a.bindings[item.name]) item.actions.push(n);
    }
    if (Buffer.byteLength(JSON.stringify(this.data)) > LIMITS.vault)
      fail('STORAGE_UNAVAILABLE');
    await atomicJson(
      path.join(this.context.directory, 'vault.json'),
      this.data,
    );
    // This cache is never used to authorize an action or decrypt a record.
    await atomicJson(path.join(this.context.directory, 'registry.json'), {
      schemaVersion: 1,
      workspaceId: this.context.workspaceId,
      items,
      actions,
    });
  }
}
export async function catalogue(
  context: VaultContext,
): Promise<{ items: unknown[]; actions: unknown[] }> {
  try {
    const st = await lstat(context.directory);
    if (st.isSymbolicLink()) fail('STORAGE_UNAVAILABLE');
    const v = strictJson(
      await regularFile(
        path.join(context.directory, 'registry.json'),
        LIMITS.vault,
        true,
      ),
      LIMITS.vault,
    ) as { workspaceId: string; items: unknown[]; actions: unknown[] };
    if (
      v.workspaceId !== context.workspaceId ||
      !Array.isArray(v.items) ||
      !Array.isArray(v.actions)
    )
      fail('STORAGE_UNAVAILABLE');
    // Cache content is untrusted: return only the documented display schema.
    const items = v.items.map((item) => {
      record(item, ['name', 'type', 'description', 'actions']);
      name(item.name);
      if (
        !SECRET_TYPES.includes(item.type as SecretType) ||
        !Array.isArray(item.actions)
      )
        fail('STORAGE_UNAVAILABLE');
      text(item.description, 512);
      return {
        name: item.name,
        type: item.type,
        description: item.description,
        actions: item.actions.map(name),
      };
    });
    const actions = v.actions.map((item) => {
      record(item, ['name', 'version', 'fields', 'output']);
      name(item.name);
      text(item.version, 80);
      if (
        item.output !== 'status-only' ||
        !item.fields ||
        typeof item.fields !== 'object' ||
        Array.isArray(item.fields)
      )
        fail('STORAGE_UNAVAILABLE');
      for (const [key, field] of Object.entries(item.fields)) {
        name(key);
        record(field, ['type', 'name', 'maxBytes']);
        if (field.type === 'secret') {
          name(field.name);
          if (field.maxBytes !== undefined) fail('STORAGE_UNAVAILABLE');
        } else if (field.type === 'string') {
          if (
            field.name !== undefined ||
            !Number.isSafeInteger(field.maxBytes) ||
            Number(field.maxBytes) < 1 ||
            Number(field.maxBytes) > LIMITS.input
          )
            fail('STORAGE_UNAVAILABLE');
        } else if (
          !['integer', 'boolean'].includes(String(field.type)) ||
          field.name !== undefined ||
          field.maxBytes !== undefined
        )
          fail('STORAGE_UNAVAILABLE');
      }
      return {
        name: item.name,
        version: item.version,
        fields: item.fields,
        output: 'status-only',
      };
    });
    return { items, actions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { items: [], actions: [] };
    throw error;
  }
}
