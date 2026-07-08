import type { SkillSpec } from './index.js';

/**
 * /man skill — Playoffs Mode（docs/03 §4 + docs/14）。
 *
 * 8 步季后赛流程：Scout → Plan → 用户确认 → 实施 → 自测 →
 * Film #1 → 修复 → Film #2 → 收尾。
 */
export const MAN_SKILL: SkillSpec = {
  name: 'man',
  description:
    'Full 8-step playoffs workflow with coaching staff. Scout → Plan → Implement → Self-test → Film Offense → Fix → Film Defense → Wrap-up. Use for production code, complex features, critical modules.',
  body: `# mancode · /man (Playoffs Mode)

用户用 \`/man <task>\` 触发你。这是**完整 8 步流程**，教练组全员上场。

## 提取 task

1. 先用 Read 读取 \`.mancode/state.json\`。
2. 立即用 Edit 更新 state：
   - \`lastMode\` ← 原 \`currentMode\`
   - \`currentMode\` → \`"man"\`
   - \`currentTask\` → \`null\`
   - \`currentWorkflowMode\` → \`null\`
   - \`skippedSteps\` → \`[]\`
3. 从 \`/man <task>\` 提取 \`<task>\`。
4. 如 task 为空，用 AskUserQuestion 问用户："要用 /man 处理什么任务？"。等待任务期间，当前模式仍是 \`man\`；如果用户问"现在是什么模式"，回答 man 模式。

## 8 步流程

### Step 1: Scout Report（球探报告）

1. 创建 workflow 目录：\`.mancode/workflows/<YYYYMMDD-HHMMSS-slug>/\`
   - 写入 \`metadata.json\`：\`{"taskId":"...","task":"...","mode":"man","currentStep":1,"skippedSteps":[],"startedAt":"<ISO>","updatedAt":"<ISO>","status":"in_progress"}\`
2. 调用 Scout：
   \`\`\`
   Agent({ subagent_type: "scout", description: "Scout: <task>",
     prompt: "任务：<task>\\n项目栈：<从 state.json>\\n开始调研。" })
   \`\`\`
3. Write scout 输出到 \`scout-report.md\`
4. 更新 state.json：\`currentMode: "man"\`, \`currentTask: "<taskId>"\`, \`currentWorkflowMode: "man"\`
5. metadata.json：\`currentStep: 2\`

### Step 2: Game Plan

1. 读 \`scout-report.md\` 内容
2. 调用 Plan Coach（只读 plan 模式）：
   \`\`\`
   Agent({ subagent_type: "plan-coach", description: "Plan Coach: plan <task>",
     prompt: "任务：<task>\\nScout Report：\\n<scout-report.md 内容>\\n\\n只返回 plan markdown，不要修改项目文件。" })
   \`\`\`
3. Write 到 \`plan.md\`
4. metadata.json：\`currentStep: 3\`

### 用户确认 plan

用 AskUserQuestion：

\`\`\`
AskUserQuestion({
  questions: [{
    question: "Plan 见 .mancode/workflows/<taskId>/plan.md。怎么做？",
    header: "Plan review",
    options: [
      { label: "按 plan 实施 (Recommended)", description: "进入 Step 3" },
      { label: "修改 plan", description: "回 Step 2 重写" },
      { label: "退出", description: "放弃，标记 abandoned" }
    ],
    multiSelect: false
  }]
})
\`\`\`

- "退出" → metadata.json \`status: "abandoned"\`；用 Edit 更新 \`.mancode/state.json\`：\`currentMode: "solo"\`, \`lastMode: "man"\`, \`currentTask: null\`, \`currentWorkflowMode: null\`, \`skippedSteps: []\`；然后结束。
- "修改 plan" → 回 Step 2，附用户修改意见。
- metadata.json：\`currentStep: 3\`

### Step 3: Tip-off（实施）

1. 如任务规模大（多文件、新模块），建议用 EnterWorktree 创建 worktree（可选，问用户）
2. 调用 Head Coach（实施模式）：
   \`\`\`
   Agent({ subagent_type: "head-coach", description: "Head Coach: implement <task>",
     prompt: "任务：<task>\\nPlan：\\n<plan.md 内容>\\n\\n按 plan 实施。" })
   \`\`\`
3. metadata.json：\`currentStep: 4\`

### Step 4: Head Coach 自测

让 Head Coach 跑验证：\`npm run build && npm run lint && npm test\`（或项目实际命令）。

**铁律 1.3：失败两次必须停下诊断根因**。

通过后 metadata.json：\`currentStep: 5\`

### Step 5: Film Session #1（进攻）

用 AskUserQuestion 问用户："准备叫录像分析师 #1（进攻）上场，需要吗？"
- 跳过：metadata.json \`skippedSteps: ["film-1"]\`，直接 Step 7
- 执行：

\`\`\`
Agent({ subagent_type: "film-analyst-offense", description: "Film #1: offense review",
  prompt: "任务：<task>\\nScout Report：\\n<scout-report.md>\\n\\n本次改动的 git diff：\\n<git diff HEAD>\\n\\n开始审查。" })
\`\`\`

Write 输出到 \`film-report-1.md\`。metadata.json：\`currentStep: 6\`

### Step 6: Halftime 修复

调用 Head Coach（修复模式）：
\`\`\`
Agent({ subagent_type: "head-coach", description: "Head Coach: fix film-1",
  prompt: "任务：<task>\\nFilm Report #1：\\n<film-report-1.md>\\n\\n修复指出的问题（🔴 必修 > 🟡 建议 > 🟢 可选）。" })
\`\`\`

修复后重跑 build/lint/test。metadata.json：\`currentStep: 7\`

### Step 7: Film Session #2（防守）

问用户："叫录像分析师 #2（防守）上场？"
- 跳过：metadata.json \`skippedSteps\` 加 \`"film-2"\`，直接 Step 8
- 执行：

\`\`\`
Agent({ subagent_type: "film-analyst-defense", description: "Film #2: defense review",
  prompt: "任务：<task>\\nScout Report：\\n<scout-report.md>\\nFilm Report #1 已指出（不要重复）：\\n<film-report-1.md>\\n\\n本次改动的 git diff：\\n<git diff HEAD>\\n\\n开始防守审查。" })
\`\`\`

Write 到 \`film-report-2.md\`。
metadata.json：\`currentStep: 8\`

### Step 8: Post-game 收尾

1. 调用 Head Coach（收尾模式）修复 Film Report #2 的 🔴 问题：
   \`\`\`
   Agent({ subagent_type: "head-coach", description: "Head Coach: wrap up",
     prompt: "任务：<task>\\nFilm Report #2：\\n<film-report-2.md>\\n\\n修复 🔴 必修问题，然后生成 summary。" })
   \`\`\`
2. 把 summary 写到 \`summary.md\`
3. 如有 worktree，合并回主分支（用户确认后）
4. 更新 state.json：\`currentMode: "solo"\`, \`lastMode: "man"\`, \`currentTask: null\`, \`currentWorkflowMode: null\`, \`skippedSteps: []\`
5. metadata.json：\`status: "completed"\`

## 最终输出

告诉用户：
- 改了哪些文件 / 新建了哪些文件
- 复用了哪些已有代码
- 哪些步骤被跳过（⚠️ 标注）
- 验证结果（build/lint/test 是否通过）
- summary 路径

## 上下文预算

- 调用 subagent 时，**只贴必要文件内容**（scout-report.md 全文、film-report 全文）
- diff 大时只贴 hunk 摘要，让 agent 自己用 Read 看完整 diff
- 不要 dump 整个源文件到对话

## 铁律（永不违反）

1. **不做无关修改** — 只改 plan 范围内的
2. **先验证再声称完成** — build/lint/test 必须实际跑
3. **失败两次必须停下** — 不盲试
4. **不可逆操作先问** — 删除、force push、worktree 合并
5. **只解决被问到的问题** — 不加推测性功能

收到 \`/man\` 触发后立即开始 Step 1。`,
};
