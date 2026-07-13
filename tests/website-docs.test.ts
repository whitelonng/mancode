import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const website = path.join(root, 'website');

async function readPage(name: string): Promise<string> {
  return readFile(path.join(website, name), 'utf8');
}

function internalAnchors(html: string): string[] {
  return [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
}

function ids(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
  );
}

describe('website documentation', () => {
  it('keeps every internal page anchor resolvable', async () => {
    for (const name of [
      'index.html',
      'index.zh-CN.html',
      'docs.html',
      'docs.zh-CN.html',
    ]) {
      const html = await readPage(name);
      const pageIds = ids(html);
      const missing = internalAnchors(html).filter(
        (anchor) => !pageIds.has(anchor),
      );
      expect(missing, `${name} has missing anchors`).toEqual([]);
    }
  });

  it('documents the complete public CLI surface in both languages', async () => {
    for (const name of ['docs.html', 'docs.zh-CN.html']) {
      const html = await readPage(name);
      for (const requiredText of [
        '--empty',
        '--lang',
        '--minimal',
        'status --json',
        'refresh-project',
        'manps [area]',
        '--remediate',
        'require-manual',
        'confirm-manual',
        'governed_execution',
        'plan_only',
        'blockingUnknowns',
        'data_and_persistence',
        'acceptanceCriteria',
        '.gitignore',
        '.cursor/commands/',
        '.github/prompts/',
        'ZCode',
      ]) {
        expect(html, `${name} is missing ${requiredText}`).toContain(
          requiredText,
        );
      }
    }
    expect(await readPage('docs.zh-CN.html')).toContain(
      '安全的空目录支持交互初始化',
    );
  });

  it('shows workflow commands in a legal governed order', async () => {
    for (const name of ['docs.html', 'docs.zh-CN.html']) {
      const html = await readPage(name);
      const start = html.indexOf(
        name === 'docs.html'
          ? '<h3>A valid governed sequence</h3>'
          : '<h3>一条合法的治理式执行顺序</h3>',
      );
      const end = html.indexOf(
        name === 'docs.html'
          ? '<h3>Verification, manual checks, and remediation</h3>'
          : '<h3>自动验证、手工确认与修复后重验</h3>',
        start,
      );
      const example = html.slice(start, end);
      const orderedTokens = [
        '--step 2',
        'requirements &lt;taskId&gt; finalize',
        '--step 3',
        '--step 4',
        'governed_execution',
        '--step 5',
        '--step 6',
        'verify &lt;taskId&gt; init',
        'verify &lt;taskId&gt; record',
        'review &lt;taskId&gt; init',
        '--step 7',
        'review &lt;taskId&gt; complete',
        '--step 9',
        '--status completed',
      ];

      let previous = -1;
      for (const token of orderedTokens) {
        const current = example.indexOf(token);
        expect(current, `${name} is missing ${token}`).toBeGreaterThan(
          previous,
        );
        previous = current;
      }
      expect(example).not.toContain('--step 4 --plan-version 1');
    }
  });

  it('copies the visible documentation code instead of stale data attributes', async () => {
    for (const name of ['docs.html', 'docs.zh-CN.html']) {
      const html = await readPage(name);
      const codeBlocks = html.match(/<div class="code-wrap"><pre>/g) ?? [];
      const copyButtons = html.match(/data-copy-code/g) ?? [];
      expect(copyButtons).toHaveLength(codeBlocks.length);
      expect(html).not.toMatch(/data-copy=/);
    }
  });

  it('keeps both landing pages honest about adapter capabilities', async () => {
    const english = await readPage('index.html');
    const chinese = await readPage('index.zh-CN.html');

    expect(english).toContain('Project rules · commands');
    expect(english).toContain('Repository instructions · prompts');
    expect(english).toContain('Preview adapter');
    expect(chinese).toContain('id="context"');
    expect(chinese).toContain('04 / 项目感知');
    expect(chinese).toContain('05 / 适配器');
    expect(chinese).toContain('06 / 快速开始');
    expect(chinese).toContain('预览适配器');
  });

  it('keeps version labels aligned with package.json', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as { version: string };
    for (const name of [
      'index.html',
      'index.zh-CN.html',
      'docs.html',
      'docs.zh-CN.html',
    ]) {
      expect(await readPage(name)).toContain(`v${packageJson.version}`);
    }
  });
});
