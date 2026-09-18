# Secrets V1

Secrets stores protected text locally and hands it to a reviewed execution package through JSON stdin. No model API key, model gateway, server port or provider change is required. The executor and destination can see plaintext. This is exposure reduction, not isolation from malicious code running as your user.

## Availability

The first backend is macOS Keychain through the optional native `@napi-rs/keyring` 2.1.0 binding (MIT). Other platforms, missing native binaries and unavailable Keychain return capability/keystore errors. Ordinary tasks and `privacy scan/preview/status` do not load Keychain. A successful local test does not establish all host or OS support.

V1 executors are self-contained **Node entry packages**, not arbitrary shell commands or Python programs. Node uses a fixed installation reference; its executable and non-system Mach-O library identities are bound and rechecked. System libraries remain part of the trusted OS. Candidate packages are copied to independent private installation snapshots, with at most 256 files, 16 MiB total and eight directory levels. Symlinks and package paths escaping the snapshot are unsupported. Updating the source candidate does not change the approved snapshot; changing the installed snapshot or runtime invalidates execution. Review imports, native dependencies and all side effects before approval. Dependencies outside the declared package are unsupported.

## Human setup

In an independent local terminal, from an initialized project:

```sh
mancode secret set contact-email
```

Choose a type and neutral purpose. Enter the protected value without echo; Ctrl+D finishes, including multiline input, and Ctrl+C cancels. There is no `--value`, stdin import, plaintext get/reveal/decrypt/export or environment-key fallback. TTY is an interaction convention, not proof of a trusted human. Updates create a new revision and invalidate old approvals.

Create a candidate action JSON using only references and non-sensitive configuration. Replace the two absolute installation paths below with actual paths; do not place secrets in the specification:

```json
{
  "schemaVersion": 1,
  "name": "send-notice",
  "version": "1",
  "executable": "/absolute/installed/node",
  "packagePath": "/absolute/reviewed/package",
  "entry": "main.cjs",
  "fields": {
    "recipient": { "type": "secret", "name": "contact-email" },
    "subject": { "type": "string", "maxBytes": 200 },
    "body": { "type": "string", "maxBytes": 4096 }
  },
  "credentials": {},
  "fixed": { "operation": "send-notice" },
  "target": "Reviewed notification system",
  "effects": "Sends one notification; no automatic retry",
  "output": "status-only",
  "timeoutMs": 60000,
  "outputBytes": 262144
}
```

All declared input fields are required; extra fields are rejected. Flat fields support string/maxBytes, integer, boolean and an exact secret binding. Nested business schemas and optional fields are not supported in V1. Fixed configuration and credential slots cannot be overridden through input. Review the program and its full dependency/configuration chain, destination, redirects, proxy behavior, log and file outputs. A target label is not a firewall.

```sh
mancode secret action approve --file send-notice.action.json
```

The command displays the exact captured package/runtime identity, project, secret revisions, input requirements, fixed configuration, destination, side effects and budgets. Type `approve` to confirm that snapshot. Candidate scripts do not gain access automatically. Timeout must be explicit, at most 300 seconds; 60 seconds is recommended. Output budget is at most 256 KiB.

## Agent usage

```sh
mancode secret list --json
mancode secret action list --json
mancode secret run send-notice --input request.json --json
```

Example request:

```json
{"recipient":{"$secret":"contact-email"},"subject":"Synthetic test","body":"Test message"}
```

The program receives one UTF-8 JSON object with separate `data`, `credentials` and `fixed` namespaces. Only approved reference slots are replaced. An executor must not turn secrets into downstream argv/env, workspace files or logs. It must not daemonize or escape the process group. Raw stdout/stderr are discarded within the approved output budget.

A successful receipt reports `executor_succeeded`, which means protocol exit 0, not proof of delivery. Failures after start report `outcome_unknown`; do not automatically retry an operation that may already have happened. Exit classes: 0 success, 2 rejected/storage/authentication failure, 3 executor failure/output limit, 4 timeout/cancellation, 5 platform/keystore unavailable. Diagnostics use fixed codes only.

Local host acceptance used Codex 0.153.4 and Claude Code 2.1.142 with synthetic credentials against a reviewed local Ticket API fixture. Codex's default workspace sandbox rejected storage access before the request; the exact test command succeeded through its normal approval workflow. Host permission to reach local storage, Keychain and the intended target is required. Do not disable sandboxing globally to make a call work. These observations do not establish support for cloud hosts or all host configurations.

## Storage and lifecycle

Encrypted records and authenticated encrypted approvals live under the current user's macOS Application Support directory, separately per workspace identity. The master key lives only in Keychain. Neither is placed in project Git or Context Pack. A minimal registry is a display cache; it grants no authority. Management operations maintain separately authenticated catalogue metadata without decrypting unrelated values. The audit rotates at 256 KiB and contains only random run IDs, action IDs, fixed events and coarse timestamps.

Writes use the existing exclusive owner lock and atomic ciphertext replacement. The vault is the single authority; if registry refresh fails after vault commit, the operation reports an error, execution follows the committed vault and a later successful management operation rebuilds the cache. A failed ciphertext write leaves the previous vault authoritative; orphan temporary files contain ciphertext only. Dead locks are reclaimed only under the existing owner-death and lease rules. Do not delete live locks.

Calls currently serialize per workspace vault. Pause related calls before rotation. A running action keeps its approved snapshot; removal/updates block calls whose authorization checks happen after the commit. Already disclosed data and external actions cannot be recalled.

```sh
mancode secret remove contact-email
mancode secret action remove send-notice
```

Both require explicit local confirmation. Removal does not revoke remote API keys or erase backups. Old executor snapshots may remain on disk without active approval; they contain code, not secret values. V1 has no plaintext backup or cross-device export. Losing the Keychain key can make ciphertext unrecoverable; re-enter data instead of expecting a plaintext fallback.

See [security boundaries](secrets-security.md) and [gateway retirement](privacy-gateway-retirement.md).
