import { describe, expect, it } from 'vitest';
import type { ClaimScope } from '../src/team/claims.js';
import { evaluateClaimScopeSubset } from '../src/team/conflicts.js';

function scope(paths: string[]): ClaimScope {
  return { paths, modules: [], apis: [], schemas: [] };
}

function excluded(candidate: string, exclude: string): boolean {
  return !evaluateClaimScopeSubset(scope([candidate]), {
    source: 'explicit',
    include: [candidate],
    exclude: [exclude],
    modules: [],
  }).allowed;
}

describe('claim path boundaries', () => {
  it('accepts the exact approved file with disjoint same-directory and root excludes', () => {
    expect(
      evaluateClaimScopeSubset(scope(['src/app.mjs']), {
        source: 'explicit',
        include: ['src/app.mjs'],
        exclude: [
          'src/store.mjs',
          'src/server.mjs',
          'package.json',
          'AGENTS.md',
        ],
        modules: [],
      }),
    ).toEqual({ allowed: true, reasons: [] });
  });

  it.each([
    ['src/app.mjs', 'src/app.mjs', true],
    ['src/app.mjs', 'src/store.mjs', false],
    ['package.json', 'AGENTS.md', false],
    ['package.json', 'package.json', true],
    ['src/app.mjs', 'src/app.mjs.map', false],
    ['src/app.mjs', 'src/*.mjs', true],
    ['src/app.mjs', 'src/*.ts', false],
    ['src/app.mjs', 'src/a??.mjs', true],
    ['src/app.mjs', 'src/b??.mjs', false],
    ['src/app.mjs', 'src/**/app.mjs', true],
    ['src/nested/app.mjs', 'src/**/app.mjs', true],
    ['src/nested/app.mjs', 'src/*.mjs', false],
    ['src/app.mjs', '*.mjs', false],
    ['package.json', '*.json', true],
    ['package.json', '*.md', false],
    ['src-private/app.mjs', 'src/**', false],
    ['src/app.mjs', 'src-private/**', false],
    ['src/app.mjs', 'src/app/**', false],
    ['src/**', 'src/private/**', true],
    ['src/**', 'test/**', false],
    ['src/**', 'src/**', true],
    ['src/*.mjs', 'src/*.ts', true],
  ])(
    'checks %s against %s without discarding file boundaries',
    (left, right, overlaps) => {
      expect(excluded(left, right)).toBe(overlaps);
      expect(excluded(right, left)).toBe(overlaps);
    },
  );

  it.each([
    'src/[as]*.mjs',
    'src/{app,store}.mjs',
    'src/@(app|store).mjs',
    'src/!(store).mjs',
  ])('retains conservative exclusion for complex pattern %s', (pattern) => {
    expect(excluded('src/other.mjs', pattern)).toBe(true);
    expect(excluded(pattern, 'src/other.mjs')).toBe(true);
  });

  it('does not broaden an exact include to sibling files or a directory glob', () => {
    for (const paths of [['src/store.mjs'], ['src/**'], ['package.json']]) {
      expect(
        evaluateClaimScopeSubset(scope(paths), {
          source: 'explicit',
          include: ['src/app.mjs'],
          exclude: [],
          modules: [],
        }),
      ).toEqual({ allowed: false, reasons: ['path_outside_include'] });
    }
  });

  it.each(['src/{app,store}/**', 'src/@(app|store)/**', 'src/[as]*/**'])(
    'does not prove a broader include from complex pattern %s',
    (include) => {
      expect(
        evaluateClaimScopeSubset(scope(['src/private/secrets.mjs']), {
          source: 'explicit',
          include: [include],
          exclude: [],
          modules: [],
        }),
      ).toEqual({ allowed: false, reasons: ['path_outside_include'] });
    },
  );
});
