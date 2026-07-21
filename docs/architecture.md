# V3 架构

mancode Continuity 把跨会话任务状态、治理证据和团队协调放在显式、可校验的本地权威中。平台适配器只负责入口与 bootstrap，不保存任务副本。

## 核心模型

一个任务由 `TaskRef` 标识：

```text
local:<ULID>
shared:<ULID>
```

`local` 任务只属于当前 checkout；`shared` 任务可以参与团队协调。可见性与协作方式是两个维度：`visibility=local|shared`，`coordination=single|team`。

任务的稳定视图是 Task Aggregate，由以下实体共同组成：

- `metadata.json`：生命周期、owner、revision、scope 和治理摘要。
- `requirements.json`：目标、范围、未知项和验收标准。
- `review-ledger.json`：审查领域、报告与 blocker。
- `verification-ledger.json`：自动或人工验证证据。
- checkpoint、claim、handoff 和 task-head fence：团队协调与恢复状态。

Markdown 计划和报告是人类可读产物。完成门禁以结构化实体及其 digest 为准。

## 目录与权威

```text
.mancode/
├── schema.json                    # V3 激活状态和兼容门禁
├── shared/
│   ├── config.json                # 项目策略与 transport 配置
│   ├── context/project.json       # 可共享项目事实
│   ├── workflows/                 # shared Task Aggregate
│   ├── team/                      # actor、claim、handoff、checkpoint
│   └── memory/decisions/          # 明确确认的共享决策
├── local/
│   ├── sessions/                  # checkout-local 会话
│   ├── workflows/                 # local Task Aggregate
│   ├── cache/                     # 可重建扫描与 transport 缓存
│   └── preseason-*                # 本地健康扫描产物
└── runtime/                       # operation journal、reservation、repair
```

旧架构的 `state.json`、`config.json`、`project-profile.json`、`workflows/` 和 `memory/` 与 V3 目录物理隔离。普通 `mancode init` 创建 V3；只有显式 `--legacy` 才创建旧布局。

## 一致性与恢复

所有跨实体业务写入都使用 durable operation：

1. 写入带预期 revision 的 operation journal。
2. 获取本地锁并校验 session、Task Aggregate、checkout binding 和 coordination freshness。
3. 为受影响实体写 reservation 或 `operation_pending` 状态。
4. 按 operation definition 幂等应用步骤。
5. 最后发布稳定 metadata，并清理 reservation。

进程中断后，普通 writer 不会把新旧实体拼成稳定结果。`mancode context doctor` 和 `mancode operation` 根据 journal 继续 repair；只有能证明没有可见业务写时才允许 abort。

## 版本与兼容

`schema.json` 支持 manifest version 1 和 2，layout version 固定为 3。0.4.0 新初始化项目直接写入 V2；历史 V1 项目只有完成显式 Policy 2 upgrade 后才写入 V2。激活状态包括 `initializing`、`dual_read`、`activating`、`v3_active` 和 `repair_required`。

Reader 和 writer 必须先通过兼容门禁。legacy 迁移采用隔离 stage、显式确认和 journaled activation；不能把当前 Git HEAD 或当前用户伪装成历史事实。

## Transport

默认 `local` transport 在同一 Git common directory 内协调。可选 `git-ref` transport 使用 `refs/mancode/team` 在不同 clone 间显式同步：

```bash
mancode team sync pull
mancode team sync push shared:<ULID> --expected-task-revision N --session <ID>
```

远端不会自动同步业务代码。bundle、ownership fence 和 remote revision 只协调 mancode 权威；调用者仍需自行同步 Git 分支。
