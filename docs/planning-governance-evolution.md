# 规划治理演进与安全发布契约

本文是 mancode 0.4.0 的规划治理实施与发布契约。它描述目标行为、兼容边界、验证证据和停止条件。`4dc2e7e` 是当前已验证的开发集成候选；后续契约修复必须进入新的唯一候选。在最终发布门禁和 npm 发布完成前，本文的“已完成”只表示代码与自动化验证完成，不表示已经发布。

## 1. 决策摘要

| 阶段 | 发布内容 | 明确不做的事 | 放行前提 |
| --- | --- | --- | --- |
| 0.4.0 | additive advisory、adapter digest/upgrade、policy parser/capability gate、显式 project upgrade、已升级项目的 Policy 2 默认值，以及 local transport 的原子 `reframe` | 不强制 `solo -> /man`；不批量重写旧 workflow；不把项目升级伪装成普通 `refresh`；不自动降级 policy；git-ref transport 不执行 reframe | A–F 工作包、完整测试、真实宿主验收和 npm 发布前检查全部通过；只有完成 project upgrade 的项目启用 Policy 2 |

这是唯一对外版本。工作包可以分 PR、独立合并和独立评审，但不产生中间发布。任何能力都必须一起通过 0.4.0 release gate；在此之前不得通过 feature flag、环境变量、手工 metadata 或 npm 预发布提前启用。

### 当前状态（2026-07-22）

| 类别 | 状态 | 证据 |
| --- | --- | --- |
| A–F 实现工作包 | 工作树生产加固完成 | `4dc2e7e` 包含 Policy 2 mode scope、resolver 短路和 adapter target recovery 修复；本轮又补齐 required adapter readiness、真实 reframe 并发和已发布旧 CLI 黑盒证据，等待形成下一候选 |
| 本地发布前检查 | 工作树通过 | 本轮 `npm run prepublishOnly` 通过：lint、typecheck、build、dist adapter 验证、119 个测试文件/824 个测试；`npm audit --omit=dev`、`npm pack --dry-run` 和实际 tarball 安装/CLI/module smoke 均通过，形成候选后仍需在干净 checkout 重跑 |
| GitHub Quality gate | 候选通过 | `4dc2e7e` 的 [Quality gate run 29896302856](https://github.com/whitelonng/mancode/actions/runs/29896302856) 成功；候选变化后必须重跑 |
| GitHub Windows gate | 候选通过 | `4dc2e7e` 的 [Windows gate run 29896302904](https://github.com/whitelonng/mancode/actions/runs/29896302904) 在 CMD、PowerShell、Git Bash 全部成功；候选变化后必须重跑 |
| `develop` 远程一致性 | 候选已对齐 | `4dc2e7e` 已与 `origin/develop` 对齐；后续工作树修复形成新候选后需重新推送和对齐，`main` 未修改 |
| 最终发布验收 | 未完成 | 五平台真实宿主、跨 clone/legacy 人工验收、最终 Beta gate 和干净 checkout tarball 验收仍待完成 |
| npm 发布 | 未执行 | 在上项全部完成前保持禁止 |

## 2. 目标、不变量与非目标

### 2.1 目标

1. 让 `/man` 在入口、语义 owner、source of truth、状态和 contract 发生不确定时停下来，而不是用默认值继续推进。
2. 让旧 CLI 在 V2 manifest 的 reader/writer 边界显式拒绝，并让 0.4.x parser 拒绝未知 policy，避免“看起来成功但执行了旧规则”。
3. 让新 policy 只影响新建 workflow；历史 workflow 按创建时记录的 policy 继续运行。
4. 让 0.4.0 的 local `reframe` 具备单一 journal、单一 revision 线和可证明的中断恢复结果。

### 2.2 必须保持的不变量

- `.mancode/shared|local/workflows/<task>/metadata.json`、`requirements.json`、`plan.md`、review ledger、verification ledger、claim、handoff 和 task-head fence 的权威关系不变。
- Markdown 是人类可读产物；完成门禁和兼容门禁读取结构化实体及 digest，不以文本存在代替权威状态。
- 所有跨实体写入都经过 durable operation、expected revision、锁和 recovery action。
- 任何重新对齐触发都先保留当前权威文件；不能通过手工编辑 `currentStep`、`planning`、requirements 或 plan 制造“回退”。
- policy 版本是 workflow 创建时的事实。后续 CLI 升级不会静默把 `planning: 1` 改成 `2`。

### 2.3 非目标

- advisory 不改变 Solo 的执行授权，也不把提示性升级变成自动升级。
- advisory 本身不写 `planning: 2`、`blocked`、`reframe` 事件或其他状态来模拟回 Step 2。
- 不创建独立的 Domain Matrix 权威文件；它只能是高风险 `plan.md` 的可选章节。
- 不用 scope-change 表达需求重构。scope-change 只处理 implementation scope 和 claim successor。
- git-ref reframe 不属于本计划；在其具备跨 clone 原子语义前始终稳定拒绝，不发布本地成功、远端稍后同步的变体。

## 3. 基线证据与代码 owner

以下证据以当前工作树的 V3 实现为准。候选形成前后都应重新运行对应 contract；如果在途改动改变了行号或行为，更新证据而不是沿用旧结论。

| 事实 | 当前证据 | 对本计划的影响 |
| --- | --- | --- |
| workflow create 保留 Policy 1 基线，只在 V2 已升级项目的新 `/man` 上使用 Policy 2 默认值 | 以 release candidate 的 public `workflow create` contract 和 [`src/context/workflow-create.ts`](../src/context/workflow-create.ts#L277) 共同复核 | 不以单个 builder 行号宣称基线；项目升级状态和 workflow mode 共同决定默认值 |
| policy parser 只接受各组件显式支持的版本白名单 | [`src/context/workflow-metadata.ts`](../src/context/workflow-metadata.ts#L621) | 未知版本产生稳定的 `WorkflowPolicyVersionUnsupportedError`，不能被当成未来版本静默接受 |
| context compatibility 使用 adapter 的实际磁盘 inventory | [`src/commands/context.ts`](../src/commands/context.ts#L881) | manifest echo 不作为磁盘内容证据；inventory、renderer version 和内容状态必须共同匹配 |
| adapter inspection 重建 expected bytes/digest，并分类 `ready`、`missing`、`stale`、`unreadable` | [`src/installers/v3-adapter.ts`](../src/installers/v3-adapter.ts#L626) | status 与 mutation gate 都以物理 target 为准，非 ready 状态不能与 manifest version 混淆 |
| requirements finalize 与 plan revise 显式把旧 review/verification ledger 标为 stale | [`src/context/requirements-finalize.ts`](../src/context/requirements-finalize.ts#L188)、[`src/context/plan-revision.ts`](../src/context/plan-revision.ts#L347) | 复用 ledger stale 的验证模式，但 reframe 仍使用独立原子 operation |
| scope-change 会处理旧 claim 与 successor claim | [`src/context/scope-change.ts`](../src/context/scope-change.ts#L637) | 它不是需求重构；reframe 使用独立 operation type 和 eligibility |
| parent contract 变化会使 child snapshot stale | [`src/context/child-result-merge.ts`](../src/context/child-result-merge.ts#L331) | reframe 在入口拒绝 active child，而不是事后合并 stale 结果 |
| reframe eligibility 显式拒绝 active child、open handoff 和 active solo assignment | [`src/context/reframe.ts`](../src/context/reframe.ts#L497) | advisory 只返回诊断；不得通过局部清理绕过跨实体约束 |

**实现 owner 约定：** workflow metadata/parser 负责 policy 结构和状态转换； adapter installer/status 负责渲染、digest 和物理文件； compatibility/resolver 负责 reader/writer 门；workflow operation 模块负责跨实体写入；templates 只负责 advisory 文本，不得直接写权威状态。

## 4. 0.4.0：Additive Advisory

### 4.1 Scout 报告字段

在 `scout-report.md` 增加以下可选小节。它们是调研证据，不进入 workflow metadata，也不替代 requirements 的确认。

```markdown
## Current Behavior Evidence
- Observation: <当前真实行为>
- Evidence: `<command or file:line>`
- Reproduction/validation: <如何复现或验证>

## Candidate Semantic Owner
- Candidate: <模块、实体或命令>
- Confidence: high | medium | low
- Unresolved conflict: <none or concrete question>

## Source of Truth
- Authority: <结构化文件、ledger、manifest 或外部系统>
- Readers: <读取方>
- Writers: <唯一写入路径或 operation>
- Derived copies: <cache、markdown、adapter 等>

## Historical / Compatibility Impact
- Existing workflows: <影响或 no change>
- Legacy/transport: <影响或 no change>
- Migration/rollback: <需要的证据>
```

字段规则：

- “可选”表示只有相关或能从项目事实验证时才写；不得为了填满模板编造 owner 或 source of truth。
- `Current Behavior Evidence` 至少包含一个可复现观察和一个仓库路径、测试或命令证据；只有推测时必须标为未知。
- `Candidate Semantic Owner` 可以不是最终 owner，但必须写置信度和冲突；存在两个同等候选时，Plan Coach 必须停在 `NEEDS_CLARIFICATION`。
- `Source of Truth` 必须区分 authority 与 derived copy。adapter、cache、Markdown 默认不是任务状态的 owner。
- `Historical / Compatibility Impact` 至少回答旧 workflow、legacy fixture、transport 和 rollback 是否受影响；不受影响也要明确写 `no change`。

### 4.2 Plan Coach 规则

Plan Coach 继续是只读组件。它在产生计划前执行以下检查：

1. 所有候选方案是否针对同一个用户目标、同一验收边界和同一 scope。若某个选项偷偷改变目标或把问题改成另一个问题，返回 `NEEDS_CLARIFICATION`。
2. 每个选项的复杂度由谁承担：实现代码、迁移、运行维护、用户操作、兼容层或测试。不能只写“更简单”，要写承担者和可观察成本。
3. 输出唯一推荐，并给出拒绝其他选项的主要理由。推荐不是“由用户决定”；用户仍可否决，但计划不能同时保留多个未决方向。
4. 简单任务可以只列一个明显可行方向，并标注为什么没有真实替代方案；不能为了满足“多选”制造伪选项。

建议的输出契约：

```text
READY_FOR_PLAN
goal: <one stable goal>
options:
  - id: <id>
    solves: <same goal statement>
    complexity_bearer: <who pays and how>
    tradeoffs: <bounded list>
recommendation: <exactly one id>
stop_conditions: <conditions that invalidate this plan>
```

违反同目标、复杂度承担者或唯一推荐规则时，不写 `plan.md`，只返回 `NEEDS_CLARIFICATION` 及缺失决策。简单任务的单一方向仍必须有 `recommendation` 和停止条件。

### 4.3 Domain Matrix（仅高风险任务）

Domain Matrix 是 `plan.md` 内的可选章节，不另建权威文件。以下任一条件成立时建议加入：入口或流程跨平台不一致、owner/source of truth 不清、状态或 contract 语义会变化、跨 workflow/child/team/transport、迁移或兼容影响超过一个版本。

推荐表格：

| Domain | Current behavior/evidence | Candidate owner | Source of truth | Contract/state impact | Compatibility/history | Validation | Rollback/stop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<domain>` | `<path/test/command>` | `<module/entity>` | `<authority>` | `<field/transition>` | `<old workflow/transport>` | `<test/e2e>` | `<condition>` |

表格只帮助计划审查，不产生运行时决策。最终实现仍必须由对应 authority writer 和 operation contract 证明。

### 4.4 Solo 到 `/man` 的升级条件

advisory 只增加建议，不改变 Solo 权限或当前 workflow：

- 入口或流程不一致；
- semantic owner 不清；
- source of truth 不清；
- 状态或 contract 语义会变化；
- 任务范围、架构、成本或验收发生跨文件/跨模块变化；
- 需要历史兼容、迁移、跨平台或团队协调证据。

命中条件时，Solo/Head Coach 应建议改用 `/man` 并说明原因。除非用户明确发起新 `/man` workflow，否则不得自动改变 mode、current step、policy 或 authority。

### 4.5 停止与重新对齐诊断

以下任一条件出现，实施立即停止：

- 新证据推翻已确认的目标、owner、source of truth 或验收；
- 发现入口/流程在平台间不一致，且会导致不同语义；
- 需要改变 status、contract、policy 或 workflow transition 的含义；
- 发现 adapter stale、writer 不兼容、未完成 operation、active child、open handoff 或 active solo assignment；
- 用户提出的变化已经超出当前 requirements/plan 的 scope。

advisory 的唯一结果是停止当前代理执行，并返回只读诊断 `NEEDS_REALIGNMENT` 与原因 `MANCODE_REFRAME_REQUIRED`。该诊断不写入 workflow authority，也不调用通用 `workflow update`。

- 保留当前 `requirements.json`、`plan.md`、review/verification ledger、claims 和 handoff，且不写入任何 metadata；
- 不手改 `currentStep`，不写 `planning: 2`，不归档旧文件；
- 不释放 claim，不取消 handoff，不宣称任务已回到 Step 2；
- 用户可以查看当前 authority，并明确选择新建 `/man` workflow 或显式执行第 7 节的 local `reframe`。旧 workflow 不因该诊断而自动获得新的状态转换。

这是“停止并保留证据”，不是 reframe。advisory 不得把诊断伪装成持久 blocker；真正返回 Step 2 只由第 7 节的独立 operation 完成。

## 5. 0.4.0 的 Policy 2 基础能力

以下四个能力是 0.4.0 的独立工作包和共同 release gate，不是中间发布版本。它们分别有失败测试；不能用 `VERSION` 常量、managed marker 存在或 manifest 回显互相替代。

### 5.1 Adapter 内容 digest 与 stale 检测

目标契约：

- 对每个平台的每一个 managed target，以 `UTF-8("mancode-adapter-digest-v1") || 0x00 || UTF-8(target identity) || 0x00 || managed bytes` 作为 hash 输入，计算 `sha256:<64 hex>`。renderer 的 expected bytes 必须是规范化 UTF-8/LF；磁盘的 actual bytes 不先把 CRLF 转成 LF，否则换行漂移和截断会被掩盖。整文件 target 的 managed bytes 是整个文件，嵌入式 target 的 managed bytes 仅为 marker 边界内的 block，用户托管区域不参与 digest。
- status 同时读取磁盘内容、manifest 的 renderer version 和 renderer 重建的期望内容，返回 `ready`、`missing`、`stale` 或 `unreadable`，并提供 target、actual digest、expected digest、renderer version 和修复建议。
- 只有所有 required adapter 均 `ready`，compatibility gate 才允许需要 adapter 的 mutation。stale 读可以返回诊断，但不得继续执行新 policy。
- digest 必须覆盖实际 managed 内容；仅检查 marker 或版本常量不能证明用户没有改动、文件没有截断、换行没有变化。
- 首次落地时先对五个平台、共享 target（如 AGENTS）和 legacy marker 做 fixture，确认同一内容在支持的平台上得到同一 digest。

**本计划的选择：** 不把 content digest 写入 V1 或 V2 manifest。manifest 继续保存 renderer/schema version；status 每次从 renderer 重建 expected digest，并与磁盘 actual digest 比较。可重建的性能 cache 只能放在 local cache，不能成为 authority。性能问题不能在 0.4.0 临时扩展 schema；它必须作为后续独立设计重新评审。

`managedAdapters` 的 key 是 required adapter inventory，不是五个平台的固定全集。greenfield 只登记初始化时选择的平台；后续新增平台由 journaled adapter upgrade 同时发布 managed targets 和 inventory。compatibility 必须双向比较 manifest inventory 与实际主 target；required target 全部丢失时，空的实际集合不能通过门禁。

### 5.2 显式 adapter 升级命令

0.4.0 已固定并由 CLI contract 覆盖的命令：

```bash
mancode adapter upgrade --all --dry-run
mancode adapter upgrade --all --confirm --operation-id <operationId> --session <id> --client <client>
mancode adapter upgrade --platform <platform> --dry-run
mancode adapter status --json
```

升级命令必须：

1. 先读取 project manifest、实际 adapter inventory、profile 和当前 writer capability；stale、路径冲突、未完成 operation 或版本门禁失败时只报告，不写文件。
2. 在 staging 目录渲染所有目标，展示变更 target、digest 和托管区域差异；用户确认后才进入 journal。
3. 在 adapter locks 下按目标写入，使用 before/target digest recovery action；中断后由 `operation repair` 继续或在无业务写的前提下 abort。
4. 写完重新读取并验证每个 target；仅在 renderer version 变化时更新 manifest 的 adapter version/inventory，不写 content digest。任何一个 target 失败都不能报告整体成功。
5. 不修改 task、requirements、plan、policy 或 step；adapter 升级与 workflow 语义升级是两个 operation。

`refresh-project` 可以发现并报告 stale，但不能悄悄完成 adapter upgrade。`install --force` 是否复用底层 writer 由实现决定，但必须保留一个语义明确、可审计的显式 upgrade 入口。

### 5.3 Policy parser 版本白名单

版本解析必须从“任意正整数”改为按组件白名单：

| CLI/release | 可读取/写入的 planning policy |
| --- | --- |
| 既有 0.3.x CLI | 只支持 V1/Policy 1；已发布的 0.3.18 在 V2 manifest schema parser 边界拒绝未知的 `workflowPolicyDefaults`，并在 policy 执行和 authority mutation 前终止；能解析 V2 的 reader/writer 仍由 `minReaderVersion`/`minWriterVersion` 拒绝 |
| 0.4.0（未升级项目） | 读取和写入已有 `1`；新建仍按项目记录的默认值 |
| 0.4.0（已升级项目） | `1` 和 `2`；新建 `/man` 默认 `2` |

解析失败必须发生在 workflow mutation 之前，并携带 component、observed version、supported versions 和 required writer。不得把未知版本降为 1，也不得把缺省值自动解释成 2。

### 5.4 Writer capability 与 `minWriterVersion`

兼容门分两层：

- CLI 启动 mutation 前声明 capability 集合，例如 `planning-policy:1|2`、`adapter-digest:1`、`reframe-local:1`；resolver 根据 task/project 和 transport 需要的 capability 逐项检查。git-ref transport 不声明 `reframe` capability。
- project manifest 使用已有的 `minWriterVersion` 作为粗粒度下限。启用 Policy 2 的升级操作必须把 `minReaderVersion` 和 `minWriterVersion` 都提高到能完整理解 Policy 2、adapter digest 和 recovery contract 的版本，确保旧 CLI 在解析 workflow policy 前被 manifest gate 阻断。

门禁顺序固定为：读取 manifest → 检查 reader/writer semver → 检查 capability → 检查 adapter 内容 digest → 解析 workflow policy → 获取 locks。任一失败都没有业务写入。

建议的稳定错误：`MANCODE_WRITER_VERSION_TOO_OLD`、`MANCODE_WRITER_CAPABILITY_MISSING`、`MANCODE_ADAPTER_CONTENT_STALE`、`MANCODE_POLICY_VERSION_UNSUPPORTED`。错误输出应指向显式升级命令，而不是建议手工编辑 manifest。

## 6. 0.4.0：项目升级后的 Policy 2 默认值

### 6.1 项目升级边界

0.4.0 已固定并由 CLI contract 覆盖的命令：

```bash
mancode project upgrade --policy 2 --dry-run
mancode project upgrade --policy 2 --operation-id <operationId> --session <id> --client <client>
```

升级是 project-level journaled operation，至少包含：

1. 预检：所有 adapter digest fresh；没有 `operation_pending`/`repair_required`；没有正在进行的迁移；当前 writer 满足新 policy 和 adapter capability。
2. 生成 staging manifest 和新默认策略，记录 before/after digest、minReader/minWriter、操作 ID 和 release version。
3. 用户确认后原子提交 project policy marker/default 和兼容门；不改任何已有 workflow 的 `governance.policyVersions`。
4. 重新读取 project 与 workflow fixture，证明新建路径选择 2、旧路径仍按记录选择 1。

升级失败或进程中断时，必须由 journal repair 恢复到升级前的 project authority；不能留下“默认值已变但门禁未变”的半状态。

**推荐的 source of truth：** 0.4.0 引入支持 V1/V2 白名单的 schema manifest parser；V2 保持 `layoutVersion=3`，只新增 `workflowPolicyDefaults: { planning }`，并提高 `minReaderVersion`/`minWriterVersion`。review 与 verification 没有本次升级的 policy 语义，不能提前加入 defaults。现有 V1 项目必须显式升级到 V2；0.4.0 新初始化项目只有在 adapter digest 校验完成后才创建 V2，因此视为已升级。不要把 planning policy 放进现有 `TeamPolicyV1`：该实体的 owner 是团队推荐、可见性和 retention，不是 workflow 治理版本。

### 6.2 新旧 workflow 规则

- 只有已完成项目升级的项目，之后新建的 `/man` workflow 才默认 `policyVersions.planning=2`。
- 现有 workflow 的 planning/review/verification policy 按创建时记录保持不变；读取、plan revise、review 和 verification 不得因为 CLI 升级而批量重写。
- 0.4.0 在未升级项目中不得隐式写 2。若用户需要 Policy 2，必须先完成显式 project upgrade 并通过所有门禁。
- 删除、复制或导出 workflow 时保留 policy provenance；不能以“当前 CLI 版本”重算历史 policy。

### 6.3 回滚边界

- 在 project upgrade journal commit 前可 repair/abort，前提是没有可见业务写。
- 一旦已有 Policy 2 workflow 被创建，不允许把 project `minWriterVersion` 或默认 policy 静默降回旧值；发布回滚只能停止创建新 workflow，保留已有 policy 事实。
- 发现 adapter stale、旧 writer 或解析不支持时，阻塞 mutation 并要求 adapter/project upgrade；不能自动降级到 Policy 1。

## 7. 0.4.0：local transport 的独立原子 `reframe` operation

`reframe` 是需求语义重构，不是 scope-change 的别名，也不是设置一个 step 数字。它随 0.4.0 发布，但只有 local transport 支持；完整 operation 和 recovery 是 0.4.0 的 release gate。

### 7.1 Eligibility 与拒绝条件

在获取 task、task-head、claims、handoffs、review、verification 的锁后，以 expected task revision 做一次完整检查：

- task 必须是可继续的 active workflow，不能是终态、`operation_pending` 或 `repair_required`；
- 有 active child 时拒绝：`MANCODE_REFRAME_ACTIVE_CHILD`；
- 有 draft/offered/open handoff 时拒绝：`MANCODE_REFRAME_OPEN_HANDOFF`；
- 有 active solo assignment 时拒绝：`MANCODE_REFRAME_ACTIVE_SOLO`；
- git-ref transport 一律拒绝：`MANCODE_REFRAME_GIT_REF_UNSUPPORTED`；其跨 clone receipt/CAS 设计不属于本计划；
- 任一 claim、task head、review/verification digest 或 session freshness 过期时拒绝并要求重新读取 context。

拒绝发生在任何 authority 写入之前。特别是不能先释放 claim 再发现 child 或 handoff，不能先改 currentStep 再等待用户确认。

### 7.2 单一 journal 的原子步骤

建议 operation type 为 `reframe`，并为每个目标写 recovery action：

1. 记录 before revision、requirements digest、plan digest、review/verification digest、active claim IDs、handoff IDs 和 code head。
2. 写 `transitionState=operation_pending`，固定 operation ID 和 expected revisions。
3. 将旧 `requirements.json` 和 `plan.md` 复制为不可变 archive artifact，保存内容 digest、来源 revision、operation ID 和时间；旧文件不被覆盖或删除。
4. 在同一 operation 中释放所有 active claims；不能复用 claim identity，也不能把旧 claim 标记成新范围的 claim。
5. 重置旧 plan decision，并将 review 与 verification ledger 标为 `stale`，保留原证据和 stale reason。`soloExecution` 必须已为 `null`；active assignment 在 eligibility 阶段拒绝，不能在 operation 中清除它来绕过拒绝。
6. 写入新的 requirements draft/clarification-needed 状态、`currentStep=2`、`status=in_progress` 和 reframe checkpoint；这些字段只能作为同一 journal 的最终提交出现。
7. 更新 aggregate 和 task-head fence，提交 journal，清理 reservation；最后才允许新的 Step 2 writer 继续。

中断恢复必须能重跑每一步而不重复归档、重复释放或生成两个合法 task head。若无法证明前后状态，保持 `operation_pending`/`repair_required` 并拒绝普通 mutation。

### 7.3 与现有操作的边界

| 操作 | 能改变什么 | 不能代替什么 |
| --- | --- | --- |
| requirements finalize | 确认当前需求并使旧 ledger stale | 不能归档旧需求并回 Step 2 |
| plan revise | 在允许的步骤更新计划并使 ledger stale | 不能清理 solo/claim/handoff |
| scope-change | 更换 implementation scope，释放/重建 successor claim | 不能改变需求语义或 workflow step |
| `reframe` | 归档旧 requirements/plan、释放 claim、使 ledger stale、回 Step 2 | 不能清除 active assignment 来绕过 eligibility，也不能在 active child/open handoff/git-ref transport 中强行执行 |

## 8. 兼容矩阵

| Writer / project | 旧 Policy 1 workflow | Policy 2 workflow | 新建 `/man` | 结果 |
| --- | --- | --- | --- | --- |
| 0.3.x + V1 未升级项目 | 读写 Policy 1 | 不提供 Policy 2 创建 | 写 1 | 保持旧行为；Policy 2 需要显式升级 |
| 0.4.x + 未升级项目 | 读写 | 不创建、不接受未满足门禁的 2 | 写 1 | CLI 新，但 project policy 未升级 |
| 0.4.x + 已升级项目 | 读写且保留 provenance | 读写，要求 digest/capability | 写 2 | 目标 Policy 2 路径 |
| 0.3.x + V2 已升级项目 | 不允许写入 | 不允许读取后执行 | 不允许创建 | 0.3.18 在 manifest parser 边界拒绝；能解析 V2 的旧 reader/writer 返回 version-too-old failure |
| 任意 CLI + stale adapter | 读诊断 | 拒绝 mutation | 拒绝创建 | 先执行显式 adapter upgrade |
| 任意 CLI + git-ref transport | 正常既有 transport contract | Policy 2 仍可按 transport contract 运行 | 不能 reframe | `MANCODE_REFRAME_GIT_REF_UNSUPPORTED` |

“读”不等于“执行”：旧 CLI 只能在 V1/Policy 1 的兼容范围内展示安全诊断；遇到 V2 manifest 必须先由 manifest parser 或 reader gate 阻断，不能生成执行指令或写入任何 authority。

## 9. 验证矩阵

### 9.1 单元和 contract

- policy parser：1 可接受；0、负数、小数、未知正整数、缺失值和错误 component 均拒绝。
- workflow create：未升级项目只写 1；升级项目新 `/man` 写 2；已有 workflow 的 policy provenance 不变。
- Plan Coach：不同目标、无复杂度承担者、多个 recommendation、无 stop condition 均返回 `NEEDS_CLARIFICATION`；简单任务单方向通过。
- stop/re-align：触发时返回 `NEEDS_REALIGNMENT + MANCODE_REFRAME_REQUIRED`，且 authority 的前后 digest 完全相同。
- Scout/Domain Matrix：可选字段不进入 metadata；高风险 plan 可包含章节；普通任务不被强制增加文件。
- digest：内容、marker、路径、换行、截断、用户托管区域变化分别得到预期结果；manifest echo 与磁盘不一致必为 stale。
- manifest：V1/V2 都拒绝 content digest 字段；expected digest 只能由 renderer 和 managed target 重建。
- compatibility：reader、writer、capability、adapter digest、policy parser 按规定顺序短路，且失败前没有 journal 或业务写。
- reframe：每个拒绝条件都在第一步失败；每个 recovery action 幂等；中断后不出现部分 Step 2。

### 9.2 集成和恢复

- 五个平台生成、status、stale 编辑、dry-run、确认升级、升级后重新读取。
- adapter upgrade 在每个 target 写入前、写入后和中断点恢复；共享 `AGENTS` target 不能被两个平台重复覆盖。
- local transport 下的 Policy 2 create/plan/review/verification 与旧 workflow 并存。
- 两个 clone 的 git-ref 兼容门、旧 writer 拒绝、receipt recovery；所有 git-ref reframe 请求必须确认硬拒绝。
- active child、open handoff、active solo assignment 的并发 race：先取得锁的一方决定，另一方得到 expected-revision 或明确 reframe error。

### 9.3 真实宿主和跨平台

发布候选必须在 Claude Code、Codex、Cursor、GitHub Copilot、ZCode 以及 Windows CMD/PowerShell/Git Bash 路径上验证：入口传播、session identity、adapter 文件、status/stale 诊断和升级命令。缺少真实宿主证据的平台只能标记 `not_applicable` 并阻止对应能力发布，不能用另一个宿主代替。

## 10. 单版本 release gate

### 10.1 实施工作包

| 工作包 | 主要模块 | 必须新增的证据 | 完成定义 |
| --- | --- | --- | --- |
| A. advisory | `src/templates/agents/scout.ts`、Plan Coach template、`src/templates/skills/man.ts`、共享 adapter renderer | template snapshot、八类路由样例、简单任务单方向样例 | 所有 renderer 文案一致；advisory 不直接修改 metadata/schema |
| B. stop/re-align diagnostic | Scout/Plan Coach template、context 输出 | 触发器 contract、authority before/after digest、重复调用测试 | 只返回 `NEEDS_REALIGNMENT + MANCODE_REFRAME_REQUIRED`；authority、step、requirements、plan、claim 不变 |
| C. adapter digest/upgrade | `src/installers/v3-adapter.ts`、status/context callsite、operation recovery、CLI registration | 五平台 target fixture、stale 分类、dry-run、每个 crash point | compatibility 使用实际磁盘 digest；显式 upgrade 可 repair |
| D. policy/version gate | workflow metadata parser、manifest parser、compatibility/resolver、workflow create | V1/V2 白名单、0.3.x + V2 reader/writer fixture、capability/minWriter matrix | 未知 policy/manifest 在写前拒绝；没有 fallback |
| E. project Policy 2 upgrade | 新 project upgrade command/operation、manifest V2 writer、workflow create | V1→V2 dry-run/commit/repair、旧 workflow provenance、新 workflow default | 只有 V2 项目新建 `/man` 写 2；历史 metadata 无 diff |
| F. atomic local reframe | 新 `reframe` context module、operation definition/recovery、archive store、claim/ledger writers | eligibility、并发、每步 crash、archive digest、task-head fence | 单 journal 全前/全后；0.4.0 local transport 发布，git-ref 一律硬拒绝 |

每个工作包单独合并和评审。C、D 可以并行开发，E 依赖 C 和 D；F 与 E 可以分别完成，但二者都属于同一个 0.4.0 release gate，不能提前开启默认路径。

### 10.2 0.4.0 gate

当前 gate 结果如下。`[x]` 仅表示实现和自动化证据完成；真实宿主或发布验收未完成时，仍不得发布 npm。

- [x] 模板和文档 contract 通过；advisory 不直接执行 schema migration、policy 写入或自动 step 变更。
- [x] 旧 V3 fixture、legacy fixture、已有 adapter 和历史 workflow 通过原有测试。
- [x] 触发 stop/re-align 时只返回 `NEEDS_REALIGNMENT + MANCODE_REFRAME_REQUIRED`，authority 文件内容和 claims 不变。
- [x] Scout/Plan Coach 新字段和规则覆盖正常、缺失证据、冲突 owner、单方向简单任务。
- [x] adapter digest algorithm、status 分类、stale error、explicit upgrade command 和 recovery contract 完成。
- [x] policy parser 白名单、writer capability、`minWriterVersion`/reader gate 和 0.3.x + V2 manifest 拒绝 contract 完成；本轮已增加真实发布版 0.3.18 CLI 的黑盒写入拒绝与 authority 全树字节不变证据，后续候选仍需重跑。
- [x] project upgrade dry-run、确认、commit、repair、abort 和 provenance 完成；现有 workflow 未被批量重写，新 `/man` Policy 2 默认值有明确创建证据。
- [x] local transport 的完整原子 reframe、recovery、archive retention，以及与 child create、handoff create/start、solo handoff start 的真实并发竞争通过；没有复用 scope-change，也没有部分 authority 或 eligibility 绕过路径。
- [x] 已升级/未升级项目、旧/新 workflow、local/git-ref transport 的自动化兼容矩阵通过；git-ref reframe 稳定返回 `MANCODE_REFRAME_GIT_REF_UNSUPPORTED`。
- [x] 5 个 adapter renderer、Windows path、line ending、用户托管区和每个 target 写前/写后中断恢复在 `4dc2e7e` 通过；后续候选仍需重跑 dist/Windows/recovery gate。
- [ ] Claude Code、Codex、Cursor、GitHub Copilot、ZCode 的最终候选真实宿主验收，以及 [`docs/release-acceptance.md`](./release-acceptance.md) 要求的跨 clone、legacy、Beta gate 和干净 checkout tarball 验收。
- [x] 按开发集成要求将候选 `4dc2e7e` 推送到远程 `develop`，且 Quality 与 Windows gate 均通过；这不等同于 release gate 通过。
- [ ] 完成剩余发布验收后才允许进入 npm 发布检查；任何条件失败都不得发布 npm。

## 11. 发布回滚与停止策略

| 发现的问题 | 立即动作 | 禁止动作 | 恢复方式 |
| --- | --- | --- | --- |
| advisory 模板误导但无 authority 写 | 停止发布、修模板、重跑 snapshot | 不要求用户迁移 workflow | 发布前替换 adapter/模板；已有 authority 不变 |
| adapter stale 或 renderer mismatch | 阻塞 mutation，提示显式 upgrade | 自动 `--force`、手工改 digest | upgrade dry-run → 确认 → journal repair |
| Policy 2 parser/门禁错误 | 关闭 Policy 2 创建入口 | 把 2 降为 1 或修改旧 workflow | 修复 CLI 后重新读取；project marker 保持可审计 |
| project upgrade 中断 | 标记 pending/repair，禁止普通写 | 直接删除半成品或手改 minWriter | `operation repair` 恢复 before/target 状态 |
| reframe 中断或前置条件冲突 | 保留 operation journal，维持 blocked/repair_required | 手动写 Step 2、释放部分 claim | 修复原 operation；无法证明时人工处理后再重试 |
| git-ref reframe 请求 | 稳定返回 `MANCODE_REFRAME_GIT_REF_UNSUPPORTED` | 只在本 clone 先执行、以后同步 | 本计划不提供恢复路径；后续若要支持，必须另立协议设计与发布评审 |

版本回滚只回滚代码入口和默认创建策略，不回写历史 policy、requirements、plan 或 task step。任何需要修改现有权威内容的“回滚”都必须成为另一个明确、journaled 的 migration，并经过独立评审。

## 12. 实施顺序与停止/重新对齐条件

截至 `4dc2e7e`，步骤 1–4 是已验证的开发集成候选；本轮生产加固修复形成新候选后，受影响的自动化证据和步骤 5、7 仍需重新完成。

1. [x] 冻结本文件中的错误码、字段语义、digest 规范和兼容矩阵，并复核 public workflow create 的 Policy 1 基线。
2. [x] 完成 A–F 工作包；工作包可以独立合并，但不发布中间 npm 版本。
3. [x] 完成 adapter digest/upgrade 和 parser/capability gate；当前工作树已通过 0.3.x + V2 manifest reader/writer fixture，新候选仍需重跑。
4. [x] 完成 project upgrade 和 local reframe 的独立 operation/recovery；只在 upgraded marker 下打开 Policy 2 create default。
5. [ ] 在同一个 release candidate 上通过第 10.2 节和 [`docs/release-acceptance.md`](./release-acceptance.md) 的全部真实宿主、跨 clone、legacy、Beta gate 和 tarball 检查。
6. [ ] 将本轮加固后的唯一候选提交推送到远程 `develop`；`4dc2e7e` 的历史推送不替代新候选，且禁止推送、合并或创建以 `main` 为目标的发布操作。
7. [ ] 确认远程 `develop` 与完整验收证据完全一致后，才允许发布唯一的 npm 版本 0.4.0。git-ref reframe 始终拒绝，不进入本计划范围。

任何阶段出现下列情况，都回到“证据和契约评审”，而不是继续编码：

- 发现两个入口给同一任务不同的 owner、scope 或状态语义；
- authority writer 与 derived copy 的责任无法唯一确定；
- status、contract、policy 或完成门禁的意义需要改变；
- digest 只反映版本常量、无法重建 expected bytes，或跨平台结果不稳定；
- 旧 CLI 能读到新 policy 却没有可靠的 reader/writer/capability 拒绝；
- operation 无法在任意中断点证明“全前或全后”；
- 需求变化需要同时改 requirements、plan、claims、handoff 或 step，但当前 operation 没有覆盖它们。

重新对齐完成的最低证据是：新的目标、候选 owner、source of truth、兼容影响、停止条件和唯一 recommendation 已被记录，并由相应 authority writer 重新确认。仅仅修改 Markdown 或手动调整 step 不算重新对齐。

## 13. 0.4.0 已定稿的四个实现选择

以下选择已由 compatibility contract 固定；发布前不得在缺少重新评审和对应证据时改变：

1. **Public create 基线：** 用未升级项目的端到端 create contract 证明只写 Policy 1；不得把 CLI 选项、模板默认值或 builder 默认值中的任一项当成唯一证据。
2. **Digest 的持久化位置：** 固定采用“renderer 重建 expected digest + local 非权威 cache”，不在 V1 或 V2 持久化 content digest。性能不足必须另立设计，不能阻塞后临时扩 schema。
3. **升级命令的公开名称：** 以现有 `adapter status/upgrade` 命令注册、JSON 输出和 shell 退出码测试确定名称；文档和实现必须只保留一个正式入口。
4. **Capability 的编码：** 默认由 CLI 内置 capability set 加 project `minWriterVersion` 双门控制，不新增可被旧 CLI 忽略的 manifest capability 字段；local reframe 与 git-ref hard reject 必须使用不同 capability 结果。

这四项仍须与第 10.2 节的共同 release gate 一起通过，才允许发布 0.4.0。git-ref reframe 不在支持范围内。

## 14. 远程分支与 npm 发布顺序

0.4.0 只允许按以下顺序发布：

`4dc2e7e` 是当前已验证的开发集成候选，其 [Quality gate](https://github.com/whitelonng/mancode/actions/runs/29896302856) 和 [Windows gate](https://github.com/whitelonng/mancode/actions/runs/29896302904) 均成功。候选后的任何实现、测试或发布文档修改都会使这些证据不再适用于新候选；新的唯一候选必须重新完成第 1–3 步并推送到 `origin/develop`，第 4–6 步必须在任何 `npm publish` 前补齐。

1. 所有实现、修复和文档进入本地 `develop`，形成唯一 release candidate commit。
2. 在该提交上完成第 10.2 节的全部自动化、恢复、跨平台和真实宿主验收。任何失败都必须修复并从头重跑受影响的 release gate。
3. [ ] 对本轮形成的新候选只执行 `git push origin develop`。禁止直接或间接更新远程 `main`，包括 push、merge、rebase、以 `main` 为目标的 PR 或自动化发布工作流。
4. 从远程 `develop` 的同一提交创建干净 checkout，运行 `npm ci`、`npm run prepublishOnly`、要求的平台 smoke tests 和 `npm pack --dry-run`；随后执行实际 `npm pack`，验证生成 tarball 可安装、CLI 可启动。
5. 确认 release candidate commit、远程 `develop` commit、测试证据和待发布 package version 完全一致。
6. 前五步全部成功后才允许执行 `npm publish`。不发布 `0.4.0-beta`、`0.4.0-rc` 或其他中间 npm 版本。

若 `npm publish` 前发生任何代码、依赖、构建配置或发布文档变化，候选提交立即失效，必须重新执行步骤 2–5。npm 发布成功不授权更新远程 `main`。
