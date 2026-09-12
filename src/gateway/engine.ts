import { scanSensitiveText } from '../privacy/detect.js';
import { GatewayError } from './errors.js';
import { parseStrictJson, property, stringValue } from './json.js';
import { MappingStore, type RequestMapping } from './mapping.js';
import {
  type GatewayProtocol,
  transformRequest,
  transformResponse,
} from './protocol.js';
import { ProtocolStream, type SseFrame } from './sse.js';

export interface AuditSummary {
  phase: 'after_emit';
  action: 'observe';
  scanStatus: 'complete' | 'partial' | 'failed';
  counts: Record<string, number>;
  truncated: boolean;
}
interface ActiveRequest {
  mapping: RequestMapping;
  stream: ProtocolStream;
  protocol: GatewayProtocol;
  finished: boolean;
  audit: Map<string, string>;
  truncated: boolean;
}
export type EngineOperation =
  | { kind: 'begin'; id: string; body: string; protocol: GatewayProtocol }
  | { kind: 'frame'; id: string; frame: SseFrame }
  | { kind: 'response'; id: string; body: string }
  | { kind: 'finish'; id: string }
  | { kind: 'release'; id: string };

/** Entire content processing and reversible state stay in one bounded worker. */
export class GatewayEngine {
  private store: MappingStore;
  private requests = new Map<string, ActiveRequest>();
  constructor(
    scope: string,
    private readonly rules: readonly string[],
    private readonly host: string,
  ) {
    this.store = new MappingStore(scope);
  }
  execute(operation: EngineOperation): unknown {
    if (operation.kind === 'begin') {
      if (this.requests.size >= 8 || this.requests.has(operation.id))
        throw new GatewayError('MANCODE_GATEWAY_CONCURRENCY_LIMIT', 429);
      const tree = parseStrictJson(operation.body);
      const previous = stringValue(property(tree, 'previous_response_id'));
      const mapping = this.store.begin(previous);
      try {
        const result = transformRequest(
          operation.body,
          operation.protocol,
          mapping,
          this.rules,
          this.host,
        );
        this.requests.set(operation.id, {
          mapping,
          stream: new ProtocolStream(operation.protocol, mapping),
          protocol: operation.protocol,
          finished: false,
          audit: new Map(),
          truncated: false,
        });
        return result;
      } catch (error) {
        mapping.release();
        throw error;
      }
    }
    const active = this.requests.get(operation.id);
    if (!active) {
      if (operation.kind === 'release') return null;
      throw new GatewayError('MANCODE_GATEWAY_REQUEST_UNKNOWN');
    }
    if (operation.kind === 'release') {
      active.mapping.release();
      this.requests.delete(operation.id);
      return null;
    }
    if (operation.kind === 'frame') {
      const result = active.stream.accept(operation.frame);
      this.observeFrame(active, operation.frame);
      if (active.stream.completed && !active.finished) {
        active.mapping.finish(
          active.protocol === 'responses'
            ? active.stream.responseId
            : undefined,
        );
        active.finished = true;
      }
      return { frames: result, opaqueBlocks: active.stream.opaqueBlocks };
    }
    if (operation.kind === 'response') {
      const result = transformResponse(
        operation.body,
        active.protocol,
        active.mapping,
      );
      const responseId = stringValue(
        property(parseStrictJson(operation.body), 'id'),
      );
      if (!responseId)
        throw new GatewayError('MANCODE_GATEWAY_RESPONSE_ID_MISSING');
      active.mapping.finish(
        active.protocol === 'responses' ? responseId : undefined,
      );
      active.finished = true;
      // Buffered HTTP output can be observed before emission; we conservatively report observation only.
      return {
        ...result,
        audit: {
          phase: 'after_emit',
          action: 'observe',
          scanStatus: 'partial',
          counts: {},
          truncated: false,
        } satisfies AuditSummary,
      };
    }
    active.stream.finish();
    return {
      opaqueBlocks: active.stream.opaqueBlocks,
      audit: this.audit(active),
    };
  }

  private observeFrame(active: ActiveRequest, frame: SseFrame): void {
    if (frame.data === '[DONE]') return;
    const event = JSON.parse(frame.data) as Record<string, unknown>;
    let text: string | undefined;
    let key: string | undefined;
    if (
      event.type === 'response.output_text.delta' ||
      event.type === 'response.refusal.delta'
    ) {
      text = typeof event.delta === 'string' ? event.delta : undefined;
      key = `${event.output_index}:${event.content_index}:${event.item_id}`;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text = delta.text;
        key = `messages:${event.index}`;
      }
    }
    if (text === undefined || key === undefined) return;
    const previous = active.audit.get(key) ?? '';
    if (Buffer.byteLength(previous) + Buffer.byteLength(text) > 64 * 1024) {
      active.truncated = true;
      return;
    }
    active.audit.set(key, previous + text);
  }

  private audit(active: ActiveRequest): AuditSummary {
    const summary: AuditSummary = {
      phase: 'after_emit',
      action: 'observe',
      scanStatus: active.truncated ? 'partial' : 'complete',
      counts: {},
      truncated: active.truncated,
    };
    for (const text of active.audit.values()) {
      const result = scanSensitiveText(
        active.mapping.withoutKnownEchoes(text),
        this.rules,
      );
      if (result.status !== 'complete') {
        summary.scanStatus = 'failed';
        continue;
      }
      for (const finding of result.findings)
        summary.counts[finding.category] =
          (summary.counts[finding.category] ?? 0) + 1;
    }
    return summary;
  }
}
