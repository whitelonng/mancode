# Privacy scanner rule sources

The TypeScript scanner in `src/privacy/` adapts detection ideas, regular-expression shapes, and checksum validation from **数据面具 Maskit — 本地 LLM 敏感信息脱敏代理**, Copyright (C) 2026 TMW. The audited upstream baseline is [Maskit v0.2.7, commit 19ee66463dc11432feec7afe69dabfe24bc997e6](https://github.com/xiaYuTian11/maskit/tree/19ee66463dc11432feec7afe69dabfe24bc997e6). This notice does not imply endorsement or affiliation.

Maskit's upstream license is GNU Affero General Public License version 3. A complete copy is retained in [privacy-upstream-license.txt](privacy-upstream-license.txt). mancode remains AGPL-3.0-only; its root `LICENSE` applies to this distribution. Both this attribution and the upstream license are included in the npm package's explicit file list.

The source reference is the upstream [`engine/transparent.py`](https://github.com/xiaYuTian11/maskit/blob/19ee66463dc11432feec7afe69dabfe24bc997e6/engine/transparent.py), with the locally audited rule catalogue recorded in `research/maskit-integration-2026-09-11/`. The upstream proxy, event store, audit logging, token table, configuration loader, and UI are not copied into the scanner.

| Rule family | mancode adaptation |
|---|---|
| API/vendor/cloud keys, connection credentials, bearer/JWT | Explicit bounded shapes; offsets select the password capture where appropriate; JWT header/payload decoding validates structure only |
| Chinese mobile numbers | Explicit supported prefixes and consistent spaces/hyphens; identifier boundaries reduce build/version false positives |
| Chinese identity cards | Province prefix, real date and 18-digit checksum; legacy 15-digit values have no checksum claim |
| Payment cards | Supported digit/group shapes and Luhn validation, including 16-digit Mastercard 2-series prefixes 222100–272099; a checksum alone is insufficient to accept arbitrary grouped numbers |
| Named secrets | Complete ASCII field names of 1–128 characters, beginning with a letter, optionally preceded by `-` or `--`; credential names and `_`/`-` separated prefixes such as `client_password`, `DB_PASSWORD` and `service-api-key`; quoted values preserve spaces and escaped quotes/backslashes, and unfinished quotes protect the remaining input |
| Authorization, cookies, local paths, email, PEM | Retains mancode's existing categories as new scanner rules; PEM covers unfinished blocks and case variants; email matches preserve sentence punctuation and support `mailto:` prefixes |

Ruleset identity: `mancode-sensitive-text:1`. Findings contain a rule ID, category, original UTF-16 code-unit offsets, and `shape` or `checksum` validation. They contain no input, input path, secret-derived hash, or reversible identifier. Checksum success does not establish authenticity, ownership, or current validity. Patterns deliberately have finite boundaries and may miss unsupported formats; the tool does not claim complete PII or credential detection.

Named-secret matching requires `:` or `=` and a terminal credential name (`password`, `passwd`, `secret`, `token`, `api_key`/`api-key`/`apikey`, or the corresponding `access_key` variants), case-insensitively. Metrics such as `password_length` and `token_count` do not match this rule. Unquoted values end at whitespace, quotes, semicolons or commas; quote values that contain these characters. Empty quoted values and exact recognized redaction markers are already safe; a marker followed by more value text is scanned as a credential. Other rules still apply independently.

The old `src/context/privacy.ts` parser contract and its six persisted categories remain independent. New scanner categories must never be written into old schemas merely because their names are similar. Once a ruleset is released, changes require a new explicit version and compatibility review. The prefixed-name and complete-quoted-value corrections belong to the first, unpublished `mancode-sensitive-text:1` implementation; they do not introduce a policy migration.
