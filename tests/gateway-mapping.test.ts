import { describe, expect, it } from 'vitest';
import { IncrementalRestorer, MappingStore } from '../src/gateway/mapping.js';

describe('gateway scoped mappings', () => {
  it('restores each possible token split without dropping unicode', () => {
    const request = new MappingStore('a').begin();
    const token = request.mask('alice@example.com');
    expect(token).not.toContain('alice');
    for (let split = 0; split <= token.length; split++) {
      const stream = new IncrementalRestorer(request);
      expect(
        stream.push(`汉${token.slice(0, split)}`) +
          stream.push(`${token.slice(split)}字`) +
          stream.push('', true),
      ).toBe('汉alice@example.com字');
    }
  });
  it('rejects foreign scope, request and malformed tokens', () => {
    const store = new MappingStore('a');
    const request = store.begin();
    const token = request.mask('alice@example.com');
    expect(() => store.begin().restore(token)).toThrow('UNAUTHORIZED_TOKEN');
    expect(() => new MappingStore('b').begin().mask(token)).toThrow(
      'UNKNOWN_TOKEN',
    );
    expect(() => request.restore('__MANCODE_broken')).toThrow(
      'MALFORMED_TOKEN',
    );
    request.release();
  });
  it('inherits only known response lineage and makes restart loss explicit', () => {
    const store = new MappingStore('a');
    const request = store.begin();
    const token = request.mask('alice@example.com');
    request.finish('resp_1');
    request.release();
    expect(store.begin('resp_1').restore(token)).toBe('alice@example.com');
    expect(() => new MappingStore('a').begin('resp_1')).toThrow(
      'HISTORY_UNAVAILABLE',
    );
    expect(() => request.finish('resp_1')).toThrow('RESPONSE_REPLAY');
  });
  it('pins active entries and bounds count and bytes', () => {
    let time = 0;
    const store = new MappingStore(
      'a',
      { entries: 1, bytes: 100, ttlMs: 1, lineage: 1 },
      () => time,
    );
    const request = store.begin();
    const token = request.mask('alice@example.com');
    time = 2;
    expect(() => store.begin().mask('bob@example.com')).toThrow(
      'MAPPING_CAPACITY',
    );
    expect(request.restore(token)).toBe('alice@example.com');
    request.release();
    time = 4;
    expect(store.begin().mask('bob@example.com')).toMatch(/^__MANCODE_/);
  });
});
