import type { SkillSpec } from './index.js';
import { CORE_CODING_PRINCIPLES } from './principles.js';

/**
 * /manteam skill — Team Game（README MVP-2）。
 *
 * 团队模式：在 /man 的 9 步流程上增加协作上下文、变更边界、
 * commit/hand-off 约束，避免多人并行时互相踩改动。
 */
export const MANTEAM_SKILL: SkillSpec = {
  name: 'manteam',
  description:
    'Team workflow for shared repositories. Adds contributor context, coordination notes, commit discipline, and hand-off summaries to the full /man flow.',
  body: `# mancode · /manteam (Team Game)

用户用 \`/manteam <task>\` 触发你。这是多人协作版的完整工作流：先理解团队上下文，再按 /man 的 9 步流程推进。

用 \`mancode workflow create manteam "<task>" --json\` 创建 workflow，并将 state 指向返回的 taskId。后续 step/status/planVersion/skippedSteps 全部使用 \`mancode workflow update\`；不得直接改 metadata.json。若已有 active workflow，先让用户选择恢复或放弃，不能清空旧指针。

## 适用场景

- 多人近期都在同一仓库活跃
- 改动会碰共享模块、公共 API、数据库 schema、设计系统或 CI
- 需要清楚记录为什么改、改了什么、还剩什么风险

## Step 0: Team Context

1. 读取 \`.mancode/state.json\`、\`.mancode/config.json\` 和团队 memory：
   - \`.mancode/memory/prd.md\`
   - \`.mancode/memory/spec.md\`
   - \`.mancode/memory/decisions.md\`
   - \`.mancode/team/commit-template.txt\`
   - \`.github/PULL_REQUEST_TEMPLATE.md\`
2. 如果 memory 文件不存在，先创建上述 3 个文件，使用简短标题和空模板，不要覆盖已有内容。
3. 收集团队上下文：
   - \`git status --short\`
   - \`git branch --show-current\`
   - \`git log --since="30 days ago" --pretty=format:"%h %an <%ae> %s" --max-count=30\`
   - \`git diff --stat\`
4. 如果有未提交改动，先判断是否属于用户当前任务；不确定就问用户，不要覆盖。
5. 不要在确认前追加 \`.mancode/memory/decisions.md\`。先把本次团队上下文写入当前 workflow 的 \`team-context.md\`：
   - 日期
   - task
   - branch
   - current contributors signal
   - files likely to touch
   - coordination risks

## Step 1-9: Run Progressive /man Flow

按 \`/man\` 的 9 步流程执行（含澄清、计划关卡和增强收尾），但每一步增加团队约束：

1. Scout Report：必须列出共享文件、近期相关提交、潜在冲突文件。
2. 澄清：最多两轮；把已确认约束和保守默认值写入 requirements.md。
3. Game Plan：计划里必须包含变更边界、兼容性风险、回滚方式；Plan Coach 只返回计划文本，禁止提前修改业务文件或团队 memory。
4. 计划关卡：用户可只保留计划、继续执行或重写计划；Active Plans 按 taskId 更新。
5. 实施：改动前再次检查 \`git status --short\`，避免踩用户或队友改动。
6. Self-test：优先跑项目已有验证命令；失败两次停下诊断根因。需要真实验证时创建带 parentTaskId 的 /mamba 子任务。子任务修复后若父任务曾因此 blocked，先用 workflow CLI 恢复父任务为 in_progress；manual_test_required 不得自动恢复。
7. Review scope + Film #1：基于实际 diff 写 \`review-scope.md\`，用 \`workflow review ... init\` 选择 targeted 或 full；重点审查行为、可维护性、团队风格与测试，finding 必须有证据和稳定 ID。
8. Film #2：仅 full 执行，先读 Film #1 报告并去重，只审查边界、安全、性能、并发和兼容性。用户明确要求才可跳过全部 review，并写入 \`skippedSteps\` 和残余风险。
9. Post-game：汇总 blocker，只做一轮修复并用 \`workflow review ... remediate\` 记录；复验后写 summary 与 hand-off。验证失败、审查不完整或仍有 blocker 时标记 blocked，不得标 completed。

如果用户在确认阶段选择"退出"或放弃团队 workflow：用 \`mancode workflow update <taskId> --status abandoned\` 更新并清理 Active Plans；若有活跃 mamba 子任务，先取得确认并逐个 abandoned。成功后再用 Edit 更新 state 回 solo。不要直接改 metadata，也不要把 abandoned workflow 留在 active state。

## Team Hand-off Summary

收尾时写 \`.mancode/workflows/<taskId>/handoff.md\`，包含：

- What changed
- Why it changed
- Files touched
- Validation run and result
- Migration or rollback notes
- Follow-up TODOs, only if unavoidable
- Suggested commit message

只有在用户确认实施并完成 workflow 后，才把最终 ADR 追加到 \`.mancode/memory/decisions.md\`。abandoned / plan-only workflow 只能保留在 \`.mancode/workflows/<taskId>/team-context.md\`、\`plan.md\` 和 \`handoff.md\`，不能污染长期团队 memory。

## Commit Discipline

不要自动 commit，除非用户明确要求。若用户要求 commit：

1. 先展示 \`git diff --stat\`
2. 确认没有无关文件
3. 优先参考 \`.mancode/team/commit-template.txt\`，commit message 使用：
   \`\`\`
   <type>(<scope>): <summary>

   Context:
   - task: <task>
   - workflow: <taskId>
   - validation: <commands>
   \`\`\`
4. 如果团队需要强制 commit 规范，建议在项目层面配置 Git hooks（如 husky 或 native git hooks）；不要覆盖已有自定义 hook。
5. 如果用户要开 PR，参考 \`.github/PULL_REQUEST_TEMPLATE.md\` 输出 PR 描述。

${CORE_CODING_PRINCIPLES}

## 团队扩展纪律

1. **不覆盖未确认的用户/队友改动** — 改动前后都检查工作区状态
2. **共享接口变更必须写兼容性说明** — 包含迁移、回滚和调用方影响
3. **不自动 commit / merge / push** — 除非用户明确要求

收到 \`/manteam\` 触发后立即开始 Step 0。`,
};
