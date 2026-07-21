import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeCode } from '../src/installers/claude-code.js';
import { renderModeSkill } from '../src/installers/mode-skills.js';
import { SOLO_SKILL } from '../src/templates/inline.js';
import {
  MAMBA_SKILL,
  MANPS_SKILL,
  MANSOLO_SKILL,
  MANTEAM_SKILL,
  MAN_SKILL,
  MVP2_SKILLS,
  renderSkill,
} from '../src/templates/skills/index.js';

describe('mvp-2 skills', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mancode-skills-'));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('ships the redesigned command set without man8', () => {
    expect(MVP2_SKILLS.map((skill) => skill.name).sort()).toEqual([
      'man',
      'manba',
      'manps',
      'mansolo',
      'manteam',
    ]);
  });

  it('defines a progressive 9-step man workflow', () => {
    expect(MAN_SKILL.body).toMatch(/Step 1:/);
    expect(MAN_SKILL.body).toMatch(/Step 9:/);
    expect(MAN_SKILL.body).toMatch(/requirements\.md/);
    expect(MAN_SKILL.body).toMatch(/只要计划/);
    expect(MAN_SKILL.body).toMatch(/--parent-task/);
    expect(MAN_SKILL.body).toMatch(/2–3 个可行方案/);
    expect(MAN_SKILL.body).toMatch(/project-profile\.json/);
    expect(MAN_SKILL.body).toMatch(/workflow create man/);
    expect(MAN_SKILL.body).toMatch(/workflow update/);
    expect(MAN_SKILL.body).toMatch(/--plan-version/);
    expect(MAN_SKILL.body).toMatch(/confirm-manual/);
    expect(MAN_SKILL.body).toMatch(/workflow update <taskId> --step 4/);
    expect(MAN_SKILL.body).toMatch(/Plan Coach 先返回/);
    expect(MAN_SKILL.body).toMatch(/不得直接.*metadata\.json/);
    expect(MAN_SKILL.body).toMatch(/review-scope\.md/);
    expect(MAN_SKILL.body).toMatch(/定向审查/);
    expect(MAN_SKILL.body).toMatch(/一轮修复/);
    expect(MAN_SKILL.body).toMatch(/workflow review/);
    expect(MAN_SKILL.body).toMatch(/不用固定轮数/);
    expect(MAN_SKILL.body).toMatch(/不限制每批数量/);
    expect(MAN_SKILL.body).not.toMatch(/最多询问 4 个/);
    expect(MAN_SKILL.body).toMatch(/workflow requirements/);
    expect(MAN_SKILL.body).toMatch(/requirements\.json/);
    expect(MAN_SKILL.body).toMatch(/hybrid/);
    expect(MAN_SKILL.body).toMatch(/coverage/);
    expect(MAN_SKILL.body).toMatch(/--exit-code/);
    expect(MAN_SKILL.body).toMatch(/review <taskId> skip --reason/);
    expect(MAN_SKILL.body).toMatch(/Step 9 重跑全部 required/);
    expect(MAN_SKILL.body).toMatch(/workflow handoff/);
    expect(MAN_SKILL.body).toMatch(/workflow decide/);
    expect(MAN_SKILL.body).toMatch(/solo 轻量执行/);
    expect(MAN_SKILL.body).toMatch(/开工回执/);
    expect(MAN_SKILL.body).toMatch(/Current Behavior Evidence/);
    expect(MAN_SKILL.body).toMatch(/Candidate Semantic Owner/);
    expect(MAN_SKILL.body).toMatch(/Source of Truth/);
    expect(MAN_SKILL.body).toMatch(/Historical \/ Compatibility Impact/);
    expect(MAN_SKILL.body).toMatch(/complexity bearer/);
    expect(MAN_SKILL.body).toMatch(/一个 recommendation/);
    expect(MAN_SKILL.body).toMatch(/简单任务.*只列一个方向/);
    expect(MAN_SKILL.body).toMatch(/stop conditions/);
    expect(MAN_SKILL.body).toMatch(/Domain Matrix/);
    expect(MAN_SKILL.body).toContain('NEEDS_REALIGNMENT');
    expect(MAN_SKILL.body).toContain('MANCODE_REFRAME_REQUIRED');
    expect(MAN_SKILL.body).toMatch(/不得调用通用.*workflow update.*blocked/);
  });

  it('keeps solo review bounded and lightweight', () => {
    expect(SOLO_SKILL).toMatch(/只做一次/);
    expect(SOLO_SKILL).toMatch(/本次 diff/);
    expect(SOLO_SKILL).toMatch(/不调用.*reviewer/);
    expect(SOLO_SKILL).toMatch(/最窄/);
    expect(SOLO_SKILL).not.toMatch(/自审发现 3 个以上问题/);
    expect(SOLO_SKILL).toMatch(/activeSoloPlan/);
    expect(SOLO_SKILL).toMatch(/不重新规划/);
    expect(SOLO_SKILL).toMatch(/handoff <taskId> --complete/);
    for (const signal of [
      /平台入口或流程不一致/,
      /semantic owner 不清/,
      /source of truth.*不清/,
      /status、contract、policy.*语义会变化/,
      /scope、架构、成本或验收.*跨文件\/跨模块/,
      /历史兼容/,
      /迁移、跨平台/,
      /团队协调证据/,
    ]) {
      expect(SOLO_SKILL).toMatch(signal);
    }
    expect(SOLO_SKILL).toMatch(/不自动改变 mode/);
    expect(SOLO_SKILL).toContain('NEEDS_REALIGNMENT');
    expect(SOLO_SKILL).toContain('MANCODE_REFRAME_REQUIRED');
    expect(SOLO_SKILL).toMatch(/这是只读诊断/);
  });

  it('defines manba diagnosis and real browser validation boundaries', () => {
    expect(MAMBA_SKILL.body).toMatch(/diagnosis\.md/);
    expect(MAMBA_SKILL.body).toMatch(/mamba-report\.md/);
    expect(MAMBA_SKILL.body).toMatch(/Playwright/);
    expect(MAMBA_SKILL.body).toMatch(/snapshot/);
    expect(MAMBA_SKILL.body).toMatch(/manual_test_required/);
    expect(MAMBA_SKILL.body).toMatch(/profile 确认 Web UI/);
    expect(MAMBA_SKILL.body).toMatch(/workflow create manba/);
    expect(MAMBA_SKILL.body).toMatch(/--parent-task/);
    expect(MAMBA_SKILL.body).toMatch(
      /currentMode\/currentTask\/currentWorkflowMode/,
    );
    expect(MAMBA_SKILL.body).toMatch(/workflow update/);
    expect(MAMBA_SKILL.body).toMatch(/--status in_progress/);
    expect(MAMBA_SKILL.body).toMatch(/不得自动恢复父任务/);
    expect(MAMBA_SKILL.body).toMatch(/unrelated active workflow/);
  });

  it('keeps manteam and mansolo workflow constraints', () => {
    expect(MANTEAM_SKILL.body).toMatch(/Step 1-9/);
    expect(MANTEAM_SKILL.body).toMatch(/handoff\.md/);
    expect(MANSOLO_SKILL.body).toMatch(/abandoned/);
    expect(MANPS_SKILL.body).toMatch(/Preseason/);
    expect(MANSOLO_SKILL.body).toMatch(/manba/);
    expect(MANSOLO_SKILL.body).toMatch(/workflow show/);
    expect(MANSOLO_SKILL.body).toMatch(/workflow update.*abandoned/);
    expect(MANSOLO_SKILL.body).toMatch(/completed\/abandoned/);
    expect(MANSOLO_SKILL.body).toMatch(/不要先清空 state/);
    expect(MANTEAM_SKILL.body).toMatch(/workflow create manteam/);
    expect(MANTEAM_SKILL.body).toMatch(/planVersion/);
  });

  it('keeps non-Claude mode files on the same validated workflow contract', () => {
    const man = renderModeSkill('man', '/');
    expect(man).toMatch(/workflow create man/);
    expect(man).toMatch(/Step 1/);
    expect(man).toMatch(/Step 9/);
    expect(man).toMatch(/--plan-version/);
    expect(man).toMatch(/Never edit metadata\.json directly/);
    expect(man).toMatch(/review-scope\.md/);
    expect(man).toMatch(/targeted review/);
    expect(man).toMatch(/one remediation round/);
    expect(man).toMatch(/workflow review/);
    expect(man).toMatch(/Current Behavior Evidence/);
    expect(man).toMatch(/complexity bearer/);
    expect(man).toMatch(/exactly one recommendation/);
    expect(man).toMatch(/one real direction/);
    expect(man).toMatch(/Domain Matrix/);
    expect(man).toContain('NEEDS_REALIGNMENT');
    expect(man).toContain('MANCODE_REFRAME_REQUIRED');
    expect(man).toMatch(/Do not call generic workflow update/);

    const manba = renderModeSkill('manba', '/');
    expect(manba).toMatch(/workflow create manba/);
    expect(manba).toMatch(/currentWorkflowMode to mamba/);
    expect(manba).toMatch(/--parent-task/);
    expect(manba).toMatch(/diagnosis\.md/);
    expect(manba).toMatch(/mamba-report\.md/);
    expect(manba).toMatch(/manual_test_required/);
    expect(manba).toMatch(/production writes require explicit approval/);
    expect(manba).toMatch(/--status in_progress/);
    expect(manba).toMatch(/Never auto-resume manual_test_required/);
    expect(manba).toMatch(/unrelated active workflow/);

    const manteam = renderModeSkill('manteam', '/');
    expect(manteam).toMatch(/Step 1 through Step 9/);
    expect(manteam).toMatch(/linked manba child/);

    const mansolo = renderModeSkill('mansolo', '/');
    expect(mansolo).toMatch(/workflow show/);
    expect(mansolo).toMatch(/active children before their\s+parent/);
    expect(mansolo).toMatch(/semantic owner or source of truth is unclear/);
    expect(mansolo).toContain('NEEDS_REALIGNMENT');
    expect(mansolo).toContain('MANCODE_REFRAME_REQUIRED');
    expect(mansolo).toMatch(/This is read-only/);
  });

  it('renders skill frontmatter', () => {
    const rendered = renderSkill(MAMBA_SKILL);
    expect(rendered).toContain('name: manba');
    expect(rendered).toContain('# mancode · /manba');
  });

  it('installs the redesigned Claude skills', async () => {
    await installClaudeCode(dir, { techStack: [], uiLibrary: null });
    for (const skill of MVP2_SKILLS) {
      const content = await readFile(
        path.join(dir, '.claude', 'skills', skill.name, 'SKILL.md'),
        'utf-8',
      );
      expect(content).toContain(`name: ${skill.name}`);
    }
  });
});
