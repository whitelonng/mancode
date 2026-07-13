import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeCode } from '../src/installers/claude-code.js';
import {
  ALL_AGENTS,
  FILM_ANALYST_DEFENSE_AGENT,
  FILM_ANALYST_OFFENSE_AGENT,
  HEAD_COACH_AGENT,
  PLAN_COACH_AGENT,
  SCOUT_AGENT,
  renderAgent,
} from '../src/templates/agents/index.js';

describe('coaching staff agents', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-agents-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('agent specs', () => {
    it('each agent has required frontmatter fields', () => {
      for (const agent of ALL_AGENTS) {
        expect(agent.name).toBeTruthy();
        expect(agent.description.length).toBeGreaterThan(20);
        expect(agent.tools.length).toBeGreaterThan(0);
        expect(agent.body.length).toBeGreaterThan(100);
      }
    });

    it('agent names are unique and kebab-case', () => {
      const names = ALL_AGENTS.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    });

    it('scout body describes investigation role', () => {
      expect(SCOUT_AGENT.body).toMatch(/Scout/);
      expect(SCOUT_AGENT.body).toMatch(/调研|investigat/i);
      expect(SCOUT_AGENT.tools).toContain('Read');
      expect(SCOUT_AGENT.tools).not.toContain('Edit');
    });

    it('plan coach is read-only and owns pre-confirmation plans', () => {
      expect(PLAN_COACH_AGENT.body).toMatch(/只读/);
      expect(PLAN_COACH_AGENT.body).toMatch(/plan\.md/);
      expect(PLAN_COACH_AGENT.body).toMatch(/READY_FOR_PLAN/);
      expect(PLAN_COACH_AGENT.body).toMatch(/NEEDS_CLARIFICATION/);
      expect(PLAN_COACH_AGENT.body).toMatch(/blocking/);
      expect(PLAN_COACH_AGENT.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(PLAN_COACH_AGENT.tools).not.toContain('Edit');
      expect(PLAN_COACH_AGENT.tools).not.toContain('Write');
      expect(PLAN_COACH_AGENT.tools).not.toContain('Bash');
    });

    it('head coach body includes 5 core principles', () => {
      // 五条铁律的关键词（中文）
      expect(HEAD_COACH_AGENT.body).toMatch(/不做无关修改/);
      expect(HEAD_COACH_AGENT.body).toMatch(/先验证再声称完成/);
      expect(HEAD_COACH_AGENT.body).toMatch(/失败两次必须停下/);
      expect(HEAD_COACH_AGENT.body).toMatch(/不可逆操作先问/);
      expect(HEAD_COACH_AGENT.body).toMatch(/只解决被问到的问题/);
      // 包含 Phase 1-3 执行协议
      expect(HEAD_COACH_AGENT.body).toMatch(/Phase 1/);
      expect(HEAD_COACH_AGENT.body).toMatch(/Phase 2/);
      expect(HEAD_COACH_AGENT.body).toMatch(/Phase 3/);
      expect(HEAD_COACH_AGENT.body).toMatch(/恢复为 in_progress/);
      // 有 Edit 权限（要写代码）
      expect(HEAD_COACH_AGENT.tools).toContain('Edit');
      expect(HEAD_COACH_AGENT.tools).toContain('Write');
    });

    it('film analyst offense body describes quality review', () => {
      expect(FILM_ANALYST_OFFENSE_AGENT.description).toMatch(/Step 7/);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/质量|quality/i);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/可读性|readability/i);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/信息层级/);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(
        /空、加载、失败、无权限、成功/,
      );
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/project-profile\.json/);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/本次 diff/);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/证据/);
      expect(FILM_ANALYST_OFFENSE_AGENT.body).toMatch(/最多 3 个/);
      expect(FILM_ANALYST_OFFENSE_AGENT.tools).not.toContain('Edit');
    });

    it('film analyst defense body describes security review', () => {
      expect(FILM_ANALYST_DEFENSE_AGENT.description).toMatch(/Step 8/);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/边界|boundary/i);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/安全|security/i);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/键盘可用性/);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/对比/);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/权限与错误路径/);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/film-report-1\.md/);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/duplicate/);
      expect(FILM_ANALYST_DEFENSE_AGENT.body).toMatch(/最多 3 个/);
      expect(FILM_ANALYST_DEFENSE_AGENT.tools).not.toContain('Edit');
    });
  });

  describe('renderAgent', () => {
    it('produces YAML frontmatter + body', () => {
      const rendered = renderAgent(SCOUT_AGENT);
      expect(rendered.startsWith('---\n')).toBe(true);
      expect(rendered).toMatch(/name: scout/);
      expect(rendered).toMatch(/description:/);
      expect(rendered).toMatch(/tools: Read, Grep, Glob, Bash/);
      // frontmatter 结束后再有空行 + body
      expect(rendered).toMatch(/---\n\n/);
    });

    it('escapes description with colon by quoting', () => {
      const spec = {
        name: 'test',
        description: 'does X: important stuff',
        tools: ['Read'],
        body: 'body',
      };
      const rendered = renderAgent(spec);
      expect(rendered).toMatch(/description: "does X: important stuff"/);
    });

    it('body with literal --- is preserved (not frontmatter-like at line start)', () => {
      const spec = {
        name: 'test',
        description: 'desc',
        tools: ['Read'],
        body: 'some text\n---\nmore text',
      };
      const rendered = renderAgent(spec);
      // body 内的 --- 应该在 frontmatter 之后，不影响解析
      const frontmatterEnd = rendered.indexOf('---\n\n') + 5;
      const body = rendered.slice(frontmatterEnd);
      expect(body).toBe('some text\n---\nmore text\n');
    });
  });

  describe('installAgents (via installClaudeCode)', () => {
    it('creates agent files in .claude/agents/', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const agentsDir = path.join(dir, '.claude', 'agents');
      for (const agent of ALL_AGENTS) {
        const file = path.join(agentsDir, `${agent.name}.md`);
        const content = await readFile(file, 'utf-8');
        expect(content).toMatch(new RegExp(`name: ${agent.name}`));
      }
    });

    it('agent files have valid frontmatter', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const scoutPath = path.join(dir, '.claude', 'agents', 'scout.md');
      const content = await readFile(scoutPath, 'utf-8');
      expect(content.startsWith('---\n')).toBe(true);
      // 找到第二个 --- 结束 frontmatter
      const secondBreak = content.indexOf('---', 4);
      expect(secondBreak).toBeGreaterThan(0);
      const frontmatter = content.slice(0, secondBreak);
      expect(frontmatter).toMatch(/name: scout/);
      expect(frontmatter).toMatch(/description:/);
      expect(frontmatter).toMatch(/tools:/);
    });

    it('--force reinstall overwrites agent files', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });
      // 第二次安装应该正常覆盖
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const scoutPath = path.join(dir, '.claude', 'agents', 'scout.md');
      const content = await readFile(scoutPath, 'utf-8');
      expect(content).toMatch(/name: scout/);
    });
  });
});
