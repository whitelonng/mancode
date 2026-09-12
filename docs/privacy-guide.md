# Privacy protection

mancode offers three separate surfaces: text scanning, project-shared content protection, and an optional local model gateway. New capabilities are opt-in. Existing basic shared-content checks continue to apply.

## Scan and preview

```sh
mancode privacy scan --file notes.txt --profile shared --json
cat notes.txt | mancode privacy scan --json
mancode privacy preview --file notes.txt --output notes.redacted.txt --json
```

Pass sensitive text in a UTF-8 file or stdin, never as a command-line argument. The scanner accepts up to 1 MiB and reports only rule/category, UTF-16 offsets, finding count and completion state. Scan exits with 0 for no findings, 1 for findings and 2 for an input/scan error. Preview exits with 0 when the new copy is fully written; findings are expected and do not make a successful preview fail.

Preview never overwrites an existing target or source. It writes a separate irreversible copy, restricts POSIX permissions to 0600, and publishes only after a complete scan and successful write. It does not rewrite task authority. If the input is too large, malformed UTF-8, contains invalid text, exceeds the finding/time budget or cannot be read, no preview is published. Error messages contain safe reason codes and selected system error codes, without paths or original text.

Detection uses explicit shapes plus selected checksums. A clean result does not prove that all credentials or personal data are absent. Unsupported identifier formats, encoded content and application-specific secrets may require additional rules. Rule sources and limitations are documented in [privacy-rule-sources.md](privacy-rule-sources.md).

Named credentials include assignments such as `client_password="synthetic phrase"` and `DB_PASSWORD=synthetic-value`. Supported quoted values are protected through the matching closing quote, including spaces and escaped quotes; an unfinished quote protects the remaining input. Metrics such as `token_count` and `password_length` are not credential names. This same scanner protects previews, enhanced shared writes and supported gateway prose fields.

## First initialization

```sh
mancode init --platform codex --shared-privacy --gateway-privacy
mancode init --platform codex --no-shared-privacy --no-gateway-privacy --yes
```

Interactive first initialization asks separately about shared enhanced protection and this user's gateway preference for the current checkout. Choose `q` to cancel before the new project is written. Explicit flags answer only their corresponding question. Supplying both positive and negative forms is a parameter error.

Non-interactive first initialization leaves unspecified enhancements disabled. `--yes` skips questions and does not enable privacy features or redirect network traffic. Repeating `init`, including with opposite flags, preserves existing choices. Legacy initialization rejects these options instead of implicitly migrating authority.

Shared policy participates in the journaled project initialization. Gateway settings are written afterward to user-local storage; if that step fails, the project remains initialized and the command reports the local-settings failure. Retry the gateway command directly. Enabling a gateway preference does not start a server or change a client provider.

## Activate shared policy

```sh
mancode privacy status --json
mancode privacy enable --dry-run --json
mancode privacy enable --expected-revision 0 --session <session-id> --client codex --json
mancode privacy disable --expected-revision 1 --session <session-id> --client codex --json
mancode privacy policy apply --file candidate.json --expected-revision 2 --session <session-id> --client codex --json
```

Dry-run scans current shared files and, for git-ref coordination, the current remote authority. It performs no authority mutation and returns 2 when activation is blocked. Results report safe counts and reasons without sensitive values. Candidate JSON contains exactly `schemaVersion`, `enabled`, `rulesetVersion`, and `enabledRuleIds`; the current ruleset is `mancode-sensitive-text:1`, and rule IDs are listed in `src/privacy/rules.ts`. Updates require an active maintenance session, the expected policy revision (zero before activation), and a clean operation baseline. The same `--operation-id` can resume an interrupted operation without creating a competing policy.

Mutable sensitive shared content must be cleaned through its owning workflow before enabling. Existing sensitive confirmed decisions and checkpoint files remain unchanged; their digests enter a permanent exclusion ledger so future context output, shared writes, sync and recovery cannot re-export those entities, including after disabling enhanced rules. A mutable `summary.md` copy of a historical checkpoint is separately scanned and must also be cleaned.

Remote actor profiles, claims and handoffs are immutable coordination history. If they match the proposed rules, dry-run returns `retain_basic_or_new_workspace`: retain basic protection, or explicitly create a new workspace and migrate cleaned content through the supported workflow. Activation never rewrites these objects or deletes ownership history. A sensitive checkpoint still present in an active remote task bundle requires a new safe checkpoint and an explicit sync before activation; its remediation is `replace_checkpoint_and_sync`. Other mutable bundle content must be cleaned and synced. A clean existing git-ref workspace can upgrade in place.

The project manifest, policy and exclusions are revision/digest bound. Git-ref policy changes first use the remote manifest's CAS, then commit local authority through a recoverable journal. Concurrent changes and stale clones fail closed. Other clones must receive the tracked `.mancode/schema.json` and `.mancode/shared/context/privacy-*.json` authority files through the repository's normal checkout before their next sync. Old local caches are discarded when their policy differs. Interrupted policy writes block ordinary writes until operation recovery establishes the committed state. Disabling keeps the upgraded local/remote schema and minimum client version 0.6.5.

## Configure the optional gateway

Run these commands inside a project already initialized by `mancode init`. Gateway configuration and execution require its real workspace and checkout identity. Reading gateway status in an uninitialized directory reports missing configuration and creates no project authority.

```sh
mancode privacy gateway enable --upstream openai --env-key OPENAI_API_KEY --client-host codex-cli/0.153.4 --json
mancode privacy gateway print-config --host codex
mancode privacy gateway run
mancode privacy gateway doctor --json
mancode privacy gateway disable --json
```

Use `--upstream anthropic --env-key ANTHROPIC_API_KEY --client-host claude-code/2.1.142` and `print-config --host claude` for the corresponding Claude Code API-key flow. `run` stays in the foreground. Configuration fragments are explicit instructions for the user; mancode does not edit host provider/login settings. Host versions are checked when starting a bound gateway; an unknown host remains unverified. Keep gateway/client secrets in the documented local environment or private settings, never in command arguments or shared project files.

The gateway handles supported OpenAI Responses and Anthropic Messages HTTP/SSE text fields. Strict JSON rejects duplicate keys, invalid escapes and limit violations; unknown supported-endpoint payload shapes and processing failures fail closed. Incremental SSE restoration preserves event boundaries, typed identities, completion and usage fields. In-memory mappings have a 15-minute TTL, 4 MiB/4,096-entry bounds, and isolation by checkout, user, upstream and gateway instance; request limits are 1 MiB and eight active requests. Scanning runs outside the main event loop. Disabling allows a bounded five-second drain and then cancels remaining requests.

Supported prose fields in tool schemas are scanned; schema constraints and opaque protocol blocks are not rewritten. Executable token restoration is limited to the exact captured Claude Code 2.1.142 Read schema. Its real-host test used a synthetic temporary file under the host's ordinary permissions; other executable tools are blocked when restoration would be required. SSE audit observation follows semantic channels; `after_emit` observation is not a blocking filter. HTTP audit coverage is reported as partial and does not claim complete semantic observation.

## Shared policy and gateway boundaries

Project-shared policy is versioned authority and must be changed through the policy commands. Editing a live policy file is not a supported configuration shortcut. Disabling enhanced protection does not downgrade project format, remove history, restore redacted copies or turn off the pre-existing basic checks.

Gateway settings and mappings belong to the local user and checkout. They must not be committed with task content. A running port or `enabled: true` setting does not prove the client routes its requests through the intended instance. `routeVerified` remains false; `routeObservedAt` and the host binding describe observations by the current instance and do not establish coverage of all traffic. Unsupported protocols and processing failures must fail closed; disabling the gateway does not create a plaintext proxy or silently restore a provider configuration.

Protection covers content handled by the corresponding mancode boundary. It does not imply coverage of arbitrary Git operations, direct file access, tool-originated network traffic, images, encrypted blocks or every host connection. Real-host compatibility and production concurrency require separate evidence; see [privacy-implementation-plan.md](privacy-implementation-plan.md) for the current verified scope.
