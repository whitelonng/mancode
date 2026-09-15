import path from 'node:path';
import { digestCanonicalJson } from './canonical.js';
import type { ConfirmedDecisionV1 } from './confirmed-decision.js';
import { assertUlid } from './ids.js';
import { assertPrivacyValueAllowed } from './privacy-guard.js';
import type { PrivacyPolicySnapshot } from './privacy-policy.js';
import {
  assertSafeSharedRelativePath,
  assertSharedTextSafe,
} from './privacy.js';
import { assertKnownKeys, assertRecord } from './validation.js';

export const DECISION_RELATIONS_CAPABILITY = 'decision-relations:1';

export interface DecisionRelation {
  action: 'supersede' | 'revoke';
  targetId: string;
  targetDigest: string;
  clauses: 'all' | string[];
}

export interface DecisionDetails {
  capability: typeof DECISION_RELATIONS_CAPABILITY;
  recordKind: 'decision' | 'revocation';
  rationale: string;
  alternatives: Array<{ option: string; reasonNotChosen: string }>;
  tradeoffs: string[];
  revisitWhen: string[];
  applicability: { modules: string[]; paths: string[] };
  clauses: Array<{ id: string; statement: string }>;
  relations: DecisionRelation[];
  resolution?: { records: Array<{ decisionId: string; digest: string }> };
}

export interface ConfirmedDecisionV2
  extends Omit<ConfirmedDecisionV1, 'schemaVersion'> {
  schemaVersion: 2;
  details: DecisionDetails;
}

export type ConfirmedDecision = ConfirmedDecisionV1 | ConfirmedDecisionV2;

function text(value: unknown, max = 4000): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\0')
  )
    throw new Error('MANCODE_DECISION_DETAILS_INVALID');
  assertSharedTextSafe(value, 'decision details');
  return value;
}
function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('MANCODE_DECISION_DETAILS_INVALID');
  const items = value.map((item) => text(item));
  if (new Set(items).size !== items.length)
    throw new Error('MANCODE_DECISION_DETAILS_DUPLICATE');
  return items;
}
function clauseId(value: unknown): string {
  const id = text(value, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))
    throw new Error('MANCODE_DECISION_CLAUSE_INVALID');
  return id;
}

/** This is a schema, never JSON hidden inside a free-text statement. */
export function parseDecisionDetails(value: unknown): DecisionDetails {
  assertRecord(value, 'decision details');
  assertKnownKeys(
    value,
    [
      'capability',
      'recordKind',
      'rationale',
      'alternatives',
      'tradeoffs',
      'revisitWhen',
      'applicability',
      'clauses',
      'relations',
      'resolution',
    ],
    'decision details',
  );
  if (value.capability !== DECISION_RELATIONS_CAPABILITY)
    throw new Error('MANCODE_DECISION_CAPABILITY_UNSUPPORTED');
  if (value.recordKind !== 'decision' && value.recordKind !== 'revocation')
    throw new Error('MANCODE_DECISION_KIND_INVALID');
  assertRecord(value.applicability, 'decision applicability');
  assertKnownKeys(
    value.applicability,
    ['modules', 'paths'],
    'decision applicability',
  );
  const modules = strings(value.applicability.modules).map((item) =>
    text(item, 128),
  );
  const paths = strings(value.applicability.paths).map((item) => {
    const result = assertSafeSharedRelativePath(text(item, 256));
    if (result.includes('*') && !result.endsWith('/**'))
      throw new Error('MANCODE_DECISION_PATH_INVALID');
    if (result.slice(0, -3).includes('*'))
      throw new Error('MANCODE_DECISION_PATH_INVALID');
    return result;
  });
  if (
    !Array.isArray(value.alternatives) ||
    value.alternatives.length > 32 ||
    !Array.isArray(value.clauses) ||
    value.clauses.length > 64 ||
    !Array.isArray(value.relations) ||
    value.relations.length > 32
  )
    throw new Error('MANCODE_DECISION_DETAILS_INVALID');
  const alternatives = value.alternatives.map((item) => {
    assertRecord(item, 'decision alternative');
    assertKnownKeys(
      item,
      ['option', 'reasonNotChosen'],
      'decision alternative',
    );
    return {
      option: text(item.option),
      reasonNotChosen: text(item.reasonNotChosen),
    };
  });
  const clauses = value.clauses.map((item) => {
    assertRecord(item, 'decision clause');
    assertKnownKeys(item, ['id', 'statement'], 'decision clause');
    return { id: clauseId(item.id), statement: text(item.statement) };
  });
  if (new Set(clauses.map((clause) => clause.id)).size !== clauses.length)
    throw new Error('MANCODE_DECISION_CLAUSE_INVALID');
  const relations = value.relations.map((item): DecisionRelation => {
    assertRecord(item, 'decision relation');
    assertKnownKeys(
      item,
      ['action', 'targetId', 'targetDigest', 'clauses'],
      'decision relation',
    );
    if (item.action !== 'supersede' && item.action !== 'revoke')
      throw new Error('MANCODE_DECISION_RELATION_INVALID');
    assertUlid(item.targetId, 'decision relation target');
    if (
      typeof item.targetDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(item.targetDigest)
    )
      throw new Error('MANCODE_DECISION_RELATION_INVALID');
    const selected =
      item.clauses === 'all' ? 'all' : strings(item.clauses, 64).map(clauseId);
    if (selected !== 'all' && selected.length === 0)
      throw new Error('MANCODE_DECISION_RELATION_INVALID');
    return {
      action: item.action,
      targetId: item.targetId,
      targetDigest: item.targetDigest,
      clauses: selected,
    };
  });
  if (new Set(relations.map((item) => item.targetId)).size !== relations.length)
    throw new Error('MANCODE_DECISION_RELATION_INVALID');
  if (
    value.recordKind === 'decision' &&
    (clauses.length === 0 ||
      modules.length + paths.length === 0 ||
      relations.some((item) => item.action !== 'supersede'))
  )
    throw new Error('MANCODE_DECISION_DETAILS_INVALID');
  if (
    value.recordKind === 'revocation' &&
    (clauses.length !== 0 ||
      relations.length === 0 ||
      relations.some((item) => item.action !== 'revoke'))
  )
    throw new Error('MANCODE_DECISION_DETAILS_INVALID');
  let resolution: DecisionDetails['resolution'];
  if (value.resolution !== undefined) {
    assertRecord(value.resolution, 'decision resolution');
    assertKnownKeys(value.resolution, ['records'], 'decision resolution');
    if (
      !Array.isArray(value.resolution.records) ||
      value.resolution.records.length < 2 ||
      value.resolution.records.length > 32
    )
      throw new Error('MANCODE_DECISION_RESOLUTION_INVALID');
    const records = value.resolution.records.map((item) => {
      assertRecord(item, 'decision resolution record');
      assertKnownKeys(
        item,
        ['decisionId', 'digest'],
        'decision resolution record',
      );
      assertUlid(item.decisionId, 'decision resolution target');
      if (
        typeof item.digest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(item.digest)
      )
        throw new Error('MANCODE_DECISION_RESOLUTION_INVALID');
      return { decisionId: item.decisionId, digest: item.digest };
    });
    if (
      new Set(records.map((item) => item.decisionId)).size !== records.length ||
      records.length !== relations.length ||
      records.some(
        (item) =>
          !relations.some(
            (relation) =>
              relation.targetId === item.decisionId &&
              relation.targetDigest === item.digest &&
              relation.clauses === 'all',
          ),
      )
    )
      throw new Error('MANCODE_DECISION_RESOLUTION_INVALID');
    resolution = { records };
  }
  return {
    capability: DECISION_RELATIONS_CAPABILITY,
    recordKind: value.recordKind,
    rationale: text(value.rationale),
    alternatives,
    tradeoffs: strings(value.tradeoffs),
    revisitWhen: strings(value.revisitWhen),
    applicability: { modules, paths },
    clauses,
    relations,
    ...(resolution ? { resolution } : {}),
  };
}

export interface DecisionProjection {
  decision: ConfirmedDecision;
  state: 'current' | 'historical' | 'partial' | 'reference' | 'conflict';
  activeClauses: string[];
}
export interface DecisionCollectionProjection {
  entries: DecisionProjection[];
  validityUnavailable: boolean;
}

function visible(
  privacy: PrivacyPolicySnapshot | null | undefined,
  record: ConfirmedDecision,
): boolean {
  try {
    assertPrivacyValueAllowed(privacy, record);
    return true;
  } catch {
    return false;
  }
}

function connectConflict(
  graph: Map<string, Set<string>>,
  left: string,
  right: string,
): void {
  for (const [a, b] of [
    [left, right],
    [right, left],
  ] as const) {
    const peers = graph.get(a) ?? new Set<string>();
    peers.add(b);
    graph.set(a, peers);
  }
}

function conflictComponent(
  graph: Map<string, Set<string>>,
  start: string,
): Set<string> {
  const found = new Set<string>();
  const pending = graph.has(start) ? [start] : [];
  while (pending.length) {
    const id = pending.pop();
    if (!id || found.has(id)) continue;
    found.add(id);
    pending.push(...(graph.get(id) ?? []));
  }
  return found;
}

function resolutionMatches(
  candidate: ConfirmedDecisionV2,
  byId: ReadonlyMap<string, ConfirmedDecision>,
  graph: Map<string, Set<string>>,
): boolean {
  const references = candidate.details.resolution?.records;
  if (!references?.length) return false;
  const component = conflictComponent(graph, references[0]?.decisionId ?? '');
  return (
    component.size === references.length &&
    component.size >= 2 &&
    new Set(references.map((item) => item.decisionId)).size ===
      references.length &&
    candidate.details.relations.length === references.length &&
    references.every((reference) => {
      const target = byId.get(reference.decisionId);
      return (
        target !== undefined &&
        component.has(reference.decisionId) &&
        target.decisionId !== candidate.decisionId &&
        digestCanonicalJson(target) === reference.digest &&
        candidate.details.relations.some(
          (relation) =>
            relation.targetId === reference.decisionId &&
            relation.targetDigest === reference.digest &&
            relation.clauses === 'all',
        )
      );
    })
  );
}

function collectionConflictGraph(
  records: readonly ConfirmedDecision[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const byId = new Map(records.map((record) => [record.decisionId, record]));
  const owners = new Map<string, string>();
  for (const record of records) {
    if (record.schemaVersion !== 2) continue;
    for (const relation of record.details.relations) {
      const target = byId.get(relation.targetId);
      if (
        !target ||
        target.decisionId === record.decisionId ||
        digestCanonicalJson(target) !== relation.targetDigest ||
        (target.schemaVersion === 2 &&
          target.details.recordKind === 'revocation' &&
          !record.details.resolution)
      )
        continue;
      const all = relationClauseIds(target);
      const clauses = relation.clauses === 'all' ? all : relation.clauses;
      if (clauses.some((clause) => !all.includes(clause))) continue;
      for (const clause of clauses) {
        const key = `${target.decisionId}/${clause}`;
        const owner = owners.get(key);
        if (owner && owner !== record.decisionId)
          connectConflict(graph, owner, record.decisionId);
        owners.set(key, record.decisionId);
      }
    }
  }
  return graph;
}

function relationClauseIds(target: ConfirmedDecision | undefined): string[] {
  if (target?.schemaVersion !== 2) return ['statement'];
  return target.details.recordKind === 'revocation'
    ? ['@revocation']
    : target.details.clauses.map((clause) => clause.id);
}

/** A successor must carry confirmation of every conflict in its referenced basis. */
function hasUnconfirmedConflictBasis(
  record: ConfirmedDecision,
  byId: ReadonlyMap<string, ConfirmedDecision>,
  components: ReadonlyMap<string, string>,
  certificates: ReadonlyMap<string, string>,
): boolean {
  const required = new Set<string>();
  const confirmed = new Set<string>();
  const visited = new Set<string>();
  const pending = [record];
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current.decisionId)) continue;
    visited.add(current.decisionId);
    const certificate = certificates.get(current.decisionId);
    if (certificate) confirmed.add(certificate);
    if (current.schemaVersion !== 2) continue;
    for (const relation of current.details.relations) {
      const target = byId.get(relation.targetId);
      if (!target || digestCanonicalJson(target) !== relation.targetDigest)
        continue;
      const component = components.get(target.decisionId);
      if (component) required.add(component);
      pending.push(target);
    }
  }
  return [...required].some((component) => !confirmed.has(component));
}

/** Relations are evaluated over the authority collection before any visibility filtering. */
export function projectDecisions(
  records: readonly ConfirmedDecision[],
  privacy?: PrivacyPolicySnapshot | null,
): DecisionCollectionProjection {
  const byId = new Map(records.map((record) => [record.decisionId, record]));
  const retired = new Map<string, Set<string>>();
  const conflicts = new Set<string>();
  const hiddenImpact = new Set<string>();
  const owners = new Map<string, string>();
  const conflictGraph = new Map<string, Set<string>>();
  const visibleIds = new Set(
    records
      .filter((record) => visible(privacy, record))
      .map((record) => record.decisionId),
  );
  let validityUnavailable = false;
  for (const record of records) {
    if (record.schemaVersion !== 2) continue;
    for (const relation of record.details.relations) {
      const target = byId.get(relation.targetId);
      const all = relationClauseIds(target);
      const clauses = relation.clauses === 'all' ? all : relation.clauses;
      if (
        !visibleIds.has(record.decisionId) ||
        (target && !visibleIds.has(target.decisionId))
      ) {
        hiddenImpact.add(record.decisionId);
        if (target) hiddenImpact.add(target.decisionId);
        validityUnavailable = true;
      }
      if (
        !target ||
        target.decisionId === record.decisionId ||
        digestCanonicalJson(target) !== relation.targetDigest ||
        clauses.some((clause) => !all.includes(clause)) ||
        (target.schemaVersion === 2 &&
          target.details.recordKind === 'revocation' &&
          !record.details.resolution)
      ) {
        conflicts.add(record.decisionId);
        if (target) conflicts.add(target.decisionId);
        validityUnavailable = true;
        continue;
      }
      const inactive = retired.get(target.decisionId) ?? new Set<string>();
      for (const clause of clauses) {
        const key = `${target.decisionId}/${clause}`;
        const owner = owners.get(key);
        if (owner && owner !== record.decisionId) {
          conflicts.add(owner);
          conflicts.add(record.decisionId);
          validityUnavailable = true;
          connectConflict(conflictGraph, owner, record.decisionId);
        }
        owners.set(key, record.decisionId);
        inactive.add(clause);
      }
      retired.set(target.decisionId, inactive);
    }
  }
  // An explicit resolution retires a whole conflict component, never a chosen winner.
  // Re-evaluate against the merged collection so an unseen competing branch invalidates it.
  for (const record of records) {
    if (record.schemaVersion !== 2 || !record.details.resolution) continue;
    if (resolutionMatches(record, byId, conflictGraph)) {
      for (const target of record.details.resolution.records)
        conflicts.delete(target.decisionId);
    }
  }
  // New competitors invalidate old confirmations. A fresh explicit resolution may
  // repair that basis; ordinary descendants cannot silently inherit a resolution.
  const components = new Map<string, string>();
  for (const id of conflictGraph.keys()) {
    if (components.has(id)) continue;
    const members = [...conflictComponent(conflictGraph, id)].sort();
    const key = members.join(',');
    for (const member of members) components.set(member, key);
  }
  const certificates = new Map<string, string>();
  for (const record of records) {
    if (
      record.schemaVersion !== 2 ||
      !resolutionMatches(record, byId, conflictGraph)
    )
      continue;
    const component = components.get(
      record.details.resolution?.records[0]?.decisionId ?? '',
    );
    if (component) certificates.set(record.decisionId, component);
  }
  const invalidBasis = new Set<string>();
  for (const record of records) {
    if (
      (record.schemaVersion === 2 &&
        record.details.resolution &&
        !certificates.has(record.decisionId)) ||
      hasUnconfirmedConflictBasis(record, byId, components, certificates)
    ) {
      invalidBasis.add(record.decisionId);
    }
  }
  const explicitlyRetired = new Set<string>();
  for (const record of records) {
    if (
      record.schemaVersion !== 2 ||
      !certificates.has(record.decisionId) ||
      invalidBasis.has(record.decisionId)
    )
      continue;
    for (const relation of record.details.relations)
      explicitlyRetired.add(relation.targetId);
  }
  for (const id of invalidBasis)
    if (!explicitlyRetired.has(id)) conflicts.add(id);
  validityUnavailable = conflicts.size > 0 || hiddenImpact.size > 0;
  // Hidden target identities must not escape through a visible successor's relations.
  for (let changed = true; changed; ) {
    changed = false;
    for (const record of records)
      if (
        record.schemaVersion === 2 &&
        record.details.relations.some((relation) =>
          hiddenImpact.has(relation.targetId),
        ) &&
        !hiddenImpact.has(record.decisionId)
      ) {
        hiddenImpact.add(record.decisionId);
        changed = true;
      }
  }
  const entries: DecisionProjection[] = [];
  for (const decision of records) {
    if (
      !visibleIds.has(decision.decisionId) ||
      hiddenImpact.has(decision.decisionId)
    )
      continue;
    const all =
      decision.schemaVersion === 2
        ? decision.details.clauses.map((clause) => clause.id)
        : ['statement'];
    const activeClauses = all.filter(
      (clause) => !retired.get(decision.decisionId)?.has(clause),
    );
    const state = conflicts.has(decision.decisionId)
      ? 'conflict'
      : (decision.schemaVersion === 2 &&
            decision.details.recordKind === 'revocation') ||
          activeClauses.length === 0
        ? 'historical'
        : activeClauses.length !== all.length
          ? 'partial'
          : decision.schemaVersion === 1
            ? 'reference'
            : 'current';
    entries.push({ decision, state, activeClauses });
  }
  return { entries, validityUnavailable };
}

/** Publishing against an already replaced clause is a conflict, never last-writer-wins. */
export function assertDecisionRelationsPublishable(
  records: readonly ConfirmedDecision[],
  candidate: ConfirmedDecisionV2,
): void {
  const current = projectDecisions(records);
  if (candidate.details.resolution) {
    const byId = new Map(records.map((record) => [record.decisionId, record]));
    const graph = collectionConflictGraph(records);
    if (
      !resolutionMatches(candidate, byId, graph) ||
      candidate.details.resolution.records.some(
        (reference) =>
          current.entries.find(
            (entry) => entry.decision.decisionId === reference.decisionId,
          )?.state !== 'conflict',
      )
    )
      throw new Error('MANCODE_DECISION_RESOLUTION_STALE');
    return;
  }
  for (const relation of candidate.details.relations) {
    const target = current.entries.find(
      (entry) => entry.decision.decisionId === relation.targetId,
    );
    if (
      !target ||
      digestCanonicalJson(target.decision) !== relation.targetDigest ||
      target.state === 'historical' ||
      target.state === 'conflict'
    )
      throw new Error('MANCODE_DECISION_RELATION_STALE');
    const selected =
      relation.clauses === 'all' ? target.activeClauses : relation.clauses;
    if (
      (relation.clauses === 'all' && target.state === 'partial') ||
      selected.some((clause) => !target.activeClauses.includes(clause))
    )
      throw new Error('MANCODE_DECISION_RELATION_STALE');
  }
}

export function decisionMatch(
  decision: ConfirmedDecisionV2,
  modules: readonly string[],
  paths: readonly string[],
): 'matched' | 'possible' | 'none' {
  if (
    decision.details.applicability.modules.some((module) =>
      modules.includes(module),
    )
  )
    return 'matched';
  let possible = false;
  const hasGlob = (value: string) => /[*?\[\]{}()!+@]/.test(value);
  const prefix = (value: string) =>
    value.slice(0, value.search(/[*?\[\]{}()!+@]/)).replace(/[^/]*$/, '');
  for (const pattern of decision.details.applicability.paths) {
    for (const candidate of paths) {
      if (pattern === candidate) return 'matched';
      if (!hasGlob(pattern) || !hasGlob(candidate)) {
        const file = hasGlob(pattern) ? candidate : pattern;
        const glob = hasGlob(pattern) ? pattern : candidate;
        if (path.matchesGlob(file, glob)) return 'matched';
      } else {
        const left = prefix(pattern);
        const right = prefix(candidate);
        if (left.startsWith(right) || right.startsWith(left)) possible = true;
      }
    }
  }
  return possible ? 'possible' : 'none';
}

export function decisionMatches(
  decision: ConfirmedDecisionV2,
  modules: readonly string[],
  paths: readonly string[],
): boolean {
  return decisionMatch(decision, modules, paths) !== 'none';
}

/** Derived content always labels validity and removes retired clauses from a partial current rule. */
export function decisionContextValue(entry: DecisionProjection): unknown {
  const record = entry.decision;
  if (record.schemaVersion === 1 && entry.state === 'reference') return record;
  const { statement, ...withoutStatement } = record;
  return {
    ...(entry.state === 'partial'
      ? withoutStatement
      : { ...withoutStatement, statement }),
    ...(record.schemaVersion === 2 && entry.state === 'partial'
      ? {
          details: {
            ...record.details,
            clauses: record.details.clauses.filter((clause) =>
              entry.activeClauses.includes(clause.id),
            ),
          },
        }
      : {}),
    validity: {
      state: entry.state,
      activeClauses: entry.activeClauses,
      sourceDigest: digestCanonicalJson(record),
    },
  };
}
