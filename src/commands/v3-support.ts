import path from 'node:path';
import {
  type StoredProjectSnapshot,
  V3ContextStore,
} from '../context/store.js';
import { readPlatformSessionSpike } from '../runtime/platform-spike-store.js';
import {
  type SessionSpikePlatform,
  evaluatePlatformSessionCapability,
} from '../runtime/platform-spike.js';
import {
  type ProjectRuntimeContext,
  readProjectRuntimeContext,
} from '../runtime/project-runtime.js';
import { createSessionIdentityProvider } from '../runtime/session-identity.js';
import {
  type SessionStateV1,
  resolveSessionCandidate,
} from '../runtime/session.js';
import { readLocalActor } from '../team/actor.js';

export const EXIT_V3_OK = 0;
export const EXIT_V3_INVALID_ARGUMENT = 2;
export const EXIT_V3_BLOCKED = 3;

export interface V3CommandProject {
  projectRoot: string;
  runtime: ProjectRuntimeContext;
  store: V3ContextStore;
  project: StoredProjectSnapshot;
}

export async function readV3CommandProject(
  projectRoot: string,
): Promise<V3CommandProject> {
  const root = path.resolve(projectRoot);
  const runtime = await readProjectRuntimeContext(root);
  const store = new V3ContextStore(root);
  return {
    projectRoot: root,
    runtime,
    store,
    project: await store.readProjectSnapshot(),
  };
}

/**
 * There is intentionally no process-global client pointer. A caller either
 * supplies a session, inherits MANCODE_SESSION_ID, or receives a precise
 * bootstrap error.
 */
export async function resolveV3CommandSession(
  project: V3CommandProject,
  input: { session?: string; client?: string },
): Promise<SessionStateV1> {
  const client = commandClient(input.client);
  const candidate = await resolveV3SessionCandidate(project, input, client);
  const actor =
    candidate?.source === 'host'
      ? await readLocalActor(project.projectRoot)
      : null;
  const session = await resolveSessionCandidate(
    project.projectRoot,
    candidate,
    actor?.actorId,
  );
  if (session === null) throw new Error('MANCODE_SESSION_REQUIRED');
  return session;
}

/**
 * A Context Pack may be inspected without a session, but only an explicit
 * TaskRef can locate the task in that case. Mutating commands continue to use
 * resolveV3CommandSession and therefore require a reliable identity.
 */
export async function resolveV3ReadSession(
  project: V3CommandProject,
  input: { session?: string; client?: string },
): Promise<SessionStateV1 | null> {
  const client = commandClient(input.client);
  const candidate = await resolveV3SessionCandidate(project, input, client);
  const actor =
    candidate?.source === 'host'
      ? await readLocalActor(project.projectRoot)
      : null;
  return resolveSessionCandidate(
    project.projectRoot,
    candidate,
    actor?.actorId,
  );
}

async function resolveV3SessionCandidate(
  project: V3CommandProject,
  input: { session?: string; client?: string },
  client: string,
) {
  const platform = platformForClient(client);
  const spike =
    platform === null
      ? null
      : await readPlatformSessionSpike(project.projectRoot, platform);
  const hostIdentityCapability =
    spike === null
      ? 'explicit_required'
      : evaluatePlatformSessionCapability(spike).hostIdentity;
  const hostSessionKey = process.env.MANCODE_HOST_SESSION_KEY;
  const provider = createSessionIdentityProvider(project.runtime.workspaceId, {
    hostIdentityCapability,
  });
  return provider.resolveCandidate({
    explicitSessionId: input.session,
    environment: process.env,
    ...(hostIdentityCapability === 'host_verified' && hostSessionKey
      ? {
          trustedHostInput: {
            externalSessionKey: hostSessionKey,
            propagatesToCommands: true,
          },
        }
      : {}),
    client,
  });
}

function platformForClient(client: string): SessionSpikePlatform | null {
  return client === 'claude-code' ||
    client === 'codex' ||
    client === 'cursor' ||
    client === 'copilot' ||
    client === 'zcode'
    ? client
    : null;
}

export function commandClient(value: string | undefined): string {
  const client = value ?? 'mancode-cli';
  if (!client.trim() || client.includes('\0')) {
    throw new Error('MANCODE_CLIENT_INVALID');
  }
  return client.trim();
}

export function printV3Result(
  json: boolean | undefined,
  result: unknown,
): number {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return EXIT_V3_OK;
}

export function printV3Error(
  json: boolean | undefined,
  code: string,
  message: string,
  exitCode: number = EXIT_V3_BLOCKED,
): number {
  const result = { schemaVersion: 1, error: { code, message } };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`✗  ${code}`);
    console.error(`   ${message}`);
  }
  return exitCode;
}

export function v3ErrorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.startsWith('MANCODE_')) {
    return error.message.split(':', 1)[0] ?? fallback;
  }
  return fallback;
}
