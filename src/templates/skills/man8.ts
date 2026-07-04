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
    'Automatically use for pre-implementation research and planning requests: "先看看", "给方案", "怎么做", "不要改代码", architecture/risk/approach questions. Also available as /man8. Runs Scout, then Head Coach writes a plan before coding.',
  body: `# mancode · /man8 (4 AM Warmup)

这是**调研 + 计划** skill。它可以被用户显式 \`/man8 <task>\` 触发，也应该在用户没有输入命令但明显表达"先调研/给方案/怎么做/别改代码/评估风险/设计方案"时自动触发。

用户确认前不动代码；用户选择实施后，切回 solo 并立即按 plan 开始改。

## 自动触发条件

当用户请求符合以下任一条件时，主动使用本 skill，而不是直接进入 solo 实施：

- 要求"先看看"、"先调研"、"先分析"、"给我方案"、"怎么做"、"设计一下"
- 明确说"先别改代码"、"不要动代码"、"只给计划"、"先评估风险"
- 任务涉及未知模块、架构选择、集成方案、迁移方案、较大范围改动
- 用户问"这个功能怎么实现更好"、"应该怎么拆"、"有没有风险"

不要因为普通小改动自动触发本 skill。例如："把 README 加一行"、"修一个 typo"、"把按钮文案改掉" 应继续用 solo。

## 你需要从用户消息里提取的

1. 先用 Read 读取 \`.mancode/state.json\`。
2. 立即用 Edit 更新 state：
   - \`lastMode\` ← 原 \`currentMode\`
   - \`currentMode\` → \`"man8"\`
   - \`currentTask\` → \`null\`
   - \`currentWorkflowMode\` → \`null\`
   - \`skippedSteps\` → \`[]\`
3. **task**：
   - 显式触发：用户输入 \`/man8 <task>\` 时，task 是 \`<task>\` 部分。如 \`/man8 添加 OAuth 登录按钮\` → task = "添加 OAuth 登录按钮"。
   - 自动触发：用户没有输入 \`/man8\` 但本 skill 被选中时，把用户原始请求整体作为 task。
4. 只有在显式输入 \`/man8\` 且 task 为空时，才用 AskUserQuestion 问用户："要调研什么任务？"。等待任务期间，当前模式仍是 \`man8\`；如果用户问"现在是什么模式"，回答 man8 模式。

## 3 步流程

### Step 1：Scout 调研

1. 用 Write 工具创建 workflow 目录。task id 用 \`YYYYMMDD-HHMMSS-<slug>\` 格式（slug = task 的 kebab-case，截到 30 字符）：
   - 必须先用 Bash 执行 \`date -u +"%Y%m%d-%H%M%S"\` 获取真实时间戳；不要凭空估算日期时间
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
4. 用 Edit 更新 \`.mancode/state.json\`：\`currentMode: "man8"\`, \`currentTask: "<taskId>"\`, \`currentWorkflowMode: "man8"\`
5. 用 Edit 工具更新 metadata.json：\`currentStep: 2\`

### Step 2：Plan Coach 写 plan

1. 用 Agent tool 调用 Plan Coach（只读 plan 模式）：
   \`\`\`
   Agent({
     description: "Plan Coach: write plan for <task>",
     subagent_type: "plan-coach",
     prompt: "任务：<task>\\nScout Report（来自 .mancode/workflows/<taskId>/scout-report.md）：\\n<把 scout-report.md 内容贴进来>\\n\\n只返回 plan markdown，不要修改项目文件。"
   })
   \`\`\`
2. 把 Plan Coach 输出写入 \`.mancode/workflows/<taskId>/plan.md\`
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
      { label: "修改 plan", description: "重新跑 Step 2（Plan Coach 重写 plan）" },
      { label: "退出，保留 plan", description: "结束 /man8，plan 保留在 .mancode/workflows/ 供日后参考" }
    ],
    multiSelect: false
  }]
})
\`\`\`

根据用户选择：

- **切 solo 实施**：
  1. 用 Edit 更新 \`.mancode/state.json\`：\`currentMode: "solo"\`, \`lastMode: "man8"\`, \`currentTask: null\`, \`currentWorkflowMode: null\`, \`skippedSteps: []\`
  2. 读取 \`.mancode/workflows/<taskId>/plan.md\`
  3. 用当前 assistant（solo 模式）立即按 plan 实施；不要再次要求用户输入"开始实施"
  4. 实施完成后运行 plan 里列出的验证命令；如没有验证命令，至少用只读检查确认目标文件内容
  5. 用 Edit 更新 metadata.json：\`status: "completed"\`, \`currentStep: 3\`
  6. 最终告诉用户：改了哪些文件、验证结果、plan 路径

- **修改 plan**：
  1. 询问用户希望调整什么
  2. 重新跑 Step 2（Plan Coach 重写 plan，可附用户的修改意见）

- **退出**：
  1. 更新 metadata.json：\`status: "completed"\`
  2. 用 Edit 更新 \`.mancode/state.json\`：\`currentMode: "solo"\`, \`lastMode: "man8"\`, \`currentTask: null\`, \`currentWorkflowMode: null\`, \`skippedSteps: []\`
  3. 告诉用户："plan 保留在 \`.mancode/workflows/<taskId>/plan.md\`，需要时再叫我。"

## 上下文预算

- Scout 的 prompt ≤ 200 tokens
- Plan Coach 的 prompt 把 scout-report.md 全部贴进去（plan 阶段值得）
- 不要 dump 大量代码到对话；让 agent 自己用 Read 读

## 失败处理

- Agent 调用失败：报告错误，不重试 2 次以上（铁律 1.3）
- metadata.json 写入失败：停下来诊断，不伪造状态

收到 \`/man8\` 或自动触发后立即开始 Step 1，不要等用户确认。`,
};
