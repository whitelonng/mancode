import { describe, expect, it } from 'vitest';
import { GatewayEngine } from '../src/gateway/engine.js';
import { DEFAULT_RULE_IDS } from '../src/privacy/rules.js';

describe('gateway processing engine', () => {
  it('keeps request authorization and lineage in isolated engine memory', () => {
    const engine = new GatewayEngine('scope', DEFAULT_RULE_IDS, 'unverified');
    const masked = engine.execute({
      kind: 'begin',
      id: 'a',
      protocol: 'responses',
      body: '{"model":"m","input":"alice@example.com"}',
    }) as { body: string };
    const token = JSON.parse(masked.body).input;
    const result = engine.execute({
      kind: 'response',
      id: 'a',
      body: JSON.stringify({
        id: 'resp_a',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: token }] },
        ],
      }),
    }) as { body: string };
    expect(result.body).toContain('alice@example.com');
    engine.execute({ kind: 'release', id: 'a' });
    expect(() =>
      engine.execute({
        kind: 'begin',
        id: 'b',
        protocol: 'responses',
        body: '{"model":"m","input":"next","previous_response_id":"foreign"}',
      }),
    ).toThrow('HISTORY_UNAVAILABLE');
    expect(() =>
      engine.execute({
        kind: 'begin',
        id: 'b',
        protocol: 'responses',
        body: '{"model":"m","input":"next","previous_response_id":"resp_a"}',
      }),
    ).not.toThrow();
  });
  it('caps active requests and safely releases a failed body parse', () => {
    const engine = new GatewayEngine('scope', DEFAULT_RULE_IDS, 'unverified');
    expect(() =>
      engine.execute({
        kind: 'begin',
        id: 'broken',
        protocol: 'responses',
        body: '{"model":"m","input":[',
      }),
    ).toThrow('INVALID_JSON');
    for (let i = 0; i < 8; i++)
      engine.execute({
        kind: 'begin',
        id: String(i),
        protocol: 'responses',
        body: '{"model":"m","input":"hello"}',
      });
    expect(() =>
      engine.execute({
        kind: 'begin',
        id: 'nine',
        protocol: 'responses',
        body: '{"model":"m","input":"hello"}',
      }),
    ).toThrow('CONCURRENCY_LIMIT');
    engine.execute({ kind: 'release', id: '0' });
    expect(() =>
      engine.execute({
        kind: 'begin',
        id: 'nine',
        protocol: 'responses',
        body: '{"model":"m","input":"hello"}',
      }),
    ).not.toThrow();
  });
});
