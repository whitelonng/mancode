# 平台适配器

平台适配器把相同的 Continuity workflow 暴露给不同宿主。它们安装 bootstrap 和 mode 入口，但任务、session、review 与 verification 只存于 `.mancode/`。

## 能力矩阵

| 平台 | 入口与文件 | 动态能力 | 当前边界 |
|---|---|---|---|
| Claude Code | `CLAUDE.md` 托管区、`.claude/skills/` | 项目 memory 与 mode skills；legacy 模式可用 hooks | 默认 Continuity 不依赖旧 `state.json` hooks |
| Cursor | `.cursor/rules/`、`.cursor/commands/` | rules 与 commands | 无 mancode 原生 session API |
| Codex | `AGENTS.md` 托管区、`.agents/skills/` | `$man*` skills | session 传播需真实宿主证据 |
| GitHub Copilot | instruction 托管区、`.github/prompts/` | instructions 与 prompts | 能力依具体 Copilot 宿主而异 |
| ZCode | `AGENTS.md` 托管区、`.agents/skills/` | provisional `$man*` skills | 项目级发现与命令路径仍需真实 UI 验证 |
| Kimi Code | `AGENTS.md` 托管区、`.agents/skills/` | provisional `/skill:man*` skills（桌面端/CLI 共用） | 项目级 skill 发现与命令路径仍需真实宿主验证 |
| Qoder | `AGENTS.md` 托管区、`.qoder/commands/` | provisional `/man*` commands（IDE/CLI 共用） | 命令发现与传播仍需真实宿主验证 |
| DeepSeek Harness | `AGENTS.md` 托管区、`.dsh/skills/` | provisional 用户显式 `/man*` skills 与原生 subagents | 官方文件发现契约已确认；GUI 发现、session 与 subagent 传播仍需真实宿主验证 |

安装示例：

```bash
mancode init --platform codex,cursor
mancode adapter upgrade --platform copilot --dry-run
mancode adapter upgrade --platform copilot --confirm --operation-id <operationId> --session <id> --client <client>
mancode status
```

manifest 的 `managedAdapters` key 是项目登记的 required 平台集合。greenfield init 只登记所选平台；后续新增或修复平台必须通过带 active session 和显式确认的 adapter upgrade journal。`AGENTS.md` 和 Copilot instruction 文件中托管区外的用户内容必须原样保留。

DeepSeek Harness 的 mode entry 只安装到 `.dsh/skills/`，不复用
`.agents/skills/`，以遵守 DSH 的目录优先级并避免不同宿主清理彼此的托管 skill。
每个入口都标记为仅用户调用；在 host session 传播得到真实证据前，Continuity mutation
继续要求显式 `--session`，不会把环境中的 `DSH_SESSION_ID` 自动升级为可信身份。

## 内容完整性与升级

`adapter status` 每次都从当前 renderer 重建 expected managed bytes，并与磁盘上的
actual managed bytes 比较。整文件 target 比较完整内容；嵌入式 target 只比较 mancode
托管区。磁盘内容不先规范化换行，因此 CRLF 漂移、截断和手工编辑都能被识别。

每个 required target 的状态为 `ready`、`missing`、`stale` 或 `unreadable`。只有全部
required target 都是 `ready`，依赖 adapter 的 mutation 才能继续。manifest 只记录
renderer/schema version 和 required inventory；content digest 是可重建结果，不能成为
新的 manifest authority。

adapter upgrade 先在 staging 中生成预览，用户确认后再通过 journaled operation 发布。
中断必须由原 operation repair；升级不能修改 workflow policy、requirements、plan 或 step。

## Bootstrap 合约

每个平台都必须：

- 能发现原来的 `man`、`manba`、`manteam`、`manps` 和 `mansolo` 入口。
- 在开始任务前解析 Continuity manifest、session、TaskRef 和 Context Pack。
- 不保存易过期的 task/session 状态副本。
- 未证明宿主 session 传播时要求显式 session。
- 保留用户自写配置，并支持重复安装和安全卸载。

## Legacy hooks

初始化生成的 `AGENTS.md` / `CLAUDE.md` 现在包含限定于新 `/man` 模块交付策略的文档交接和执行效率规则。项目计划目录优先沿用明确约定，默认 `doc/`；不强制其他模式建计划、审核或提交。规则不保存任务状态，也不授权修改未批准的业务代码。

新 man 入口显式使用 `workflow create man --delivery`，引导一次模块总审、真实验证、文档回写和提交/发布分离。`manba`、`manteam`、`manps`、`mansolo` 的入口流程不变。详细数据格式与限制见 [新 man 模块交付](./workflows.md#新-man一次模块审核与文档交付)。仅更新源码不会改写已安装文件；现有项目仍走上文的 adapter upgrade 预览和确认流程。

只有 `mancode init --legacy` 安装读取 `.mancode/state.json` 的旧 Claude Code hooks。Continuity adapter 不应创建、读取或刷新 legacy authority。

Continuity 的 Claude Code bootstrap 位于根目录 `CLAUDE.md` 的 `mancode:continuity:claude` 托管区，确保普通 Solo 请求也会加载；原有 mode skills 仍位于 `.claude/skills/`。Cursor bootstrap 位于 `.cursor/rules/mancode-continuity.mdc`，其他嵌入式托管区同样使用 `mancode:continuity:*` 标记。升级时只自动移除带 mancode 旧管理标记的 `mancode-v3`/旧 Continuity bootstrap 或托管区；用户在 `CLAUDE.md` 和同名旧文件中的自写内容会保留。

固定适配器目标若是符号链接：解析到仓库内常规文件时（`CLAUDE.md -> AGENTS.md` 约定），mancode 读写都穿透到解析目标，链接保持不变——交互式 init 提供「保留链接穿透 / 替换为普通文件 / 退出」三选一，非交互调用直接穿透。解析目标落在 AGENTS.md 时该平台并入共享 `agents` 组合（多平台一次写入、块共存）；落在其他文件时写入计划把解析目标记入 journal，发布与恢复时校验链接仍指向原目标，漂移即 `MANCODE_V3_ADAPTER_TARGET_CONFLICT`。解析到仓库外、断链或非普通文件的链接一律拒绝。

Windows 上的脚本与文件替换不能依赖 Bash、jq 或 Unix rename 行为。发布流程包含 CMD、PowerShell 和 Git Bash smoke test。

## Session 发布证据

真实宿主证据必须显式选择 `--session-mode host` 或 `--session-mode explicit`。`host` 模式使用一次性宿主 key 比较双窗口，并且只有完整证明传播、继承和必要 hook approval 后才允许 `host_verified`。`explicit` 模式读取 `MANCODE_SPIKE_SESSION_ID` 与 `MANCODE_SPIKE_SECOND_SESSION_ID`，验证两个 session 已存在、active、互不相同且 client 与平台一致；写入证据前丢弃原始 ID。它可以得到 `explicit_session_verified` 发布证据，但运行时继续要求显式 `--session`。

```bash
MANCODE_SPIKE_SESSION_ID=<window-a-session> \
MANCODE_SPIKE_SECOND_SESSION_ID=<window-b-session> \
./node_modules/.bin/mancode context session spike \
  --platform cursor --session-mode explicit --host-session-source none \
  --command-propagation proven \
  --subagent-inheritance not_applicable \
  --subagent-inheritance-reason "Host has no child-agent API" \
  --host-version <version> --release-candidate <full-commit> --json
```

## 发布声明

“文件能生成”不等于“宿主已验证”。每个平台的双窗口 session、子命令传播和子 agent 继承必须在同一发布候选上记录，才能通过内部 Beta gate。ZCode、Kimi Code、Qoder 和 DeepSeek Harness 在完成该验证前保持 provisional 描述。
