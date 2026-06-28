import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeCode } from '../src/installers/claude-code.js';
import {
  MAN8_SKILL,
  MANSOLO_SKILL,
  MAN_SKILL,
  MVP2_SKILLS,
  renderSkill,
} from '../src/templates/skills/index.js';

describe('mvp-2 skills (man8 / man / mansolo)', () => {
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

    it('contains exactly 3 skills (man8, man, mansolo)', () => {
      const names = MVP2_SKILLS.map((s) => s.name).sort();
      expect(names).toEqual(['man', 'man8', 'mansolo']);
    });
  });

  describe('man8 skill content', () => {
    it('describes 3-step flow with Scout + Head Coach', () => {
      expect(MAN8_SKILL.body).toMatch(/Scout/);
      expect(MAN8_SKILL.body).toMatch(/Head Coach/);
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
    });

    it('uses Agent tool with subagent_type: scout', () => {
      expect(MAN8_SKILL.body).toMatch(/subagent_type.*scout/);
      expect(MAN8_SKILL.body).toMatch(/subagent_type.*head-coach/);
    });

    it('switches back to solo on user confirm', () => {
      expect(MAN8_SKILL.body).toMatch(/currentMode.*solo/);
    });
  });

  describe('man skill content', () => {
    it('describes 8-step flow with all 4 agents', () => {
      expect(MAN_SKILL.body).toMatch(/Scout/);
      expect(MAN_SKILL.body).toMatch(/Head Coach/);
      expect(MAN_SKILL.body).toMatch(/film-analyst-offense/);
      expect(MAN_SKILL.body).toMatch(/film-analyst-defense/);
      // 8 步流程
      for (let i = 1; i <= 8; i++) {
        expect(MAN_SKILL.body).toMatch(new RegExp(`Step ${i}`));
      }
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

  describe('renderSkill', () => {
    it('produces pure markdown (no YAML frontmatter)', () => {
      const rendered = renderSkill(MAN8_SKILL);
      expect(rendered.startsWith('# ')).toBe(true);
      expect(rendered.startsWith('---')).toBe(false);
    });

    it('preserves body verbatim with trailing newline', () => {
      const spec = {
        name: 'test',
        description: 'desc',
        body: '# title\n\nbody text',
      };
      const rendered = renderSkill(spec);
      expect(rendered).toBe('# title\n\nbody text\n');
    });
  });

  describe('installMvp2Skills (via installClaudeCode)', () => {
    it('creates 3 skill files in .claude/skills/', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      for (const skill of MVP2_SKILLS) {
        const file = path.join(
          dir,
          '.claude',
          'skills',
          `mancode-${skill.name}.md`,
        );
        const content = await readFile(file, 'utf-8');
        expect(content.length).toBeGreaterThan(100);
      }
    });

    it('settings.json registers all 4 skills (solo + 3 mvp-2)', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const settingsPath = path.join(dir, '.claude', 'settings.json');
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      expect(settings.skills).toBeDefined();
      expect(settings.skills.solo).toBe('.claude/skills/mancode-solo.md');
      expect(settings.skills.man8).toBe('.claude/skills/mancode-man8.md');
      expect(settings.skills.man).toBe('.claude/skills/mancode-man.md');
      expect(settings.skills.mansolo).toBe('.claude/skills/mancode-mansolo.md');
    });

    it('reinstall overwrites skill files', async () => {
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });
      await installClaudeCode(dir, { techStack: [], uiLibrary: null });

      const skillPath = path.join(dir, '.claude', 'skills', 'mancode-man8.md');
      const content = await readFile(skillPath, 'utf-8');
      expect(content.startsWith('# ')).toBe(true);
    });
  });
});
