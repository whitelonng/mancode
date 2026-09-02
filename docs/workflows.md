# 工作流与团队协作

mancode 不把“当前模式”保存成全局开关。平台入口创建或恢复显式 session 与 TaskRef，再读取 Context Pack。

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
| 表述明确但与项目证据冲突，或涉及认证、支付、敏感数据、删除、迁移、公开 API、并发、基础设施等高风险边界 | 展示证据和影响，推荐更安全路径，取得聚焦确认后再继续；“明确”不等于“正确或安全” |
| 用户明确请求计划、架构、迁移设计或正式验收 | 可直接进入 `/man` 规划路径；普通实现中途遇到这类决策时只推荐 `/man`，不得静默切换权威 |

受治理任务在等待 blocking 回答前，必须把已知事实、部分决定和开放问题写入 requirements draft：

```bash
mancode workflow requirements local:<ULID> draft \
  --file requirements.json --expected-revision N --session <SESSION_ID>
```

draft 的 `blockingUnknowns` 必须列出开放决定；scope、coverage、technical decisions 或 acceptance 可以暂不完整。后续会话通过 TaskRef 恢复同一澄清状态，每次回答后更新 draft；只有 blocking 项清零且 requirements 完整时才能 `finalize`。`manba` 在修复前还必须先从复现、测试、文档、历史或语义 owner 建立预期行为，无法确定时先问一个聚焦问题。

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

需求未 ready、计划未确认、执行任务缺少非空 implementation scope、验证失败、审查 blocker 未清零、存在活动子任务或未完成 repair 时，任务不能完成。升级前已进入执行阶段的本地 Man 任务可在用户确认完整边界后，用内容不变的当前 plan 和 `--scope-file` 执行一次兼容 plan revision；它只补绑 scope，并使旧 review/verification 失效。

### 新 `/man`：一次模块审核与文档交付

新入口创建任务时传 `--delivery`，显式选用 planning policy 3。省略该选项仍沿用项目默认策略。只有 `man` 可启用；旧任务不能静默升级或降级，其他模式及 Solo handoff 不受影响。更新运行时后，还需按 adapter upgrade 协议更新宿主入口，不能只手改 skill。

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

JSON 临时输入放在 `.mancode/local/drafts/`，避免把审核输入本身计入被测源码。自动化输入示例为 `{"argv":["npm","test"]}`；实际选择与验收相称的命令，不为同一事实反复全量测试。

```bash
mancode workflow delivery <TASK_REF> sync --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
mancode workflow delivery <TASK_REF> verify --acceptance AC-1 --file .mancode/local/drafts/check.json --expected-revision <N> --session <SESSION_ID> --client <CLIENT> --json
mancode workflow delivery <TASK_REF> inspect --json
```

`verify` 无 shell 地执行 argv，返回实际 stdout、stderr 和 exitCode，并通过原 journal 写证据。一个命令确实覆盖多个验收项时，可用 `--acceptance AC-1,AC-2` 一次运行并关联多个槽位，不能为逐项登记重复执行同一套测试。CLI 返回 0 表示录入成功，不表示测试通过；查看 `commandResult.exitCode` 和 verification 状态。命令运行期间源码改变时不记录“通过”。手动/hybrid 验收使用 `confirm` 替代 `verify`，输入 `{"confirmed":true,"summary":"真实观察或用户确认的来源、结果与非敏感环境"}`；返回 manualConfirmation、记录当前 actor，不能把自述冒充独立认证。

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

subject 占位文字不是有效摘要，须替换为 `inspect` 结果。`reviewer` 可为 `self` 或 `independent`；coverage 状态为 `met`、`missing` 或 `unverified`。必修 finding 形如 `{"id":"R-1","domain":"quality","severity":"p1","summary":"因果证据及影响"}`；domain 为 quality/security，severity 为 p0/p1/p2。修复后在 resolved 列出原 finding ID，不通过删掉问题记录来放行。

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

check 检查证据、计划回写、任务文件提交及范围，complete 仍重新执行原有 authority/子任务/repair/claim 门禁。工作区无关脏文件不要求提交；同一文件内的他人改动仍需人工区分。基线之后的范围外提交会被拒绝，需处理或重新确认范围，不能静默归为本任务。

`publication` 只查询现有 upstream，不 fetch、push 或设置 remote；结果为 published、unpublished 或 unverified。没有 remote/上游或 push 失败不属于业务阻塞，报告“交付未发布”；查询失败不能冒称已发布。shared 的业务分支发布不等同于 Continuity transport 同步，保留既有显式同步和 fence 协议。

可选 `项目进度.html` 只识别以下精确数据契约，不解析/猜测 UI：

```html
<script type="application/json" id="mancode-progress-data">
{"schemaVersion":1,"tasks":[{"taskId":"export","status":"未完成","reason":null}]}
</script>
```

taskId 来自基线中的显式 progress-task 标记，未提供时为完整 TaskRef。sync 只更新唯一匹配记录的 status/reason；保留其他内容并转义 script 终止符。页面不存在、契约损坏/缺失、ID 不唯一或不在写入范围时返回 absent/manual_sync，不阻止开发。普通修复为“进行中”，已验证待审为“待审核”，审核和验收通过为“已完成”；只有业务状态 blocked 且存在未决外部确认时显示“阻塞”。未开发任务不更新。页面状态不是发布状态，也不替代运行时权威。

## 状态与 revision

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

## Session 与 Context Pack

session 是 checkout-local 的调用身份，不决定任务是否完成。没有真实宿主传播证据时，mutating command 必须显式传 `--session`。

`mancode context show` 按 `bootstrap`、`task` 或 `full` 级别生成 Context Pack。它只返回与当前 revision 和 digest 一致的内容；发现未完成 operation 时返回 repair envelope。

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
