import type { SchemaManifest } from '../context/manifest.js';
import { GitRefTeamManifestStore } from './git-ref-transport.js';
import { type ProjectConfigV1, projectConfigDigest } from './policy.js';

/** Creates a strict client bound to the exact active project/transport header. */
export function createGitRefTeamManifestStore(
  projectRoot: string,
  config: ProjectConfigV1,
  manifest: SchemaManifest,
): GitRefTeamManifestStore {
  if (config.transport.mode !== 'git-ref' || config.transport.remote === null) {
    throw new Error('MANCODE_TRANSPORT_UNAVAILABLE');
  }
  return new GitRefTeamManifestStore({
    projectRoot,
    remote: config.transport.remote,
    workspaceId: config.workspaceId,
    schemaEpoch: manifest.epoch,
    minReaderVersion: manifest.minReaderVersion,
    minWriterVersion: manifest.minWriterVersion,
    transportEpoch: config.transport.epoch,
    configRevision: config.revision,
    configDigest: projectConfigDigest(config),
  });
}
