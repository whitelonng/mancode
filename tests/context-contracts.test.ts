import { describe, expect, it } from 'vitest';
import {
  assertReferenceNamespace,
  parseArtifactRef,
} from '../src/context/artifact-ref.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  sortUtf8StringSet,
} from '../src/context/canonical.js';
import { createUlid, isUlid } from '../src/context/ids.js';
import {
  parentSnapshotStaleReasons,
  parseParentSnapshot,
} from '../src/context/parent-snapshot.js';
import {
  assertWorkflowStatusTransition,
  normalizeLegacyWorkflowMode,
  parseWorkflowDescriptor,
} from '../src/context/schema.js';
import {
  formatTaskRef,
  parseTaskRef,
  parseTaskRefValue,
} from '../src/context/task-ref.js';

const LOCAL_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const SHARED_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const OTHER_SHARED_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('V3 context contract spike', () => {
  it('creates canonical ULIDs and rejects non-canonical identifiers', () => {
    const generated = createUlid(1_720_000_000_000, new Uint8Array(10));
    expect(generated).toBe('01J1VZTC000000000000000000');
    expect(isUlid(generated)).toBe(true);
    expect(isUlid(generated.toLowerCase())).toBe(false);
    expect(() => createUlid(-1)).toThrow(/48 bits/);
  });

  it('requires namespace-qualified TaskRefs', () => {
    const taskRef = parseTaskRef(`shared:${SHARED_ID}`);
    expect(formatTaskRef(taskRef)).toBe(`shared:${SHARED_ID}`);
    expect(() => parseTaskRef(SHARED_ID)).toThrow(/local:<ULID>/);
    expect(() => parseTaskRef(`shared:${SHARED_ID.toLowerCase()}`)).toThrow(
      /local:<ULID>/,
    );
    expect(() =>
      parseTaskRefValue({
        namespace: 'shared',
        taskId: SHARED_ID,
        extra: true,
      }),
    ).toThrow(/unknown field/);
  });

  it('keeps ArtifactRefs typed and prevents shared-to-local references', () => {
    const localArtifact = parseArtifactRef({
      taskRef: { namespace: 'local', taskId: LOCAL_ID },
      kind: 'review_report',
    });
    expect(() => assertReferenceNamespace('shared', localArtifact)).toThrow(
      /cannot reference local/,
    );
    expect(() =>
      parseArtifactRef({
        taskRef: { namespace: 'shared', taskId: SHARED_ID },
        kind: 'review_report',
        path: '../../secret',
      }),
    ).toThrow(/unknown field/);
  });

  it('enforces the workflow mode, visibility, coordination, and parent matrix', () => {
    expect(
      parseWorkflowDescriptor({
        workflowMode: 'man',
        visibility: 'local',
        coordination: 'single',
        parent: null,
      }),
    ).toMatchObject({ workflowMode: 'man' });
    expect(() =>
      parseWorkflowDescriptor({
        workflowMode: 'manteam',
        visibility: 'shared',
        coordination: 'single',
        parent: null,
      }),
    ).toThrow(/manteam requires/);
    expect(() =>
      parseWorkflowDescriptor({
        workflowMode: 'manba',
        visibility: 'shared',
        coordination: 'single',
        parent: null,
      }),
    ).toThrow(/requires a shared man parent/);
    expect(
      parseWorkflowDescriptor({
        workflowMode: 'manba',
        visibility: 'shared',
        coordination: 'team',
        parent: {
          taskRef: { namespace: 'shared', taskId: SHARED_ID },
          workflowMode: 'manteam',
          visibility: 'shared',
          coordination: 'team',
        },
      }),
    ).toMatchObject({ workflowMode: 'manba', coordination: 'team' });
    expect(() =>
      parseWorkflowDescriptor({
        workflowMode: 'solo',
        visibility: 'local',
        coordination: 'single',
        parent: null,
      }),
    ).toThrow(/workflowMode/);
    expect(normalizeLegacyWorkflowMode('mamba')).toBe('manba');
  });

  it('only allows publish/promote to supersede a local task with a new shared TaskRef', () => {
    const localTaskRef = { namespace: 'local' as const, taskId: LOCAL_ID };
    const sharedTaskRef = { namespace: 'shared' as const, taskId: SHARED_ID };
    expect(() =>
      assertWorkflowStatusTransition({
        sourceTaskRef: localTaskRef,
        from: 'in_progress',
        to: 'superseded',
        operation: 'ordinary',
        successorTaskRef: sharedTaskRef,
      }),
    ).toThrow(/publish or promote/);
    expect(() =>
      assertWorkflowStatusTransition({
        sourceTaskRef: localTaskRef,
        from: 'in_progress',
        to: 'superseded',
        operation: 'publish',
        successorTaskRef: localTaskRef,
      }),
    ).toThrow(/new shared TaskRef/);
    expect(() =>
      assertWorkflowStatusTransition({
        sourceTaskRef: localTaskRef,
        from: 'in_progress',
        to: 'superseded',
        operation: 'promote',
        successorTaskRef: sharedTaskRef,
      }),
    ).not.toThrow();
  });

  it('uses deterministic canonical JSON and rejects unsafe input', () => {
    expect(canonicalizeJson({ z: [true, null], a: 1 })).toBe(
      '{"a":1,"z":[true,null]}',
    );
    expect(sortUtf8StringSet(['z', 'é', 'a', 'é'])).toEqual(['a', 'z', 'é']);
    expect(digestCanonicalJson({ a: 1, z: [true, null] })).toBe(
      'sha256:d79ef1418118f481e327f7703cda523ad18181b74f2779b866bc9d0cb41d11dc',
    );
    expect(() => canonicalizeJson({ value: -0 })).toThrow(/negative zero/);
    expect(() => canonicalizeJson({ value: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalizeJson({ value: '\uD800' })).toThrow(
      /lone surrogate/,
    );
    const sparse = new Array<number>(2);
    expect(() => canonicalizeJson(sparse)).toThrow(/sparse/);
  });

  it('matches RFC 8785 number and object-key ordering vectors', () => {
    const numberVector = JSON.parse(
      '{"numbers":[333333333.33333329,1e30,4.5,2e-3,0.000000000000000000000000001]}',
    );
    expect(canonicalizeJson(numberVector, { numberPolicy: 'finite' })).toBe(
      '{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
    );
    expect(digestCanonicalJson(numberVector, { numberPolicy: 'finite' })).toBe(
      'sha256:7c892d3452ad85ad65857a43e8dcac93b79475d2334fc3e85bac5c599142c158',
    );
    expect(
      canonicalizeJson({
        '\u20ac': 'Euro Sign',
        '\r': 'Carriage Return',
        '\ufb33': 'Hebrew Letter Dalet With Dagesh',
        '\u0001': 'Start of Heading',
        '😀': 'Emoji: Grinning Face',
        '\u0080': 'Control',
        ö: 'Latin Small Letter O With Diaeresis',
      }),
    ).toBe(
      '{"\\u0001":"Start of Heading","\\r":"Carriage Return","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('marks a child parent snapshot stale after a parent contract change', () => {
    const snapshot = parseParentSnapshot({
      parent: {
        taskRef: { namespace: 'shared', taskId: SHARED_ID },
        revisionAtCreate: 7,
        planVersionAtCreate: 2,
        requirementsDigestAtCreate: DIGEST,
        implementationScopeDigestAtCreate: DIGEST,
        visibility: 'shared',
        coordination: 'team',
        participants: [OTHER_SHARED_ID, SHARED_ID],
      },
    });
    expect(snapshot.participants).toEqual([SHARED_ID, OTHER_SHARED_ID]);
    expect(
      parentSnapshotStaleReasons(snapshot, {
        taskRef: { namespace: 'shared', taskId: SHARED_ID },
        revision: 8,
        planVersion: 2,
        requirementsDigest: DIGEST,
        implementationScopeDigest: DIGEST,
        visibility: 'shared',
        coordination: 'team',
      }),
    ).toEqual(['revision']);
  });
});
