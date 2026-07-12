# 12 - Harness 生命周期

mancode 的运行时生命周期：跨平台 hook、上下文注入、状态管理与团队检测。

---

## 1. 生命周期概览

```text
用户执行 mancode init
  ↓
Node CLI 检测项目 profile
  ↓
Git 可用 → 读取团队活动
Git 不可用 → 使用 solo 默认值，不阻止初始化
  ↓
创建 .mancode/state.json 与平台适配文件
  ↓
Claude Code 启动
  ↓
node .mancode/hooks/session-start.mjs
  ↓ 注入模式与项目上下文
用户提交 prompt
  ↓
node .mancode/hooks/user-prompt-submit.mjs
  ↓ 注入 solo 六问、自动路由与条件审美 token
Claude 处理请求
```

当前两个 runtime hook 都是 Node `.mjs` 脚本。它们不依赖 Bash、jq、grep、
sed 或 Git，因此可以从 macOS、Linux、Windows CMD、PowerShell 与 Git Bash
运行。

---

## 2. Hook 详细说明

### 2.1 SessionStart Hook

**位置**：`.mancode/hooks/session-start.mjs`

**触发时机**：Claude Code 启动会话并加载项目。

**职责**：

1. 从 hook 文件位置计算项目根目录，不依赖当前 shell 或 Git。
2. 读取 `.mancode/state.json` 与 `.mancode/project-profile.json`。
3. 注入当前模式、技术栈、UI 能力和最小改动原则。
4. 已检测到团队且仍处于 solo 时，提示按需使用 `/manteam`。
5. 状态不存在或 JSON 无法读取时安全退出，不抛出未处理异常。

动态值会移除换行并限制为 200 个字符，避免项目状态污染 prompt 结构。

### 2.2 UserPromptSubmit Hook

**位置**：`.mancode/hooks/user-prompt-submit.mjs`

**触发时机**：用户提交 prompt 后、Claude 开始处理前。

**职责**：

1. 在 solo 模式下注入六个动手前问题。
2. 从 stdin 读取 Claude Code 提供的 JSON，并提取原始 prompt。
3. 识别规划或调研请求，提示路由到 `man` skill。
4. 只有项目 profile 确认存在 UI 资产且 prompt 涉及 UI 时，才注入审美摘要。
5. 对颜色、字体、组件和 CSS variable 设置数量与字符上限。

Node 直接解析 JSON。不存在 jq fallback，也不会调用任何外部进程。

### 2.3 PostToolUse Hook（计划中，尚未实现）

未来如果实现 PostToolUse，必须继续满足同一跨平台约束：

- 使用 Node 脚本，不调用 Bash 或 POSIX 管道。
- 默认 opt-in，只处理本次修改的项目内文本文件。
- 不格式化整仓，不修改未触达文件。
- 子进程使用 `execFile` / `spawn` 参数数组，不拼接 shell 字符串。
- 单次执行设置超时；超时提示但不无限阻塞编辑流程。
- lint/typecheck 的失败必须保留真实退出状态。

---

## 3. 团队检测

团队检测发生在 CLI 初始化和状态查询阶段，不在 hook 内执行。

判定为团队需要同时满足：

1. Git 历史贡献者超过 1 人。
2. 存在 GitHub、GitLab 或 Bitbucket remote。
3. 最近 30 天活跃贡献者超过 1 人。

实现通过 Node `execFile('git', args)` 直接调用 Git，并在 Node 中拆分、去重邮箱；
不使用 `/bin/bash`、`sort`、`grep`、重定向或管道。以下情况统一安全降级：

- Git 未安装或不在 PATH。
- 项目来自 ZIP，没有 `.git`。
- Git 历史为空或命令执行失败。
- 当前目录不是独立仓库根目录。

降级结果为 `isTeam: false`、`contributors: 1`、`recentActive: 1`，不会阻止
`mancode init`。用户仍可通过 `--team` 或 `--no-team` 明确覆盖。

---

## 4. `.mancode/state.json`

```json
{
  "version": "0.3.3",
  "currentMode": "solo",
  "lastMode": "solo",
  "platform": "claude-code",
  "initializedAt": "2026-07-11T10:30:00.000Z",
  "techStack": "JavaScript/TypeScript + React",
  "uiLibrary": "Tailwind CSS",
  "currentTask": null,
  "currentWorkflowMode": null,
  "skippedSteps": [],
  "teamModeAutoDetected": false,
  "contributors": 1
}
```

| 字段 | 说明 |
|---|---|
| `currentMode` / `lastMode` | 当前和上一次工作流模式 |
| `platform` | 初始化时选择的默认适配器 |
| `techStack` / `uiLibrary` | 从 project profile 得到的摘要 |
| `currentTask` / `currentWorkflowMode` | 当前持久化工作流信息 |
| `skippedSteps` | 用户明确跳过的工作流步骤 |
| `teamModeAutoDetected` | 自动检测或显式配置后的团队状态 |
| `contributors` | 检测到的贡献者数量；降级时为 1 |

CLI 负责写入 state；hooks 只读，不在会话启动或 prompt 提交时修改磁盘状态。

---

## 5. Claude Code 集成

### 5.1 settings.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \".mancode/hooks/session-start.mjs\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \".mancode/hooks/user-prompt-submit.mjs\""
          }
        ]
      }
    ]
  }
}
```

命令只使用 `node` 和带引号的相对路径，在 CMD、PowerShell、Git Bash 与 POSIX
shell 中语义一致。

### 5.2 旧版本迁移

`mancode init --force` 或 `mancode install claude-code --force` 会：

1. 识别并移除 mancode 生成的旧命令：
   `bash .mancode/hooks/session-start.sh` 与
   `bash .mancode/hooks/user-prompt-submit.sh`。
2. 注册新的 Node hook 命令。
3. 删除两个旧 `.sh` 文件并生成 `.mjs` 文件。
4. 保留无法精确识别为 mancode 生成内容的用户 hook。

卸载同样同时识别新旧 mancode hook，不会删除无关用户命令。

---

## 6. 验证矩阵

本地测试覆盖：

- Git 存在与 PATH 中没有 Git。
- 非 Git manifest 项目正常初始化。
- 团队检测的单人、多人、remote 与近期活跃组合。
- Node hooks 的上下文输出、自动路由、token cap 与不可信 token 清洗。
- 旧 Bash hook 设置迁移、新 hook 状态检查与卸载。

Windows CI 会在同一个 `windows-latest` runner 上分别从 CMD、PowerShell 和 Git
Bash 执行 smoke test。测试清空子进程 PATH 来模拟 Git/Bash 不可用，验证 Codex
初始化、solo 降级、Claude Code 初始化和两个 Node hooks 均能完成。

---

## 7. 实施状态

| 阶段 | 内容 |
|---|---|
| MVP-1 | SessionStart、UserPromptSubmit、state.json |
| MVP-2 | 多模式切换；PostToolUse 仍为计划项 |
| MVP-3 | Claude Code、Cursor、Codex、Copilot、ZCode 适配 |
| Windows native | Node hooks、无 shell 团队检测、Git 可选、三 shell smoke |
