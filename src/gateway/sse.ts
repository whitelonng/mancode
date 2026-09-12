import type { Node } from 'jsonc-parser';
import { GatewayError } from './errors.js';
import {
  type JsonEdit,
  applyJsonEdits,
  parseStrictJson,
  property,
  replaceString,
  stringValue,
} from './json.js';
import { IncrementalRestorer, type RequestMapping } from './mapping.js';
import {
  type GatewayProtocol,
  restoreToolArguments,
  transformContentItem,
  transformResponse,
} from './protocol.js';

export interface SseFrame {
  event?: string;
  data: string;
}
export class SseDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  constructor(private readonly maxEventBytes = 256 * 1024) {}
  push(chunk: Uint8Array, final = false): SseFrame[] {
    try {
      this.pending += this.decoder.decode(chunk, { stream: !final });
    } catch {
      throw new GatewayError('MANCODE_GATEWAY_INVALID_UTF8');
    }
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const block = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (Buffer.byteLength(block) > this.maxEventBytes)
        throw new GatewayError('MANCODE_GATEWAY_EVENT_LIMIT');
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':') || line === '') continue;
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (name === 'event') event = value;
        else if (name === 'data') data.push(value);
        else throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_SSE_FIELD');
      }
      if (data.length) frames.push({ event, data: data.join('\n') });
      if (frames.length > 256)
        throw new GatewayError('MANCODE_GATEWAY_EVENT_QUEUE_LIMIT');
    }
    if (Buffer.byteLength(this.pending) > this.maxEventBytes)
      throw new GatewayError('MANCODE_GATEWAY_EVENT_LIMIT');
    if (final && this.pending.trim())
      throw new GatewayError('MANCODE_GATEWAY_TRUNCATED_SSE');
    return frames;
  }
}

export function encodeSse(frame: SseFrame): string {
  return `${frame.event ? `event: ${frame.event}\n` : ''}${frame.data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`;
}

interface TextChannel {
  restorer: IncrementalRestorer;
  closed: boolean;
}
interface ToolChannel {
  arguments: string;
  closed: boolean;
  initial?: SseFrame;
  name?: string;
}
const RESPONSE_METADATA = new Set(['response.in_progress', 'response.queued']);
const OPAQUE_EVENTS = new Set([
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
]);

/** Incremental plain text; tool arguments remain private until a validated done event. */
export class ProtocolStream {
  private texts = new Map<string, TextChannel>();
  private tools = new Map<string, ToolChannel>();
  private anthropicTypes = new Map<number, string>();
  responseId: string | undefined;
  completed = false;
  opaqueBlocks = 0;
  constructor(
    private readonly protocol: GatewayProtocol,
    private readonly mapping: RequestMapping,
    private readonly maxChannels = 128,
    private readonly maxToolBytes = 256 * 1024,
  ) {}

  accept(frame: SseFrame): SseFrame[] {
    if (frame.data === '[DONE]') {
      if (!this.completed)
        throw new GatewayError('MANCODE_GATEWAY_TRUNCATED_RESPONSE');
      return [frame];
    }
    if (this.completed)
      throw new GatewayError('MANCODE_GATEWAY_EVENT_AFTER_DONE');
    const tree = parseStrictJson(frame.data);
    const type = stringValue(property(tree, 'type'));
    if (!type || (frame.event && frame.event !== type))
      throw new GatewayError('MANCODE_GATEWAY_EVENT_TYPE_MISMATCH');
    return this.protocol === 'responses'
      ? this.responses(frame, tree, type)
      : this.messages(frame, tree, type);
  }

  finish(): void {
    if (!this.completed)
      throw new GatewayError('MANCODE_GATEWAY_TRUNCATED_RESPONSE');
    for (const channel of this.texts.values())
      if (!channel.closed)
        throw new GatewayError('MANCODE_GATEWAY_UNFINISHED_CHANNEL');
    for (const channel of this.tools.values())
      if (!channel.closed)
        throw new GatewayError('MANCODE_GATEWAY_UNFINISHED_TOOL');
  }

  private key(tree: Node): string {
    const index = property(tree, 'output_index')?.value;
    const content = property(tree, 'content_index')?.value ?? 0;
    const item = stringValue(property(tree, 'item_id'));
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !Number.isSafeInteger(content) ||
      content < 0 ||
      !item ||
      item.length > 256
    )
      throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ID_INVALID');
    return `${index}:${content}:${item}`;
  }

  private limitChannels(): void {
    if (this.texts.size + this.tools.size >= this.maxChannels)
      throw new GatewayError('MANCODE_GATEWAY_CHANNEL_LIMIT');
  }

  private textDelta(key: string, delta: string, done = false): string {
    let channel = this.texts.get(key);
    if (!channel) {
      this.limitChannels();
      channel = {
        restorer: new IncrementalRestorer(this.mapping),
        closed: false,
      };
      this.texts.set(key, channel);
    }
    if (channel.closed)
      throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ALREADY_DONE');
    const restored = channel.restorer.push(delta, done);
    channel.closed = done;
    return restored;
  }

  private toolDelta(key: string, delta: string): void {
    let channel = this.tools.get(key);
    if (!channel) {
      this.limitChannels();
      channel = { arguments: '', closed: false };
      this.tools.set(key, channel);
    }
    if (channel.closed)
      throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ALREADY_DONE');
    if (
      Buffer.byteLength(channel.arguments) + Buffer.byteLength(delta) >
      this.maxToolBytes
    )
      throw new GatewayError('MANCODE_GATEWAY_TOOL_LIMIT');
    channel.arguments += delta;
  }

  private toolDone(key: string, snapshot?: string): string {
    const channel = this.tools.get(key);
    if (channel?.closed)
      throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ALREADY_DONE');
    if (
      snapshot !== undefined &&
      channel?.arguments &&
      snapshot !== channel.arguments
    )
      throw new GatewayError('MANCODE_GATEWAY_TOOL_SNAPSHOT_MISMATCH');
    const argumentsText = snapshot ?? (channel?.arguments || '{}');
    const restored = restoreToolArguments(
      argumentsText,
      this.mapping,
      channel?.name,
    );
    if (channel) channel.closed = true;
    return restored;
  }

  private responses(frame: SseFrame, tree: Node, type: string): SseFrame[] {
    if (type === 'response.created') {
      if (this.responseId)
        throw new GatewayError('MANCODE_GATEWAY_DUPLICATE_RESPONSE');
      const response = property(tree, 'response');
      this.responseId = response && stringValue(property(response, 'id'));
      if (!this.responseId)
        throw new GatewayError('MANCODE_GATEWAY_RESPONSE_ID_MISSING');
      const output = response && property(response, 'output');
      if (output?.children?.length)
        throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_RESPONSE');
      return [frame];
    }
    if (
      type === 'response.output_text.delta' ||
      type === 'response.refusal.delta'
    ) {
      const delta = property(tree, 'delta');
      if (delta?.type !== 'string')
        throw new GatewayError('MANCODE_GATEWAY_INVALID_DELTA');
      const edits: JsonEdit[] = [];
      const value = this.textDelta(this.key(tree), delta.value);
      replaceString(edits, delta, value);
      return value
        ? [{ ...frame, data: applyJsonEdits(frame.data, edits) }]
        : [];
    }
    if (
      type === 'response.output_text.done' ||
      type === 'response.refusal.done'
    ) {
      const fieldName = type === 'response.refusal.done' ? 'refusal' : 'text';
      const field = property(tree, fieldName);
      if (field?.type !== 'string')
        throw new GatewayError('MANCODE_GATEWAY_INVALID_DELTA');
      const tail = this.textDelta(this.key(tree), '', true);
      const edits: JsonEdit[] = [];
      replaceString(edits, field, this.mapping.restore(field.value));
      const output: SseFrame[] = [];
      if (tail) {
        const delta = {
          type: type.replace(/\.done$/, '.delta'),
          item_id: property(tree, 'item_id')?.value,
          output_index: property(tree, 'output_index')?.value,
          content_index: property(tree, 'content_index')?.value,
          delta: tail,
        };
        output.push({ event: delta.type, data: JSON.stringify(delta) });
      }
      output.push({ ...frame, data: applyJsonEdits(frame.data, edits) });
      return output;
    }
    if (type === 'response.function_call_arguments.delta') {
      const delta = stringValue(property(tree, 'delta'));
      if (delta === undefined)
        throw new GatewayError('MANCODE_GATEWAY_INVALID_DELTA');
      if (!this.tools.has(this.key(tree)))
        throw new GatewayError('MANCODE_GATEWAY_UNKNOWN_TOOL_CHANNEL');
      this.toolDelta(this.key(tree), delta);
      return [];
    }
    if (type === 'response.function_call_arguments.done') {
      const args = stringValue(property(tree, 'arguments'));
      if (args === undefined)
        throw new GatewayError('MANCODE_GATEWAY_INVALID_TOOL_ARGUMENTS');
      const value = this.toolDone(this.key(tree), args);
      // A single complete delta preserves the normal host protocol without exposing partial arguments.
      const delta = {
        type: 'response.function_call_arguments.delta',
        item_id: property(tree, 'item_id')?.value,
        output_index: property(tree, 'output_index')?.value,
        delta: value,
      };
      return [{ event: delta.type, data: JSON.stringify(delta) }, frame];
    }
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done' ||
      type === 'response.content_part.added' ||
      type === 'response.content_part.done'
    ) {
      const item = property(
        tree,
        type.includes('output_item') ? 'item' : 'part',
      );
      if (!item) throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_EVENT');
      if (
        type === 'response.output_item.added' &&
        stringValue(property(item, 'type')) === 'function_call' &&
        stringValue(property(item, 'arguments')) !== ''
      )
        throw new GatewayError('MANCODE_GATEWAY_NONEMPTY_INITIAL_TOOL');
      // Added tool items have empty arguments by protocol; they cannot execute until done.
      if (
        type === 'response.output_item.added' &&
        stringValue(property(item, 'type')) === 'function_call' &&
        stringValue(property(item, 'arguments')) === ''
      ) {
        const itemSource = frame.data.slice(
          item.offset,
          item.offset + item.length,
        );
        const itemTree = parseStrictJson(itemSource);
        const argumentsNode = property(itemTree, 'arguments');
        if (!argumentsNode)
          throw new GatewayError('MANCODE_GATEWAY_INVALID_TOOL_ARGUMENTS');
        transformContentItem(
          applyJsonEdits(itemSource, [
            {
              offset: argumentsNode.offset,
              length: argumentsNode.length,
              text: JSON.stringify('{}'),
            },
          ]),
          this.mapping,
        );
        const index = property(tree, 'output_index')?.value;
        const itemId = stringValue(property(item, 'id'));
        if (!Number.isSafeInteger(index) || index < 0 || !itemId)
          throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ID_INVALID');
        const key = `${index}:0:${itemId}`;
        if (this.tools.has(key))
          throw new GatewayError('MANCODE_GATEWAY_DUPLICATE_TOOL');
        this.toolDelta(key, '');
        const channel = this.tools.get(key) as ToolChannel;
        channel.name = stringValue(property(item, 'name'));
        return [frame];
      }
      const result = transformContentItem(
        frame.data.slice(item.offset, item.offset + item.length),
        this.mapping,
      );
      this.opaqueBlocks += result.opaqueBlocks;
      return [
        {
          ...frame,
          data: applyJsonEdits(frame.data, [
            { offset: item.offset, length: item.length, text: result.body },
          ]),
        },
      ];
    }
    if (type === 'response.completed') {
      const response = property(tree, 'response');
      if (
        !response ||
        stringValue(property(response, 'id')) !== this.responseId
      )
        throw new GatewayError('MANCODE_GATEWAY_RESPONSE_SCOPE_MISMATCH');
      const result = transformResponse(
        frame.data.slice(response.offset, response.offset + response.length),
        'responses',
        this.mapping,
      );
      this.opaqueBlocks += result.opaqueBlocks;
      this.completed = true;
      this.finish();
      return [
        {
          ...frame,
          data: applyJsonEdits(frame.data, [
            {
              offset: response.offset,
              length: response.length,
              text: result.body,
            },
          ]),
        },
      ];
    }
    if (OPAQUE_EVENTS.has(type)) {
      this.opaqueBlocks++;
      return [frame];
    }
    if (RESPONSE_METADATA.has(type)) return [frame];
    throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_EVENT');
  }

  private messages(frame: SseFrame, tree: Node, type: string): SseFrame[] {
    if (type === 'ping') return [frame];
    if (type === 'message_start') {
      if (this.responseId)
        throw new GatewayError('MANCODE_GATEWAY_DUPLICATE_RESPONSE');
      const message = property(tree, 'message');
      this.responseId = message && stringValue(property(message, 'id'));
      if (
        !this.responseId ||
        property(message as Node, 'content')?.children?.length
      )
        throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_RESPONSE');
      return [frame];
    }
    if (type === 'message_delta') return [frame];
    if (type === 'message_stop') {
      this.completed = true;
      this.finish();
      return [frame];
    }
    const index = property(tree, 'index')?.value;
    if (!Number.isSafeInteger(index) || index < 0)
      throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ID_INVALID');
    const key = `messages:${index}`;
    if (type === 'content_block_start') {
      if (
        this.anthropicTypes.has(index) ||
        this.anthropicTypes.size >= this.maxChannels
      )
        throw new GatewayError('MANCODE_GATEWAY_CHANNEL_LIMIT');
      const block = property(tree, 'content_block');
      const blockType = block && stringValue(property(block, 'type'));
      if (!block || !blockType)
        throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_EVENT');
      this.anthropicTypes.set(index, blockType);
      if (blockType === 'tool_use') {
        const input = property(block, 'input');
        if (input?.type !== 'object' || input.children?.length)
          throw new GatewayError('MANCODE_GATEWAY_NONEMPTY_INITIAL_TOOL');
        transformContentItem(
          frame.data.slice(block.offset, block.offset + block.length),
          this.mapping,
        );
        this.toolDelta(key, '');
        const channel = this.tools.get(key) as ToolChannel;
        channel.initial = frame;
        channel.name = stringValue(property(block, 'name'));
        return [];
      }
      const result = transformContentItem(
        frame.data.slice(block.offset, block.offset + block.length),
        this.mapping,
      );
      this.opaqueBlocks += result.opaqueBlocks;
      return [
        {
          ...frame,
          data: applyJsonEdits(frame.data, [
            { offset: block.offset, length: block.length, text: result.body },
          ]),
        },
      ];
    }
    if (type === 'content_block_delta') {
      const delta = property(tree, 'delta');
      const deltaType = delta && stringValue(property(delta, 'type'));
      if (!delta) throw new GatewayError('MANCODE_GATEWAY_INVALID_DELTA');
      if (
        deltaType === 'input_json_delta' &&
        this.anthropicTypes.get(index) === 'tool_use'
      ) {
        const value = stringValue(property(delta, 'partial_json'));
        if (value === undefined)
          throw new GatewayError('MANCODE_GATEWAY_INVALID_DELTA');
        this.toolDelta(key, value);
        return [];
      }
      if (
        deltaType === 'text_delta' &&
        this.anthropicTypes.get(index) === 'text'
      ) {
        const field = property(delta, 'text');
        if (field?.type !== 'string')
          throw new GatewayError('MANCODE_GATEWAY_INVALID_DELTA');
        const edits: JsonEdit[] = [];
        const value = this.textDelta(key, field.value);
        replaceString(edits, field, value);
        return value
          ? [{ ...frame, data: applyJsonEdits(frame.data, edits) }]
          : [];
      }
      if (
        (deltaType === 'thinking_delta' || deltaType === 'signature_delta') &&
        this.anthropicTypes.get(index) === 'thinking'
      ) {
        this.opaqueBlocks++;
        return [frame];
      }
      throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_EVENT');
    }
    if (type === 'content_block_stop') {
      if (!this.anthropicTypes.has(index))
        throw new GatewayError('MANCODE_GATEWAY_CHANNEL_ID_INVALID');
      const tool = this.tools.get(key);
      if (tool) {
        const args = this.toolDone(key);
        const delta = {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: args },
        };
        return [
          tool.initial as SseFrame,
          { event: delta.type, data: JSON.stringify(delta) },
          frame,
        ];
      }
      const tail = this.texts.has(key) ? this.textDelta(key, '', true) : '';
      if (tail) {
        const delta = {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: tail },
        };
        return [{ event: delta.type, data: JSON.stringify(delta) }, frame];
      }
      return [frame];
    }
    throw new GatewayError('MANCODE_GATEWAY_UNSUPPORTED_EVENT');
  }
}
