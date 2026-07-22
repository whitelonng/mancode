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

安装示例：

```bash
mancode init --platform codex,cursor
mancode adapter upgrade --platform copilot --dry-run
mancode adapter upgrade --platform copilot --confirm --operation-id <operationId> --session <id> --client <client>
mancode status
```

manifest 的 `managedAdapters` key 是项目登记的 required 平台集合。greenfield init 只登记所选平台；后续新增或修复平台必须通过带 active session 和显式确认的 adapter upgrade journal。`AGENTS.md` 和 Copilot instruction 文件中托管区外的用户内容必须原样保留。

## Bootstrap 合约

每个平台都必须：

- 能发现原来的 `man`、`manba`、`manteam`、`manps` 和 `mansolo` 入口。
- 在开始任务前解析 Continuity manifest、session、TaskRef 和 Context Pack。
- 不保存易过期的 task/session 状态副本。
- 未证明宿主 session 传播时要求显式 session。
- 保留用户自写配置，并支持重复安装和安全卸载。

## Legacy hooks

只有 `mancode init --legacy` 安装读取 `.mancode/state.json` 的旧 Claude Code hooks。Continuity adapter 不应创建、读取或刷新 legacy authority。

Continuity 的 Claude Code bootstrap 位于根目录 `CLAUDE.md` 的 `mancode:continuity:claude` 托管区，确保普通 Solo 请求也会加载；原有 mode skills 仍位于 `.claude/skills/`。Cursor bootstrap 位于 `.cursor/rules/mancode-continuity.mdc`，其他嵌入式托管区同样使用 `mancode:continuity:*` 标记。升级时只自动移除带 mancode 旧管理标记的 `mancode-v3`/旧 Continuity bootstrap 或托管区；用户在 `CLAUDE.md` 和同名旧文件中的自写内容会保留。

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

“文件能生成”不等于“宿主已验证”。每个平台的双窗口 session、子命令传播和子 agent 继承必须在同一发布候选上记录，才能通过内部 Beta gate。ZCode 在完成该验证前保持 provisional 描述。
