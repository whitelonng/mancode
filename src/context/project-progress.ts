import { digestCanonicalJson } from './canonical.js';
import { decisionContextValue, projectDecisions } from './decision-record.js';
import type { ManEvidenceSubject } from './man-delivery-evidence.js';
import { assertPrivacyValueAllowed } from './privacy-guard.js';
import { redactSharedText } from './privacy.js';
import {
  type ProgressViews,
  buildProgressViews,
  updateProgressViews,
} from './project-progress-projection.js';
import type {
  StoredProjectSnapshot,
  StoredTaskSnapshot,
  V3ContextStore,
} from './store.js';
import { type TaskRef, formatTaskRef } from './task-ref.js';

export type ProgressVisibility =
  | 'local-preview'
  | 'local-snapshot'
  | 'shared-snapshot';
export type ProgressState =
  | '未开始'
  | '仅规划'
  | '进行中'
  | '待审核'
  | '已验收'
  | '已完成'
  | '已暂停'
  | '已放弃'
  | '已替代'
  | '需核对';
export interface ProgressTask {
  id: string;
  title: string;
  namespace: 'local' | 'shared';
  revision: number;
  state: ProgressState;
  phase: number;
  owner: string | null;
  modules: string[];
  reason: string | null;
  issue:
    | 'business_blocker'
    | 'test_failed'
    | 'review_findings'
    | 'evidence_stale'
    | 'runtime_repair'
    | null;
  next: string | null;
  /** Absent in older disposable caches; absence also means unobserved. */
  publication?: 'unobserved';
  updatedAt: string;
  source: string;
  acceptance: Array<{ id: string; text: string; state: string }>;
}
export interface ProgressDecision {
  id: string;
  title: string;
  statement: string;
  state: string;
  rationale: string | null;
  source: string;
  updatedAt: string;
}
export interface ProgressTimeline {
  id: string;
  title: string;
  time: string;
  source: string;
}
export interface ProgressPitfall {
  id: string;
  option: string;
  reason: string;
  source: string;
}
export interface ProjectProgressData {
  schemaVersion: 2;
  workspaceId: string;
  checkoutId: string | null;
  project: string;
  version: string;
  generatedAt: string;
  visibility: ProgressVisibility;
  coverage: 'registered_tasks_only';
  scopeNote: string;
  transport: string;
  totals: {
    registered: number;
    completed: number;
    accepted: number;
    blocked: number;
  };
  tasks: ProgressTask[];
  modules: Array<{ name: string; tasks: string[]; registered?: number }>;
  decisions: ProgressDecision[];
  timeline: ProgressTimeline[];
  pitfalls: ProgressPitfall[];
  omissions: {
    tasks: number;
    decisions: number;
    timeline: number;
    pitfalls: number;
  };
  diagnostics: string[];
}
export interface ProgressInvalidation {
  taskRefs?: TaskRef[];
  project?: boolean;
  full?: boolean;
  currentSubjects?: Record<string, ManEvidenceSubject>;
  reason?: string;
}
export interface ProgressVersion {
  version: string | null;
  sequence: number;
  stale: boolean;
  notifications: 'connected' | 'unverified';
  diagnostic: string | null;
}

const safe = (text: string) => redactSharedText(text).text;
function isAllowed(project: StoredProjectSnapshot, value: unknown): boolean {
  try {
    assertPrivacyValueAllowed(project.privacy, value);
    return true;
  } catch {
    return false;
  }
}

/** Lifecycle is authoritative; evidence and failure causes are independently projected. */
export function projectProgressTask(
  task: StoredTaskSnapshot,
  currentSubject?: ManEvidenceSubject,
): ProgressTask {
  const m = task.metadata;
  let state: ProgressState =
    m.status === 'completed'
      ? '已完成'
      : m.status === 'abandoned'
        ? '已放弃'
        : m.status === 'superseded'
          ? '已替代'
          : m.status === 'blocked'
            ? '已暂停'
            : m.status === 'planned'
              ? m.governance.planDecision === 'plan_only'
                ? '仅规划'
                : '未开始'
              : '进行中';
  let issue: ProgressTask['issue'] = null;
  if (m.status === 'blocked') issue = 'business_blocker';
  else if (m.governance.verificationStatus === 'failed') issue = 'test_failed';
  else if (m.governance.reviewStatus === 'blocked') issue = 'review_findings';
  const ledgerMatches =
    task.verification.planVersion === m.governance.planVersion &&
    task.verification.requirementsDigest === task.requirements.contentDigest;
  const required = task.verification.checks.filter((check) => check.required);
  const componentsFor = (
    check: StoredTaskSnapshot['verification']['checks'][number],
  ) => {
    return check.verificationRequirement === 'hybrid'
      ? [check.automated, check.manual]
      : [
          check.verificationRequirement === 'automated'
            ? check.automated
            : check.manual,
        ];
  };
  const checkMatches = (
    check: StoredTaskSnapshot['verification']['checks'][number],
  ) => {
    const components = componentsFor(check);
    return (
      ledgerMatches &&
      currentSubject !== undefined &&
      components.every(
        (item) =>
          item?.status === 'passed' &&
          item.subject?.contentDigest === currentSubject.contentDigest &&
          item.subject?.environment === currentSubject.environment,
      )
    );
  };
  const evidenceMatches = required.length > 0 && required.every(checkMatches);
  if (m.status === 'in_progress') {
    if (m.governance.planDecision === 'plan_only') state = '仅规划';
    else if (m.governance.verificationStatus === 'passed' && evidenceMatches)
      state = '已验收';
    else if (m.governance.reviewStatus === 'in_review') state = '待审核';
  }
  if (
    m.governance.verificationStatus === 'passed' &&
    !evidenceMatches &&
    issue === null
  )
    issue = 'evidence_stale';
  if (task.aggregate === null || m.transitionState !== 'stable') {
    state = '需核对';
    issue = 'runtime_repair';
  }
  const checkpoint = task.latestCheckpoint;
  const checkpointCurrent =
    checkpoint &&
    checkpoint.governance.requirementsDigest ===
      m.governance.requirementsDigest &&
    checkpoint.governance.planVersion === m.governance.planVersion;
  return {
    id: formatTaskRef(m.taskRef),
    title: safe(m.task),
    namespace: m.taskRef.namespace,
    revision: m.revision,
    state,
    phase: m.currentStep,
    owner: m.ownerActorId,
    modules: m.implementationScope.modules.map(safe),
    reason: m.blockingReason ? safe(m.blockingReason) : null,
    issue,
    next: checkpointCurrent ? safe(checkpoint.nextAction) : null,
    publication: 'unobserved',
    updatedAt: m.updatedAt,
    source: formatTaskRef(m.taskRef),
    acceptance: task.requirements.acceptanceCriteria.map((criterion) => {
      const check = task.verification.checks.find(
        (item) => item.criterionId === criterion.criterionId,
      );
      return {
        id: criterion.displayId,
        text: safe(criterion.statement),
        state:
          check && checkMatches(check)
            ? '已验收'
            : check &&
                componentsFor(check).some((item) => item?.status === 'failed')
              ? '失败'
              : check &&
                  componentsFor(check).every(
                    (item) => item?.status === 'passed',
                  )
                ? '证据需核对'
                : '待验证',
      };
    }),
  };
}

export interface ProgressAuthority {
  project: StoredProjectSnapshot;
  tasks: StoredTaskSnapshot[];
  workspaceId: string;
  checkoutId: string;
  projectName: string;
  subjects?: Record<string, ManEvidenceSubject>;
}

export function screenProgressTask(
  project: StoredProjectSnapshot,
  task: StoredTaskSnapshot,
  subject?: ManEvidenceSubject,
): ProgressTask | null {
  if (
    !isAllowed(project, task.metadata) ||
    !isAllowed(project, task.requirements) ||
    !isAllowed(project, task.verification)
  )
    return null;
  const screened =
    task.latestCheckpoint && !isAllowed(project, task.latestCheckpoint)
      ? { ...task, latestCheckpoint: null }
      : task;
  return projectProgressTask(screened, subject);
}

export function projectProgressData(
  authority: ProgressAuthority,
  visibility: ProgressVisibility,
  generatedAt: string,
  limit = 100,
): ProjectProgressData {
  const tasks = authority.tasks
    .filter(
      (task) =>
        visibility !== 'shared-snapshot' ||
        task.metadata.taskRef.namespace === 'shared',
    )
    .filter(
      (task) =>
        isAllowed(authority.project, task.metadata) &&
        isAllowed(authority.project, task.requirements) &&
        isAllowed(authority.project, task.verification),
    )
    .map((task) => {
      const screened =
        task.latestCheckpoint &&
        !isAllowed(authority.project, task.latestCheckpoint)
          ? { ...task, latestCheckpoint: null }
          : task;
      return projectProgressTask(
        screened,
        authority.subjects?.[formatTaskRef(task.metadata.taskRef)],
      );
    })
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  const projected = projectDecisions(
    authority.project.confirmedDecisions,
    authority.project.privacy,
  );
  const decisions = projected.entries.map((entry): ProgressDecision => {
    const { decision, state } = entry;
    const content = decisionContextValue(entry) as {
      statement?: string;
      details?: { rationale: string; clauses?: Array<{ statement: string }> };
    };
    return {
      id: decision.decisionId,
      title: safe(decision.title),
      statement: safe(
        state === 'partial'
          ? (content.details?.clauses ?? [])
              .map((clause) => clause.statement)
              .join('\n')
          : (content.statement ?? ''),
      ),
      state,
      rationale: content.details?.rationale
        ? safe(content.details.rationale)
        : null,
      source: `decision:${decision.decisionId}`,
      updatedAt: decision.confirmedAt,
    };
  });
  const pitfalls = projected.entries.flatMap(({ decision }) =>
    decision.schemaVersion === 2
      ? decision.details.alternatives.map((item, i) => ({
          id: `${decision.decisionId}:${i}`,
          option: safe(item.option),
          reason: safe(item.reasonNotChosen),
          source: `decision:${decision.decisionId}`,
        }))
      : [],
  );
  const timeline = [
    ...tasks.map((task) => ({
      id: task.id,
      title: `${task.title} · ${task.state}`,
      time: task.updatedAt,
      source: task.source,
    })),
    ...decisions.map((decision) => ({
      id: decision.id,
      title: `决定 · ${decision.title}`,
      time: decision.updatedAt,
      source: decision.source,
    })),
  ].sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id));
  const modules = new Map<string, string[]>();
  for (const task of tasks)
    for (const module of task.modules)
      modules.set(module, [...(modules.get(module) ?? []), task.id]);
  const data = {
    schemaVersion: 2 as const,
    workspaceId: authority.workspaceId,
    checkoutId: visibility === 'shared-snapshot' ? null : authority.checkoutId,
    project:
      visibility === 'shared-snapshot'
        ? '共享项目进度'
        : safe(authority.projectName),
    visibility,
    coverage: 'registered_tasks_only' as const,
    scopeNote:
      visibility === 'shared-snapshot'
        ? '仅展示可共享的已登记任务；不代表全部项目范围。'
        : '仅展示此 checkout 已登记任务；普通未登记工作不自动追踪。',
    transport:
      authority.project.config.transport.mode === 'git-ref'
        ? '以本 checkout 已接收的共享版本为准；预览不自动同步远端。'
        : '本 checkout 已保存状态。',
    totals: {
      registered: tasks.length,
      completed: tasks.filter((task) => task.state === '已完成').length,
      accepted: tasks.filter((task) => task.state === '已验收').length,
      blocked: tasks.filter((task) => task.issue === 'business_blocker').length,
    },
    tasks: tasks.slice(0, limit),
    modules: [...modules]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ids]) => ({ name, tasks: ids })),
    decisions: decisions.slice(0, limit),
    timeline: timeline.slice(0, limit),
    pitfalls: pitfalls.slice(0, limit),
    omissions: {
      tasks: Math.max(0, tasks.length - limit),
      decisions: Math.max(0, decisions.length - limit),
      timeline: Math.max(0, timeline.length - limit),
      pitfalls: Math.max(0, pitfalls.length - limit),
    },
    diagnostics: projected.validityUnavailable
      ? ['部分决定的有效性无法安全展示，请核对权威记录。']
      : [],
  };
  return { ...data, version: digestCanonicalJson(data), generatedAt };
}

/** In-memory read model. No model calls, writes, background work or polling are started here. */
export class ProjectProgressController {
  private authority: ProgressAuthority | null = null;
  private taskRows = new Map<string, ProgressTask>();
  private taskSnapshots = new Map<string, StoredTaskSnapshot>();
  private pending: ProgressInvalidation = { full: true };
  private generation = 0;
  private serial: Promise<void> = Promise.resolve();
  private status: ProgressVersion = {
    version: null,
    sequence: 0,
    stale: true,
    notifications: 'unverified',
    diagnostic: 'initializing',
  };
  private generatedAt = '';
  private views = new Map<ProgressVisibility, ProjectProgressData>();
  constructor(
    readonly store: V3ContextStore,
    private readonly identity: {
      workspaceId: string;
      checkoutId: string;
      projectName: string;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}
  setNotificationsConnected(connected: boolean): void {
    this.status.notifications = connected ? 'connected' : 'unverified';
  }
  invalidate(change: ProgressInvalidation): void {
    this.generation++;
    this.pending = {
      full: this.pending.full || change.full,
      project: this.pending.project || change.project,
      taskRefs: [...(this.pending.taskRefs ?? []), ...(change.taskRefs ?? [])],
      currentSubjects: {
        ...this.pending.currentSubjects,
        ...change.currentSubjects,
      },
    };
    this.status.stale = true;
    this.status.diagnostic = change.reason ?? 'update_pending';
  }
  version(): ProgressVersion {
    return { ...this.status };
  }
  exportAuthority(): ProgressAuthority | null {
    return this.authority === null
      ? null
      : structuredClone({
          ...this.authority,
          tasks: [...this.taskSnapshots.values()],
        });
  }
  /** Caller validates the cache schema, source generation and root identity before restoring. */
  restoreAuthority(authority: ProgressAuthority, generatedAt: string): void {
    if (
      authority.workspaceId !== this.identity.workspaceId ||
      authority.checkoutId !== this.identity.checkoutId ||
      authority.projectName !== this.identity.projectName ||
      !Number.isFinite(Date.parse(generatedAt))
    )
      throw new Error('MANCODE_PROGRESS_CACHE_IDENTITY_INVALID');
    this.authority = structuredClone(authority);
    this.generatedAt = generatedAt;
    this.taskSnapshots = new Map(
      authority.tasks.map((task) => [
        formatTaskRef(task.metadata.taskRef),
        task,
      ]),
    );
    this.taskRows = new Map(
      authority.tasks.flatMap((task) => {
        const row = screenProgressTask(
          authority.project,
          task,
          authority.subjects?.[formatTaskRef(task.metadata.taskRef)],
        );
        return row ? [[row.id, row] as const] : [];
      }),
    );
    this.views = new Map(
      Object.entries(
        buildProgressViews(authority, [...this.taskRows.values()], generatedAt),
      ) as Array<[ProgressVisibility, ProjectProgressData]>,
    );
    this.pending = {};
    this.status = {
      ...this.status,
      version: this.views.get('local-preview')?.version ?? null,
      stale: false,
      diagnostic: null,
    };
  }

  restoreViews(project: StoredProjectSnapshot, views: ProgressViews): void {
    this.authority = { project, tasks: [], ...this.identity };
    this.views = new Map(
      Object.entries(views) as Array<[ProgressVisibility, ProjectProgressData]>,
    );
    this.generatedAt = views['local-preview'].generatedAt;
    this.pending = {};
    this.status = {
      ...this.status,
      version: views['local-preview'].version,
      stale: false,
      diagnostic: null,
    };
  }
  exportScreening(): {
    privacy: StoredProjectSnapshot['privacy'];
    transport: StoredProjectSnapshot['config']['transport']['mode'];
  } {
    if (!this.authority) throw new Error('MANCODE_PROGRESS_UNAVAILABLE');
    return {
      privacy: structuredClone(this.authority.project.privacy),
      transport: this.authority.project.config.transport.mode,
    };
  }
  exportProjectView(): ProjectProgressData {
    if (!this.authority) throw new Error('MANCODE_PROGRESS_UNAVAILABLE');
    return projectProgressData(
      { ...this.authority, tasks: [] },
      'local-preview',
      this.generatedAt,
    );
  }
  exportViews(): ProgressViews {
    return structuredClone(Object.fromEntries(this.views)) as ProgressViews;
  }
  exportRows(): ProgressTask[] {
    return structuredClone([...this.taskRows.values()]);
  }

  data(visibility: ProgressVisibility = 'local-preview'): ProjectProgressData {
    const view = this.views.get(visibility);
    if (!view) throw new Error('MANCODE_PROGRESS_UNAVAILABLE');
    return structuredClone(view);
  }
  page(
    kind: 'tasks' | 'decisions' | 'timeline' | 'pitfalls',
    offset = 0,
    limit = 50,
  ): { version: string; items: unknown[]; next: number | null } {
    if (!this.authority) throw new Error('MANCODE_PROGRESS_UNAVAILABLE');
    const tasks = [...this.taskRows.values()].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    const projectOnly = projectProgressData(
      { ...this.authority, tasks: [] },
      'local-preview',
      this.generatedAt,
      Number.MAX_SAFE_INTEGER,
    );
    const all =
      kind === 'tasks'
        ? tasks
        : kind === 'timeline'
          ? [
              ...projectOnly.timeline,
              ...tasks.map((row) => ({
                id: row.id,
                title: `${row.title} · ${row.state}`,
                time: row.updatedAt,
                source: row.source,
              })),
            ].sort(
              (a, b) =>
                b.time.localeCompare(a.time) || a.id.localeCompare(b.id),
            )
          : projectOnly[kind];
    const size = Math.min(50, Math.max(1, limit));
    return {
      version: this.views.get('local-preview')?.version ?? '',
      items: all.slice(offset, offset + size),
      next: offset + size < all.length ? offset + size : null,
    };
  }
  refresh(): Promise<void> {
    const work = this.serial.then(() => this.performRefresh());
    this.serial = work.catch(() => {});
    return work;
  }
  private async performRefresh(): Promise<void> {
    if (!this.status.stale && this.authority) return;
    const generation = this.generation;
    const pending = this.pending;
    try {
      let project = this.authority?.project;
      let tasks: StoredTaskSnapshot[] = [];
      if (pending.full || !project) {
        const first = await this.store.readProjectSnapshot();
        const metadata = await this.store.listWorkflowMetadata();
        tasks = [];
        for (const item of metadata)
          tasks.push(await this.readTask(item.taskRef));
        const after = await this.store.listWorkflowMetadata();
        project = await this.store.readProjectSnapshot();
        if (
          first.fingerprint !== project.fingerprint ||
          digestCanonicalJson(metadata) !== digestCanonicalJson(after)
        )
          throw new Error('MANCODE_PROGRESS_SNAPSHOT_CHANGED');
      } else {
        if (pending.project) {
          const first = await this.store.readProjectSnapshot();
          project = await this.store.readProjectSnapshot();
          if (first.fingerprint !== project.fingerprint)
            throw new Error('MANCODE_PROGRESS_SNAPSHOT_CHANGED');
        }
        const refs = new Map(
          (pending.taskRefs ?? []).map((ref) => [formatTaskRef(ref), ref]),
        );
        for (const ref of refs.values()) {
          const updated = await this.readTask(ref);
          tasks.push(updated);
        }
      }
      if (generation !== this.generation)
        throw new Error('MANCODE_PROGRESS_SNAPSHOT_CHANGED');
      const subjects = {
        ...(pending.full ? {} : this.authority?.subjects),
        ...pending.currentSubjects,
      };
      for (const ref of pending.taskRefs ?? [])
        if (!pending.currentSubjects?.[formatTaskRef(ref)])
          delete subjects[formatTaskRef(ref)];
      const authority = { project, tasks: [], ...this.identity, subjects };
      const timestamp = this.now().toISOString();
      const full = Boolean(pending.full || !this.authority || pending.project);
      if (pending.full || !this.authority) this.taskSnapshots.clear();
      for (const task of tasks)
        this.taskSnapshots.set(formatTaskRef(task.metadata.taskRef), task);
      let views = Object.fromEntries(this.views) as ProgressViews;
      if (full) {
        this.taskRows.clear();
        for (const task of this.taskSnapshots.values()) {
          const row = screenProgressTask(
            project,
            task,
            subjects[formatTaskRef(task.metadata.taskRef)],
          );
          if (row) this.taskRows.set(row.id, row);
        }
        views = buildProgressViews(
          authority,
          [...this.taskRows.values()],
          timestamp,
        );
      } else {
        for (const task of tasks) {
          const id = formatTaskRef(task.metadata.taskRef);
          const before = this.taskRows.get(id) ?? null;
          const row = screenProgressTask(project, task, subjects[id]);
          if (row) this.taskRows.set(id, row);
          else this.taskRows.delete(id);
          views =
            updateProgressViews(views, before, row, timestamp) ??
            buildProgressViews(
              authority,
              [...this.taskRows.values()],
              timestamp,
            );
        }
      }
      const next = new Map(
        Object.entries(views) as Array<
          [ProgressVisibility, ProjectProgressData]
        >,
      );
      const version = next.get('local-preview')?.version ?? null;
      if (version !== this.status.version) this.status.sequence++;
      this.views = next;
      this.authority = authority;
      this.generatedAt = timestamp;
      this.pending = {};
      this.status = { ...this.status, version, stale: false, diagnostic: null };
    } catch {
      this.status.stale = true;
      this.status.diagnostic = 'refresh_failed';
      throw new Error('MANCODE_PROGRESS_REFRESH_FAILED');
    }
  }
  private async readTask(ref: TaskRef): Promise<StoredTaskSnapshot> {
    const before = await this.store.readTaskSnapshot(ref);
    const after = await this.store.readTaskSnapshot(ref);
    if (before.fingerprint !== after.fingerprint)
      throw new Error('MANCODE_PROGRESS_SNAPSHOT_CHANGED');
    return after;
  }
}
