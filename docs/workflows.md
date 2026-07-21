# 工作流与团队协作

mancode 不把“当前模式”保存成全局开关。平台入口创建或恢复显式 session 与 TaskRef，再读取 Context Pack。

## 模式

| 模式 | 用途 | 持久任务 |
|---|---|---|
| `solo` | 小改、最窄验证和一次受限 diff 自检 | 否；可执行已确认的 solo handoff |
| `manba` | 复现、根因诊断、最小修复或真实验证 | 是，5 步 |
| `man` | 需求对齐、计划及可选完整治理 | 是，9 步 |
| `manteam` | 带 owner、participant、scope 和 claim 的团队治理 | 是，9 步 |
| `manps` | 确定性项目健康扫描 | 否 |

平台入口分别表现为 `/man`、`$man` 或 prompt，具体映射见 [platform-adapters.md](./platform-adapters.md)。

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
```

用 `mancode workflow show <TaskRef> --json` 获取最新 revision，不要手工编辑 metadata 或 ledger。

## Policy 2 与需求重新对齐

项目治理升级是显式操作，不会批量重写已有 workflow：

```bash
mancode project upgrade --policy 2 --dry-run
mancode project upgrade --policy 2 --operation-id <OPERATION_ID> --session <SESSION_ID> --client <CLIENT>
```

升级后的项目只对新建 `/man` workflow 默认使用 planning Policy 2；历史 workflow 继续使用创建时记录的 policy。

当新证据推翻已确认需求时，local workflow 可以从现有 checkpoint 执行原子 reframe：

```bash
mancode workflow reframe local:<ULID> \
  --expected-revision N --checkpoint-id <ULID> --session <SESSION_ID>
```

reframe 会归档当前 requirements、plan 和 ledger，释放有效 claim，并把任务带回需求对齐步骤。它只接受 requirements 已确认、且不存在 active child、open handoff 或 active solo assignment 的 local workflow；git-ref transport 明确拒绝该操作。

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

只有经过明确确认且通过隐私筛查的决策才能进入 shared memory。任务文本、绝对路径、凭据和宿主 session key 不应写入共享 transport。
