import { describe, expect, it } from 'vitest';
import {
  applyJsonEdits,
  parseStrictJson,
  property,
  replaceString,
} from '../src/gateway/json.js';

describe('gateway source JSON', () => {
  it('preserves unsafe numbers and unrelated source bytes', () => {
    const source = '{ "count":90071992547409931234, "text":"secret" }';
    const edits = [];
    const field = property(parseStrictJson(source), 'text');
    if (!field) throw new Error('Missing text fixture');
    replaceString(edits, field, 'safe');
    expect(applyJsonEdits(source, edits)).toBe(
      '{ "count":90071992547409931234, "text":"safe" }',
    );
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,}',
    '{/*x*/"a":1}',
    '[1',
    '{"a": {"b":0,"b":1}}',
  ])('rejects ambiguous or malformed JSON %s', (source) => {
    expect(() => parseStrictJson(source)).toThrow(/MANCODE_GATEWAY_/);
  });
  it('rejects deep structures before parser recursion and continues to parse', () => {
    expect(() =>
      parseStrictJson(`${'['.repeat(20000)}0${']'.repeat(20000)}`),
    ).toThrow('JSON_LIMIT');
    expect(() => parseStrictJson('["[[[[\\"[[[["]')).not.toThrow();
    expect(parseStrictJson('{"ok":true}').type).toBe('object');
  });
});
