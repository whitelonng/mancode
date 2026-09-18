import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Command } from 'commander';
import { readPrivacyPolicyStatus } from '../context/privacy-policy.js';
import { MAX_SCAN_BYTES, scanSensitiveText } from '../privacy/detect.js';
import { redactSensitiveText } from '../privacy/redact.js';
import { RULESET_VERSION } from '../privacy/rules.js';
import type { ScanResult } from '../privacy/types.js';
import { registerPrivacyPolicyCommands } from './privacy-policy.js';

export interface PrivacyScanOptions {
  file?: string;
  profile?: string;
  json?: boolean;
  output?: string;
}

type PrivacyInputError =
  | 'input_required'
  | 'input_unreadable'
  | 'input_too_large'
  | 'invalid_utf8'
  | 'unsupported_profile'
  | 'output_required'
  | 'output_unavailable';

class PrivacyCommandError extends Error {
  constructor(
    readonly code: PrivacyInputError,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

/** Bounded byte reads also cover a file that grows after the initial stat. */
async function readInput(
  rootDir: string,
  file: string | undefined,
  stdin: Readable & { isTTY?: boolean },
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const append = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_SCAN_BYTES)
      throw new PrivacyCommandError('input_too_large');
    chunks.push(buffer);
  };
  if (file === undefined) {
    if (stdin.isTTY) throw new PrivacyCommandError('input_required');
    try {
      for await (const chunk of stdin) append(chunk);
    } catch (error) {
      if (error instanceof PrivacyCommandError) throw error;
      throw new PrivacyCommandError('input_unreadable', error);
    }
  } else {
    let handle: FileHandle | undefined;
    try {
      // O_NONBLOCK prevents named pipes from blocking before we can reject them.
      handle = await fs.open(
        path.resolve(rootDir, file),
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw new PrivacyCommandError('input_unreadable');
      if (stat.size > MAX_SCAN_BYTES)
        throw new PrivacyCommandError('input_too_large');
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        append(Buffer.from(buffer.subarray(0, bytesRead)));
      }
    } catch (error) {
      if (error instanceof PrivacyCommandError) throw error;
      throw new PrivacyCommandError('input_unreadable', error);
    } finally {
      await handle?.close();
    }
  }
  try {
    // Preserve the BOM: offsets must refer to the original decoded text.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new PrivacyCommandError('invalid_utf8');
  }
}

function printReport(result: ScanResult, options: PrivacyScanOptions): void {
  const report = { ...result, count: result.findings.length };
  if (options.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`Privacy scan: ${result.status}; findings: ${report.count}.`);
    if (result.reason !== undefined) console.log(`Reason: ${result.reason}.`);
    for (const finding of result.findings) {
      console.log(
        `${finding.category}: ${finding.ruleId} [${finding.start}, ${finding.end})`,
      );
    }
  }
}

function printError(error: unknown, options: PrivacyScanOptions): number {
  const cause = error instanceof Error ? error.cause : undefined;
  const safeCodes = [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ENOSPC',
    'EEXIST',
    'EIO',
    'EMFILE',
    'ENFILE',
    'EROFS',
  ];
  const systemCode =
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    safeCodes.includes(cause.code)
      ? cause.code
      : undefined;
  const reason =
    error instanceof PrivacyCommandError ? error.code : 'operation_failed';
  const report = {
    status: 'failed',
    rulesetVersion: RULESET_VERSION,
    findings: [],
    count: 0,
    reason,
    ...(systemCode === undefined ? {} : { systemCode }),
  };
  if (options.json) console.log(JSON.stringify(report));
  else
    console.error(
      `Privacy operation failed: ${reason}${systemCode === undefined ? '' : ` (${systemCode})`}.`,
    );
  return 2;
}

/** Reports only metadata; never logs source paths, snippets, values, or hashes. */
export async function privacyScan(
  rootDir: string,
  options: PrivacyScanOptions = {},
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<number> {
  try {
    if (options.profile !== undefined && options.profile !== 'shared') {
      throw new PrivacyCommandError('unsupported_profile');
    }
    const result = scanSensitiveText(
      await readInput(rootDir, options.file, stdin),
    );
    printReport(result, options);
    return result.status === 'failed' ? 2 : result.findings.length > 0 ? 1 : 0;
  } catch (error) {
    return printError(error, options);
  }
}

export async function privacyPreview(
  rootDir: string,
  options: PrivacyScanOptions = {},
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<number> {
  try {
    if (!options.output) throw new PrivacyCommandError('output_required');
    if (options.profile !== undefined && options.profile !== 'shared') {
      throw new PrivacyCommandError('unsupported_profile');
    }
    const result = redactSensitiveText(
      await readInput(rootDir, options.file, stdin),
    );
    if (result.scan.status !== 'complete') {
      printReport(result.scan, options);
      return 2;
    }
    const destination = path.resolve(rootDir, options.output);
    const temporary = path.join(
      path.dirname(destination),
      `.mancode-preview-${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(result.text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Publish a fully written file with an exclusive hard link. This refuses
      // existing destinations (including source and symlinks) without overwriting.
      await fs.link(temporary, destination);
    } catch (error) {
      throw new PrivacyCommandError('output_unavailable', error);
    } finally {
      await handle?.close();
      // This unpredictable name was exclusively created by this operation.
      await fs.unlink(temporary).catch(() => undefined);
    }
    printReport(result.scan, options);
    return 0;
  } catch (error) {
    return printError(error, options);
  }
}

export async function privacyStatus(
  root: string,
  options: { json?: boolean } = {},
): Promise<number> {
  const shared = await readPrivacyPolicyStatus(root);
  if (options.json) console.log(JSON.stringify({ schemaVersion: 2, shared }));
  else {
    console.log(
      `Shared enhanced privacy: ${shared.state}; revision: ${shared.revision ?? 'unavailable'}.`,
    );
    if (shared.error !== null)
      console.log(`Shared policy error: ${shared.error}.`);
  }
  return shared.state === 'error' ? 2 : 0;
}

export function registerPrivacyCommands(program: Command): Command {
  const privacy = program
    .command('privacy')
    .description('Scan text and manage explicit privacy protection');
  for (const name of ['scan', 'preview'] as const) {
    const command = privacy
      .command(name)
      .description(
        name === 'scan'
          ? 'Scan a UTF-8 file or stdin and report metadata'
          : 'Write an irreversible redacted copy to a new private file',
      )
      .option('--file <path>', 'Read a UTF-8 regular file (default: stdin)')
      .option('--profile <name>', 'Scanner profile (shared)', 'shared')
      .option('--json', 'Output metadata as JSON');
    if (name === 'preview')
      command.requiredOption(
        '--output <path>',
        'New output file; existing files are never overwritten',
      );
    command.action(async (options) => {
      process.exitCode = await (name === 'scan' ? privacyScan : privacyPreview)(
        process.cwd(),
        options,
      );
    });
  }
  privacy
    .command('status')
    .description('Inspect project-shared privacy policy')
    .option('--json', 'Output safe structured status')
    .action(async (options) => {
      process.exitCode = await privacyStatus(process.cwd(), options);
    });
  registerPrivacyPolicyCommands(privacy);
  return privacy;
}
