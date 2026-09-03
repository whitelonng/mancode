import { describe, expect, it } from 'vitest';
import {
  compileManDeliveryPlan,
  parseManDeliveryPlan,
  parseManPlanDocument,
  replaceManDeliveryRecord,
} from '../src/context/man-delivery-plan.js';

const document = [
  '# Export module',
  '<!-- mancode:plan-baseline:start -->',
  'AC-1: users can download their own records.',
  '<!-- mancode:plan-baseline:end -->',
  'User notes are preserved.',
  '<!-- mancode:delivery-record:start -->',
  'Not started.',
  '<!-- mancode:delivery-record:end -->',
  '',
].join('\n');

describe('man plan baseline and delivery record', () => {
  it('binds the source path and only the approved baseline', () => {
    const source = {
      version: 1 as const,
      path: 'docs/export.md',
      baseHead: null,
    };
    const plan = compileManDeliveryPlan(source, document);
    expect(parseManDeliveryPlan(plan)).toEqual({
      source,
      baseline: 'AC-1: users can download their own records.',
    });
    const updated = replaceManDeliveryRecord(document, 'Awaiting review.');
    expect(compileManDeliveryPlan(source, updated)).toBe(plan);
    expect(updated).toContain('User notes are preserved.');
    expect(updated).not.toContain('Not started.');
    expect(parseManPlanDocument(updated).record).toBe('Awaiting review.');
  });

  it('detects a changed approved target instead of laundering it as progress', () => {
    const source = {
      version: 1 as const,
      path: 'doc/export.md',
      baseHead: null,
    };
    expect(
      compileManDeliveryPlan(source, document.replace('their own', 'all')),
    ).not.toBe(compileManDeliveryPlan(source, document));
  });

  it('ignores marker examples inside backtick and tilde code fences', () => {
    const examples = `\`\`\`markdown\n${document}\`\`\`\n~~~html\n${document}~~~\n`;
    expect(parseManPlanDocument(examples + document).baseline).toBe(
      'AC-1: users can download their own records.',
    );
    expect(() => parseManPlanDocument(examples)).toThrow(
      'MANCODE_MAN_PLAN_MARKERS_INVALID',
    );
  });

  it.each([
    document.replace('<!-- mancode:plan-baseline:end -->', ''),
    document + document,
    document.replace(
      '<!-- mancode:delivery-record:start -->',
      '<!-- mancode:plan-baseline:start -->',
    ),
    document.replace('AC-1: users can download their own records.', ''),
  ])('rejects ambiguous, incomplete or empty baseline documents', (text) => {
    expect(() => parseManPlanDocument(text)).toThrow();
  });

  it.each([
    '../outside.md',
    '/tmp/plan.md',
    '.mancode/plan.md',
    '架构/design.md',
    '项目接口/api.md',
    'docs/../secret.md',
  ])('rejects unsafe or private source paths: %s', (file) => {
    expect(() =>
      compileManDeliveryPlan(
        { version: 1, path: file, baseHead: null },
        document,
      ),
    ).toThrow();
  });

  it('does not reinterpret a legacy plan as a bound plan', () => {
    expect(parseManDeliveryPlan('# Existing legacy plan')).toBeNull();
  });

  it('does not permit record text to introduce another managed block', () => {
    expect(() => replaceManDeliveryRecord(document, document)).toThrow();
  });
});
