import type { SkillSpec } from './index.js';

/**
 * /mansolo skill — Back to Practice（docs/03 §6）。
 *
 * 切回 solo 模式：清理 state.json 里的 workflow 状态。
 */
export const MANSOLO_SKILL: SkillSpec = {
  name: 'mansolo',
  description:
    'Switch back to solo mode. Clears the current workflow state and returns to lightweight daily-practice mode.',
  body: `# mancode · /mansolo (Back to Practice)

用户用 \`/mansolo\` 触发你。这是**切回 solo 模式**的命令。

## 你要做的

1. 用 Read 读 \`.mancode/state.json\`。如果 \`currentTask\` 非空，先运行 \`mancode workflow show <taskId> --json\`，不要先清空 state。
2. 按下方边界规则安全处理 active workflow；终态 workflow 不再改写状态。
3. 只有不再遗留 active workflow 后，才用 Edit 更新以下字段：
   - \`currentMode\` → \`"solo"\`
   - \`lastMode\` ← 原 \`currentMode\`（保留上一个模式名作为记录）
   - \`currentTask\` → \`null\`
   - \`currentWorkflowMode\` → \`null\`
   - \`skippedSteps\` → \`[]\`
4. 不改 \`initializedAt\`、\`techStack\`、\`uiLibrary\`、\`teamModeAutoDetected\`、\`contributors\`

## 输出

简短一句话告诉用户：

> man 已回到 solo 模式。日常训练继续。

或英文环境：

> man is back to solo mode. Daily practice continues.

## 边界情况

- **没有 .mancode/state.json**：告诉用户："项目未初始化，运行 \`mancode init\`。"
- **state.json 已是 solo**：仍正常执行，告知用户当前已是 solo。
- **当前 task 已是 completed/abandoned**：不要尝试把终态改成 abandoned；直接清理 state。若它是关联 mamba 且父任务仍 active，先展示父任务并按下一条确认是否一并放弃。
- **当前在 active /man /mamba /manteam 流程中**：用 AskUserQuestion 问用户：
  \`\`\`
  AskUserQuestion({
    questions: [{
      question: "当前在 <mode> workflow 中（task: <taskId>）。切回 solo 会放弃这个 workflow，确认？",
      header: "Confirm",
      options: [
        { label: "确认切回 solo", description: "workflow 标记为 abandoned" },
        { label: "取消", description: "保持当前模式" }
      ],
      multiSelect: false
    }]
  })
  \`\`\`
  用户确认后：
  - 先用 \`mancode workflow show <taskId> --json\` 检查父子关系和 activeChildren。
  - 若存在活跃子任务或当前是带 parentTaskId 的 mamba，明确说明将放弃的 workflow 链；先逐个用 CLI 标记子任务 abandoned，再标记父/当前任务 abandoned。
  - 所有 metadata 状态都必须通过 \`mancode workflow update <taskId> --status abandoned\` 更新；CLI 拒绝时停止，不得直接 Edit 绕过。
  - 成功后再更新 state.json 切回 solo；CLI 会同步清理 Active Plans。

收到触发立即检查状态；除放弃 active workflow 所需的确认外，不问额外问题。`,
};
