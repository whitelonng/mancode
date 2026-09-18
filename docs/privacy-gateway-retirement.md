# Model gateway retirement

The local model proxy is retired. New installations cannot forward, redact or restore model requests. Shared protection and scan/preview remain available, including their rule-source and license notices. This decision reduces an extra data-processing boundary; it is not a claim that a leak occurred.

`privacy gateway` and both `init --gateway-privacy` flags now fail with a nonzero parameter error. `privacy status --json` changes its top-level output to `{schemaVersion: 2, shared}`. Consumers must stop expecting `gateway`; the shared object and project disk schema are unchanged.

## Before upgrading an existing gateway setup

1. Pause new requests to the old gateway. Stop the confirmed instance from its original foreground terminal, or use the **old CLI** in that checkout: `mancode privacy gateway disable --json`. Confirm that the instance actually exited. Package upgrades do not stop old processes. Never kill a process solely from a saved PID or kill all Node processes.
2. Restore the client connection you previously chose. Remove only gateway-specific base URLs, local tokens and headers. The new CLI neither inspects nor rewrites external provider, subscription or login configuration.
3. Upgrade and check normal workflow commands and `privacy status --json`.
4. Optionally inspect and manually remove the exact obsolete checkout directory under `~/.mancode/privacy-gateway/`. It may contain `config.json`, `runtime.json` and `config-locks/`. Do not delete the whole user or project `.mancode` directory. The new CLI never reads, migrates or deletes this old data.

The old local `accessToken` is different from an upstream API key. Upstream keys came from process environment variables; do not remove variables still used by other tools. Deleting a file does not revoke a remote credential or erase backups. If there is evidence of exposure, revoke the credential at its actual service.

The old mapping was in memory, not a disk vault. There is no automatic import into Secrets. Git history, previously published packages and already running old instances are not erased by this retirement.
