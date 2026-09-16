import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type ReviewLayer = 'head' | 'index' | 'working_tree' | 'untracked';

export interface ReviewFile {
  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'type_changed'
    | 'untracked';
  path: string;
  previousPath?: string;
  layers: ReviewLayer[];
}

export interface ReviewSubject {
  kind: 'review_inventory';
  repositoryRoot: string;
  base: { requested: string; commit: string };
  head: string;
  target: 'head_index_and_working_tree';
  files: ReviewFile[];
  reviewStatus: 'not_reviewed';
  notes: string[];
}

export class ReviewInspectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Inventory only: never executes project checks or changes task authority. */
export async function inspectReviewSubject(
  projectRoot: string,
  base: string,
): Promise<ReviewSubject> {
  if (typeof base !== 'string' || !base.trim() || base.includes('\0')) {
    throw new ReviewInspectionError(
      'MANCODE_REVIEW_BASE_REQUIRED',
      'Provide an explicit Git commit or ref with --base; the PR base is not inferred.',
    );
  }
  // Git can run configured fsmonitor, diff, and clean-filter programs even for
  // read-only queries. Disable them rather than executing repository helpers.
  const config = [
    '--no-pager',
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
  ];
  const git = async (args: string[], cwd = projectRoot) =>
    (
      await execFile('git', [...config, ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  let repositoryRoot: string;
  try {
    repositoryRoot = (await git(['rev-parse', '--show-toplevel'])).replace(
      /\n$/,
      '',
    );
    if (!repositoryRoot) throw new Error('missing worktree');
  } catch {
    throw new ReviewInspectionError(
      'MANCODE_REVIEW_GIT_REQUIRED',
      'Review inspection requires an accessible Git working tree.',
    );
  }
  const commit = async (ref: string, code: string) => {
    try {
      const value = (
        await git(
          ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
          repositoryRoot,
        )
      ).trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
        throw new Error('invalid commit');
      return value;
    } catch {
      throw new ReviewInspectionError(
        code,
        'The requested review commit cannot be resolved; no inventory was produced.',
      );
    }
  };
  const baseCommit = await commit(base, 'MANCODE_REVIEW_BASE_INVALID');
  const head = await commit('HEAD', 'MANCODE_REVIEW_HEAD_INVALID');
  try {
    let filters = '';
    try {
      filters = await git(
        ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
        repositoryRoot,
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
    const names = new Set(
      filters
        .split('\0')
        .filter(Boolean)
        .map((key) => key.slice(0, key.lastIndexOf('.'))),
    );
    for (const name of names) {
      config.push(
        '-c',
        `${name}.clean=`,
        '-c',
        `${name}.process=`,
        '-c',
        `${name}.required=false`,
      );
    }
    if (await git(['ls-files', '--unmerged', '-z'], repositoryRoot)) {
      throw new ReviewInspectionError(
        'MANCODE_REVIEW_UNMERGED',
        'Resolve the unmerged index before capturing a review inventory.',
      );
    }
    const diffArgs = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-relative',
      '--ignore-submodules=none',
      '--find-renames',
      '--name-status',
      '-z',
    ];
    // A staged change or committed change can be undone only in the working
    // tree. Preserve each comparison, since commit and push use different layers.
    const comparisons: Array<[ReviewLayer, string[]]> = [
      ['head', [baseCommit, head, '--']],
      ['index', ['--cached', baseCommit, '--']],
      ['working_tree', [baseCommit, '--']],
    ];
    const byChange = new Map<string, ReviewFile>();
    for (const [layer, args] of comparisons) {
      const tracked = await git([...diffArgs, ...args], repositoryRoot);
      for (const change of parseChanges(tracked)) {
        const key = JSON.stringify(change);
        const existing = byChange.get(key);
        if (existing) existing.layers.push(layer);
        else byChange.set(key, { ...change, layers: [layer] });
      }
    }
    const untracked = await git(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      repositoryRoot,
    );
    const files = [...byChange.values()];
    for (const file of nulFields(untracked))
      files.push({ status: 'untracked', path: file, layers: ['untracked'] });
    if ((await commit('HEAD', 'MANCODE_REVIEW_HEAD_INVALID')) !== head) {
      throw new ReviewInspectionError(
        'MANCODE_REVIEW_HEAD_CHANGED',
        'HEAD changed during inspection; rerun against the intended target.',
      );
    }
    return {
      kind: 'review_inventory',
      repositoryRoot,
      base: { requested: base, commit: baseCommit },
      head,
      target: 'head_index_and_working_tree',
      files,
      reviewStatus: 'not_reviewed',
      notes: [
        'This is a file inventory, not a completed review or passing verification. Rerun after edits; the index and working tree are not immutable snapshots.',
        'Each tracked layer (HEAD, index, working tree) is compared with the explicit base. Layers may contain different content even for the same path and status; inspect each indicated layer. Different change kinds for a path remain separate entries.',
        'Non-ignored untracked files are included. Git-ignored untracked files are excluded.',
        'Unstaged moves may appear as a deletion plus an untracked path. Submodule contents require separate inspection.',
        'External Git helpers are disabled; clean-filtered files may appear changed even when their normalized content is equivalent.',
      ],
    };
  } catch (error) {
    if (error instanceof ReviewInspectionError) throw error;
    throw new ReviewInspectionError(
      'MANCODE_REVIEW_INSPECTION_FAILED',
      'Git could not collect the complete file inventory; no successful review result is available.',
    );
  }
}

function nulFields(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('incomplete Git output');
  return output.slice(0, -1).split('\0');
}

function parseChanges(output: string): Array<Omit<ReviewFile, 'layers'>> {
  const fields = nulFields(output);
  const files: Array<Omit<ReviewFile, 'layers'>> = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const first = fields[index++];
    if (!status || !first) throw new Error('invalid Git change');
    if (/^[RC]\d+$/.test(status)) {
      const target = fields[index++];
      if (!target) throw new Error('invalid Git rename');
      files.push({
        status: status.startsWith('R') ? 'renamed' : 'copied',
        previousPath: first,
        path: target,
      });
      continue;
    }
    const statuses = {
      A: 'added',
      M: 'modified',
      D: 'deleted',
      T: 'type_changed',
    } as const;
    if (!(status in statuses)) throw new Error('unsupported Git change');
    files.push({
      status: statuses[status as keyof typeof statuses],
      path: first,
    });
  }
  return files;
}
