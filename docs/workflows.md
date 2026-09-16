# 工作流与团队协作

mancode 不把“当前模式”保存成全局开关。受治理的模式入口创建或恢复显式 session 与 TaskRef，再按能力读取有界上下文索引；普通 Solo 不创建这些治理状态。

## 模式

| 模式 | 用途 | 持久任务 |
|---|---|---|
| `solo` | 小改、最窄验证和一次受限 diff 自检；先判断需求是否清晰 | 否；可执行已确认的 solo handoff |
| `manba` | 复现、根因诊断、最小修复或真实验证 | 是，5 步 |
| `man` | 需求对齐、计划及可选完整治理 | 是，9 步 |
| `manteam` | 带 owner、participant、scope 和 claim 的团队治理 | 是，9 步 |
| `manps` | 确定性项目健康扫描 | 否 |

平台入口分别表现为 `/man`、`$man` 或 prompt，具体映射见 [platform-adapters.md](./platform-adapters.md)。

### 条件式需求澄清

`solo` 和 `/man` 都先判断需求是否足够清晰，不机械追问。目标、范围、验收边界和关键约束可以从用户请求、项目事实或明确的安全默认值确定时，直接继续；不需要为了形式制造问题。

如果仍有会改变目标、范围、用户可见行为、验收、架构、数据、安全、兼容性、owner 或 source of truth 的歧义，必须先向用户提出聚焦问题并等待回答。回答前不得把假设写成 confirmed requirements；复杂度、owner、迁移、跨模块或团队决策超出 Solo 边界时，应推荐 `/man` 并等待用户选择。该判断属于 Continuity mode entry 的固定行为契约。

| 输入状态 | 处理方式 |
| --- | --- |
| 目标与需求清晰、与项目证据一致、风险低 | 默认 Solo 直接执行最窄改动，不创建 session 或 TaskRef，不做形式化追问 |
| 目标清晰、需求有缺口 | 先把未知项分成 blocking、recommendable、defaultable；只为会改变决策的 blocking 项停下提问 |
| 请求与项目证据冲突，或出现尚未获授权的认证、支付、敏感数据、删除、迁移、公开 API、并发、基础设施等实质影响 | 展示具体证据和影响，只暂停受影响的动作，取得聚焦确认后继续；已有且仍适用的明确授权无需重复询问 |
| 用户明确请求计划、架构、迁移设计或正式验收 | 可直接进入 `/man` 规划路径；普通实现中途遇到这类决策时只推荐 `/man`，不得静默切换权威 |

已确认的需求、计划、文件范围和有效用户决定持续适用。普通 Solo 中明确授权且无事实冲突的局部 API 修复，可以直接实施；不能只因命中风险关键词再次要求确认。新范围、行为或验收变化仍须遵循原有 plan confirmation、scope change 或 reframe 协议。Continuity 权威状态只通过公共 CLI 修改，这不限制代码和文档使用正常编辑工具。

受治理任务在等待 blocking 回答前，必须把已知事实、部分决定和开放问题写入 requirements draft：

```bash
mancode workflow requirements local:<ULID> draft \
  --file requirements.json --expected-revision N --session <SESSION_ID>
```

draft 的 `blockingUnknowns` 必须列出开放决定；scope、coverage、technical decisions 或 acceptance 可以暂不完整。后续会话通过 TaskRef 恢复同一澄清状态，每次回答后更新 draft；只有 blocking 项清零且 requirements 完整时才能 `finalize`。`manba` 在修复前还必须先从复现、测试、文档、历史或语义 owner 建立预期行为，无法确定时先问一个聚焦问题。

## 各阶段按需读取

支持 `context-index-v1` 的入口以 `context index --purpose <purpose>` 获取少量引用，再按版本读取必需正文；不默认灌入全部任务、计划、spec 或历史。

| 阶段 | 当前行动前展开 |
|---|---|
| orient | 仅定位；写入前切换到实际阶段 |
| plan | 当前目标、需求/验收、范围及适用决定 |
| implement | 当前批准计划相关内容、完整适用 scope/约束、恢复检查点 |
| review | 批准基线、相关契约、实际完整 diff、未解决项和必要调用链 |
| verify | 验收条件、当前内容/环境基线、证据及未解决项 |
| handoff | 当前授权、批准依据、scope、剩余工作、阻塞和证据 |

分段读取以内容单元的完整性为准；`more_required` 未结束时不依据局部片段行动。分页完成后核对同一查询的 `--snapshot`。上下文压缩只保留“曾读过”的事实不能代替正文，恢复时重读当前必需约束；仍可见的相同版本在稳定行动批次可复用。历史诊断显式加 `--history`，旧计划不能授予新执行权。以上读取不替代既有批准、scope、revision、review 和完成门禁。

## `man` 流程

1. 调研已有实现、复用点、风险和未知项。
2. 澄清会改变范围、架构、成本或验收的问题。
3. 建立带版本的计划。
4. 用户选择只保留计划、solo handoff、完整治理或修订计划。
5. 按确认范围实施。
6. 运行验证并确定 targeted/full 审查范围。
7. 质量审查。
8. 仅在 full 深度执行安全与边界审查。
9. 必要问题修复、复验、交付记录和完成。新模块交付策略按下节收敛复核，不叠加审核流水线；旧任务仍遵循原策略。

`man` 面向长任务和项目交付。计划须覆盖实施阶段、依赖和相关集成验收；每个局部模块通过测试不等于项目验收通过。实质阶段结束、等待或交接时，通过既有 draft、checkpoint 和交付记录保存实际进度、未决事项与证据，避免只留在聊天里。

跨会话恢复已有 TaskRef 时，先读取其 Context Pack、原模式入口、批准计划和当前记录，按任务原有 policy 继续缺失环节。`plan_only` 仍止于规划；`governed_execution` 在批准范围内连续执行，无需逐阶段重复请示。普通 Solo 的轻量规则不能覆盖 `man`，受支持的 Solo handoff 也必须继承原 requirements、plan、implementationScope、必需验收和完成协议。工具暂时不可用时保留未验证状态，不能静默切换模式或降低标准。

受管 `solo_handoff` 继承正式 review/verification ledger 门禁。使用原 assigned session 登记当前需求和计划对应的证据与审查；缺失、失败或 stale 的记录不能完成交接。planning policy 3 继续使用 `workflow delivery` 的 verify/confirm、review、sync 和 check，保留文档回写、范围与任务提交检查，通过后执行 `workflow handoff <TaskRef> --complete`。旧 policy 使用原 verification/review apply 协议，不自动升级策略。普通无 TaskRef 的 Solo 不受这些要求影响，已完成的历史交接记录不被重写。

需求未 ready、计划未确认、执行任务缺少非空 implementation scope、验证失败、审查 blocker 未清零、存在活动子任务或未完成 repair 时，任务不能完成。升级前已进入执行阶段的本地 Man 任务可在用户确认完整边界后，用内容不变的当前 plan 和 `--scope-file` 执行一次兼容 plan revision；它只补绑 scope，并使旧 review/verification 失效。

### 新 `/man`：一次模块审核与文档交付

新入口创建任务时传 `--delivery`，显式选用 planning policy 3。省略该选项仍沿用项目默认策略。只有 `man` 可启用；旧任务不能静默升级或降级，其他模式不因此升级。该任务后续选择 Solo handoff 时仍继承相同交付门禁。更新运行时后，还需按 adapter upgrade 协议更新宿主入口，不能只手改 skill。

policy 3 的每个必需验收项还要按证据槽位声明精确的期望观察面。例如自动化真实 HTTP 验收使用 `{"id":"AC-1","description":"真实 HTTP 返回约定结果","required":true,"method":"automated","verificationSurfaces":{"automated":"real_http"}}`；manual 使用 `manual`，hybrid 同时声明 `automated` 和 `manual`。历史 requirements 和非 delivery 任务仍可读取缺少该字段的记录。

默认路径：一份模块计划 → 实现与相关验证 → 回写待审 → 一次总审 → 必要修复与定向复核 → 提交与完成。只讨论/规划不授权实现。模块以可独立验收的结果划分，不以文件或函数划分。审核既检查“目标到实现”的缺漏，也检查“改动到目标”的偏离，并检查具体缺陷和不必要的复杂度。允许零 finding；可选改进不阻止交付。

#### 绑定一份计划

优先用用户指定或项目已有的计划目录，新项目默认 `doc/`。本项目使用 `docs/`。选定路径随计划权威保存，远程接续不需要再猜目录；没有新增全局目录配置或第二份计划。文件须可正常版本化，不能强制添加被忽略的私有资料。架构资料不可用时，只为会改变实现且无法从计划/现有契约得出的细节请求确认。

```markdown
<!-- mancode:plan-baseline:start -->
# 导出模块
目标、包含/排除范围、相关架构依据、阶段、验收 ID 与验证方法、未决问题。
<!-- mancode:progress-task export -->
<!-- mancode:plan-baseline:end -->
<!-- mancode:delivery-record:start -->
尚未实现。
<!-- mancode:delivery-record:end -->
```

四个区块标记必须独占一行且唯一、有序；代码围栏内示例不参与解析。进度任务标记可省略。基线变化需重新确认；交付区回写不增加计划版本、不改变批准目标。运行时只更新交付区，不覆盖外部手写内容。

```bash
mancode workflow create man "导出模块" --delivery --session <SESSION_ID> --client <CLIENT> --json
# 按已有 requirements 协议完成澄清和 finalize 后：
mancode workflow plan <TASK_REF> revise --file docs/export.md --scope-file scope.json --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
mancode workflow plan <TASK_REF> confirm --plan-decision governed_execution --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
```

每步使用上一结果的新 revision。`scope.json` 的 include 要覆盖计划文件及获授权的进度页面；exclude 仍优先。无 Git 仍能规划和绑定文档，但不能声称版本化交付完成。

#### 验证与总审

JSON 临时输入放在 `.mancode/local/drafts/`，避免把审核输入本身计入被测源码。自动化输入示例为 `{"argv":["npm","test"],"surface":"component"}`；`surface` 必须是实际观察面并与该验收槽位的 `verificationSurfaces` 精确一致。实际选择与验收相称的命令，不为同一事实反复全量测试。

```bash
mancode workflow delivery <TASK_REF> sync --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
mancode workflow delivery <TASK_REF> verify --acceptance AC-1 --file .mancode/local/drafts/check.json --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
mancode workflow delivery <TASK_REF> inspect --json
```

`verify` 无 shell 地执行 argv，返回实际 stdout、stderr 和 exitCode，并通过原 journal 写证据。一个命令确实覆盖多个验收项时，可用 `--acceptance AC-1,AC-2` 一次运行并关联多个槽位，不能为逐项登记重复执行同一套测试。CLI 返回 0 表示录入成功，不表示测试通过；查看 `commandResult.exitCode` 和 finalization 状态。命令运行期间源码改变时不记录“通过”。手动/hybrid 验收使用 `confirm` 替代 `verify`，输入 `{"confirmed":true,"surface":"manual_observation","summary":"真实观察或用户确认的来源、结果与非敏感环境"}`；返回 manualConfirmation、记录当前 actor，不能把自述冒充独立认证。实际 surface 缺失或与 requirements 不一致时，即使底层 verification ledger 已记录 passed，最终门禁仍保持 `verification_incomplete`。

实现完整模块后，一名 reviewer 尽可能在获授权的独立上下文审核；无法独立时明确自审。使用批准计划、相关架构、`inspect.source.baseHead` 以来完整 diff、入口调用链与验证证据，不只阅读实现者总结。审核输入：

```json
{
  "subject": { "contentDigest": "从 inspect.subject 原样复制", "environment": "从 inspect.subject 原样复制" },
  "reviewer": "self",
  "direction": "各验收如何落到入口/调用链；全部改动为何属于计划",
  "correctness": "主链路和相关失败路径的实际证据、具体风险",
  "proportionality": "抽象和防御对应哪些真实约束，有无冗余",
  "nextAction": "仅继续已经授权的下一模块，否则结束",
  "coverage": [{ "acceptanceId": "AC-1", "status": "met", "evidence": "实现入口与真实验证结果" }],
  "findings": [],
  "resolved": []
}
```

subject 占位文字不是有效摘要，须替换为 `inspect` 结果。`reviewer` 可为 `self` 或 `independent`，但它只是调用者自述的审核元数据，不绑定另一 actor/session，不能单独证明独立身份；coverage 状态为 `met`、`missing` 或 `unverified`。必修 finding 形如 `{"id":"R-1","domain":"quality","severity":"p1","summary":"因果证据及影响"}`；domain 为 quality/security，severity 为 p0/p1/p2。修复后在 resolved 列出原 finding ID，不通过删掉问题记录来放行。

```bash
mancode workflow delivery <TASK_REF> review --file .mancode/local/drafts/review.json --review-depth targeted --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
```

涉及实质安全风险时使用 full；同一次总审可给出 quality/security 结论，不拆成三轮审核。复核只覆盖修复及直接回归，无新诊断依据时停止重复操作。每次 verify、confirm、review 自动回写交付记录；投影失败会返回 `deliveryRecord.status=pending` 及原始原因，已成功的账本写入不回滚，用 sync 重试即可。

内容摘要用于证据适用性，不证明功能正确。当前实现保守覆盖 Git 索引、工作区、非忽略未追踪文件，排除 `.mancode/` 和进度页；计划只计批准基线。仅提交或回写记录不废弃测试；源码改变会让旧证据过期，重新验证时清空不适用的其他槽位。外部依赖/环境变化不能仅靠本机 Node/平台标识检测，需主动重新验证。仓库内子模块及外部符号链接尚不支持自动证明，错误必须明确处理，不能猜测适用性。

#### 完成、发布与本地视图

先 sync，再提交本任务的源码、计划和必要页面变更。不要全库 add，不混入他人改动。

```bash
mancode workflow delivery <TASK_REF> check --json
mancode workflow complete <TASK_REF> --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
# 若已获授权且当前分支已有上游，正常推送后，可只读核实真实上游：
mancode workflow delivery <TASK_REF> publication --json
```

check 检查证据、计划回写、任务文件提交及范围，complete 仍重新执行原有 authority/子任务/repair/claim 门禁。范围外未提交文件不要求加入本任务提交，但必须先移出当前 checkout、stash 或单独提交，因为它可能参与本次验证；同一文件内的他人改动仍需人工区分。基线之后的范围外提交会被拒绝，需处理或重新确认范围，不能静默归为本任务。后置读取失败返回 `inspection_failed` 及原始 diagnostic，不再误报为 delivery record stale。

`publication` 只查询现有 upstream，不 fetch、push 或设置 remote；结果为 published、unpublished 或 unverified。没有 remote/上游或 push 失败不属于业务阻塞，报告“交付未发布”；查询失败不能冒称已发布。shared 的业务分支发布不等同于 Continuity transport 同步，保留既有显式同步和 fence 协议。

可选 `项目进度.html` 只识别以下精确数据契约，不解析/猜测 UI：

```html
<script type="application/json" id="mancode-progress-data">
{"schemaVersion":1,"tasks":[{"taskId":"export","status":"未完成","reason":null}]}
</script>
```

taskId 来自基线中的显式 progress-task 标记，未提供时为完整 TaskRef。sync 只更新唯一匹配记录的 status/reason；保留其他内容并转义 script 终止符。页面不存在、契约损坏/缺失、ID 不唯一或不在写入范围时返回 absent/manual_sync，不阻止开发。普通修复为“进行中”，已验证待审为“待审核”，审核和验收通过为“已完成”；只有业务状态 blocked 且存在未决外部确认时显示“阻塞”。未开发任务不更新。页面状态不是发布状态，也不替代运行时权威。

## manba 完整审核

`/manba <故障>` 保留诊断、最小修复、验证和原 typed outcome。显式 `/manba 审核 <范围>`
或 `/manba review <范围>` 请求则进入审核流程，默认只出报告，不自动修复代码。独立审核
不创建诊断任务，不用 `verified` 或 `no_repro` 表示“报告完成”。

审核先确定基线和目标。底层只读命令为：

```bash
mancode review inspect --base <批准的commit或ref> --json
```

清单分别比较明确基线到 HEAD、暂存区和当前工作区，合并相同变更并标记 `layers`；
同一路径跨层状态不同会保留不同条目，避免工作区还原掩盖暂存的待提交改动。另列未被
Git 忽略的未跟踪文件，包含删除和重命名。未暂存移动可能表现为删除加未跟踪路径。忽略文件、生成
内容和 submodule 的内部变更需要按验收契约另查；它不是不可变快照，变更后应重采。
命令不会创建 actor/session/task，不会执行项目检查。无 Git、无有效基线、冲突或采集
失败会显式失败；退出码 0 只证明采集成功，不证明语义审查或代码验收通过。

报告说明：基线/目标与范围、每个文件的审查情况及排除理由、行为链和验收覆盖、带稳定 ID
和因果证据的问题、实际检查结果、未验证环境以及下一步。借鉴 OCR 的关联分组与事实复核，
测试和 CI 同样参与审查，必修问题不截断。一次总审后按修复和新证据定向复核。

明确指定已有 Man TaskRef 时，读取原任务的 review context、批准计划和 policy，复用同一
次总审。不会切换 workflowMode 或默认创建 child；得到授权后才通过该任务现有的
`delivery review` 或相应旧 policy 协议登记，再读回状态。报告完成不能替代账本已应用；
plan_only、已完成任务和只读请求均不获得新增写权限。

本期交付审核入口、共享规则与检查对齐；持久化 audit outcome、TDD/修复预算门禁以及
GitHub CI 自动完成门留待后续。现有旧任务、诊断和 child snapshot 兼容协议保持原义。

## 状态与 revision

`manba` 使用诊断完成协议：先 finalize 诊断需求，实际执行相关检查，通过
`workflow verify <TaskRef> apply --file <verification-ledger.json>` 登记当前证据，
再调用 `workflow complete <TaskRef> --outcome <outcome>`，各写命令均携带当前 revision、
session 和 client。它不要求伪造 Man 的 plan decision 或模块总审。`fixed`、`verified`
和 `no_repro` 要求必需验证通过；`manual_test_required` 只表示已记录仍待人工验证的事项，
不能隐藏失败、缺失或过期证据。子诊断的 outcome 不替代父任务验收。

工作流状态为 `in_progress`、`planned`、`blocked`、`completed` 或 `abandoned`。终态不可恢复；`blocked` 只能在阻塞条件被显式处理后回到 `in_progress`。

每个写命令都需要当前 `expected-revision`。这是一条 compare-and-swap 约束，不是可选提示。revision、requirements digest 或 plan version 变化后，旧 review 和 verification 可能变为 `stale`。

典型路径：

```bash
mancode context session new --client codex --json
mancode context session show --session <id> --client codex --json
mancode workflow create man "添加导出功能" --session <SESSION_ID> --json
mancode workflow requirements local:<ULID> finalize \
  --file requirements.json --expected-revision 1 --session <SESSION_ID>
mancode workflow plan local:<ULID> revise \
  --file plan.md --scope-file scope.json \
  --expected-revision 2 --session <SESSION_ID>
mancode workflow plan local:<ULID> confirm \
  --plan-decision governed_execution --expected-revision 3 --session <SESSION_ID>
```

`plan revise` 必须通过 `--file <plan.md>` 读取 Markdown 计划。准备执行时同时通过
`--scope-file <scope.json>` 绑定 `{ include, exclude, modules }`；`include` 是非空的
repo-relative 文件边界，`exclude` 优先，`modules` 不单独授权写文件。修订与确认是两个
独立写操作；每次写入后都应从命令结果或 `mancode workflow show <TaskRef> --json`
获取最新 revision，再用于下一次 `--expected-revision`。没有明确边界时不能选择
`governed_execution` 或 Solo handoff；只保留计划时可以暂不提供边界并使用
`--plan-decision plan_only`。不要手工编辑 metadata 或 ledger。

后续明确批准实施时，local、single 的 man 任务可在同一 TaskRef 上继续：先恢复到由任务
owner 持有的 active session，再使用上述 `plan confirm --plan-decision governed_execution`
命令及当前 revision。该路径仅接受 Step 4 的 `plan_only`，状态须为 planned 或合法的
in_progress；需求仍就绪，已批准计划、版本和有效实施范围均保持不变。已有 blocker
须先按原生命周期协议解除；缺少范围、改变计划/需求或 scope 时不能借续接顺带放行。
`context resume` 或 lifecycle 更新本身不授予实施权，续接不清空审核/验证记录，也不降低
原完成门禁。

## Policy 2 与需求重新对齐

项目治理升级是显式操作，不会批量重写已有 workflow：

```bash
mancode project upgrade --policy 2 --dry-run
mancode project upgrade --policy 2 --operation-id <OPERATION_ID> --session <SESSION_ID> --client <CLIENT>
```

升级后的项目只对新建 `/man` workflow 默认使用 planning Policy 2；历史 workflow 继续使用创建时记录的 policy。

当新证据推翻已确认需求时，local workflow 可以从现有 checkpoint 执行原子 reframe：

```bash
mancode context resume local:<ULID> --session <SESSION_ID> --client <CLIENT> --json
mancode workflow reframe local:<ULID> \
  --expected-revision N \
  --checkpoint-id <FRESH_CHECKPOINT_ULID> \
  --summary "新证据为何使当前需求失效" \
  --next-action "回到 Step 2 后要澄清的事项" \
  --session <SESSION_ID> --json
```

仅在 session 尚未指向目标 TaskRef 时执行 `context resume`。`--checkpoint-id` 必须是本次操作新生成的规范 ULID，不能复用旧 checkpoint。reframe 会原子归档当前 requirements、plan 和 ledger，释放有效 claim，清除 plan decision，并把任务带回 Step 2 的 draft requirements；完成命令后应停止实施，先重新澄清、finalize requirements、revise plan，再由用户确认计划。它只接受 requirements 已确认、且不存在 active child、open handoff 或 active solo assignment 的 local workflow；git-ref transport 明确拒绝该操作。

reframe 的 JSON 结果会返回 `archive.archiveId` 与 `checkpoint.checkpointId`。可通过只读 CLI 检查证据，无需读取 `.mancode` 私有 authority 文件：

```bash
mancode workflow archive local:<ULID> show <ARCHIVE_ULID> --json
mancode workflow checkpoint local:<ULID> show <CHECKPOINT_ULID> --json
```

archive 输出会校验归档摘要，并返回 reframe 前的 requirements 与 plan；checkpoint 输出返回该次 reframe 的完整 checkpoint。这两个命令不修改 workflow，也不需要 `--session`。

新版本会在 reframe 创建 journal 或修改业务 authority 前拒绝已存在的 checkpoint ID。仅当旧版本已经留下一个 `repair_required` reframe，且普通 `operation repair` 明确因为该 ID 被另一 operation 的 checkpoint 占用而无法前向恢复时，才使用定向替换：

```bash
mancode operation show <REFRAME_OPERATION_ULID> --json
mancode operation repair <REFRAME_OPERATION_ULID> \
  --replacement-checkpoint-id <FRESH_CHECKPOINT_ULID> \
  --session <ORIGINAL_SESSION_ID> --client <CLIENT> --json
```

该命令只重绑定原 reframe 的 checkpoint、最终 metadata、aggregate 与 task-head fence 目标，然后继续原 operation；它不会删除或覆盖占用旧 ID 的 checkpoint。非 reframe、非 `repair_required`、存在 secondary reservation、资源已漂移或 replacement ID 已占用时都会拒绝。若换绑后再次中断，非终态恢复必须携带同一个 replacement ID 精确重试；终态 operation 不带替换参数时仍返回通用终态结果，携带替换参数时只接受原 replacement ID。其他中断仍使用不带该参数的 `operation repair`；不得通过删除 operation journal、recovery payload、checkpoint 或任务状态解除 adapter upgrade 门禁。

## Session 与 Context Pack

session 是 checkout-local 的调用身份，不决定任务是否完成。没有真实宿主传播证据时，mutating command 必须显式传 `--session`。

`mancode context show` 按 `bootstrap`、`task` 或 `full` 级别生成 Context Pack。它只返回与当前 revision 和 digest 一致的内容；发现未完成 operation 时返回 repair envelope。

Context Pack 是派生视图。治理说明中的受支持本机路径可仅在输出副本脱敏，并在
`provenance.redactions` 标记具体字段；原账本及来源摘要不变。被标记为
`[REDACTED:non_executable_command]` 的验证命令不能执行或当作完整命令回写账本，
应从当前项目核对实际可运行的检查。视图的 `packDigest` 对应实际输出，不能用它替代
原 authority digest；其他敏感内容与显式隐私排除仍按原规则处理。

## 团队协作

团队任务使用显式 actor、participant 和 implementation scope：

```bash
mancode team identity create --name "Alice"
mancode team join --name "Alice" --session <SESSION_ID>
mancode team claim shared:<ULID> \
  --path 'src/api/**' --expected-task-revision N --session <SESSION_ID>
```

claim 声明 path、module、API 或 schema 边界。任务或代码基线漂移后需要 revalidate；lease 过期不自动授权另一个 writer 接管。

handoff 必须经过 `draft → offered → accepted|rejected|cancelled`。accept 会在同一个 journaled operation 中更新 owner、claim、checkpoint 和 task head，避免出现两个合法 owner。

在 git-ref transport 下，workflow create、requirements、plan、review 和 verification 采用延后发布：先不带 `--sync` 写入本地 shared authority，把它与匹配的代码一起提交，再执行 `mancode team sync push shared:<ULID> --expected-task-revision N`。命令直接带 `--sync` 时必须返回 `MANCODE_GIT_REF_DEFERRED_SYNC_REQUIRED`，不能把未获得 receipt 的变更当作已同步。

`workflow update` 等明确要求 `--sync` 的原子 mutation 先取得远端 receipt，再 materialize
本地 `.mancode/shared` 投影。对于仍需跨 clone resume 的 `in_progress` 或 `blocked`
任务，如果提交这些 tracked 投影使 Git HEAD 前进，owner 必须在 clean worktree 上使用
不变的 task revision 再执行一次 `team sync push`。该操作只允许同 revision、同
aggregate 的 code-head fast-forward rebind；完成后另一个 clone 才能 pull 并 resume。

只有经过明确确认且通过隐私筛查的决策才能进入 shared memory。任务文本、绝对路径、凭据和宿主 session key 不应写入共享 transport。
