# Privacy protection

mancode offers text scanning and project-shared content protection. New capabilities are opt-in. Existing basic shared-content checks continue to apply.

## Scan and preview

```sh
mancode privacy scan --file notes.txt --profile shared --json
cat notes.txt | mancode privacy scan --json
mancode privacy preview --file notes.txt --output notes.redacted.txt --json
```

Pass sensitive text in a UTF-8 file or stdin, never as a command-line argument. The scanner accepts up to 1 MiB and reports only rule/category, UTF-16 offsets, finding count and completion state. Scan exits with 0 for no findings, 1 for findings and 2 for an input/scan error. Preview exits with 0 when the new copy is fully written; findings are expected and do not make a successful preview fail.

Preview never overwrites an existing target or source. It writes a separate irreversible copy, restricts POSIX permissions to 0600, and publishes only after a complete scan and successful write. It does not rewrite task authority. If the input is too large, malformed UTF-8, contains invalid text, exceeds the finding/time budget or cannot be read, no preview is published. Error messages contain safe reason codes and selected system error codes, without paths or original text.

Detection uses explicit shapes plus selected checksums. A clean result does not prove that all credentials or personal data are absent. Unsupported identifier formats, encoded content and application-specific secrets may require additional rules. Rule sources and limitations are documented in [privacy-rule-sources.md](privacy-rule-sources.md).

Named credentials include assignments such as `client_password="synthetic phrase"` and `DB_PASSWORD=synthetic-value`. Supported quoted values are protected through the matching closing quote, including spaces and escaped quotes; an unfinished quote protects the remaining input. Metrics such as `token_count` and `password_length` are not credential names. This same scanner protects previews and enhanced shared writes.

## First initialization

```sh
mancode init --platform codex --shared-privacy
mancode init --platform codex --no-shared-privacy --yes
```

Interactive first initialization asks whether to enable enhanced project-shared protection. Answering `y` enables it; `n` or Enter leaves it disabled; `q` cancels before project mutation. Explicit shared flags skip the question. Both positive and negative flags together are a parameter error. Non-interactive initialization and `--yes` leave unspecified protection disabled. Repeating initialization preserves the existing choice. Legacy initialization rejects these options rather than migrating authority.

`privacy status --json` returns `{schemaVersion: 2, shared}`. Shared errors exit 2; normal states exit 0. The command never reads retired gateway settings or probes their ports. The model gateway and its initialization flags have been removed. See [retirement and client migration](privacy-gateway-retirement.md).

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

## Protection boundaries

Project-shared policy is versioned authority and must be changed through policy commands. Disabling enhanced protection does not downgrade format, remove historical exclusions, restore redacted copies or disable basic checks. Rules still include Maskit-derived detection; their source and license notices remain distributed.

Protection covers content handled by the corresponding mancode boundary. It does not cover arbitrary Git operations, direct file access, tool-originated traffic, images or encrypted blocks. mancode does not route model requests or modify provider/login settings.
