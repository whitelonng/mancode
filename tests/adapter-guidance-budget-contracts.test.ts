// Guidance budgets are a ratchet and a review trigger, not a quality metric.
// Lower the budget after shrinking guidance text; raising one must be an
// explicit, reviewed edit to tests/fixtures/guidance-budget.json.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import type { PlatformName } from '../src/installers/registry.js';
import {
  type V3ModeName,
  V3_ADAPTER_PLATFORMS,
  V3_MODE_NAMES,
  renderV3Bootstrap,
  renderV3ModeEntry,
} from '../src/installers/v3-adapter.js';

const FIXTURE_PATH = path.join(
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'guidance-budget.json',
);

interface GuidanceBudgetFixture {
  encoding: string;
  budgets: Record<string, Record<string, number>>;
}

async function loadBudgets(): Promise<GuidanceBudgetFixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
}

function renderEntry(platform: PlatformName, entry: string): string {
  return entry === 'bootstrap'
    ? renderV3Bootstrap(platform)
    : renderV3ModeEntry(entry as V3ModeName, platform);
}

describe('v3 adapter guidance budget', () => {
  it('covers exactly every adapter platform and mode entry', async () => {
    const fixture = await loadBudgets();
    expect(fixture.encoding).toBe('cl100k_base');
    const expectedEntries = ['bootstrap', ...V3_MODE_NAMES].sort();
    expect(Object.keys(fixture.budgets).sort()).toEqual(
      [...V3_ADAPTER_PLATFORMS].sort(),
    );
    for (const platform of V3_ADAPTER_PLATFORMS) {
      expect(Object.keys(fixture.budgets[platform] ?? {}).sort()).toEqual(
        expectedEntries,
      );
    }
  });

  it('keeps every rendered entry within its budget', async () => {
    const fixture = await loadBudgets();
    const encoding = getEncoding('cl100k_base');
    const overBudget: string[] = [];
    for (const platform of V3_ADAPTER_PLATFORMS) {
      for (const [entry, budget] of Object.entries(
        fixture.budgets[platform] ?? {},
      )) {
        const tokens = encoding.encode(renderEntry(platform, entry)).length;
        if (tokens > budget) {
          overBudget.push(`${platform}/${entry}: ${tokens} > ${budget}`);
        }
      }
    }
    expect(overBudget).toEqual([]);
  });
});
