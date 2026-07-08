import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANCODE_END_MARKER,
  DEFAULT_MANCODE_START_MARKER,
  hasManagedBlock,
  replaceManagedBlock,
} from '../src/installers/managed-block.js';

describe('replaceManagedBlock', () => {
  it('creates a managed block for an empty file', () => {
    expect(replaceManagedBlock('', 'hello')).toBe(
      `${DEFAULT_MANCODE_START_MARKER}\nhello\n${DEFAULT_MANCODE_END_MARKER}\n`,
    );
  });

  it('appends a managed block after existing user content', () => {
    expect(replaceManagedBlock('# User Notes\n\nKeep this.\n', 'managed')).toBe(
      `# User Notes\n\nKeep this.\n\n${DEFAULT_MANCODE_START_MARKER}\nmanaged\n${DEFAULT_MANCODE_END_MARKER}\n`,
    );
  });

  it('replaces an existing managed block and preserves surrounding content', () => {
    const existing = [
      '# User Notes',
      '',
      DEFAULT_MANCODE_START_MARKER,
      'old managed',
      DEFAULT_MANCODE_END_MARKER,
      '',
      '## User Footer',
      '',
    ].join('\n');

    expect(replaceManagedBlock(existing, 'new managed')).toBe(
      [
        '# User Notes',
        '',
        DEFAULT_MANCODE_START_MARKER,
        'new managed',
        DEFAULT_MANCODE_END_MARKER,
        '',
        '## User Footer',
        '',
      ].join('\n'),
    );
  });

  it('ignores marker examples inside fenced code blocks', () => {
    const existing = [
      '# User Notes',
      '',
      '```html',
      DEFAULT_MANCODE_START_MARKER,
      DEFAULT_MANCODE_END_MARKER,
      '```',
      '',
    ].join('\n');

    expect(replaceManagedBlock(existing, 'managed')).toBe(
      [
        '# User Notes',
        '',
        '```html',
        DEFAULT_MANCODE_START_MARKER,
        DEFAULT_MANCODE_END_MARKER,
        '```',
        '',
        DEFAULT_MANCODE_START_MARKER,
        'managed',
        DEFAULT_MANCODE_END_MARKER,
        '',
      ].join('\n'),
    );
  });

  it('ignores inline marker text that is not on its own line', () => {
    const existing = `example: ${DEFAULT_MANCODE_START_MARKER}\n`;

    expect(replaceManagedBlock(existing, 'managed')).toBe(
      `example: ${DEFAULT_MANCODE_START_MARKER}\n\n${DEFAULT_MANCODE_START_MARKER}\nmanaged\n${DEFAULT_MANCODE_END_MARKER}\n`,
    );
  });

  it('accepts a block that already includes both markers', () => {
    const block = `${DEFAULT_MANCODE_START_MARKER}\nmanaged\n${DEFAULT_MANCODE_END_MARKER}`;

    expect(replaceManagedBlock('', block)).toBe(`${block}\n`);
  });

  it('throws when the existing file has only a start marker', () => {
    expect(() =>
      replaceManagedBlock(`${DEFAULT_MANCODE_START_MARKER}\nold`, 'new'),
    ).toThrow('managed block is malformed');
  });

  it('throws when the existing file has only an end marker', () => {
    expect(() =>
      replaceManagedBlock(`${DEFAULT_MANCODE_END_MARKER}\nold`, 'new'),
    ).toThrow('managed block is malformed');
  });

  it('throws when the end marker appears before the start marker', () => {
    expect(() =>
      replaceManagedBlock(
        `${DEFAULT_MANCODE_END_MARKER}\nold\n${DEFAULT_MANCODE_START_MARKER}`,
        'new',
      ),
    ).toThrow('end marker precedes start');
  });

  it('throws when replacement content includes only one marker', () => {
    expect(() =>
      replaceManagedBlock('', `${DEFAULT_MANCODE_START_MARKER}\nnew`),
    ).toThrow('managed block content includes only one marker');
  });

  it('supports custom markers', () => {
    expect(replaceManagedBlock('prefix', 'body', '<start>', '<end>')).toBe(
      'prefix\n\n<start>\nbody\n<end>\n',
    );
  });
});

describe('hasManagedBlock', () => {
  it('ignores marker examples inside fenced code blocks', () => {
    const existing = [
      '# User Notes',
      '',
      '```html',
      DEFAULT_MANCODE_START_MARKER,
      DEFAULT_MANCODE_END_MARKER,
      '```',
      '',
    ].join('\n');

    expect(hasManagedBlock(existing)).toBe(false);
  });

  it('detects markers on their own lines outside fences', () => {
    const existing = [
      '# User Notes',
      '',
      DEFAULT_MANCODE_START_MARKER,
      'managed',
      DEFAULT_MANCODE_END_MARKER,
      '',
    ].join('\n');

    expect(hasManagedBlock(existing)).toBe(true);
  });
});
