import type { SkillSpec } from './index.js';
import { CORE_CODING_PRINCIPLES } from './principles.js';

export const MAN_SKILL: SkillSpec = {
  name: 'man',
  description:
    'Progressive 9-step engineering workflow: research, clarify, plan, choose plan-only or execution, implement, validate, review, and wrap up. Use for complex or high-risk changes.',
  body: `# mancode · /man (Progressive Governance)

用户用 \`/man <task>\` 触发你。立即读 \`.mancode/state.json\`。若已有不同的 active workflow，不得直接清空指针；先让用户选择恢复原流程或用 \`/mansolo\` 放弃。task 为空时询问任务，等待期间仍是 \`man\` 模式。

用 \`mancode workflow create man "<task>" --json\` 创建 workflow 并读取返回的 taskId；不得直接创建或改写 metadata.json。随后只用 \`mancode workflow update\` 更新 step/status/planVersion/skippedSteps。state 的 \`currentMode\`、\`currentTask\` 和 \`currentWorkflowMode\` 指向本 task。

## 新项目技术选择关卡（仅在适用时）

先读 \`.mancode/project-profile.json\`。如果用户要新建项目、profile 为 unknown，且用户没有指定技术栈：先收集目标平台、用户规模、离线/部署、团队熟悉度、预算与集成约束；列出 2–3 个可行方案的优缺点和推荐理由，取得用户确认后才创建脚手架。不要把任何语言、框架、UI 库或浏览器自动化当作默认。已有项目则以检测到的事实和仓库约定为准。

### Step 1: Scout 调研

调用 \`scout\`，写 \`scout-report.md\`。报告必须包含“**不确定的地方**”。运行 \`mancode workflow update <taskId> --step 2\`。

### Step 2: 需求澄清

主 skill 直接基于 Scout 报告和任务歧义提问：客观题用 AskUserQuestion（每次最多 4 个），主观题开放提问。最多两轮，回答写 \`requirements.md\`；无问题则通过 CLI 将 \`clarify\` 写入累计 skippedSteps。第二轮后将假设、未决风险和保守默认值写入 requirements，不无限追问。完成后更新至 Step 3。

### Step 3: Plan Coach 出计划

调用只读 \`plan-coach\`，输入 task、scout-report 和 requirements；Plan Coach 只返回计划文本，由主 skill 写入 \`plan.md\`。计划必须含任务分级、模块索引、复用资源与 scout 行号、最小策略、不做什么、完成定义、验证与 smoke test、预估。首次计划写入成功后运行 \`mancode workflow update <taskId> --step 4\`，由 CLI upsert Active Plans 并进入计划关卡；重写计划时保持在 Step 4，运行 \`--plan-version <当前版本+1>\`，不得直接编辑 planVersion。

### Step 4: 计划关卡

用 AskUserQuestion 让用户选择：
1. **只要计划**：CLI 更新 \`status: planned\`，state 回 solo 并清空 workflow 指针，结束。
2. **继续执行（推荐）**：CLI 更新至 Step 5。
3. **修改计划**：收集意见并重跑 Step 3 的 Plan Coach，workflow 指针保持 Step 4；计划重写完成后递增 planVersion。

### Step 5: 实施

调用 \`head-coach\` 按确认计划实施。多文件、新模块或高风险任务可建议 worktree，必须先获用户同意。实施完成后通过 CLI 更新至 Step 6。

### Step 6: 自测、诊断与回归

运行实际 build/lint/typecheck/test 和 smoke test。相同代码、环境、命令下相同错误签名失败两次，停止盲试并诊断根因。需要真实浏览器、复杂复现或回归时，用 \`mancode workflow create manba "<问题>" --parent-task <taskId> --json\` 创建子 workflow；父任务保持 Step 6。子任务 fixed/verified/no_repro 后恢复本任务；若父曾因该子任务 blocked，先通过 \`workflow update --status in_progress\` 恢复，再更新至 Step 7。blocked 或 manual_test_required 会由 CLI 自动阻塞父任务，不得手改父 metadata，也不得自动越过人工验证要求。

验证后基于**实际 diff**写 \`review-scope.md\`：base、改动文件、需求、已跑验证、硬风险和审查深度。鉴权、支付、敏感数据、迁移/删除、公开 API、未可信输入、并发、跨服务或基础设施命中任一项时用完整审查 \`full\`；否则用定向审查 \`targeted\`。运行 \`mancode workflow review <taskId> init --review-depth targeted --review-domain quality\` 或 \`--review-depth full\`。用户明确跳过审查时才把 \`review\` 写入累计 skippedSteps，并记录残余风险。

### Step 7: Film #1 代码质量审查与修复

未跳过 review 时调用 \`film-analyst-offense\`，只审查本次 diff 的行为正确性、复用、复杂度和测试，写 \`film-report-1.md\`。每条 finding 必须引用改动行、给出证据和用户影响；最多 3 个新 finding。用稳定 ID（如 Q1）标记 🔴 blocker，并运行 \`mancode workflow review <taskId> complete --review-domain quality --report film-report-1.md --blockers Q1,Q2\`；没有 blocker 时传空字符串。此时不修复，先完成所需审查领域，再更新至 Step 8。

### Step 8: Film #2 安全与边界审查

\`full\` 才调用 \`film-analyst-defense\`；它必须先读 \`review-scope.md\` 和 \`film-report-1.md\`，只审查安全、权限、错误路径、兼容性、资源和边界。相同根因标记 \`duplicate\`，不得重新报告。写 \`film-report-2.md\` 后以 D1 等稳定 blocker ID 运行 \`mancode workflow review <taskId> complete --review-domain security --report film-report-2.md --blockers D1\`。\`targeted\` 不执行第二审，也不把它描述成“跳过”；完成后更新至 Step 9。

### Step 9: 增强收尾

1. 存在 open blocker 时，Head Coach 一次性修复全部 blocker，并用 \`mancode workflow review <taskId> remediate --resolved Q1,D1\` 记录唯一一轮修复；没有 blocker 时不运行 remediate。不要为 🟡/🟢 扩大改动。
2. 重跑受影响验证，不重新运行已完成的 reviewer。修复若引入新的高风险面则标记 blocked，不能开启无界 review 循环。
3. 写 \`summary.md\`：改动、新建、复用、验证、审查深度、findings 处置、跳过步骤和残余风险。
4. CLI 确认所需审查领域完成且 blocker 清零后才写 \`completed\`；否则用 \`--status blocked --blocking-reason "<原因>"\`。
5. 关键决策 appendTeamDecision 到 \`decisions.md\`，更新 Active Plans。
6. worktree 合并前取得用户确认；终态写入成功后 state 回 solo 并清空 workflow 指针。

任何 step/status/outcome/planVersion 变化都必须经过 workflow CLI；CLI 拒绝时保留当前 state 并报告原因，不可绕过校验直接改 metadata.json。

${CORE_CODING_PRINCIPLES}
`,
};
