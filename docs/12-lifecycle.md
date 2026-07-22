# Continuity 生命周期

本文描述默认 Continuity 路径。旧 `state.json` 生命周期仅用于显式 `--legacy` 兼容。

## 初始化

```text
mancode init
  → 检查项目与 legacy/Continuity 物理布局
  → 检测 Project Profile
  → 创建 schema.json，状态 initializing
  → 写 shared/local/runtime 基础权威
  → 安装所选平台 bootstrap
  → 校验 adapter 与 runtime binding
  → 最后切换为 v3_active
```

已有 legacy authority 时，普通初始化会拒绝覆盖。使用 `mancode migrate context --dry-run` 检查，再通过 stage、resolve 和显式 activation 迁移。

## 会话与任务

```text
宿主或用户创建 session
  → workflow create 生成 TaskRef 与四个治理实体
  → context resume 绑定当前 session
  → context show 解析一致的 Context Pack
  → mutation 使用 expected revision 执行
```

session 是本地便利状态。关闭一个 session 不会关闭任务，也不会影响其他 session。宿主 identity key 只保存不可逆 lookup hash；显式 session 不保存原始宿主 key。

## 写入与恢复

简单单实体 cache 写入可以原子替换。影响任务语义、claim、handoff、迁移或 transport 的写入必须经过 operation journal。

发现 `operation_pending`、reservation、task-head fence 漂移或未完成 git-ref receipt 时：

- read-only 命令返回可证明的一致子集和 repair 信息。
- 普通 mutation 被拒绝。
- `context doctor`、`operation repair` 或 transport recovery 继续原 operation。
- 只有尚未产生可见业务写时才允许 abort。

## 完成与保留

完成门禁读取整个 Task Aggregate。requirements、plan、review、verification、子任务、claim 与 repair 状态必须同时满足策略。

`mancode context compact` 先列出候选，再删除符合 retention policy 的本地 cache、终态 workflow 产物或 repair journal。active task、milestone、被引用 checkpoint 和未完成 operation 不会被静默删除；shared 删除需要显式确认。

## 团队与跨 clone

本地 transport 在同一 Git common directory 内共享协调权威。git-ref transport 只在显式 pull/push 后更新，并通过 remote revision 与 ownership fence 做 CAS。

业务 Git 内容、分支和 worktree 不由 mancode 自动同步。跨 clone handoff 的接收者必须同时取得对应代码基线。

## 发布证据

`context session spike` 记录真实宿主的窗口隔离、子命令传播、子 agent 继承和 hook approval，但不保存原始宿主 session key 或显式 session ID。证据模式为 `host` 或 `explicit`：前者通过后可授权受信宿主身份，后者只证明两个已存在、active、client 匹配的显式 session 隔离，不改变运行时的 `explicit_required` 策略。内部 `context beta` 接受与平台能力匹配的任一路径，并要求所有证据绑定同一个 immutable release candidate。

`npm run release:check -- --candidate <完整提交 SHA>` 从最终 `origin/main` 候选创建干净
checkout，运行完整自动化、真实双 clone/legacy fixture、audit、pack 与 tarball 安装
smoke，并把报告和候选 tarball 保存在 `.mancode/local/release-evidence/`。候选必须同时
等于本地 HEAD 和 `origin/main`，检查期间 main 不得变化。该命令不会执行 `npm publish`
或修改 dist-tag。

尚未完成的验收见 [release-acceptance.md](./release-acceptance.md)。
