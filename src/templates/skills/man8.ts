import type { SkillSpec } from './index.js';

/**
 * /man8 skill — 4 AM Warmup（docs/03 §3 + docs/14）。
 *
 * 3 步流程：Scout 调研 → Head Coach 写 plan → 用户确认。
 * 确认后自动切回 solo 实施。
 */
export const MAN8_SKILL: SkillSpec = {
  name: 'man8',
  description:
    'Pre-task research + planning. Runs Scout to investigate codebase, then Head Coach writes a plan. After user confirms, switches to solo mode for implementation.',
  body: `# mancode · /man8 (4 AM Warmup)

用户用 \`/man8 <task>\` 触发你。这是**调研 + 计划**模式，不动代码。

## 你需要从用户消息里提取的

- **task**：用户输入 \`/man8 <task>\` 时的 \`<task>\` 部分。如用户输入 \`/man8 添加 OAuth 登录按钮\`，task = "添加 OAuth 登录按钮"。
- 如 task 为空，用 AskUserQuestion 问用户："要调研什么任务？"

## 3 步流程

### Step 1：Scout 调研

1. 用 Write 工具创建 workflow 目录。task id 用 \`YYYYMMDD-HHMMSS-<slug>\` 格式（slug = task 的 kebab-case，截到 30 字符）：
   - 目录：\`.mancode/workflows/<taskId>/\`
   - 写入 \`metadata.json\`：\`{"taskId":"...","task":"...","mode":"man8","currentStep":1,"skippedSteps":[],"startedAt":"<ISO>","updatedAt":"<ISO>","status":"in_progress"}\`
2. 用 Agent tool 调用 Scout：
   \`\`\`
   Agent({
     description: "Scout: investigate codebase for <task>",
     subagent_type: "scout",
     prompt: "任务：<task>\\n项目栈：<从 .mancode/state.json techStack 读>\\n开始调研。"
   })
   \`\`\`
3. 把 Scout 的输出用 Write 工具写入 \`.mancode/workflows/<taskId>/scout-report.md\`
4. 用 Edit 工具更新 metadata.json：\`currentStep: 2\`

### Step 2：Head Coach 写 plan

1. 用 Agent tool 调用 Head Coach：
   \`\`\`
   Agent({
     description: "Head Coach: write plan for <task>",
     subagent_type: "head-coach",
     prompt: "任务：<task>\\nScout Report（来自 .mancode/workflows/<taskId>/scout-report.md）：\\n<把 scout-report.md 内容贴进来>\\n\\n写 plan。"
   })
   \`\`\`
2. 把 Head Coach 输出写入 \`.mancode/workflows/<taskId>/plan.md\`
3. 更新 metadata.json：\`currentStep: 3\`

### Step 3：用户确认

用 AskUserQuestion 工具问用户：

\`\`\`
AskUserQuestion({
  questions: [{
    question: "Plan 已生成（见 .mancode/workflows/<taskId>/plan.md）。怎么做？",
    header: "Next step",
    options: [
      { label: "切 solo 实施 (Recommended)", description: "切回 solo 模式，按 plan 直接开发" },
      { label: "修改 plan", description: "重新跑 Step 2（Head Coach 重写 plan）" },
      { label: "退出，保留 plan", description: "结束 /man8，plan 保留在 .mancode/workflows/ 供日后参考" }
    ],
    multiSelect: false
  }]
})
\`\`\`

根据用户选择：

- **切 solo 实施**：
  1. 用 Edit 更新 \`.mancode/state.json\`：\`currentMode: "solo"\`, \`lastMode: "man8"\`, \`currentTask: null\`, \`currentWorkflowMode: null\`, \`skippedSteps: []\`
  2. 用 Edit 更新 metadata.json：\`status: "completed"\`, \`currentStep: 3\`
  3. 告诉用户："已切回 solo。按 plan 直接说你要改什么，我就开始。"

- **修改 plan**：
  1. 询问用户希望调整什么
  2. 重新跑 Step 2（Head Coach 重写 plan，可附用户的修改意见）

- **退出**：
  1. 更新 metadata.json：\`status: "completed"\`
  2. 告诉用户："plan 保留在 \`.mancode/workflows/<taskId>/plan.md\`，需要时再叫我。"

## 上下文预算

- Scout 的 prompt ≤ 200 tokens
- Head Coach 的 prompt 把 scout-report.md 全部贴进去（plan 阶段值得）
- 不要 dump 大量代码到对话；让 agent 自己用 Read 读

## 失败处理

- Agent 调用失败：报告错误，不重试 2 次以上（铁律 1.3）
- metadata.json 写入失败：停下来诊断，不伪造状态

收到 \`/man8\` 触发后立即开始 Step 1，不要等用户确认。`,
};
