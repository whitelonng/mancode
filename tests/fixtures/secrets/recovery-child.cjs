// Synthetic-only test child. Faults are injected in this process, never in production.
const fs = require('node:fs/promises');
const path = require('node:path');
const [moduleFile, directory, workspaceId, operation, phase, failure, clockShift] =
  process.argv.slice(2);
if (clockShift === 'expired') {
  // Advance only this test process's clock; the owner PID and SIGKILL are real.
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + 360000]));
    }
    static now() {
      return RealDate.now() + 360000;
    }
  };
}
const vaultFile = path.join(directory, 'vault.json');
const registryFile = path.join(directory, 'registry.json');
let reached = false;
async function fault() {
  reached = true;
  if (failure === 'error') {
    throw Object.assign(new Error('synthetic filesystem failure'), { code: 'EIO' });
  }
  process.stdout.write('ready\n');
  return new Promise(() => setInterval(() => {}, 1000));
}
if (phase !== 'none') {
  const open = fs.open;
  fs.open = async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).startsWith(`${vaultFile}.`) && String(file).endsWith('.tmp')) {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...options) => {
        if (phase === 'partial-write') {
          await writeFile(data.slice(0, Math.floor(data.length / 2)), ...options);
          return fault();
        }
        return writeFile(data, ...options);
      };
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        if (phase === 'file-synced') return fault();
      };
    }
    if (String(file) === directory && phase === 'directory-sync') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        // The rename has completed; fail before the parent directory sync.
        if (!reached) return fault();
        return sync();
      };
    }
    if (String(file).startsWith(`${registryFile}.`) && phase === 'registry-write') {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...options) => {
        await writeFile(data.slice(0, Math.floor(data.length / 2)), ...options);
        return fault();
      };
    }
    return handle;
  };
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === vaultFile && phase === 'before-rename') return fault();
    await rename(from, to);
    if (to === vaultFile && phase === 'after-rename') return fault();
  };
}
const { Vault, catalogue } = require(moduleFile);
const context = {
  directory, workspaceId,
  keys: { get: async () => Buffer.alloc(32, 83) },
};
async function main() {
  if (operation === 'update' || operation === 'remove') {
    await Vault.transaction(context, false, v => operation === 'remove'
      ? v.remove('contact') : v.set('contact', 'text', 'neutral', 'synthetic-new'));
    return { mutation: 'committed', reached };
  }
  const result = await Vault.transaction(context, false, async v => {
    const secret = v.secret('contact');
    const metadata = v.metadata('contact');
    const action = v.action('notice');
    let authorization = 'valid';
    try { v.checkBindings(action); } catch (error) { authorization = error.code; }
    return {
      value: secret.value, revision: secret.revision,
      metadataRevision: metadata.revision,
      entryIdMatches: secret.entryId === metadata.entryId &&
        action.bindings.contact.entryId === secret.entryId,
      approvalRevision: action.bindings.contact.revision, authorization,
    };
  });
  if (operation === 'repair') {
    await Vault.transaction(context, false,
      v => v.set('second', 'text', 'neutral', 'synthetic-second'));
    result.catalogue = await catalogue(context);
  }
  return result;
}
main().then(result => console.log(JSON.stringify(result)), error => {
  console.log(JSON.stringify({ error: error.code ?? error.message, reached }));
  process.exitCode = 2;
});
