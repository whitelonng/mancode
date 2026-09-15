import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startProjectProgressPreview } from '../src/context/project-progress-server.js';
import { ProjectProgressController } from '../src/context/project-progress.js';
import type { V3ContextStore } from '../src/context/store.js';

function fixture() {
  let reads = 0;
  const project = {
    fingerprint: 'stable',
    config: { transport: { mode: 'local' } },
    confirmedDecisions: [],
    privacy: null,
  };
  const store = {
    readProjectSnapshot: async () => {
      reads++;
      return project;
    },
    listWorkflowMetadata: async () => {
      reads++;
      return [];
    },
  } as unknown as V3ContextStore;
  return {
    controller: new ProjectProgressController(store, {
      workspaceId: 'workspace',
      checkoutId: 'checkout',
      projectName: 'Example',
    }),
    reads: () => reads,
    project,
  };
}
async function http(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { headers, method }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('read-only loopback progress preview', () => {
  it('serves real HTTP while idle polling only checks the lightweight signal', async () => {
    const f = fixture();
    await f.controller.refresh();
    let revision = 1;
    let notifications = 0;
    const preview = await startProjectProgressPreview(f.controller, {
      readNotification: async () => {
        notifications++;
        return { revision, change: { project: true } };
      },
    });
    try {
      expect((await http(preview.url)).status).toBe(200);
      await http(`${preview.url}/api/version`);
      const reads = f.reads();
      for (let i = 0; i < 10; i++) {
        const response = await http(`${preview.url}/api/version`);
        expect(JSON.parse(response.body).notifications).toBe('connected');
      }
      expect(f.reads()).toBe(reads);
      expect(notifications).toBe(12);
      revision = 3;
      await http(`${preview.url}/api/version`);
      expect(f.reads()).toBeGreaterThan(reads);
      const version = f.controller.version().version;
      expect(
        (
          await http(
            `${preview.url}/api/data?version=${encodeURIComponent(version ?? '')}`,
          )
        ).status,
      ).toBe(200);
      expect((await http(`${preview.url}/api/data?version=old`)).status).toBe(
        409,
      );
    } finally {
      await preview.close();
    }
  });
  it('synchronizes direct content reads and fails closed when the signal is unavailable', async () => {
    const f = fixture();
    await f.controller.refresh();
    let revision = 1;
    let unavailable = false;
    const preview = await startProjectProgressPreview(f.controller, {
      readNotification: async () =>
        unavailable ? null : { revision, change: { project: true } },
    });
    try {
      await http(preview.url);
      const before = f.reads();
      f.project.fingerprint = 'privacy-changed';
      revision++;
      await http(
        `${preview.url}/api/data?version=${f.controller.version().version}`,
      );
      expect(f.reads()).toBeGreaterThan(before);
      unavailable = true;
      expect((await http(preview.url)).status).toBe(503);
      expect(
        (
          await http(
            `${preview.url}/api/tasks?version=${f.controller.version().version}`,
          )
        ).status,
      ).toBe(503);
    } finally {
      await preview.close();
    }
  });
  it('rejects mutation, cross-site, arbitrary path and foreign host requests', async () => {
    const f = fixture();
    await f.controller.refresh();
    const preview = await startProjectProgressPreview(f.controller);
    try {
      expect(
        (await http(`${preview.url}/api/version`, {}, 'POST')).status,
      ).toBe(405);
      expect(
        (
          await http(`${preview.url}/api/version`, {
            Origin: 'https://evil.example',
          })
        ).status,
      ).toBe(403);
      expect(
        (await http(`${preview.url}/api/version`, { Host: 'evil.example' }))
          .status,
      ).toBe(403);
      expect(
        (await http(`${preview.url}/.mancode/local/actor.json`)).status,
      ).toBe(404);
      expect((await http(`${preview.url}/%2e%2e/secret`)).status).toBe(404);
      expect(
        JSON.parse((await http(`${preview.url}/api/version`)).body)
          .notifications,
      ).toBe('unverified');
    } finally {
      await preview.close();
    }
  });
  it('reports stale while notification reading fails and recovers on a later read', async () => {
    const f = fixture();
    await f.controller.refresh();
    let failed = false;
    const preview = await startProjectProgressPreview(f.controller, {
      readNotification: async () => {
        if (failed) throw new Error('failure');
        return { revision: 1, change: { project: true } };
      },
    });
    try {
      expect(
        JSON.parse((await http(`${preview.url}/api/version`)).body).stale,
      ).toBe(false);
      failed = true;
      expect(
        JSON.parse((await http(`${preview.url}/api/version`)).body).stale,
      ).toBe(true);
      failed = false;
      expect(
        JSON.parse((await http(`${preview.url}/api/version`)).body).stale,
      ).toBe(false);
    } finally {
      await preview.close();
    }
  });
});
