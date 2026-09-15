import { randomUUID } from 'node:crypto';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import { renderProjectProgressHtml } from '../templates/project-progress.js';
import type {
  ProgressInvalidation,
  ProjectProgressController,
} from './project-progress.js';

export interface ProgressNotification {
  revision: string | number;
  change: ProgressInvalidation;
}
export interface ProjectProgressPreviewOptions {
  port?: number;
  readNotification?: () => Promise<ProgressNotification | null>;
}

/** Foreground, loopback-only server; it cannot execute tasks or serve filesystem paths. */
export async function startProjectProgressPreview(
  controller: ProjectProgressController,
  options: ProjectProgressPreviewOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  if (
    options.port !== undefined &&
    (!Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  )
    throw new Error('MANCODE_PROGRESS_PORT_INVALID');
  const instanceId = randomUUID();
  let notificationRevision: string | number | undefined;
  let sync: Promise<void> | null = null;
  let origin = '';
  const synchronize = async () => {
    if (!options.readNotification) return;
    if (sync) return sync;
    sync = (async () => {
      try {
        const notification = await options.readNotification?.();
        if (!notification) {
          controller.setNotificationsConnected(false);
          controller.invalidate({ reason: 'notification_unavailable' });
          return;
        }
        controller.setNotificationsConnected(true);
        if (notification.revision === notificationRevision) {
          if (controller.version().stale) {
            controller.invalidate({
              full: true,
              reason: 'notification_recovery',
            });
            await controller.refresh();
          }
          return;
        }
        if (notificationRevision === undefined)
          controller.invalidate({
            full: true,
            reason: 'notification_baseline',
          });
        else if (
          notificationRevision !== undefined &&
          typeof notificationRevision === 'number' &&
          typeof notification.revision === 'number' &&
          notification.revision !== notificationRevision + 1
        )
          controller.invalidate({ full: true, reason: 'notification_gap' });
        else controller.invalidate(notification.change);
        await controller.refresh();
        notificationRevision = notification.revision;
      } catch {
        controller.setNotificationsConnected(false);
        controller.invalidate({ reason: 'notification_unavailable' });
      }
    })().finally(() => {
      sync = null;
    });
    return sync;
  };
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(value));
  };
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (request.method !== 'GET') {
      send(response, 405, { error: 'read_only' });
      return;
    }
    if (
      request.headers.host !== origin.slice('http://'.length) ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      send(response, 403, { error: 'origin_forbidden' });
      return;
    }
    const target = request.url ?? '/';
    if (
      target.length > 2048 ||
      target.includes('\\') ||
      /%2e|%2f|%5c/i.test(target) ||
      target.includes('..')
    ) {
      send(response, 404, { error: 'not_found' });
      return;
    }
    const url = new URL(target, origin);
    if (url.origin !== origin) {
      send(response, 403, { error: 'origin_forbidden' });
      return;
    }
    try {
      if (url.pathname === '/api/version') {
        await synchronize();
        send(response, 200, { ...controller.version(), instanceId });
        return;
      }
      await synchronize();
      if (controller.version().stale) {
        send(response, 503, { error: 'projection_stale' });
        return;
      }
      if (url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(renderProjectProgressHtml(controller.data(), true));
        return;
      }
      if (
        ![
          '/api/data',
          '/api/tasks',
          '/api/decisions',
          '/api/timeline',
          '/api/pitfalls',
        ].includes(url.pathname)
      ) {
        send(response, 404, { error: 'not_found' });
        return;
      }
      if (controller.version().stale) {
        send(response, 503, { error: 'projection_stale' });
        return;
      }
      if (url.searchParams.get('version') !== controller.version().version) {
        send(response, 409, { error: 'projection_changed' });
        return;
      }
      if (url.pathname === '/api/data') {
        send(response, 200, controller.data());
        return;
      }
      const kind = url.pathname.slice('/api/'.length);
      if (
        url.pathname.startsWith('/api/') &&
        ['tasks', 'decisions', 'timeline', 'pitfalls'].includes(kind)
      ) {
        const offsetText = url.searchParams.get('offset') ?? '0';
        if (!/^(0|[1-9][0-9]{0,7})$/.test(offsetText)) {
          send(response, 400, { error: 'offset_invalid' });
          return;
        }
        send(
          response,
          200,
          controller.page(
            kind as 'tasks' | 'decisions' | 'timeline' | 'pitfalls',
            Number(offsetText),
          ),
        );
        return;
      }
      send(response, 404, { error: 'not_found' });
    } catch {
      send(response, 503, { error: 'projection_unavailable' });
    }
  };
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent)
        send(response, 500, { error: 'preview_failed' });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('MANCODE_PROGRESS_LISTEN_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
