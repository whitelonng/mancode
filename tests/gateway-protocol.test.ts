import { describe, expect, it } from 'vitest';
import { MappingStore } from '../src/gateway/mapping.js';
import {
  restoreToolArguments,
  transformRequest,
  transformResponse,
} from '../src/gateway/protocol.js';
import readSchema from './fixtures/privacy-protocols/claude-read-2.1.142.json';

describe('gateway protocol adapters', () => {
  it('retains credential-key meaning across embedded JSON, metadata and tool arguments', () => {
    const marker = 'review-only-credential-value';
    for (const request of [
      { model: 'm', input: JSON.stringify({ password: marker }) },
      {
        model: 'm',
        input: JSON.stringify({ client_password: `${marker} with more words` }),
      },
      { model: 'm', input: 'hi', metadata: { client_secret: marker } },
      {
        model: 'm',
        input: 'hi',
        metadata: {
          client_password: `${marker} with more words`,
          DB_PASSWORD: marker,
        },
      },
      {
        model: 'm',
        input: 'hi',
        metadata: { 'api-key': marker, 'access-key': marker },
      },
      {
        model: 'm',
        input: [
          {
            type: 'function_call',
            name: 'data',
            call_id: 'c',
            arguments: JSON.stringify({ api_key: marker }),
          },
        ],
      },
    ])
      expect(
        transformRequest(
          JSON.stringify(request),
          'responses',
          new MappingStore('s').begin(),
        ).body,
      ).not.toContain(marker);
    const escaped =
      '{"model":"m","input":"hi","metadata":{"pass\\u0077ord":"quote\\"slash\\\\value"}}';
    expect(
      transformRequest(escaped, 'responses', new MappingStore('s').begin())
        .body,
    ).not.toContain('slash');
    for (const value of [['value'], { nested: 'value' }])
      expect(() =>
        transformRequest(
          JSON.stringify({
            model: 'm',
            input: 'hi',
            metadata: { password: value },
          }),
          'responses',
          new MappingStore('s').begin(),
        ),
      ).toThrow('CREDENTIAL_CONTAINER_UNSUPPORTED');
  });
  it('masks protocol text and nested business call_id but preserves numbers and protocol IDs', () => {
    const mapping = new MappingStore('scope').begin();
    const source =
      '{"model":"m","input":[{"type":"function_call","call_id":"13800138000","name":"data","arguments":"{\\"call_id\\":\\"alice@example.com\\",\\"count\\":90071992547409931234}"},{"type":"function_call_output","call_id":"13800138000","output":"alice@example.com"}]}';
    const result = transformRequest(source, 'responses', mapping).body;
    expect(result).not.toContain('alice@example.com');
    expect(result).toContain('"call_id":"13800138000"');
    expect(result).toContain('90071992547409931234');
  });
  it('preserves immutable reasoning byte-for-byte and reports reduced coverage', () => {
    const source =
      '{"model":"m","messages":[{"role":"assistant","content":[{"type":"thinking", "thinking":"alice@example.com", "signature":"opaque"}]}]}';
    expect(
      transformRequest(source, 'messages', new MappingStore('s').begin()),
    ).toEqual({ body: source, opaqueBlocks: 1 });
  });
  it('rejects sensitive schemas, sensitive business numbers and multimodal blocks', () => {
    for (const input of [
      {
        model: 'm',
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'data',
            parameters: { type: 'string', enum: ['alice@example.com'] },
          },
        ],
      },
      { model: 'm', input: '{"phone":13800138000}' },
      {
        model: 'm',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_image', image_url: 'https://example.test/x' },
            ],
          },
        ],
      },
      {
        model: 'm',
        input: [{ role: 'user', content: 'safe', extra: '13812345678' }],
      },
    ])
      expect(() =>
        transformRequest(
          JSON.stringify(input),
          'responses',
          new MappingStore('s').begin(),
        ),
      ).toThrow(/MANCODE_GATEWAY_/);
  });
  it('treats non-JSON log and template text as text', () => {
    const mapping = new MappingStore('s').begin();
    for (const text of [
      '[INFO] alice@example.com',
      '{foo} alice@example.com',
    ]) {
      const result = transformRequest(
        JSON.stringify({ model: 'm', input: text }),
        'responses',
        mapping,
      );
      expect(result.body).not.toContain('alice@example.com');
    }
  });
  it.each(['responses', 'messages'] as const)(
    'masks complete quoted credentials in %s prose and restores exact text',
    (protocol) => {
      const source = String.raw`client_password="first \"quoted\" synthetic phrase"; DB_PASSWORD='second synthetic phrase'; token_count=2`;
      const mapping = new MappingStore('s').begin();
      const request =
        protocol === 'responses'
          ? { model: 'm', input: source }
          : { model: 'm', messages: [{ role: 'user', content: source }] };
      const transformed = JSON.parse(
        transformRequest(JSON.stringify(request), protocol, mapping).body,
      );
      const masked =
        protocol === 'responses'
          ? transformed.input
          : transformed.messages[0].content;
      for (const word of ['first', 'quoted', 'synthetic', 'phrase', 'second'])
        expect(masked).not.toContain(word);
      expect(masked).toContain('token_count=2');
      expect(mapping.restore(masked)).toBe(source);
    },
  );
  it('restores ordinary responses and blocks token restoration into every unadapted tool sink', () => {
    const mapping = new MappingStore('s').begin();
    const token = mapping.mask('alice@example.com');
    const output = {
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: token }],
        },
      ],
    };
    expect(
      transformResponse(JSON.stringify(output), 'responses', mapping).body,
    ).toContain('alice@example.com');
    for (const field of ['command', 'sql', 'url', 'code', 'email'])
      expect(() =>
        restoreToolArguments(JSON.stringify({ [field]: token })),
      ).toThrow('TOOL_SINK_UNSUPPORTED');
    expect(
      restoreToolArguments('{"command":"ls","count":90071992547409931234}'),
    ).toBe('{"command":"ls","count":90071992547409931234}');
  });
  it('permits only the captured trusted Claude Read data sink, with no path composition', () => {
    const mapping = new MappingStore('s').begin();
    const result = transformRequest(
      JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: '/Users/alice/private.txt' }],
        tools: [{ name: 'Read', input_schema: readSchema }],
      }),
      'messages',
      mapping,
      undefined,
      'claude-code/2.1.142',
    );
    const token = JSON.parse(result.body).messages[0].content;
    expect(mapping.claudeReadAllowed).toBe(true);
    expect(
      restoreToolArguments(
        JSON.stringify({ file_path: token, limit: 20 }),
        mapping,
        'Read',
      ),
    ).toBe('{"file_path":"/Users/alice/private.txt","limit":20}');
    expect(() =>
      restoreToolArguments(
        JSON.stringify({ file_path: `${token}/suffix` }),
        mapping,
        'Read',
      ),
    ).toThrow('PATH_COMPOSITION');
    expect(() =>
      restoreToolArguments(JSON.stringify({ command: token }), mapping, 'Bash'),
    ).toThrow('TOOL_SINK_UNSUPPORTED');
    const untrusted = new MappingStore('s').begin();
    transformRequest(
      JSON.stringify({
        model: 'm',
        messages: [],
        tools: [{ name: 'Read', input_schema: readSchema }],
      }),
      'messages',
      untrusted,
      undefined,
      'claude-code/unknown',
    );
    expect(untrusted.claudeReadAllowed).toBe(false);
  });
});
