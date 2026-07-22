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
9. 最多一轮 blocker 修复、复验、summary 和完成。

需求未 ready、计划未确认、验证失败、审查 blocker 未清零、存在活动子任务或未完成 repair 时，任务不能完成。

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
  --file plan.md --expected-revision 2 --session <SESSION_ID>
mancode workflow plan local:<ULID> confirm \
  --plan-decision governed_execution --expected-revision 3 --session <SESSION_ID>
```

`plan revise` 必须通过 `--file <plan.md>` 读取 Markdown 计划。修订与确认是两个独立写操作；每次写入后都应从命令结果或 `mancode workflow show <TaskRef> --json` 获取最新 revision，再用于下一次 `--expected-revision`。只保留计划时把确认参数改为 `--plan-decision plan_only`。不要手工编辑 metadata 或 ledger。

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
