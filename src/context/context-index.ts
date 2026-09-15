import { createHash } from 'node:crypto';
import { VERSION } from '../version.js';
import { canonicalizeJson, digestCanonicalJson } from './canonical.js';
import {
  CURRENT_WRITER_CAPABILITIES,
  evaluateCompatibilityGate,
} from './compatibility.js';
import { loadContextDocuments } from './context-documents.js';
import {
  readContextIndexCache,
  writeContextIndexCache,
} from './context-index-cache.js';
import {
  type ContextPurpose,
  contextPackTokenCounter,
} from './context-pack.js';
import {
  decisionContextValue,
  decisionMatch,
  projectDecisions,
} from './decision-record.js';
import { scanLegacyAuthority } from './layout.js';
import { readBoundManPlan } from './man-delivery-runtime.js';
import { assertPrivacyValueAllowed } from './privacy-guard.js';
import type { PrivacyPolicySnapshot } from './privacy-policy.js';
import { redactSharedText } from './privacy.js';
import type { ContextResolverCompatibility } from './resolver.js';
import type {
  StoredProjectSnapshot,
  StoredTaskSnapshot,
  V3ContextStore,
} from './store.js';
import type { TaskRef } from './task-ref.js';

export interface ContextIndexRecord {
  ref: string;
  kind: string;
  title: string;
  version: string;
  required: boolean;
  state: 'current' | 'historical' | 'reference' | 'partial' | 'conflict';
  reason: string;
  source: string;
  content: string;
  requires?: string[];
  relatedDocument?: string;
}

export interface ContextIndexSnapshot {
  identity: string;
  records: ContextIndexRecord[];
  task: {
    ref: string;
    revision: number;
    stage: number;
    status: string;
    workflowMode: StoredTaskSnapshot['metadata']['workflowMode'];
    policyVersions: StoredTaskSnapshot['metadata']['governance']['policyVersions'];
    planDecision: string | null;
  } | null;
  gaps: string[];
  absenceDisclosure?: boolean;
  coverage?: ContextIndexResponse['coverage'];
}

export interface ContextBatchReadRequest {
  ref: string;
  version: string;
}

export interface ContextIndexRequest {
  action: 'index' | 'search' | 'read' | 'read-batch';
  requests?: ContextBatchReadRequest[];
  purpose: ContextPurpose;
  query?: string;
  ref?: string;
  version?: string;
  cursor?: string;
  snapshot?: string;
  history?: boolean;
}

export interface ContextIndexResponse {
  format: 'context-index-v1';
  status: 'complete' | 'incomplete' | 'more_required' | 'stale' | 'unavailable';
  snapshot: string;
  coverage:
    | 'explicit_task_and_decision_relations_only'
    | 'explicit_task_decision_and_declared_document_relations_only';
  actionReady: false;
  task: ContextIndexSnapshot['task'];
  gaps: string[];
  entries: Array<Omit<ContextIndexRecord, 'content' | 'source' | 'requires'>>;
  content?: string;
  unit?: {
    start: number;
    end: number;
    total: number;
    completeInResponse: boolean;
  };
  source?: string;
  ref?: string;
  version?: string;
  state?: ContextIndexRecord['state'];
  relatedDocument?: string;
  next: string | null;
  items?: ContextBatchReadItem[];
}

export interface ContextBatchReadItem {
  ref: string;
  version?: string;
  state?: ContextIndexRecord['state'];
  relatedDocument?: string;
  status: ContextIndexResponse['status'];
  gaps: string[];
  content?: string;
  source?: string;
  unit?: ContextIndexResponse['unit'];
  next: string | null;
}

export const CONTEXT_BATCH_MAX_REQUESTS = 8;
export const CONTEXT_INDEX_LIMIT = 1600;
export const CONTEXT_READ_LIMIT = 2400;

export function serializeContextIndex(value: ContextIndexResponse): string {
  return canonicalizeJson(value);
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeJson(value))
    .digest('base64url');
}

function allowed(
  privacy: PrivacyPolicySnapshot | null | undefined,
  value: unknown,
): boolean {
  try {
    assertPrivacyValueAllowed(privacy, value);
    return true;
  } catch {
    return false;
  }
}

/** Projection only. No read receipt or returned field grants execution authority. */
export function projectContextIndex(
  project: StoredProjectSnapshot,
  task: StoredTaskSnapshot | null,
  identity: string,
  purpose: ContextPurpose,
  boundPlan?: string,
  selection: { modules?: string[]; paths?: string[] } = {},
): ContextIndexSnapshot {
  const records: ContextIndexRecord[] = [];
  const gaps = ['undeclared_dependencies_not_covered', 'read_before_action'];
  const add = (
    ref: string,
    kind: string,
    title: string,
    value: unknown,
    required: boolean,
    state: ContextIndexRecord['state'],
    reason: string,
    source: string,
  ) => {
    if (!allowed(project.privacy, value)) {
      if (!gaps.includes('privacy_unavailable'))
        gaps.push('privacy_unavailable');
      return;
    }
    const raw = typeof value === 'string' ? value : canonicalizeJson(value);
    const redacted = redactSharedText(raw);
    const content = redacted.text;
    if (redacted.redactions.length) gaps.push('privacy_redacted');
    records.push({
      ref,
      kind,
      title: Array.from(redactSharedText(title).text).slice(0, 96).join(''),
      version: digestCanonicalJson(value),
      required,
      state,
      reason,
      source,
      content,
    });
  };
  let taskIndex: ContextIndexSnapshot['task'] = null;
  if (task !== null) {
    const metadata = task.metadata;
    const ref = `${metadata.taskRef.namespace}:${metadata.taskRef.taskId}`;
    if (!allowed(project.privacy, metadata)) {
      gaps.push('privacy_unavailable');
    } else {
      const historical = ['completed', 'abandoned', 'superseded'].includes(
        metadata.status,
      );
      const state = historical ? 'historical' : 'current';
      const required = !historical;
      taskIndex = {
        ref,
        revision: metadata.revision,
        stage: metadata.currentStep,
        status: metadata.status,
        workflowMode: metadata.workflowMode,
        policyVersions: metadata.governance.policyVersions,
        planDecision: metadata.governance.planDecision,
      };
      add(
        `${ref}/requirements`,
        'requirements',
        'Task requirements and acceptance',
        task.requirements,
        required,
        state,
        'bound_task',
        `${ref}/requirements`,
      );
      add(
        `${ref}/scope`,
        'scope',
        'Complete implementation scope',
        metadata.implementationScope,
        required && purpose !== 'orient',
        state,
        'bound_task',
        `${ref}/metadata`,
      );
      if (task.plan)
        add(
          `${ref}/plan`,
          'plan',
          'Bound task plan',
          boundPlan ?? task.plan.content,
          required && purpose !== 'orient',
          state,
          'bound_task',
          `${ref}/plan`,
        );
      else if (['implement', 'review', 'verify', 'handoff'].includes(purpose))
        gaps.push('plan_unavailable');
      if (purpose === 'review' || purpose === 'handoff')
        add(
          `${ref}/review`,
          'review',
          'Review ledger and unresolved findings',
          task.review,
          required,
          state,
          'bound_task',
          `${ref}/review_ledger`,
        );
      if (purpose === 'verify' || purpose === 'handoff')
        add(
          `${ref}/verification`,
          'verification',
          'Verification ledger; subject must be checked',
          task.verification,
          required,
          state,
          'bound_task',
          `${ref}/verification_ledger`,
        );
      if (task.latestCheckpoint)
        add(
          `${ref}/checkpoint`,
          'checkpoint',
          'Latest checkpoint; recheck current blockers',
          task.latestCheckpoint,
          required && ['implement', 'handoff'].includes(purpose),
          state,
          'bound_task',
          `${ref}/checkpoint`,
        );
      if (task.aggregate === null || metadata.transitionState !== 'stable')
        gaps.push('task_consistency_unavailable');
    }
  }
  const decisions = projectDecisions(
    project.confirmedDecisions,
    project.privacy,
  );
  if (decisions.validityUnavailable) gaps.push('decision_validity_unavailable');
  const modules = [
    ...(selection.modules ?? []),
    ...(taskIndex ? (task?.metadata.implementationScope.modules ?? []) : []),
  ];
  const paths = [
    ...(selection.paths ?? []),
    ...(taskIndex ? (task?.metadata.implementationScope.include ?? []) : []),
  ];
  for (const entry of decisions.entries) {
    const decision = entry.decision;
    const match =
      decision.schemaVersion === 2
        ? decisionMatch(decision, modules, paths)
        : 'none';
    const matches = match !== 'none';
    if (match === 'possible') gaps.push('decision_applicability_uncertain');
    const required =
      matches && (entry.state === 'current' || entry.state === 'partial');
    if (entry.state === 'conflict') gaps.push('decision_conflict');
    add(
      `decision:${decision.decisionId}`,
      'decision',
      decision.title,
      decisionContextValue(entry),
      required,
      entry.state,
      decision.schemaVersion === 1
        ? 'applicability_not_declared'
        : match === 'possible'
          ? 'scope_overlap_uncertain'
          : matches
            ? 'explicit_scope_match'
            : 'applicability_not_matched',
      `decision:${decision.decisionId}`,
    );
  }
  return {
    identity,
    records,
    task: taskIndex,
    gaps: [...new Set(gaps)],
    absenceDisclosure:
      !project.privacy ||
      (!project.privacy.policy.enabled &&
        project.privacy.exclusions.entries.length === 0),
  };
}

/** Double-read the entire authority tuple, including uncommitted bound plan text. */
export async function loadContextIndexSnapshot(
  store: V3ContextStore,
  taskRef: TaskRef | null,
  purpose: ContextPurpose,
  checkoutIdentity: string | (() => Promise<string>),
  selection: {
    modules?: string[];
    paths?: string[];
    documentIds?: string[];
    sectionRefs?: string[];
  } = {},
  compatibility?: ContextResolverCompatibility,
): Promise<ContextIndexSnapshot> {
  let expectedEpoch = compatibility?.expectedSchemaEpoch;
  const read = async () => {
    const project = await store.readProjectSnapshot();
    expectedEpoch ??= project.manifest.epoch;
    const legacy = await scanLegacyAuthority(store.projectRoot);
    const gate = evaluateCompatibilityGate({
      manifest: project.manifest,
      expectedSchemaEpoch: expectedEpoch,
      readerVersion: compatibility?.readerVersion ?? VERSION,
      writerVersion: compatibility?.writerVersion ?? VERSION,
      writerCapabilities:
        compatibility?.writerCapabilities ?? CURRENT_WRITER_CAPABILITIES,
      adapterVersions:
        compatibility?.adapterVersions ?? project.manifest.managedAdapters,
      currentLegacyBaseline: legacy.baseline,
      legacyAuthorityPresent: legacy.authorityPresent,
      operation: 'read',
    });
    if (!gate.readAllowed)
      throw new Error(gate.failures[0] ?? 'MANCODE_CONTEXT_READ_BLOCKED');
    const task =
      taskRef === null ? null : await store.readTaskSnapshot(taskRef);
    const boundPlan =
      task?.plan &&
      task.metadata.workflowMode === 'man' &&
      task.metadata.governance.policyVersions.planning === 3
        ? (await readBoundManPlan(store.projectRoot, task)).document
        : undefined;
    const documents = await loadContextDocuments(store.projectRoot, {
      privacy: project.privacy,
      modules: [
        ...new Set([
          ...(selection.modules ?? []),
          ...(task?.metadata.implementationScope?.modules ?? []),
        ]),
      ],
      paths: [
        ...new Set([
          ...(selection.paths ?? []),
          ...(task?.metadata.implementationScope?.include ?? []),
        ]),
      ],
      documentIds: selection.documentIds,
      sectionRefs: selection.sectionRefs,
    });
    const fingerprint = hash([
      typeof checkoutIdentity === 'string'
        ? checkoutIdentity
        : await checkoutIdentity(),
      project.fingerprint,
      task?.fingerprint ?? null,
      boundPlan ?? null,
      documents.fingerprint,
      { modules: selection.modules ?? [], paths: selection.paths ?? [] },
    ]);
    return { project, task, boundPlan, documents, fingerprint };
  };
  const first = await read();
  const second = await read();
  if (first.fingerprint !== second.fingerprint)
    throw new Error('MANCODE_CONTEXT_INDEX_SNAPSHOT_CHANGED');
  const cacheKey = digestCanonicalJson({
    schemaVersion: 1,
    fingerprint: second.fingerprint,
    purpose,
  });
  let cacheUnavailable = false;
  try {
    const cached = await readContextIndexCache(store.projectRoot, cacheKey);
    if (cached) return cached;
  } catch {
    cacheUnavailable = true;
  }
  const projected = projectContextIndex(
    second.project,
    second.task,
    second.fingerprint,
    purpose,
    second.boundPlan,
    selection,
  );
  projected.records.push(
    ...second.documents.records.map((record) => ({
      ...record,
      relatedDocument: record.ref.split(':')[1]?.split('#')[0] ?? '',
    })),
  );
  projected.gaps = [...new Set([...projected.gaps, ...second.documents.gaps])];
  projected.coverage =
    'explicit_task_decision_and_declared_document_relations_only';
  if (projected.gaps.some((gap) => gap.includes('privacy')))
    projected.absenceDisclosure = false;
  try {
    await writeContextIndexCache(store.projectRoot, cacheKey, projected);
  } catch {
    cacheUnavailable = true;
  }
  if (cacheUnavailable)
    projected.gaps.push('cache_unavailable_using_authority');
  return projected;
}

function cursor(snapshot: string, offset: number): string {
  return `${snapshot}.${offset}`;
}

/** Fixed limits include the entire serialized response, including continuation metadata. */
export function queryContextIndex(
  snapshot: ContextIndexSnapshot,
  request: ContextIndexRequest,
): ContextIndexResponse {
  if (request.action === 'read-batch')
    return queryContextBatch(snapshot, request);
  const query = (request.query ?? '').normalize('NFKC').trim().toLowerCase();
  const candidates = snapshot.records
    .filter(
      (record) =>
        request.action === 'read' ||
        request.history ||
        record.state !== 'historical',
    )
    .filter(
      (record) =>
        request.action !== 'search' ||
        record.required ||
        `${record.title} ${record.content}`
          .normalize('NFKC')
          .toLowerCase()
          .includes(query),
    )
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        a.ref.localeCompare(b.ref, 'en'),
    );
  const id = hash([
    snapshot.identity,
    request.action,
    request.purpose,
    query,
    request.ref ?? null,
    request.version ?? null,
    request.history ?? false,
    candidates.map(({ ref, version, required, state }) => ({
      ref,
      version,
      required,
      state,
    })),
  ]);
  const result: ContextIndexResponse = {
    format: 'context-index-v1',
    status: 'complete',
    snapshot: id,
    coverage: snapshot.coverage ?? 'explicit_task_and_decision_relations_only',
    actionReady: false,
    task: snapshot.task,
    gaps: snapshot.gaps,
    entries: [],
    next: null,
  };
  let offset = 0;
  if (request.snapshot && request.snapshot !== id)
    return { ...result, status: 'stale', gaps: ['restart_required'] };
  if (request.cursor) {
    const match = /^([\w-]{43})\.(0|[1-9][0-9]*)$/.exec(request.cursor);
    if (!match || match[1] !== id || !Number.isSafeInteger(Number(match[2])))
      return { ...result, status: 'stale', gaps: ['restart_required'] };
    offset = Number(match[2]);
  }
  const fits = (value: ContextIndexResponse, limit: number) =>
    contextPackTokenCounter().count(serializeContextIndex(value)) <= limit;
  if (request.action === 'read') {
    const record = candidates.find(
      (candidate) => candidate.ref === request.ref,
    );
    if (!record)
      return {
        ...result,
        status: 'unavailable',
        gaps: [
          snapshot.absenceDisclosure &&
          !snapshot.gaps.some((gap) => gap.startsWith('privacy_'))
            ? 'not_found'
            : 'not_found_or_not_visible',
        ],
      };
    result.ref = record.ref;
    result.version = record.version;
    result.source = record.source;
    result.state = record.state;
    if (record.relatedDocument) result.relatedDocument = record.relatedDocument;
    if (record.requires?.length)
      result.gaps = [
        ...new Set([
          ...result.gaps,
          'read_related_document_constraints_via_index',
        ]),
      ];
    if (request.version !== record.version)
      return {
        ...result,
        status: 'stale',
        gaps: ['version_changed_read_again'],
      };
    // The entire record is a semantic unit. Fragments are never independently action-ready.
    const chars = Array.from(record.content);
    if (offset > chars.length)
      return { ...result, status: 'stale', gaps: ['restart_required'] };
    let low = offset;
    let high = chars.length;
    while (low < high) {
      const end = Math.ceil((low + high) / 2);
      const candidate = {
        ...result,
        content: chars.slice(offset, end).join(''),
        unit: {
          start: offset,
          end,
          total: chars.length,
          completeInResponse: offset === 0 && end === chars.length,
        },
        status:
          end < chars.length
            ? ('more_required' as const)
            : ('complete' as const),
        next: end < chars.length ? cursor(id, end) : null,
      };
      if (fits(candidate, CONTEXT_READ_LIMIT)) low = end;
      else high = end - 1;
    }
    result.content = chars.slice(offset, low).join('');
    result.unit = {
      start: offset,
      end: low,
      total: chars.length,
      completeInResponse: offset === 0 && low === chars.length,
    };
    result.next = low < chars.length ? cursor(id, low) : null;
    result.status = result.next ? 'more_required' : 'complete';
    return result;
  }
  if (offset > candidates.length)
    return { ...result, status: 'stale', gaps: ['restart_required'] };
  const limit = request.action === 'index' ? 12 : 20;
  for (
    let i = offset;
    i < candidates.length && result.entries.length < limit;
    i++
  ) {
    const record = candidates[i];
    if (!record) break;
    const {
      content: _content,
      source: _source,
      requires: _requires,
      ...entry
    } = record;
    const more = i + 1 < candidates.length;
    const candidate = {
      ...result,
      entries: [...result.entries, entry],
      status: more ? ('incomplete' as const) : ('complete' as const),
      next: more ? cursor(id, i + 1) : null,
    };
    if (!fits(candidate, CONTEXT_INDEX_LIMIT)) break;
    result.entries = candidate.entries;
  }
  const nextOffset = offset + result.entries.length;
  result.next = nextOffset < candidates.length ? cursor(id, nextOffset) : null;
  result.status = result.next ? 'incomplete' : 'complete';
  return result;
}

export function parseContextBatchRequests(
  value: unknown,
): ContextBatchReadRequest[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CONTEXT_BATCH_MAX_REQUESTS
  )
    throw new Error('MANCODE_CONTEXT_BATCH_ARGUMENT_INVALID');
  const requests = value.map((item): ContextBatchReadRequest => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => key !== 'ref' && key !== 'version') ||
      typeof item.ref !== 'string' ||
      !item.ref.trim() ||
      item.ref.length > 512 ||
      typeof item.version !== 'string' ||
      !item.version.trim() ||
      item.version.length > 128 ||
      Array.from(`${item.ref}${item.version}`).some(
        (char) => char.charCodeAt(0) < 32,
      )
    )
      throw new Error('MANCODE_CONTEXT_BATCH_ARGUMENT_INVALID');
    return { ref: item.ref, version: item.version };
  });
  if (new Set(requests.map((item) => item.ref)).size !== requests.length)
    throw new Error('MANCODE_CONTEXT_BATCH_ARGUMENT_INVALID');
  return requests;
}

/** All requested references, versions and candidate members share one batch generation. */
function queryContextBatch(
  snapshot: ContextIndexSnapshot,
  request: ContextIndexRequest,
): ContextIndexResponse {
  const requests = parseContextBatchRequests(request.requests);
  const id = hash([
    snapshot.identity,
    'read-batch',
    request.purpose,
    request.history ?? false,
    requests,
    snapshot.records.map(({ ref, version, state, required }) => ({
      ref,
      version,
      state,
      required,
    })),
  ]);
  const result: ContextIndexResponse = {
    format: 'context-index-v1',
    status: 'complete',
    snapshot: id,
    coverage: 'explicit_task_and_decision_relations_only',
    actionReady: false,
    task: snapshot.task,
    gaps: snapshot.gaps,
    entries: [],
    items: [],
    next: null,
  };
  let itemIndex = 0;
  let itemOffset = 0;
  if (request.snapshot && request.snapshot !== id)
    return { ...result, status: 'stale', gaps: ['restart_required'] };
  if (request.cursor) {
    const match = /^([\w-]{43})\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
      request.cursor,
    );
    if (
      !match ||
      match[1] !== id ||
      !Number.isSafeInteger(Number(match[2])) ||
      !Number.isSafeInteger(Number(match[3])) ||
      Number(match[2]) >= requests.length
    )
      return { ...result, status: 'stale', gaps: ['restart_required'] };
    itemIndex = Number(match[2]);
    itemOffset = Number(match[3]);
  }
  const fits = (value: ContextIndexResponse) =>
    contextPackTokenCounter().count(serializeContextIndex(value)) <=
    CONTEXT_READ_LIMIT;
  for (; itemIndex < requests.length; itemIndex++) {
    const item = requests[itemIndex];
    if (!item) break;
    const singleRequest: ContextIndexRequest = {
      action: 'read',
      purpose: request.purpose,
      history: request.history,
      ...item,
    };
    const initial = queryContextIndex(snapshot, singleRequest);
    if (itemOffset) singleRequest.cursor = cursor(initial.snapshot, itemOffset);
    const single = itemOffset
      ? queryContextIndex(snapshot, singleRequest)
      : initial;
    const chars = Array.from(single.content ?? '');
    const make = (length: number) => {
      const end = (single.unit?.start ?? 0) + length;
      const more = single.unit !== undefined && end < single.unit.total;
      const entry: ContextBatchReadItem = {
        ref: item.ref,
        ...(single.version !== undefined ? { version: single.version } : {}),
        ...(single.state !== undefined ? { state: single.state } : {}),
        ...(single.relatedDocument
          ? { relatedDocument: single.relatedDocument }
          : {}),
        status: more ? 'more_required' : single.status,
        gaps: single.gaps.filter((gap) => !snapshot.gaps.includes(gap)),
        ...(single.content !== undefined
          ? { content: chars.slice(0, length).join('') }
          : {}),
        ...(single.source !== undefined ? { source: single.source } : {}),
        ...(single.unit
          ? {
              unit: {
                ...single.unit,
                end,
                completeInResponse:
                  single.unit.start === 0 && end === single.unit.total,
              },
            }
          : {}),
        next: more ? cursor(single.snapshot, end) : null,
      };
      const next = more
        ? `${id}.${itemIndex}.${end}`
        : itemIndex + 1 < requests.length
          ? `${id}.${itemIndex + 1}.0`
          : null;
      const value: ContextIndexResponse = {
        ...result,
        items: [...(result.items ?? []), entry],
        next,
        status: next ? 'more_required' : 'complete',
      };
      return { entry, value };
    };
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(make(middle).value)) low = middle;
      else high = middle - 1;
    }
    const { entry, value } = make(low);
    if (!fits(value) || (chars.length > 0 && low === 0)) {
      if (result.items?.length === 0)
        return {
          ...result,
          status: 'unavailable',
          gaps: ['read_unit_header_exceeds_budget'],
        };
      result.next = `${id}.${itemIndex}.${itemOffset}`;
      result.status = 'more_required';
      break;
    }
    result.items = value.items;
    result.next = value.next;
    result.status = value.status;
    if (entry.next) break;
    itemOffset = 0;
  }
  return result;
}
