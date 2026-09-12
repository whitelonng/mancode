import { parentPort, workerData } from 'node:worker_threads';
import { type EngineOperation, GatewayEngine } from './engine.js';
import { GatewayError, gatewayErrorCode } from './errors.js';
const engine = new GatewayEngine(
  workerData.scope,
  workerData.rules,
  workerData.host,
);
parentPort?.on(
  'message',
  (message: { sequence: number; operation: EngineOperation }) => {
    try {
      parentPort?.postMessage({
        sequence: message.sequence,
        value: engine.execute(message.operation),
      });
    } catch (error) {
      parentPort?.postMessage({
        sequence: message.sequence,
        error: gatewayErrorCode(error),
        status: error instanceof GatewayError ? error.status : 500,
      });
    }
  },
);
