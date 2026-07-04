import type { SkillSpec } from './index.js';

/**
 * /manteam skill — Team Game（README MVP-2）。
 *
 * 团队模式：在 /man 的 8 步流程上增加协作上下文、变更边界、
 * commit/hand-off 约束，避免多人并行时互相踩改动。
 */
export const MANTEAM_SKILL: SkillSpec = {
  name: 'manteam',
  description:
    'Team workflow for shared repositories. Adds contributor context, coordination notes, commit discipline, and hand-off summaries to the full /man flow.',
  body: `# mancode · /manteam (Team Game)

用户用 \`/manteam <task>\` 触发你。这是多人协作版的完整工作流：先理解团队上下文，再按 /man 的 8 步流程推进。

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
   - \`.mancode/team/commit-msg.sh\`（仅当团队启用 \`mancode install claude-code --commit-hook\`）
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

## Step 1-8: Run Playoffs Flow

按 \`/man\` 的 8 步流程执行，但每一步增加团队约束：

1. Scout Report：必须列出共享文件、近期相关提交、潜在冲突文件。
2. Game Plan：计划里必须包含变更边界、兼容性风险、回滚方式。
   - Plan Coach 写计划：只返回计划文本，禁止提前修改业务文件或团队 memory。
3. Tip-off：改动前再次检查 \`git status --short\`，避免踩用户或队友改动。
4. Self-test：优先跑项目已有验证命令；失败两次停下诊断根因。
5. Film #1：重点审查可维护性、命名一致性、团队风格一致性。
6. Halftime Fix：只修 plan 和 film 指出的内容。
7. Film #2：重点审查边界条件、安全、性能、并发、兼容性。
8. Post-game：生成 hand-off summary。

如果用户在确认阶段选择"退出"或放弃团队 workflow：标记当前 workflow \`metadata.json.status = "abandoned"\`，并用 Edit 更新 \`.mancode/state.json\`：\`currentMode: "solo"\`, \`lastMode: "manteam"\`, \`currentTask: null\`, \`currentWorkflowMode: null\`, \`skippedSteps: []\`。不要把 abandoned workflow 留在 active state。

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
4. 如果团队需要强制 commit 规范，提醒可运行 \`mancode install claude-code --commit-hook\` 安装可选 Git hook；不要覆盖已有自定义 hook。
5. 如果用户要开 PR，参考 \`.github/PULL_REQUEST_TEMPLATE.md\` 输出 PR 描述。

## 铁律

1. 不覆盖未确认的用户/队友改动
2. 不改 plan 外文件
3. 共享接口变更必须写兼容性说明
4. 失败两次停下诊断
5. 不自动 commit / merge / push

收到 \`/manteam\` 触发后立即开始 Step 0。`,
};
