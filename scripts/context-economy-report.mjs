/**
 * Token-economy report for the mancode v3 CLI surface.
 *
 * Drives a full /man workflow against dist/cli.js in a temporary project,
 * counts cl100k_base tokens (CONTEXT_PACK_TOKENIZER_ID) for every command
 * receipt and for the agent-facing artifacts, and compares the result with
 * the committed baseline.
 *
 * Usage:
 *   npm run build
 *   node scripts/context-economy-report.mjs [--output <report.json>] [--check]
 *
 * --check compares against scripts/context-economy-baseline.json and exits
 * non-zero when any measurement drifts more than ±2%. The script is a manual
 * / pre-release gate; it is intentionally not wired into CI.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getEncoding } from 'js-tiktoken';

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const cliPath = path.join(sourceRoot, 'dist', 'cli.js');
const baselinePath = path.join(
  sourceRoot,
  'scripts',
  'context-economy-baseline.json',
);
const TOKENIZER_ID = 'cl100k_base@tiktoken-0.7.0';
const TOLERANCE = 0.02;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REQUIREMENT_DIMENSIONS = [
  'platform',
  'core_scope',
  'technical_stack',
  'data_and_persistence',
  'performance',
  'compatibility',
  'security',
];

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  console.log(
    'Usage: node scripts/context-economy-report.mjs [--output <report.json>] [--check]',
  );
  process.exit(0);
}

await access(cliPath).catch(() => {
  throw new Error('dist/cli.js is missing; run `npm run build` first');
});

const encoder = getEncoding('cl100k_base');
const projectRoot = await mkdtemp(path.join(tmpdir(), 'mancode-economy-'));
const commands = [];
const artifacts = [];

try {
  const init = measure('init', [
    'init',
    '--yes',
    '--empty',
    '--platform',
    'claude-code',
    '--lang',
    'en',
  ]);
  assert(init.exitCode === 0, `init failed:\n${init.stdout}`);

  measureOk('status_brief', ['status', '--brief', '--json']);
  measureOk('team_identity_create', [
    'team',
    'identity',
    'create',
    '--name',
    'Economy Fixture',
    '--json',
  ]);

  const sessionReceipt = measureOk('context_session_new', [
    'context',
    'session',
    'new',
    '--client',
    'mancode-cli',
    '--json',
  ]);
  const sessionId = JSON.parse(sessionReceipt.stdout).session.sessionId;
  const sessionArgs = ['--session', sessionId, '--client', 'mancode-cli'];

  const createReceipt = measureOk('workflow_create_man', [
    'workflow',
    'create',
    'man',
    'Measure mancode CLI token economy.',
    ...sessionArgs,
    '--json',
  ]);
  const created = JSON.parse(createReceipt.stdout);
  const task = `${created.taskRef.namespace}:${created.taskRef.taskId}`;

  const requirementsPath = path.join(projectRoot, 'requirements.json');
  await writeFile(
    requirementsPath,
    `${JSON.stringify(semanticRequirementsFixture(), null, 2)}\n`,
  );
  await measureArtifact('requirements.json', requirementsPath);

  const finalizeReceipt = measureOk('workflow_requirements_finalize', [
    'workflow',
    'requirements',
    task,
    'finalize',
    '--expected-revision',
    '1',
    '--file',
    requirementsPath,
    ...sessionArgs,
    '--json',
  ]);
  const finalized = JSON.parse(finalizeReceipt.stdout);
  const requirements = finalized.requirements;

  const planPath = path.join(projectRoot, 'plan.md');
  await writeFile(
    planPath,
    '# Token economy plan\n\n1. Measure every v3 receipt.\n2. Compare with the committed baseline.\n',
  );
  await measureArtifact('plan.md', planPath);

  const planReceipt = measureOk('workflow_plan_revise', [
    'workflow',
    'plan',
    task,
    'revise',
    '--expected-revision',
    String(finalized.metadata.revision),
    '--plan-decision',
    'governed_execution',
    '--file',
    planPath,
    ...sessionArgs,
    '--json',
  ]);
  const planned = JSON.parse(planReceipt.stdout);
  const planVersion = planned.metadata.governance.planVersion;

  for (const purpose of [
    'orient',
    'plan',
    'implement',
    'review',
    'verify',
    'handoff',
  ]) {
    measureOk(`context_show_${purpose}`, [
      'context',
      'show',
      '--task',
      task,
      '--purpose',
      purpose,
      '--level',
      'task',
      ...sessionArgs,
      '--json',
    ]);
  }

  const fullPack = JSON.parse(
    measureOk('context_show_review_full', [
      'context',
      'show',
      '--task',
      task,
      '--purpose',
      'review',
      '--level',
      'full',
      ...sessionArgs,
      '--json',
    ]).stdout,
  );
  assert(fullPack.pack !== undefined, 'full context pack is missing');
  // The task starts with empty on-disk ledgers; the apply inputs derive from
  // them the same way the workflow fixtures do.
  const previousReview = JSON.parse(
    await readFile(await findTaskFile('review-ledger.json'), 'utf8'),
  );
  const previousVerification = JSON.parse(
    await readFile(await findTaskFile('verification-ledger.json'), 'utf8'),
  );

  const reviewPath = path.join(projectRoot, 'review-ledger.json');
  await writeFile(
    reviewPath,
    `${JSON.stringify(
      passedReview(previousReview, requirements.contentDigest, planVersion),
      null,
      2,
    )}\n`,
  );
  const reviewReceipt = measureOk('workflow_review_apply', [
    'workflow',
    'review',
    task,
    'apply',
    '--expected-revision',
    String(planned.metadata.revision),
    '--file',
    reviewPath,
    ...sessionArgs,
    '--json',
  ]);
  const reviewed = JSON.parse(reviewReceipt.stdout);

  const verificationPath = path.join(projectRoot, 'verification-ledger.json');
  await writeFile(
    verificationPath,
    `${JSON.stringify(
      passedVerification(
        previousVerification,
        requirements,
        planVersion,
        reviewed.review.remediationRound,
      ),
      null,
      2,
    )}\n`,
  );
  measureOk('workflow_verify_apply', [
    'workflow',
    'verify',
    task,
    'apply',
    '--expected-revision',
    String(reviewed.metadata.revision),
    '--file',
    verificationPath,
    ...sessionArgs,
    '--json',
  ]);

  measureOk('context_close', [
    'context',
    'close',
    '--session',
    sessionId,
    '--json',
  ]);

  const report = buildReport();
  printTable(report);
  if (options.output) {
    const outputPath = path.resolve(sourceRoot, options.output);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport written to ${outputPath}`);
  }
  if (options.check) {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const failures = compareWithBaseline(report, baseline);
    if (failures.length > 0) {
      console.error('\nBaseline check failed:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(
        `\nBaseline check passed (tolerance ±${TOLERANCE * 100}%): ${baselinePath}`,
      );
    }
  }
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}

function measure(name, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, MANCODE_SESSION_ID: undefined },
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? '';
  const normalized = normalize(stdout);
  commands.push({
    name,
    command: `mancode ${args.join(' ')}`,
    exitCode: result.status ?? -1,
    tokens: countTokens(normalized),
    chars: normalized.length,
  });
  return { exitCode: result.status ?? -1, stdout, stderr: result.stderr ?? '' };
}

function measureOk(name, args) {
  const result = measure(name, args);
  assert(
    result.exitCode === 0,
    `${name} failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

async function measureArtifact(name, filePath) {
  const content = normalize(await readFile(filePath, 'utf8'));
  artifacts.push({
    name,
    tokens: countTokens(content),
    chars: content.length,
  });
}

/** Locates one authoritative task file under .mancode without assuming layout. */
async function findTaskFile(fileName) {
  const matches = [];
  const queue = [path.join(projectRoot, '.mancode')];
  while (queue.length > 0) {
    const directory = queue.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.name === fileName) matches.push(entryPath);
    }
  }
  assert(
    matches.length === 1,
    `expected exactly one ${fileName} under .mancode, found ${matches.length}`,
  );
  return matches[0];
}

/**
 * Run-to-run jitter sources are replaced with stable placeholders before
 * counting tokens: the temporary project root, ULIDs, sha256 digests, and
 * ISO timestamps (fixed-length, but BPE token counts vary per value).
 */
function normalize(text) {
  return text
    .split(projectRoot)
    .join('<PROJECT_ROOT>')
    .split(path.basename(projectRoot))
    .join('<PROJECT_NAME>')
    .replace(/sha256:[0-9a-f]{64}/g, `sha256:${'0'.repeat(64)}`)
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '01ARZ3NDEKTSV4RRFFQ69G5FAV')
    .replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g,
      '2026-01-01T00:00:00.000Z',
    );
}

function countTokens(text) {
  return encoder.encode(text).length;
}

function buildReport() {
  const commandTotal = commands.reduce((sum, entry) => sum + entry.tokens, 0);
  return {
    schemaVersion: 1,
    tokenizerId: TOKENIZER_ID,
    generatedAt: new Date().toISOString(),
    totals: {
      commandTokens: commandTotal,
      artifactTokens: artifacts.reduce((sum, entry) => sum + entry.tokens, 0),
    },
    commands: commands.map(({ name, command, tokens, chars }) => ({
      name,
      command: command.replace(/local:[0-7][0-9A-HJKMNP-TV-Z]{25}/g, 'local:<TASK>').replace(/01[0-9A-HJKMNP-TV-Z]{24}/g, '<ULID>'),
      tokens,
      chars,
    })),
    artifacts,
  };
}

function printTable(report) {
  const width = Math.max(...report.commands.map((entry) => entry.name.length));
  console.log(`Token economy report (${report.tokenizerId})`);
  console.log('-'.repeat(width + 20));
  for (const entry of report.commands) {
    console.log(
      `${entry.name.padEnd(width)}  ${String(entry.tokens).padStart(7)} tokens`,
    );
  }
  console.log('-'.repeat(width + 20));
  console.log(
    `${'total (commands)'.padEnd(width)}  ${String(report.totals.commandTokens).padStart(7)} tokens`,
  );
  for (const artifact of report.artifacts) {
    console.log(
      `${`artifact ${artifact.name}`.padEnd(width)}  ${String(artifact.tokens).padStart(7)} tokens`,
    );
  }
}

function compareWithBaseline(report, baseline) {
  const failures = [];
  const baselineCommands = new Map(
    baseline.commands.map((entry) => [entry.name, entry]),
  );
  for (const entry of report.commands) {
    const reference = baselineCommands.get(entry.name);
    if (!reference) {
      failures.push(`command ${entry.name} missing from the baseline`);
      continue;
    }
    if (outsideTolerance(entry.tokens, reference.tokens)) {
      failures.push(
        `command ${entry.name}: ${entry.tokens} tokens vs baseline ${reference.tokens}`,
      );
    }
  }
  for (const reference of baseline.commands) {
    if (!report.commands.some((entry) => entry.name === reference.name)) {
      failures.push(`baseline command ${reference.name} was not measured`);
    }
  }
  if (outsideTolerance(report.totals.commandTokens, baseline.totals.commandTokens)) {
    failures.push(
      `command total: ${report.totals.commandTokens} tokens vs baseline ${baseline.totals.commandTokens}`,
    );
  }
  return failures;
}

function outsideTolerance(actual, expected) {
  if (expected === 0) return actual !== 0;
  return Math.abs(actual - expected) / expected > TOLERANCE;
}

function semanticRequirementsFixture() {
  return {
    version: 1,
    goal: 'Measure the token cost of every v3 CLI receipt.',
    confirmedScope: ['Execute the full man workflow against dist/cli.js'],
    excludedScope: ['Change any command behavior during measurement'],
    technicalDecisions: ['Count tokens with the cl100k_base encoding'],
    defaults: [],
    blockingUnknowns: [],
    coverage: REQUIREMENT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: dimension === 'technical_stack' ? 'confirmed' : 'defaulted',
      rationale: `Considered ${dimension} for the measurement fixture.`,
    })),
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'Every workflow receipt is captured and tokenized.',
        required: true,
        method: 'automated',
      },
    ],
  };
}

function passedReview(previous, requirementsDigest, planVersion) {
  const draft = {
    ...previous,
    revision: previous.revision + 1,
    status: 'passed',
    requirementsDigest,
    planVersion,
    requiredDomains: ['quality'],
    domains: [{ domain: 'quality', status: 'passed', reportRef: null }],
    blockers: [],
    remediationRound: 0,
    skip: null,
    contentDigest: '',
    lastOperationId: ulid(),
    updatedAt: new Date().toISOString(),
  };
  return { ...draft, contentDigest: reviewLedgerDigest(draft) };
}

function passedVerification(previous, requirements, planVersion, remediationRound) {
  const criterion = requirements.acceptanceCriteria[0];
  assert(criterion !== undefined, 'finalized requirements are missing AC-1');
  const draft = {
    ...previous,
    revision: previous.revision + 1,
    status: 'passed',
    requirementsDigest: requirements.contentDigest,
    planVersion,
    remediationRound,
    checks: [
      {
        displayId: criterion.displayId,
        legacyId: criterion.legacyId,
        checkId: ulid(),
        criterionId: criterion.criterionId,
        required: criterion.required,
        verificationRequirement: criterion.verificationRequirement,
        automated: {
          evidenceId: ulid(),
          status: 'passed',
          summary: 'Token economy fixture verification passed.',
          command: 'npm test',
          exitCode: 0,
          artifactRef: null,
          confirmedByActorId: null,
          confirmationSource: null,
          updatedAt: new Date().toISOString(),
        },
        manual: null,
      },
    ],
    contentDigest: '',
    lastOperationId: ulid(),
    updatedAt: new Date().toISOString(),
  };
  return { ...draft, contentDigest: verificationLedgerDigest(draft) };
}

/** Mirrors src/context/review-ledger.ts reviewLedgerDigest. */
function reviewLedgerDigest(ledger) {
  return digestCanonicalJson({
    schemaVersion: ledger.schemaVersion,
    canonicalizationVersion: ledger.canonicalizationVersion,
    taskRef: ledger.taskRef,
    status: ledger.status,
    depth: ledger.depth,
    requirementsDigest: ledger.requirementsDigest,
    planVersion: ledger.planVersion,
    requiredDomains: ledger.requiredDomains,
    domains: ledger.domains,
    blockers: ledger.blockers,
    remediationRound: ledger.remediationRound,
    skip: ledger.skip,
    legacySource: ledger.legacySource,
  });
}

/** Mirrors src/context/verification-ledger.ts verificationLedgerDigest. */
function verificationLedgerDigest(ledger) {
  return digestCanonicalJson({
    schemaVersion: ledger.schemaVersion,
    canonicalizationVersion: ledger.canonicalizationVersion,
    taskRef: ledger.taskRef,
    status: ledger.status,
    requirementsDigest: ledger.requirementsDigest,
    planVersion: ledger.planVersion,
    remediationRound: ledger.remediationRound,
    checks: ledger.checks,
    legacySource: ledger.legacySource,
  });
}

/** RFC 8785-style canonical JSON (sorted keys), same as src/context/canonical.ts. */
function digestCanonicalJson(value) {
  const canonical = canonicalize(value);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), 'canonical numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('canonical JSON only accepts plain JSON values');
}

function ulid(now = Date.now()) {
  let time = '';
  let remaining = now;
  for (let index = 0; index < 10; index += 1) {
    time = ULID_ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(10);
  let random = '';
  let bits = 0;
  let accumulator = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      random += ULID_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return time + random;
}

function parseOptions(args) {
  const parsed = { output: null, check: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') {
      parsed.help = true;
      continue;
    }
    if (argument === '--check') {
      parsed.check = true;
      continue;
    }
    if (argument !== '--output') {
      throw new Error(`unknown context-economy-report argument: ${argument}`);
    }
    const value = args[index + 1];
    assert(value !== undefined, '--output requires a value');
    parsed.output = value;
    index += 1;
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
