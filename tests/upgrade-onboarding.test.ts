import { describe, expect, it } from 'vitest';
import { createUpgradePrompter } from '../src/system/upgrade-onboarding.js';

describe('upgrade terminal choices', () => {
  it('retries an invalid choice without treating empty input as permission', async () => {
    const answers = ['9', '', '2'];
    const output: string[] = [];
    const ui = createUpgradePrompter('zh-CN', {
      ask: async () => answers.shift() ?? null,
      write: (text) => output.push(text),
    });
    expect(await ui.selectAction(false)).toBe('project');
    expect(output.join('\n')).toContain('仅更新当前项目');
    expect(output.join('\n')).not.toMatch(/(?:✅|⚠️|🔄)/u);
  });

  it('cancels on EOF and defaults confirmation to no', async () => {
    const ui = createUpgradePrompter('en', {
      ask: async () => null,
      write: () => {},
    });
    expect(await ui.selectAction(true)).toBe('exit');
    expect(await ui.confirm('changes')).toBe(false);
  });

  it('keeps installed-project init choices distinct from upgrade choices', async () => {
    const ui = createUpgradePrompter('en', {
      ask: async () => '3',
      write: () => {},
    });
    expect(await ui.selectAction(true)).toBe('check');
    expect(await ui.selectAction(false)).toBe('cli');
  });
});
