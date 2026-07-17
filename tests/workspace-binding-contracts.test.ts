import { describe, expect, it } from 'vitest';
import {
  assertCheckoutBindingMatchesWorkspace,
  assertWorkspaceBindingCompatible,
  assertWorkspaceBindingMatchesConfig,
  gitRefCoordinationDomainId,
  localCoordinationDomainId,
  parseCheckoutBinding,
  parseCommonDirRegistry,
  parseWorkspaceBinding,
} from '../src/runtime/workspace-binding.js';
import {
  parseProjectConfig,
  projectConfigIdentityDigest,
} from '../src/team/policy.js';

const WORKSPACE_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7H';
const BINDING_ID = '01JZ4B6W5Z0A1B2C3D4E5F6G7J';
const CHECKOUT_A = '01JZ4B6W5Z0A1B2C3D4E5F6G7K';
const CHECKOUT_B = '01JZ4B6W5Z0A1B2C3D4E5F6G7M';
const EPOCH = '01JZ4B6W5Z0A1B2C3D4E5F6G7N';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('common-dir workspace and checkout bindings', () => {
  it('binds a workspace to config identity and monorepo-relative project path', () => {
    const config = parseProjectConfig(rawConfig());
    const binding = parseWorkspaceBinding(rawWorkspaceBinding(config));
    expect(() =>
      assertWorkspaceBindingMatchesConfig(binding, config),
    ).not.toThrow();
    expect(() =>
      assertWorkspaceBindingCompatible(
        binding,
        parseWorkspaceBinding({
          ...rawWorkspaceBinding(config),
          projectPathFromWorktreeRoot: 'packages/other',
        }),
      ),
    ).toThrow('MANCODE_WORKSPACE_BINDING_MISMATCH');
    expect(() =>
      parseWorkspaceBinding({
        ...rawWorkspaceBinding(config),
        projectPathFromWorktreeRoot: '../outside',
      }),
    ).toThrow(/projectPathFromWorktreeRoot/);
  });

  it('allows distinct worktree identities while keeping coordination domain scoped', () => {
    const config = parseProjectConfig(rawConfig());
    const workspace = parseWorkspaceBinding(rawWorkspaceBinding(config));
    const checkoutA = parseCheckoutBinding(
      rawCheckoutBinding(CHECKOUT_A, DIGEST),
    );
    const checkoutB = parseCheckoutBinding(
      rawCheckoutBinding(CHECKOUT_B, `sha256:${'b'.repeat(64)}`),
    );
    expect(() =>
      assertCheckoutBindingMatchesWorkspace(checkoutA, workspace),
    ).not.toThrow();
    expect(() =>
      assertCheckoutBindingMatchesWorkspace(checkoutB, workspace),
    ).not.toThrow();
    expect(localCoordinationDomainId(BINDING_ID, WORKSPACE_ID)).toBe(
      `local:${BINDING_ID}:${WORKSPACE_ID}`,
    );
    expect(gitRefCoordinationDomainId(DIGEST, WORKSPACE_ID, EPOCH)).toBe(
      `git-ref:${DIGEST}:${WORKSPACE_ID}:${EPOCH}`,
    );
    expect(() =>
      parseCommonDirRegistry({
        schemaVersion: 1,
        workspaceIds: [WORKSPACE_ID, WORKSPACE_ID],
        updatedAt: '2026-07-17T10:00:00.000Z',
      }),
    ).toThrow(/must not contain duplicates/);
  });
});

function rawConfig() {
  return {
    schemaVersion: 1,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    transport: { mode: 'local', remote: null },
    lastOperationId: null,
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function rawWorkspaceBinding(config: ReturnType<typeof parseProjectConfig>) {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    repositoryBindingId: BINDING_ID,
    projectPathFromWorktreeRoot: 'packages/app',
    configSchemaVersion: config.schemaVersion,
    configIdentityDigest: projectConfigIdentityDigest(config),
    registeredAt: '2026-07-17T10:00:00.000Z',
  };
}

function rawCheckoutBinding(checkoutId: string, realpathHash: string) {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    repositoryBindingId: BINDING_ID,
    checkoutId,
    worktreeGitDirHash: DIGEST,
    projectRealpathHash: realpathHash,
    registeredAt: '2026-07-17T10:00:00.000Z',
    lastSeenAt: '2026-07-17T10:01:00.000Z',
  };
}
