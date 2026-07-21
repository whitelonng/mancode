import type { SkillSpec } from './index.js';
import { CORE_CODING_PRINCIPLES } from './principles.js';

export const MAN_SKILL: SkillSpec = {
  name: 'man',
  description:
    'Planning and progressive engineering workflow: research, align requirements, recommend options, produce a confirmed plan, then choose plan-only, lightweight solo implementation, or the full governed workflow. Use for planning requests and complex or high-risk changes.',
  body: `# mancode · /man (Progressive Governance)

用户用 \`/man <task>\` 触发你。立即读 \`.mancode/state.json\`。若已有不同的 active workflow，不得直接清空指针；先让用户选择恢复原流程或用 \`/mansolo\` 放弃。若 \`activeSoloPlan\` 非空，先让用户选择继续该计划；已完成时运行 \`mancode workflow handoff <旧taskId> --complete\`，放弃时取得确认后通过 CLI 标记旧 workflow abandoned 并清理指针，然后才能创建新计划。handoff CLI 会拒绝静默覆盖。task 为空时询问任务，等待期间仍是 \`man\` 模式。

用 \`mancode workflow create man "<task>" --json\` 创建 workflow 并读取返回的 taskId；不得直接创建或改写 metadata.json。随后只用 workflow CLI 更新需求、验证、step/status/planVersion/skippedSteps。通用 \`--skipped\` 只用于 Step 1–2 的 \`clarification\`；用户明确跳过整个 review 时必须在 Step 6 使用专用 \`workflow review ... skip --reason\`，不能写数字、\`film-1\` 或 \`film-2\`。state 的 \`currentMode\`、\`currentTask\` 和 \`currentWorkflowMode\` 指向本 task。

## 计划职责与技术选择关卡

把 \`/man\` 作为正式计划入口：先对齐需求并产出可确认的计划，不因计划完成而自动进入完整实施。计划关卡必须让用户选择只保留计划、交给默认 \`solo\` 轻量实施、继续完整 \`/man\` 或修改计划。

先读 \`.mancode/project-profile.json\`。如果用户要新建项目、profile 为 unknown，且用户没有指定技术栈：收集适用的目标平台、规模、离线/部署、团队熟悉度、预算与集成约束；列出 2–3 个可行方案的优缺点、明确推荐和推荐理由，取得用户确认。不要把语言、框架、UI 库、数据存储或浏览器自动化当作静默默认。已有项目以检测到的事实和仓库约定为准。

### Step 1: Scout 调研

调用 \`scout\`，写 \`scout-report.md\`。报告必须包含“**不确定的地方**”，并按可验证事实补充 Current Behavior Evidence、Candidate Semantic Owner、Source of Truth、Historical / Compatibility Impact；字段不相关或无法验证时可以省略，不能编造。Current Behavior Evidence 至少有一个可复现观察和仓库路径、测试或命令证据；owner 写置信度与冲突；source of truth 区分 authority 和 derived copy；兼容影响覆盖旧 workflow、legacy fixture、transport、迁移和 rollback。运行 \`mancode workflow update <taskId> --step 2\`。

### Step 2: 需求澄清

基于 Scout 报告做需求就绪判断，不用固定轮数或问题数量代替理解质量。把所有会改变范围、架构、成本或验收且无法从项目事实中查清的疑问问出来；允许按需要分多批澄清，不限制每批数量。每次回答后重新判断，只追问仍阻塞计划的未知项，不重复已确认内容。

把未知项分为：
- **blocking**：技术栈、核心范围、持久化、主要交互、关键性能/兼容性/安全目标等会改变方案的决策，必须确认。
- **recommendable**：有合适方案时直接给 2–3 个方案、优缺点和明确推荐，让用户接受或调整；不要只把选择题抛给用户。
- **defaultable**：命名、微小样式等低影响细节，可采用默认值，但写明默认值和理由。

按任务实际适用范围检查：用户目标与平台、核心流程、首期范围、排除项、技术与运行约束、数据/状态/集成、性能/兼容性/安全、可验证完成标准。连续澄清没有减少 blocking 项时，不散问；让用户选择缩小首期范围、接受列明的推荐默认值或暂停。

把结论写入结构化需求输入，至少包含 \`goal\`、非空 \`confirmedScope\`、\`excludedScope\`、\`technicalDecisions\`、\`defaults\`、\`blockingUnknowns\`、\`coverage\` 和 \`acceptanceCriteria\`。coverage 必须逐项说明 platform、core_scope、technical_stack、data_and_persistence、performance、compatibility、security 是 \`confirmed\`、\`defaulted\` 或带理由的 \`not_applicable\`，不能用空数组假装已经考虑。每个核心用户行为必须有稳定验收 ID（\`AC-1\` 等）、描述、\`required\` 和验证方式 \`automated\` / \`manual\` / \`hybrid\`；至少一个验收项必需。运行 \`mancode workflow requirements <taskId> finalize --file <requirements-input.json>\`，由 CLI 校验并生成权威 \`requirements.json\` 与 \`requirements.md\`，不要手工制造两份可能冲突的结论。无须提问时可把 \`clarification\` 记入累计 skippedSteps，但不能跳过需求摘要与就绪判断。仍有 blocking 项时停在 Step 2；只有 CLI 返回 ready 才运行 \`mancode workflow update <taskId> --step 3\`。

### Step 3: Plan Coach 出计划

调用只读 \`plan-coach\`，输入 task、scout-report、\`requirements.json\` 和渲染后的 \`requirements.md\`。Plan Coach 先返回 \`READY_FOR_PLAN\` 或 \`NEEDS_CLARIFICATION\`。后者只列缺失决策、影响、推荐和问题；主 skill 将 workflow 退回 Step 2 并重新 finalize requirements，不得强行补全计划。前者返回计划文本，由主 skill 写入 \`plan.md\`。

Plan Coach 必须证明所有选项解决同一个 goal、验收边界和 scope；逐项写明 complexity bearer 及可观察成本；给出且只给出一个 recommendation、拒绝其他方向的主要理由和 stop conditions。简单任务没有真实替代时只列一个方向并说明原因，不制造伪选项。两个同等 owner 候选或 authority writer 未决时返回 \`NEEDS_CLARIFICATION\`。

计划必须含需求摘要、任务分级、技术选择及理由、模块索引、复用资源与 scout 行号、核心行为、最小策略、不做什么、步骤、风险/回退、完成定义、真实验证与 smoke test、预估和非阻塞默认值。入口/流程跨平台不一致、owner/source of truth 不清、状态或 contract 语义变化、跨 workflow/child/team/transport，或迁移/兼容影响超过一个版本时，在 \`plan.md\` 内加入可选 Domain Matrix，列出 Domain、当前行为/证据、候选 owner、source of truth、contract/state 影响、compatibility/history、validation 和 rollback/stop；它不是新的 authority。首次计划写入成功后运行 \`mancode workflow update <taskId> --step 4\`；重写计划时保持 Step 4，运行 \`--plan-version <当前版本+1>\`，不得直接编辑 planVersion。

### Step 4: 计划关卡

用 AskUserQuestion 让用户选择：
1. **交给 solo 轻量执行**：常规低风险任务推荐。运行 \`mancode workflow handoff <taskId> --to solo\`；保留已确认计划和 Active Plans，由 solo 按计划做最窄验证和一次受限自检，不进入 Step 5–9。
2. **继续完整 /man**：高风险或需要独立审查时推荐。先运行 \`mancode workflow decide <taskId> --plan-decision governed_execution\`，输出开工回执，再更新至 Step 5。
3. **只要计划（仅保留）**：运行 \`mancode workflow decide <taskId> --plan-decision plan_only\`，由 CLI 原子保存 planned 状态、切回 solo 并清空受管 workflow 指针，结束。
4. **修改计划**：收集意见；若改变需求则回 Step 2，否则重跑 Plan Coach。重写完成后递增 planVersion，保持计划决策为空。

根据风险明确推荐理由，不把完整 \`/man\` 永远标为推荐。鉴权、支付、敏感数据、迁移/删除、公开 API、未可信输入、并发、跨服务或基础设施默认推荐完整 \`/man\`；普通原型、内部工具和低风险功能默认推荐 solo。

确认执行后、修改业务文件前输出开工回执：计划版本、执行方式、目标与交付物、技术方案、包含范围、排除范围、验证方式和残余假设。仍有 blocking 未知项时不得声称开始实施。

### 实施期间停止与重新对齐

以下任一情况出现时立即停止当前代理执行：新证据推翻已确认的目标、owner、source of truth 或验收；平台入口/流程会产生不同语义；需要改变 status、contract、policy 或 workflow transition 的含义；发现 adapter stale、writer 不兼容、未完成 operation、active child、open handoff 或 active solo assignment；用户变化超出当前 requirements/plan scope。

只返回 \`NEEDS_REALIGNMENT\`、原因 \`MANCODE_REFRAME_REQUIRED\` 和具体 trigger。该诊断只读：保留 requirements、plan、review/verification ledger、claims、handoff 和 metadata；不得调用通用 \`workflow update\` 写 blocked，不得手改 currentStep/planning，不归档旧文件，不释放 claim，不取消 handoff，也不宣称已回到 Step 2。等待用户显式选择新的 \`/man\` workflow 或受支持的 reframe operation。

### Step 5: 实施

调用 \`head-coach\` 按确认计划实施。多文件、新模块或高风险任务可建议 worktree，必须先获用户同意。实施完成后通过 CLI 更新至 Step 6。

### Step 6: 自测、诊断与回归

先运行 \`mancode workflow verify <taskId> init\`，再按 \`requirements.json\` 的每个验收 ID 记录真实结果。自动 passed/failed 必须使用 \`mancode workflow verify <taskId> record --acceptance AC-N --method automated --result passed|failed --evidence "<摘要>" --command "<实际命令>" --exit-code <退出码> [--evidence-file <报告>]\`；CLI 校验 passed 的退出码为 0、failed 为非 0。需要真实浏览器、设备或人的判断时，使用 \`mancode workflow verify <taskId> require-manual --acceptance AC-N --evidence "<自动化不能覆盖的原因>"\`；CLI 会阻塞主任务。明确告诉用户具体实测步骤并停下，只有收到用户明确确认后才使用 \`mancode workflow verify <taskId> confirm-manual --acceptance AC-N --evidence "<用户确认原文>"\`。此证据用于审计，不代表 CLI 能认证操作者身份。不得用页面加载、控制提示、截图、代码阅读或 reviewer 代替核心交互验收。

运行实际 build/lint/typecheck/test 和 smoke test。相同代码、环境、命令下相同错误签名失败两次，停止盲试并诊断根因。需要复杂复现或回归时，用 \`mancode workflow create manba "<问题>" --parent-task <taskId> --json\` 创建子 workflow；父任务保持 Step 6。子任务 fixed/verified/no_repro 后恢复本任务；\`manual_test_required\` 仍必须走上述人工确认。所有 required 验收及 hybrid 的两个部分都 passed 后，CLI 才允许进入 Step 7 或启动 review；计划版本或结构化需求变化会使旧验证失效。

验证后基于**实际 diff**写 \`review-scope.md\`：base、改动文件、需求、已跑验证、硬风险和审查深度。鉴权、支付、敏感数据、迁移/删除、公开 API、未可信输入、并发、跨服务或基础设施命中任一项时用完整审查 \`full\`；否则用定向审查 \`targeted\`。运行 \`mancode workflow review <taskId> init --review-depth targeted --review-domain quality\` 或 \`--review-depth full\`。只有用户明确要求跳过审查时才运行 \`mancode workflow review <taskId> skip --reason "<用户理由>"\`；CLI 会记录原因并累计 \`review\`，不得通过通用 skipped 参数绕过。

### Step 7: Film #1 代码质量审查与修复

未跳过 review 时调用 \`film-analyst-offense\`，只审查本次 diff 的行为正确性、复用、复杂度和测试，写 \`film-report-1.md\`。每条 finding 必须引用改动行、给出证据和用户影响；最多 3 个新 finding。用稳定 ID（如 Q1）标记 🔴 blocker，并运行 \`mancode workflow review <taskId> complete --review-domain quality --report film-report-1.md --blockers Q1,Q2\`；没有 blocker 时传空字符串。此时不修复，先完成所需审查领域，再更新至 Step 8。

### Step 8: Film #2 安全与边界审查

\`full\` 才调用 \`film-analyst-defense\`；它必须先读 \`review-scope.md\` 和 \`film-report-1.md\`，只审查安全、权限、错误路径、兼容性、资源和边界。相同根因标记 \`duplicate\`，不得重新报告。写 \`film-report-2.md\` 后以 D1 等稳定 blocker ID 运行 \`mancode workflow review <taskId> complete --review-domain security --report film-report-2.md --blockers D1\`。\`targeted\` 不执行第二审，也不把它描述成“跳过”；完成后更新至 Step 9。

### Step 9: 增强收尾

1. 存在 open blocker 时，Head Coach 一次性修复全部 blocker，并用 \`mancode workflow review <taskId> remediate --resolved Q1,D1\` 记录唯一一轮修复；没有 blocker 时不运行 remediate。不要为 🟡/🟢 扩大改动。
2. remediation 会使旧验证整批失效。在 Step 9 重跑全部 required 验收，并通过 verify record/require-manual/confirm-manual 重新登记证据；未重新全部通过不能 completed。不重新运行已完成的 reviewer。修复若引入新的高风险面则标记 blocked，不能开启无界 review 循环。
3. 写 \`summary.md\`：改动、新建、复用、验证、审查深度、findings 处置、跳过步骤和残余风险。
4. CLI 确认所需审查领域完成且 blocker 清零后才写 \`completed\`；否则用 \`--status blocked --blocking-reason "<原因>"\`。
5. 关键决策 appendTeamDecision 到 \`decisions.md\`，更新 Active Plans。
6. worktree 合并前取得用户确认；终态写入成功后 state 回 solo 并清空 workflow 指针。

任何 step/status/outcome/planVersion 变化都必须经过 workflow CLI；CLI 拒绝时保留当前 state 并报告原因，不可绕过校验直接改 metadata.json。

${CORE_CODING_PRINCIPLES}
`,
};
