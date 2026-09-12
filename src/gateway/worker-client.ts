import { Worker } from 'node:worker_threads';
import type { EngineOperation } from './engine.js';
import { GatewayError } from './errors.js';

export class GatewayWorker {
  private worker: Worker;
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    scope: string,
    rules: readonly string[],
    host: string,
    url = new URL('./gateway/worker.js', import.meta.url),
  ) {
    this.worker = new Worker(url, {
      workerData: { scope, rules, host },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
    });
    this.worker.on(
      'message',
      (message: {
        sequence: number;
        value?: unknown;
        error?: string;
        status?: number;
      }) => {
        const pending = this.pending.get(message.sequence);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.sequence);
        if (message.error)
          pending.reject(new GatewayError(message.error, message.status));
        else pending.resolve(message.value);
      },
    );
    this.worker.on('error', () => {
      void this.close();
    });
    this.worker.on('exit', () => {
      void this.close();
    });
  }
  call<T>(operation: EngineOperation): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new GatewayError('MANCODE_GATEWAY_WORKER_UNAVAILABLE', 503),
      );
    if (this.pending.size >= 32)
      return Promise.reject(
        new GatewayError('MANCODE_GATEWAY_WORKER_QUEUE_LIMIT', 429),
      );
    const sequence = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.close();
      }, 10_000);
      this.pending.set(sequence, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.worker.postMessage({ sequence, operation });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new GatewayError('MANCODE_GATEWAY_WORKER_UNAVAILABLE', 503),
      );
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}
