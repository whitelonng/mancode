import type { SkillSpec } from './index.js';
import { CORE_CODING_PRINCIPLES } from './principles.js';

export const MAMBA_SKILL: SkillSpec = {
  name: 'mamba',
  description:
    'Diagnose bugs and validate real user flows. Reproduce, find the root cause, run targeted regression checks, and use browser automation when the platform supports it.',
  body: `# mancode · /mamba (Diagnosis & Real Validation)

用户用 \`/mamba <问题或模块>\` 触发你。目标是用证据回答：能否复现、根因在哪里、修复是否有效、关键路径是否回归。

## 1. 建立任务

先读 state。若 \`currentTask\` 指向 unrelated active workflow，停止并让用户选择恢复该流程或先用 /mansolo 放弃；不得覆盖旧指针。独立任务运行 \`mancode workflow create mamba "<问题或模块>" --json\`；由 /man 或 /manteam Step 6 转入时运行 \`mancode workflow create mamba "<问题或模块>" --parent-task <父taskId> --json\`。读取返回 taskId 后，将 state 的 currentMode/currentTask/currentWorkflowMode 指向 mamba。不得直接创建或改写 metadata.json。

记录现象、环境、复现条件、预期与实际结果、不可触碰的数据。先检查已有测试、路由、模块入口和 README；仍无法确定最小路径时只问关键路径问题。完成后用 CLI 更新至 Step 2。

## 2. 准备环境与权限

先读 \`.mancode/project-profile.json\`，只使用已检测到的项目类型、manifest 和验证能力；profile 为 unknown 时先问关键缺失信息。优先本地 → 测试 → staging → 生产只读。可以启动本地开发服务和做只读探测。下载依赖、seed/reset、写入测试数据、登录外部系统、通知、付款、删除或生产写操作前，说明影响并取得用户确认；不猜测凭据或 Token。

平台能力分级：
- **完整**：有终端、浏览器自动化和 Playwright CLI；可测试真实浏览器路径。
- **半自动**：只能执行命令；输出逐步人工浏览器测试清单。
- **受限**：无本地执行能力；输出环境需求与人工步骤，metadata 记 \`outcome: "manual_test_required"\`，不得声称已真实测试。

仅当 profile 确认 Web UI 且浏览器能力可用时，检查 \`npx\` 并使用项目的 Playwright CLI wrapper。其他项目类型使用已检测到的 API、模拟器、设备、命令或契约验证方式。浏览器验证时先 snapshot 再使用元素引用；导航、弹窗或 UI 大变化后重新 snapshot。截图、trace 和浏览器日志写入 \`.mancode/workflows/<taskId>/artifacts/playwright/\`，报告只写相对路径，并脱敏 Token、Cookie、个人或业务敏感数据。

环境就绪后用 CLI 更新至 Step 3；缺少环境、权限或数据则直接写 blocked + blockingReason，并保留 state 指向当前 mamba 以便恢复。

## 3. 复现与诊断

按最短用户路径复现。记录请求/响应、日志、错误栈、截图和关键 UI 状态。区分环境、数据、配置、权限、前端、后端和需求理解问题。写 \`diagnosis.md\`：复现步骤、证据、根因或候选根因、影响面和置信度。完成后用 CLI 更新至 Step 4。

## 4. 最小修复或仅验证

用户要求修复时只做最小改动；只要求测试时不改代码。新需求、架构决策或跨模块改造应停止并建议 /man。完成后用 CLI 更新至 Step 5。

## 5. 真实回归与结论

重跑原路径，覆盖受影响的关键正向、负向和权限边界路径，并运行必要 build/lint/typecheck/test。写 \`mamba-report.md\`：环境、步骤、结果、产物路径、回归范围、风险与建议。

- 已修复：\`status: "completed", outcome: "fixed"\`
- 已验证但未改代码：\`status: "completed", outcome: "verified"\`
- 指定环境未复现：\`status: "completed", outcome: "no_repro"\`，限定结论范围
- 缺少环境、权限或数据，或修复仍失败：\`status: "blocked"\` + \`blockingReason\`
- 受限平台只能生成手测方案：\`status: "completed", outcome: "manual_test_required"\`；必须明确没有执行真实测试

用 \`mancode workflow update <taskId> --status <status> [--outcome <outcome>] [--blocking-reason <原因>]\` 写结论。父子任务的 blocked/manual_test_required 传播由 CLI 负责。关联子任务以 fixed/verified/no_repro 完成后，先读取父 workflow；若父仍因本子任务 blocked，运行 \`mancode workflow update <parentTaskId> --status in_progress\` 清除阻塞，再把 state 恢复到父 workflow 的 Step 6。manual_test_required 不得自动恢复父任务。独立任务完成后回 solo；blocked 的独立任务继续保持 mamba state。任何情况下都不得直接编辑 metadata 绕过 CLI。

${CORE_CODING_PRINCIPLES}
`,
};
