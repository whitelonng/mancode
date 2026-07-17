import { createHash } from 'node:crypto';
import { type Ulid, assertUlid } from '../context/ids.js';

export type SessionIdentitySource = 'explicit' | 'env' | 'host';
export type HostIdentityCapability = 'host_verified' | 'explicit_required';

export interface SessionIdentityCandidate {
  internalSessionId?: Ulid;
  externalKeyHash?: string;
  source: SessionIdentitySource;
  client: string;
  propagatesToCommands: boolean;
}

export interface TrustedHostSessionInput {
  externalSessionKey: string;
  propagatesToCommands: boolean;
}

export interface SessionIdentityProviderInput {
  explicitSessionId?: string;
  environment: NodeJS.ProcessEnv;
  trustedHostInput?: TrustedHostSessionInput;
  client: string;
}

export interface SessionIdentityProvider {
  resolveCandidate(
    input: SessionIdentityProviderInput,
  ): SessionIdentityCandidate | null;
}

export interface SessionIdentityProviderOptions {
  /** No platform evidence means host identity is never trusted by default. */
  hostIdentityCapability?: HostIdentityCapability;
}

export function createSessionIdentityProvider(
  workspaceId: Ulid,
  options: SessionIdentityProviderOptions = {},
): SessionIdentityProvider {
  assertUlid(workspaceId, 'workspaceId');
  const hostIdentityCapability =
    options.hostIdentityCapability ?? 'explicit_required';
  if (
    hostIdentityCapability !== 'host_verified' &&
    hostIdentityCapability !== 'explicit_required'
  ) {
    throw new Error('host identity capability is invalid');
  }
  return {
    resolveCandidate(input) {
      const client = parseClient(input.client);
      if (input.explicitSessionId !== undefined) {
        assertUlid(input.explicitSessionId, '--session');
        return {
          internalSessionId: input.explicitSessionId,
          source: 'explicit',
          client,
          propagatesToCommands: true,
        };
      }
      const environmentSessionId = input.environment.MANCODE_SESSION_ID;
      if (environmentSessionId) {
        assertUlid(environmentSessionId, 'MANCODE_SESSION_ID');
        return {
          internalSessionId: environmentSessionId,
          source: 'env',
          client,
          propagatesToCommands: true,
        };
      }
      if (
        !input.trustedHostInput ||
        hostIdentityCapability !== 'host_verified'
      ) {
        return null;
      }
      return {
        externalKeyHash: hashHostSessionKey(
          workspaceId,
          client,
          input.trustedHostInput.externalSessionKey,
        ),
        source: 'host',
        client,
        propagatesToCommands: input.trustedHostInput.propagatesToCommands,
      };
    },
  };
}

/** The raw host identifier only exists in memory and never becomes a filename. */
export function hashHostSessionKey(
  workspaceId: Ulid,
  client: string,
  rawHostSessionKey: string,
): string {
  assertUlid(workspaceId, 'workspaceId');
  const normalizedClient = parseClient(client);
  const normalizedKey = normalizeHostSessionKey(rawHostSessionKey);
  return `sha256:${createHash('sha256')
    .update(`${workspaceId}\0${normalizedClient}\0${normalizedKey}`, 'utf8')
    .digest('hex')}`;
}

function parseClient(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('session client is required');
  }
  return value.trim();
}

function normalizeHostSessionKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('trusted host session key is required');
  }
  const normalized = value.trim();
  if (normalized.includes('\0')) {
    throw new Error('trusted host session key must not contain NUL');
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue;
    const next = normalized.charCodeAt(index + 1);
    if (codeUnit > 0xdbff || next < 0xdc00 || next > 0xdfff) {
      throw new Error(
        'trusted host session key must not contain a lone surrogate',
      );
    }
    index += 1;
  }
  return normalized;
}
