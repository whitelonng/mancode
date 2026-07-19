import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const website = path.join(root, 'website');

async function readPage(name: string): Promise<string> {
  return readFile(path.join(website, name), 'utf8');
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { version: string };
  return packageJson.version;
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
        'workflow verify',
        'workflow review',
        'governed_execution',
        'plan_only',
        'blockingUnknowns',
        'data_and_persistence',
        'acceptanceCriteria',
        '.gitignore',
        '.cursor/commands/',
        '.github/prompts/',
        'ZCode',
        'context session new --client',
        'context resume &lt;namespace:ULID&gt;',
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

  it('shows the Continuity workflow command contract', async () => {
    for (const name of ['docs.html', 'docs.zh-CN.html']) {
      const html = await readPage(name);
      const start = html.indexOf(
        name === 'docs.html'
          ? '<h3>A valid Continuity sequence</h3>'
          : '<h3>一条合法的 Continuity 顺序</h3>',
      );
      const end = html.indexOf(
        name === 'docs.html'
          ? '<h3>Verification, manual checks, and remediation</h3>'
          : '<h3>自动验证、手工确认与修复后重验</h3>',
        start,
      );
      const example = html.slice(start, end);
      const orderedTokens = [
        'workflow create man',
        'workflow list --json',
        'workflow show &lt;local:ULID&gt; --json',
        'workflow requirements &lt;local:ULID&gt; finalize',
        'workflow plan &lt;local:ULID&gt; revise',
        'workflow plan &lt;local:ULID&gt; confirm',
        'workflow review &lt;local:ULID&gt; apply',
        'workflow verify &lt;local:ULID&gt; apply',
        'workflow complete &lt;local:ULID&gt;',
      ];

      let previous = -1;
      for (const token of orderedTokens) {
        const current = example.indexOf(token);
        expect(current, `${name} is missing ${token}`).toBeGreaterThan(
          previous,
        );
        previous = current;
      }
      expect(example).not.toMatch(/workflow update[^\n]*--step/);
      expect(example).not.toContain('workflow decide');
      expect(example).not.toContain('verify &lt;taskId&gt;');
      expect(example).not.toContain('review &lt;taskId&gt;');
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

  it('keeps both landing pages honest about adapter capabilities and continuity', async () => {
    const english = await readPage('index.html');
    const chinese = await readPage('index.zh-CN.html');

    expect(english).toContain('Project rules · commands');
    expect(english).toContain('Repository instructions · prompts');
    expect(english).toContain('Preview adapter');
    expect(english).toContain('id="continuity"');
    expect(english).toContain('06 / Cross-session continuity');
    expect(english).toContain('Raw chat history is not copied');
    expect(english).toContain('07 / Quick start');
    expect(chinese).toContain('id="context"');
    expect(chinese).toContain('04 / 项目感知');
    expect(chinese).toContain('05 / 适配器');
    expect(chinese).toContain('id="continuity"');
    expect(chinese).toContain('06 / 跨会话续接');
    expect(chinese).toContain('不复制原始聊天记录');
    expect(chinese).toContain('07 / 快速开始');
    expect(chinese).toContain('交付干净');
    expect(chinese).toContain('代码，避免');
    expect(chinese).toContain('AI 屎山。');
    expect(chinese).toContain('预览适配器');
    const version = await readPackageVersion();
    expect(english).toContain(`Continuity / v${version}`);
    expect(chinese).toContain(`Continuity / v${version}`);
  });

  it('documents the cross-session boundary in both languages', async () => {
    const english = await readPage('docs.html');
    const chinese = await readPage('docs.zh-CN.html');

    expect(english).toContain('id="continuity"');
    expect(english).toContain('not a copy of raw chat history');
    expect(chinese).toContain('id="continuity"');
    expect(chinese).toContain('不是原始聊天记录的复制');
  });

  it('keeps version labels aligned with package.json', async () => {
    const version = await readPackageVersion();
    for (const name of [
      'index.html',
      'index.zh-CN.html',
      'docs.html',
      'docs.zh-CN.html',
    ]) {
      expect(await readPage(name)).toContain(`v${version}`);
    }
  });
});
