import { describe, expect, it } from 'vitest';
import {
  createV3AdapterFileRecoveryAction,
  operationRecoveryPayloadDigest,
  parseOperationRecoveryPayload,
} from '../src/runtime/operation-recovery-payload.js';

describe('adapter parent recovery provenance', () => {
  const base = {
    stepId: 'replace-managed-adapters',
    target: 'claude-mode-man' as const,
    beforeContent: null,
    targetContent: '# Managed skill\n',
  };

  it('keeps old actions unchanged and protects new parent provenance in the digest', () => {
    const legacy = createV3AdapterFileRecoveryAction(base);
    expect(legacy).not.toHaveProperty('absentParentDirectories');
    const action = createV3AdapterFileRecoveryAction({
      ...base,
      absentParentDirectories: [
        '.claude/skills/man',
        '.claude/skills',
        '.claude',
      ],
    });
    const payload = {
      schemaVersion: 1 as const,
      operationId: '01JZ4B6W5Z0A1B2C3D4E5F6G7N',
      type: 'v3_activate' as const,
      primaryStoreId: 'project-local:.mancode/local',
      actions: [action],
      noOpStepIds: [],
    };
    expect(parseOperationRecoveryPayload(payload).actions).toEqual([action]);
    expect(operationRecoveryPayloadDigest(payload)).not.toBe(
      operationRecoveryPayloadDigest({ ...payload, actions: [legacy] }),
    );
  });

  it.each([
    ['../outside'],
    ['.'],
    ['.claude/../user'],
    ['/tmp'],
    ['.claude/skills/man/SKILL.md'],
    ['.github'],
    ['.claude', '.claude'],
  ])('rejects unrelated or unsafe parents: %j', (absentParentDirectories) => {
    expect(() =>
      createV3AdapterFileRecoveryAction({ ...base, absentParentDirectories }),
    ).toThrow();
  });

  it('does not claim absent parents for an existing file', () => {
    expect(() =>
      createV3AdapterFileRecoveryAction({
        ...base,
        beforeContent: '# Existing',
        absentParentDirectories: ['.claude'],
      }),
    ).toThrow();
  });
});
