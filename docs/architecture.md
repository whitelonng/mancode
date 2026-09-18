# Continuity 架构

mancode Continuity（跨会话与团队协作运行时）把跨会话任务状态、治理证据和团队协调放在显式、可校验的本地权威中。平台适配器只负责入口与 bootstrap，不保存任务副本。内部 layout/schema version 仍为 3；它是存储兼容版本，不是产品名称。

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
├── schema.json                    # Continuity 激活状态和兼容门禁
├── shared/
│   ├── config.json                # 项目策略与 transport 配置
│   ├── context/project.json       # 可共享项目事实
│   ├── context/glossary.json      # 用户确认的项目术语表
│   ├── context/privacy-policy.json # 显式激活的增强隐私策略
│   ├── context/privacy-exclusions.json # 不可重新导出的历史实体摘要
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

旧架构的 `state.json`、`config.json`、`project-profile.json`、`workflows/` 和 `memory/` 与 Continuity 目录物理隔离。普通 `mancode init` 创建 Continuity 布局；只有显式 `--legacy` 才创建旧布局。

`local/` 是 checkout-local 草稿区，但它下面出现 sessions/workflows/cache/quarantine/publish/runtime 任一子目录即视为 Continuity 业务内容。`.mancode` 只有权威内容（schema.json/shared/runtime 或上述 local 子目录）时初始化拒绝覆盖；只含其他工具的草稿时，初始化在命令层把它移开、成功后再归位（见 [12-lifecycle.md](12-lifecycle.md#初始化)）。发布门禁证据（release-check 输出）不属于 Continuity 草稿区，存于 `.release/`。

## 一致性与恢复

所有跨实体业务写入都使用 durable operation：

1. 写入带预期 revision 的 operation journal。
2. 获取本地锁并校验 session、Task Aggregate、checkout binding 和 coordination freshness。
3. 为受影响实体写 reservation 或 `operation_pending` 状态。
4. 按 operation definition 幂等应用步骤。
5. 最后发布稳定 metadata，并清理 reservation。

进程中断后，普通 writer 不会把新旧实体拼成稳定结果。`mancode context doctor` 和 `mancode operation` 根据 journal 继续 repair；只有能证明没有可见业务写时才允许 abort。

## 索引投影

`context-index.ts` 从相同权威构造有界引用和版本化正文读取，新增 `context-index-v1` 输出，与既有 Context Pack V2 并存。索引不是权威，也不保存阅读即批准的账本。候选集合快照绑定工作区/checkout、查询、成员版本、关联及隐私状态；未提交计划内容同样参与新鲜度检查。默认覆盖显式任务与决定关系，未知依赖保留缺口。

`decision-record.ts` 解析不可变决定的适用条款和替代/撤销投影。有效性与可见性分别计算，隐私排除后继不能让旧约束复活。V1 记录仍可读取且不虚构适用关系；显式选择 V2 写入会要求支持决定关系的读写端，不能把新格式误称为对旧 V1 解析器透明兼容。

## 版本与兼容

`schema.json` 支持 manifest version 1、2 和 3，layout version 固定为 3。新初始化项目默认写入 V2；首次显式选择增强共享隐私时写入 V3。历史 V1 项目完成显式 Policy 2 upgrade 后写入 V2；V1/V2 项目也可通过独立隐私事务升级为 V3。激活状态包括 `initializing`、`dual_read`、`activating`、`v3_active` 和 `repair_required`。

V3 manifest 的 `privacyPolicy` 保存 revision/digest 引用，实际策略与永久历史排除表位于 `shared/context`，读取时必须完整校验绑定。`workflowPolicyDefaults.planning` 独立保留为 1 或 2：启用隐私不隐式升级 planning policy，关闭隐私不降级 manifest、不删除排除表。V3 要求 reader/writer 至少为 0.6.5。

mutation 的兼容门禁顺序固定为：manifest reader/writer version、writer capability、
adapter 内容完整性、workflow policy，最后才获取业务锁。任一门禁失败都不得创建 journal
或写入业务权威；未知 policy 不能降级为已知旧版本。

Reader 和 writer 必须先通过兼容门禁。legacy 迁移采用隔离 stage、显式确认和 journaled activation；不能把当前 Git HEAD 或当前用户伪装成历史事实。

## Transport

默认 `local` transport 在同一 Git common directory 内协调。可选 `git-ref` transport 使用 `refs/mancode/team` 在不同 clone 间显式同步：

```bash
mancode team sync pull
mancode team sync push shared:<ULID> --expected-task-revision N --session <ID>
```

其中 workflow create、requirements、plan、review 和 verification mutation 不会在一条命令中
同时提交业务代码与远程权威，因此使用显式延后发布边界：不带 `--sync`
运行 mutation，将 `.mancode/shared` 与匹配的代码基线一起提交，再运行上述
`team sync push`。直接传入 `--sync` 会稳定返回
`MANCODE_GIT_REF_DEFERRED_SYNC_REQUIRED`，防止未发布的本地成功被误报为跨 clone 成功。

明确要求 `--sync` 的原子 git-ref mutation 会在一次 CAS 中更新远端 bundle/fence，随后
materialize 本地投影。若仍可 resume 的 `in_progress` 或 `blocked` 任务留下 tracked
`.mancode/shared` 变更，owner 提交该投影后必须用不变的 task revision 再执行
`team sync push`。这个受限的 same-revision 操作只能把 code head 快进重绑到新提交；
task revision、aggregate digest、owner 和 ownership epoch 都不得变化。另一 clone 应在
该 receipt 到达后同步 Git、pull transport 并 resume。

远端不会自动同步业务代码。bundle、ownership fence 和 remote revision 只协调 mancode 权威；调用者仍需自行同步 Git 分支。

显式隐私升级使 git-ref manifest 使用格式 2，并携带完整策略/排除表快照。事务先 CAS 远端，再按 journal 提交本地 manifest 和策略文件。旧 clone 的策略引用不匹配时拒绝写入，必须先接收已提交的共享权威文件再 pull；旧缓存不能替代当前策略。敏感 actor/claim/handoff 历史不原地修改，dry-run 返回保留基础保护或明确建立新 workspace 的处理路径；活跃 bundle 的敏感 checkpoint 必须先用安全 checkpoint 替换并同步。

## 隐私模块边界

`src/privacy/` 提供有界 TypeScript 文本检测、校验及不可逆副本脱敏；输出只含规则、类别和偏移元数据。旧 `src/context/privacy.ts` 的持久化解析规则独立保留，避免新增检测改变旧实体摘要或解析语义。`src/context/privacy-policy*` 管理版本化共享策略、历史排除和恢复事务，写入、Context Pack、git-ref materialization及恢复分别在对应边界执行检查。

模型代理网关已退役；CLI 不再转发模型请求。共享扫描和策略仍保留，见[退役指南](privacy-gateway-retirement.md)。

### 可选执行证据

verification policy 2 只由新建本地 `man --delivery --execution-policy` 显式启用，使用 `VerificationLedgerV2.execution` 保存策略、run、attempt、decision 和 CI observation。V1 保持严格 schema 与原语义；旧 writer 必须在 journal 前拒绝新 policy/capability。V2 自动证据只通过语义 mutation 登记，不开放整表 apply。

执行使用 `reserve → start → finish` 的短事务和已有 `verification_record` journal。独立 supervisor 在启动真实命令前等待 start 提交，持有有限时间/输出预算，并将身份与结果写入私有本地 receipt。Windows 首版在 spawn 前明确拒绝执行，POSIX 保证限于原进程组。CLI 崩溃后 recover 读取 receipt，不能把有副作用的执行放进 journal 自动重放。账本保存摘要与适用性；本地 receipt 不是第二套任务权威。

完成门用新鲜 checkout subject 和 candidate SHA 计算场景 TDD、当前检查、未结束运行及精确 CI 缺口。历史 Red 不覆盖最终检查；预算达到上限只限制新增执行，合法最后一次成功不会被永久阻塞。例外/追加是保留历史的决定，不能重置计数或自动完成。原受管 handoff 继承门禁，报告式 manba 审核不创建任务或执行账本。
