import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeCode } from '../src/installers/claude-code.js';
import {
  MAN8_SKILL,
  MANPS_SKILL,
  MANSOLO_SKILL,
  MANTEAM_SKILL,
  MAN_SKILL,
  MVP2_SKILLS,
  renderSkill,
} from '../src/templates/skills/index.js';

describe('mvp-2 skills (man8 / man / manteam / manps / mansolo)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('skill specs', () => {
    it('each skill has name / description / body', () => {
      for (const skill of MVP2_SKILLS) {
        expect(skill.name).toBeTruthy();
        expect(skill.description.length).toBeGreaterThan(20);
        expect(skill.body.length).toBeGreaterThan(200);
      }
    });

    it('skill names are lowercase kebab-safe', () => {
      for (const skill of MVP2_SKILLS) {
        expect(skill.name).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    });

    it('contains exactly 5 skills (man8, man, manteam, manps, mansolo)', () => {
      const names = MVP2_SKILLS.map((s) => s.name).sort();
      expect(names).toEqual(['man', 'man8', 'manps', 'mansolo', 'manteam']);
    });
  });

  describe('man8 skill content', () => {
    it('is described as an automatically selected planning skill', () => {
      expect(MAN8_SKILL.description).toMatch(/Automatically use/);
      expect(MAN8_SKILL.description).toMatch(/先看看/);
      expect(MAN8_SKILL.description).toMatch(/不要改代码/);
      expect(MAN8_SKILL.description).toMatch(/architecture/);
    });

    it('describes 3-step flow with Scout + Plan Coach', () => {
      expect(MAN8_SKILL.body).toMatch(/Scout/);
      expect(MAN8_SKILL.body).toMatch(/Plan Coach/);
      expect(MAN8_SKILL.body).toMatch(/plan/);
      // 3 步流程的关键标志
      expect(MAN8_SKILL.body).toMatch(/Step 1/);
      expect(MAN8_SKILL.body).toMatch(/Step 2/);
      expect(MAN8_SKILL.body).toMatch(/Step 3/);
      // 不应包含 Step 4-8（那是 /man 的）
      expect(MAN8_SKILL.body).not.toMatch(/Step 4/);
      expect(MAN8_SKILL.body).not.toMatch(/Step 8/);
    });

    it('references workflow dir and metadata.json', () => {
      expect(MAN8_SKILL.body).toMatch(/\.mancode\/workflows\//);
      expect(MAN8_SKILL.body).toMatch(/metadata\.json/);
      expect(MAN8_SKILL.body).toMatch(/date -u/);
      expect(MAN8_SKILL.body).toMatch(/不要凭空估算日期时间/);
    });

    it('uses Agent tool with scout and read-only plan coach', () => {
      expect(MAN8_SKILL.body).toMatch(/subagent_type.*scout/);
      expect(MAN8_SKILL.body).toMatch(/subagent_type.*plan-coach/);
    });

    it('switches back to solo on user confirm', () => {
      expect(MAN8_SKILL.body).toMatch(/currentMode.*solo/);
    });

    it('enters man8 mode immediately when triggered', () => {
      expect(MAN8_SKILL.body).toMatch(/currentMode.*man8/);
      expect(MAN8_SKILL.body).toMatch(/等待任务期间，当前模式仍是 `man8`/);
    });

    it('treats natural language planning requests as man8 tasks', () => {
      expect(MAN8_SKILL.body).toMatch(/自动触发条件/);
      expect(MAN8_SKILL.body).toMatch(/用户原始请求整体作为 task/);
      expect(MAN8_SKILL.body).toMatch(/只有在显式输入 `\/man8` 且 task 为空/);
    });

    it('implements immediately after the user chooses solo implementation', () => {
      expect(MAN8_SKILL.body).toMatch(/立即按 plan 实施/);
      expect(MAN8_SKILL.body).toMatch(/不要再次要求用户输入/);
    });

    it('keeps Head Coach planning read-only before user confirmation', () => {
      expect(MAN8_SKILL.body).toMatch(/Plan Coach/);
      expect(MAN8_SKILL.body).toMatch(/只返回 plan markdown，不要修改项目文件/);
    });

    it('clears active workflow state when exiting without implementation', () => {
      expect(MAN8_SKILL.body).toMatch(/退出/);
      expect(MAN8_SKILL.body).toMatch(/currentMode: "solo"/);
      expect(MAN8_SKILL.body).toMatch(/currentTask: null/);
      expect(MAN8_SKILL.body).toMatch(/currentWorkflowMode: null/);
    });
  });

  describe('man skill content', () => {
    it('describes 8-step flow with all 4 agents', () => {
      expect(MAN_SKILL.body).toMatch(/Scout/);
      expect(MAN_SKILL.body).toMatch(/Plan Coach/);
      expect(MAN_SKILL.body).toMatch(/Head Coach/);
      expect(MAN_SKILL.body).toMatch(/film-analyst-offense/);
      expect(MAN_SKILL.body).toMatch(/film-analyst-defense/);
      const stepHeadings = [
        ...MAN_SKILL.body.matchAll(/^### Step (\d+):/gm),
      ].map((match) => Number(match[1]));
      expect(stepHeadings).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(MAN_SKILL.body).not.toMatch(/Step 9/);
    });

    it('references workflow files (scout-report.md, plan.md, film-report-*.md)', () => {
      expect(MAN_SKILL.body).toMatch(/scout-report\.md/);
      expect(MAN_SKILL.body).toMatch(/plan\.md/);
      expect(MAN_SKILL.body).toMatch(/film-report-1\.md/);
      expect(MAN_SKILL.body).toMatch(/film-report-2\.md/);
    });

    it('covers skip handling (users can skip film sessions)', () => {
      expect(MAN_SKILL.body).toMatch(/skippedSteps/);
      expect(MAN_SKILL.body).toMatch(/跳过/);
    });

    it('references core principles (fail twice, verify)', () => {
      expect(MAN_SKILL.body).toMatch(/失败两次/);
      expect(MAN_SKILL.body).toMatch(/build.*lint.*test|验证/);
    });

    it('enters man mode immediately when triggered', () => {
      expect(MAN_SKILL.body).toMatch(/currentMode.*man/);
      expect(MAN_SKILL.body).toMatch(/等待任务期间，当前模式仍是 `man`/);
    });

    it('keeps plan generation read-only and clears state on abandon', () => {
      expect(MAN_SKILL.body).toMatch(/subagent_type: "plan-coach"/);
      expect(MAN_SKILL.body).toMatch(/只返回 plan markdown，不要修改项目文件/);
      expect(MAN_SKILL.body).toMatch(/status: "abandoned"/);
      expect(MAN_SKILL.body).toMatch(/currentMode: "solo"/);
      expect(MAN_SKILL.body).toMatch(/currentTask: null/);
    });
  });

  describe('mansolo skill content', () => {
    it('instructs to switch back to solo mode', () => {
      expect(MANSOLO_SKILL.body).toMatch(/solo/);
      expect(MANSOLO_SKILL.body).toMatch(/state\.json/);
    });

    it('clears workflow state fields', () => {
      expect(MANSOLO_SKILL.body).toMatch(/currentTask.*null/);
      expect(MANSOLO_SKILL.body).toMatch(/currentWorkflowMode.*null/);
      expect(MANSOLO_SKILL.body).toMatch(/skippedSteps.*\[\]/);
    });

    it('handles in-progress workflow abandonment', () => {
      // 当用户在 /man 流程中切 solo，应提示确认
      expect(MANSOLO_SKILL.body).toMatch(/abandoned/);
    });
  });

  describe('manteam skill content', () => {
    it('adds team coordination on top of the playoffs flow', () => {
      expect(MANTEAM_SKILL.body).toMatch(/Team Context/);
      expect(MANTEAM_SKILL.body).toMatch(/git log/);
      expect(MANTEAM_SKILL.body).toMatch(/handoff\.md/);
      expect(MANTEAM_SKILL.body).toMatch(/commit-template\.txt/);
      expect(MANTEAM_SKILL.body).toMatch(/--commit-hook/);
      expect(MANTEAM_SKILL.body).toMatch(/PULL_REQUEST_TEMPLATE\.md/);
      expect(MANTEAM_SKILL.body).toMatch(/不覆盖/);
    });

    it('inherits plan-only and abandoned-state cleanup constraints', () => {
      expect(MANTEAM_SKILL.body).toMatch(/Plan Coach/);
      expect(MANTEAM_SKILL.body).toMatch(/禁止提前修改业务文件或团队 memory/);
      expect(MANTEAM_SKILL.body).toMatch(
        /metadata\.json\.status = "abandoned"/,
      );
      expect(MANTEAM_SKILL.body).toMatch(/currentMode: "solo"/);
      expect(MANTEAM_SKILL.body).toMatch(
        /不要把 abandoned workflow 留在 active state/,
      );
    });

    it('does not write durable decisions before confirmation', () => {
      expect(MANTEAM_SKILL.body).toMatch(/不要在确认前追加/);
      expect(MANTEAM_SKILL.body).toMatch(/team-context\.md/);
      expect(MANTEAM_SKILL.body).toMatch(
        /只有在用户确认实施并完成 workflow 后/,
      );
      expect(MANTEAM_SKILL.body).toMatch(/不能污染长期团队 memory/);
    });
  });

  describe('manps skill content', () => {
    it('describes a read-only preseason health check', () => {
      expect(MANPS_SKILL.body).toMatch(/Preseason/);
      expect(MANPS_SKILL.body).toMatch(/TODO\|FIXME/);
      expect(MANPS_SKILL.body).toMatch(/preseason-report\.md/);
      expect(MANPS_SKILL.body).toMatch(/--remediate/);
      expect(MANPS_SKILL.body).toMatch(/preseason-issues\.json/);
      expect(MANPS_SKILL.body).toMatch(/白名单内安全修复/);
      expect(MANPS_SKILL.body).toMatch(/package scripts/);
    });

    it('keeps CLI scan areas aligned with the manps command contract', () => {
      expect(MANPS_SKILL.body).toMatch(
        /all.*deps.*security.*dead-code.*config/,
      );
      expect(MANPS_SKILL.body).toMatch(/不要把它传给 CLI/);
      expect(MANPS_SKILL.body).toMatch(/目录\/模块\/主题/);
    });

    it('resolves the installed CLI before running manps', () => {
      expect(MANPS_SKILL.body).toMatch(/cliCommand/);
      expect(MANPS_SKILL.body).toMatch(/cliArgs/);
      expect(MANPS_SKILL.body).toMatch(/node_modules\/\.bin\/mancode/);
      expect(MANPS_SKILL.body).toMatch(/spawnSync/);
      expect(MANPS_SKILL.body).toMatch(/禁止 `eval`/);
      expect(MANPS_SKILL.body).not.toMatch(/eval "\$MANCODE_CLI"/);
      expect(MANPS_SKILL.body).toMatch(/process\.exit\(127\)/);
      expect(MANPS_SKILL.body).toMatch(/Invalid manps area/);
      expect(MANPS_SKILL.body).toMatch(/process\.exit\(2\)/);
      expect(MANPS_SKILL.body).toMatch(/不要用手写扫描替代确定性扫描/);
    });
  });

  describe('renderSkill', () => {
    it('produces a Claude Code SKILL.md with YAML frontmatter', () => {
      const rendered = renderSkill(MAN8_SKILL);
      expect(rendered.startsWith('---\n')).toBe(true);
      expect(rendered).toContain('name: man8');
      expect(rendered).toContain('description: ');
      expect(rendered).toContain('# mancode · /man8');
    });

    it('preserves body verbatim with trailing newline', () => {
      const spec = {
        name: 'test',
        description: 'desc',
        body: '# title\n\nbody text',
      };
      const rendered = renderSkill(spec);
      expect(rendered.endsWith('# title\n\nbody text\n')).toBe(true);
    });
  });

  describe('installMvp2Skills (via installClaudeCode)', () => {
    it('creates project skill directories in .claude/skills/', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      for (const skill of MVP2_SKILLS) {
        const file = path.join(
          dir,
          '.claude',
          'skills',
          skill.name,
          'SKILL.md',
        );
        const content = await readFile(file, 'utf-8');
        expect(content.length).toBeGreaterThan(100);
        expect(content).toContain(`name: ${skill.name}`);
      }
    });

    it('does not register skills through non-standard settings.skills', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const settingsPath = path.join(dir, '.claude', 'settings.json');
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      expect(settings.skills).toBeUndefined();
    });

    it('reinstall overwrites skill files', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const skillPath = path.join(dir, '.claude', 'skills', 'man8', 'SKILL.md');
      const content = await readFile(skillPath, 'utf-8');
      expect(content.startsWith('---')).toBe(true);
    });
  });
});
