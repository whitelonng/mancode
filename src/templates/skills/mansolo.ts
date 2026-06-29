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

1. 用 Read 读 \`.mancode/state.json\`
2. 用 Edit 更新以下字段：
   - \`currentMode\` → \`"solo"\`
   - \`lastMode\` ← 原 \`currentMode\`（保留上一个模式名作为记录）
   - \`currentTask\` → \`null\`
   - \`currentWorkflowMode\` → \`null\`
   - \`skippedSteps\` → \`[]\`
3. 不改 \`initializedAt\`、\`techStack\`、\`uiLibrary\`、\`teamModeAutoDetected\`、\`contributors\`

## 输出

简短一句话告诉用户：

> man 已回到 solo 模式。日常训练继续。

或英文环境：

> man is back to solo mode. Daily practice continues.

## 边界情况

- **没有 .mancode/state.json**：告诉用户："项目未初始化，运行 \`mancode init\`。"
- **state.json 已是 solo**：仍正常执行，告知用户当前已是 solo。
- **当前在 /man /man8 流程中**：用 AskUserQuestion 问用户：
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
  - 用 Edit 更新 workflow 的 \`metadata.json\`：\`status: "abandoned"\`
  - 再更新 state.json 切回 solo

收到触发立即执行，不问任何额外问题。`,
};
