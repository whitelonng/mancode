import { describe, expect, it } from 'vitest';
import { MappingStore, TOKEN_PREFIX } from '../src/gateway/mapping.js';
import { ProtocolStream, SseDecoder, encodeSse } from '../src/gateway/sse.js';

const frame = (event: Record<string, unknown>) => ({
  event: String(event.type),
  data: JSON.stringify(event),
});
describe('gateway SSE state', () => {
  it('flushes ordinary trailing token-prefix fragments for both protocols', () => {
    for (let length = 1; length < TOKEN_PREFIX.length; length++) {
      const text = `foo${TOKEN_PREFIX.slice(0, length)}`;
      const responses = new ProtocolStream(
        'responses',
        new MappingStore('s').begin(),
      );
      const output = responses.accept(
        frame({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'i',
          delta: text,
        }),
      );
      output.push(
        ...responses.accept(
          frame({
            type: 'response.output_text.done',
            output_index: 0,
            content_index: 0,
            item_id: 'i',
            text,
          }),
        ),
      );
      expect(
        output
          .map((item) => JSON.parse(item.data))
          .filter((item) => item.type.endsWith('.delta'))
          .map((item) => item.delta)
          .join(''),
      ).toBe(text);
      const messages = new ProtocolStream(
        'messages',
        new MappingStore('s').begin(),
      );
      messages.accept(
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      const anthropic = messages.accept(
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }),
      );
      anthropic.push(
        ...messages.accept(frame({ type: 'content_block_stop', index: 0 })),
      );
      expect(
        anthropic
          .map((item) => JSON.parse(item.data))
          .filter((item) => item.type === 'content_block_delta')
          .map((item) => item.delta.text)
          .join(''),
      ).toBe(text);
    }
  });
  it('rejects nonempty or unknown initial tool fields before emitting a block', () => {
    expect(() =>
      new ProtocolStream('responses', new MappingStore('s').begin()).accept(
        frame({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 't',
            name: 'tool',
            call_id: 'c',
            arguments: '{}',
          },
        }),
      ),
    ).toThrow('NONEMPTY_INITIAL_TOOL');
    for (const block of [
      {
        type: 'tool_use',
        name: 'Read',
        id: 't',
        input: { command: '__MANCODE_unknown' },
      },
      {
        type: 'tool_use',
        name: 'Read',
        id: 't',
        input: {},
        extra: 'sensitive',
      },
    ])
      expect(() =>
        new ProtocolStream('messages', new MappingStore('s').begin()).accept(
          frame({
            type: 'content_block_start',
            index: 0,
            content_block: block,
          }),
        ),
      ).toThrow(/MANCODE_GATEWAY_/);
  });
  it('decodes every UTF-8 byte and CRLF split, with bounded event buffering', () => {
    const wire = Buffer.from(
      'event: ping\r\ndata: {"type":"ping","text":"汉字"}\r\n\r\n',
    );
    const decoder = new SseDecoder();
    const output = [];
    for (const byte of wire) output.push(...decoder.push(Uint8Array.of(byte)));
    output.push(...decoder.push(new Uint8Array(), true));
    expect(output).toEqual([
      { event: 'ping', data: '{"type":"ping","text":"汉字"}' },
    ]);
    expect(() =>
      new SseDecoder(8).push(Buffer.from('data: no boundary')),
    ).toThrow('EVENT_LIMIT');
    expect(() => new SseDecoder().push(Uint8Array.of(255))).toThrow(
      'INVALID_UTF8',
    );
  });
  it('isolates interleaved text channels and never appends snapshots as deltas', () => {
    const mapping = new MappingStore('s').begin();
    const token = mapping.mask('alice@example.com');
    const stream = new ProtocolStream('responses', mapping);
    stream.accept(
      frame({ type: 'response.created', response: { id: 'r', output: [] } }),
    );
    const chunks = [];
    for (let i = 0; i < token.length; i++) {
      chunks.push(
        ...stream.accept(
          frame({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: 'a',
            delta: token[i],
          }),
        ),
      );
      if (i === 3)
        chunks.push(
          ...stream.accept(
            frame({
              type: 'response.output_text.delta',
              output_index: 1,
              content_index: 0,
              item_id: 'b',
              delta: '其他',
            }),
          ),
        );
    }
    for (const [index, id, text] of [
      [0, 'a', token],
      [1, 'b', '其他'],
    ])
      stream.accept(
        frame({
          type: 'response.output_text.done',
          output_index: index,
          content_index: 0,
          item_id: id,
          text,
        }),
      );
    stream.accept(
      frame({ type: 'response.completed', response: { id: 'r', output: [] } }),
    );
    stream.finish();
    expect(chunks.map((item) => JSON.parse(item.data).delta).join('')).toBe(
      '其他alice@example.com',
    );
  });
  it('never emits partial tools and blocks unknown executable restoration before done', () => {
    const mapping = new MappingStore('s').begin();
    const token = mapping.mask('alice@example.com');
    const stream = new ProtocolStream('responses', mapping);
    stream.accept(
      frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'tool',
          name: 'Bash',
          call_id: 'c',
          arguments: '',
        },
      }),
    );
    expect(
      stream.accept(
        frame({
          type: 'response.function_call_arguments.delta',
          item_id: 'tool',
          output_index: 0,
          delta: `{"command":"${token}`,
        }),
      ),
    ).toEqual([]);
    expect(
      stream.accept(
        frame({
          type: 'response.function_call_arguments.delta',
          item_id: 'tool',
          output_index: 0,
          delta: '"}',
        }),
      ),
    ).toEqual([]);
    expect(() =>
      stream.accept(
        frame({
          type: 'response.function_call_arguments.done',
          item_id: 'tool',
          output_index: 0,
          arguments: JSON.stringify({ command: token }),
        }),
      ),
    ).toThrow('TOOL_SINK_UNSUPPORTED');
  });
  it('releases one validated complete Anthropic tool delta only at block stop', () => {
    const stream = new ProtocolStream(
      'messages',
      new MappingStore('s').begin(),
    );
    stream.accept(
      frame({ type: 'message_start', message: { id: 'm', content: [] } }),
    );
    expect(
      stream.accept(
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} },
        }),
      ),
    ).toEqual([]);
    expect(
      stream.accept(
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"README.md"}',
          },
        }),
      ),
    ).toEqual([]);
    const done = stream.accept(frame({ type: 'content_block_stop', index: 0 }));
    expect(done.map((item) => JSON.parse(item.data).type)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
    ]);
    stream.accept(frame({ type: 'message_stop' }));
    stream.finish();
    const delta = done[1];
    if (!delta) throw new Error('Missing expected delta');
    expect(encodeSse(delta)).toContain('partial_json');
  });
  it('finishes an empty Anthropic tool input without requiring an empty delta', () => {
    const stream = new ProtocolStream(
      'messages',
      new MappingStore('s').begin(),
    );
    stream.accept(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'data', input: {} },
      }),
    );
    const output = stream.accept(
      frame({ type: 'content_block_stop', index: 0 }),
    );
    expect(JSON.parse(output[1]?.data ?? '{}').delta.partial_json).toBe('{}');
  });
  it('rejects truncated channels and websocket-like or unknown events', () => {
    const stream = new ProtocolStream(
      'responses',
      new MappingStore('s').begin(),
    );
    expect(() => stream.finish()).toThrow('TRUNCATED_RESPONSE');
    expect(() =>
      stream.accept(frame({ type: 'response.audio.delta', delta: 'opaque' })),
    ).toThrow('UNSUPPORTED_EVENT');
  });
});
