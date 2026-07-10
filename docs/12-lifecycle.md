# 12 - Harness 生命周期

mancode 的运行时生命周期：hook 触发、上下文注入、状态管理。

---

## 1. 生命周期概览

```
用户启动 Claude Code
  ↓
[SessionStart Hook 触发]
  ↓ 读取 .mancode/state.json
  ↓ 检测项目状态
  ↓ 选择模式（solo / team）
  ↓ 注入系统 prompt
  ↓
用户输入 prompt
  ↓
[UserPromptSubmit Hook 触发]
  ↓ 提醒 6 个问题（solo 模式）
  ↓ 读取项目 profile；仅在 UI 资产已检测且任务涉及 UI 时读取审美 token
  ↓
Claude 处理请求
  ↓
[PostToolUse Hook 触发]（计划中，尚未实现）
  ↓ 格式化代码
  ↓ 运行 linter
  ↓
用户关闭 Claude Code
  ↓
[SessionEnd Hook 触发]（可选）
  ↓ 更新 state.json
  ↓ 记录统计
```

---

## 2. Hook 详细说明

### 2.1 SessionStart Hook

**触发时机**：Claude Code 启动会话，加载项目

**位置**：`.mancode/hooks/session-start.sh`

**职责**：
1. 检测项目是否已初始化 mancode（检查 `.mancode/state.json`）
2. 读取项目状态和项目 profile（mode、团队、源码目录与可用能力）
3. 检测多人协作（git contributors + recent activity）
4. 选择默认模式（solo / team）
5. 生成系统 prompt 注入

**输出格式**：
```bash
#!/bin/bash
# 输出到 stdout，Claude Code 自动注入到系统 prompt

echo "mancode_mode: solo"
echo "project_type: <detected project profile>"
echo "ui_library: <detected UI library or none>"
echo "team_mode: false"
echo ""
echo "## mancode · solo mode"
echo ""
echo "你正在使用 mancode solo 模式。"
echo ""
echo "### 核心原则"
echo "1. 优先复用项目已有代码"
echo "2. 按项目 profile 使用已检测到的能力"
echo "3. 最小改动"
```

**实现**（借鉴 Ponytail 的 hook 注入思路）：

```bash
#!/bin/bash
# 注意：hook 脚本不要用 `set -e` + 全局 `trap ... ERR`。
# 原因：探测型 pipeline（git remote | grep ...）在无匹配时会触发 ERR，
# 整个脚本被退出，后续探测无法继续。改用：
#   - `set -uo pipefail`：仅保护未定义变量和 pipeline 中段失败
#   - 显式 `|| true`：容忍单个探测命令的失败
#   - 默认值用 `${var:-fallback}`
set -uo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
STATE_FILE="$PROJECT_ROOT/.mancode/state.json"

# jq fallback
HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

json_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\"$key\"" "$file" 2>/dev/null | sed 's/.*: "\(.*\)".*/\1/' || true
    fi
}

# 检查是否已初始化
if [ ! -f "$STATE_FILE" ]; then
    echo "ℹ️ mancode 未初始化。运行 \`mancode init\` 开始。"
    exit 0
fi

# 读取状态
MODE=$(json_get "currentMode" "$STATE_FILE")
TECH_STACK=$(json_get "techStack" "$STATE_FILE")
UI_LIBRARY=$(json_get "uiLibrary" "$STATE_FILE")

# 检测多人协作 —— 探测型命令一律 || true，避免污染后续逻辑
contributors=$(git shortlog -sn --all 2>/dev/null | wc -l | xargs || echo 0)
has_remote=$( { git remote -v 2>/dev/null || true; } | grep -E "github\.com|gitlab\.com|bitbucket\.org" | wc -l | xargs || echo 0)
recent_active=$(git shortlog -sn --since='30 days ago' 2>/dev/null | wc -l | xargs || echo 0)

# 兜底：确保三个变量是数字（避免 `integer expression expected`）
contributors="${contributors//[!0-9]/}"
has_remote="${has_remote//[!0-9]/}"
recent_active="${recent_active//[!0-9]/}"
contributors="${contributors:-0}"
has_remote="${has_remote:-0}"
recent_active="${recent_active:-0}"

TEAM_MODE_AUTO="false"
if [ "$contributors" -gt 1 ] && [ "$has_remote" -gt 0 ] && [ "$recent_active" -gt 1 ]; then
    TEAM_MODE_AUTO="true"
fi

# 输出元数据
echo "mancode_mode: ${MODE:-solo}"
echo "project_type: $TECH_STACK"
echo "ui_library: $UI_LIBRARY"
echo "team_mode_auto: $TEAM_MODE_AUTO"
echo ""

# 注入系统 prompt
if [ "$TEAM_MODE_AUTO" = "true" ]; then
    echo "## mancode · team mode detected"
    echo ""
    echo "检测到多人协作项目（$contributors 个贡献者，最近 30 天有 $recent_active 人活跃）。"
    echo ""
    echo "建议使用 \`/manteam\` 模式以启用团队记忆和协调功能。"
    echo ""
fi

echo "## mancode · ${MODE:-solo} mode"
echo ""
echo "你正在使用 mancode ${MODE:-solo} 模式。"
echo ""
echo "### 核心原则"
echo "1. **优先复用项目已有代码**"
echo "   - 检查 profile 中已检测到的源码目录是否已有类似实现"
echo "   - 复用现有组件、函数、样式"
echo ""
echo "2. **按项目能力工作**"
echo "   - 不假定特定语言、UI 或浏览器存在"
echo "   - 仅在 UI 资产已检测且任务涉及 UI 时使用设计 token"
echo ""
echo "3. **最小改动**"
echo "   - 只改用户要求的部分"
echo "   - 不重构无关代码"
```

---

### 2.2 UserPromptSubmit Hook

**触发时机**：用户提交 prompt 后、Claude 开始处理前

**位置**：`.mancode/hooks/user-prompt-submit.sh`

**职责**：
1. 在 solo 模式下提醒 6 个问题
2. 读取项目 profile；仅在 UI 资产已检测且任务涉及 UI 时读取审美 token
3. 提醒 YAGNI 原则

**输出格式**：
```bash
echo "## 动手前，先想六个问题："
echo ""
echo "1. **为什么做？**"
echo "   - 这个改动解决什么问题？"
echo ""
echo "2. **已经有什么？**"
echo "   - 项目里有没有类似的实现可以复用？"
echo ""
echo "3. **最少改多少？**"
echo "   - 能用一行解决吗？能复用现有代码吗？"
```

**实现**（借鉴 grill-me 的追问思路）：

```bash
#!/bin/bash
# 同 session-start：避免 `set -e` + 全局 ERR trap，用 `set -uo pipefail` + 显式 || true
set -uo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
STATE_FILE="$PROJECT_ROOT/.mancode/state.json"

HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

json_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\"$key\"" "$file" 2>/dev/null | sed 's/.*: "\(.*\)".*/\1/' || true
    fi
}

# 读取模式
MODE=$(json_get "currentMode" "$STATE_FILE")

# solo 模式：提醒 6 个问题
if [ "$MODE" = "solo" ] || [ -z "$MODE" ]; then
    echo "## 动手前，先想六个问题："
    echo ""
    echo "1. **为什么做？**"
    echo "   - 这个改动解决什么问题？"
    echo ""
    echo "2. **已经有什么？**"
    echo "   - 项目里有没有类似的实现可以复用？"
    echo ""
    echo "3. **最少改多少？**"
    echo "   - 能用一行解决吗？能复用现有代码吗？"
    echo ""
fi

# 先读 project-profile；仅当 UI 资产已检测且任务涉及 UI 才注入 token。
USER_PROMPT="$1"
if [ "$(json_get \"uiAssets\" \"$PROJECT_ROOT/.mancode/project-profile.json\")" = "detected" ] && echo "$USER_PROMPT" | grep -qiE "button|component|page|style|ui|design|layout|css"; then
    AESTHETICS_FILE="$PROJECT_ROOT/.mancode/aesthetics/style-tokens.json"
    if [ -f "$AESTHETICS_FILE" ]; then
        echo "## 审美 token 已加载"
        echo ""
        echo "使用项目已有的设计 token（颜色、字体、组件）。"
        echo ""
        # 可选：注入具体 token
        # cat "$AESTHETICS_FILE"
    fi
fi
```

---

### 2.3 PostToolUse Hook（计划中，尚未实现）

> **注意**：此 hook 尚未在 installer 中注册。以下为设计文档，供未来实现参考。

**触发时机**：Claude 使用工具（Edit / Write）后

**位置**：`.mancode/hooks/post-tool-use.sh`

**P0 设计决策**：

1. **默认启用策略**：P1 MVP 先 opt-in，通过 `.mancode/config.json` 显式开启；确认误报和性能后再考虑默认启用。
2. **处理范围**：只处理本次 Edit / Write 命中的单个项目内文件；跳过 `.git/`、`.mancode/`、`node_modules/`、构建产物和非文本文件。
3. **format 行为**：formatter 可以改刚刚由 Agent 修改的文件，但不得格式化整仓或改未触达文件。
4. **lint / test 阻断**：format 失败只提示；lint / typecheck 失败返回非零并阻断“完成”声称；test 默认不在每次 PostToolUse 跑，交给 workflow 自测阶段。
5. **超时降级**：单次 hook 总时限 15 秒；超时后停止子进程并输出 warning，不阻塞用户继续编辑，但必须在最终验证里补跑。
6. **并发冲突**：hook 不做跨进程锁；只对当前文件运行幂等命令。涉及整仓读写、缓存或报告文件的操作必须放到后续显式命令里处理。

**实现边界**：P0 只记录上述决策；hook 模板、installer 注册和配置迁移留到 P1 实现。

**职责**：
1. 自动格式化代码（prettier / eslint --fix）
2. 运行 linter 检查
3. 类型检查（TypeScript）

**输出格式**：
```bash
echo "✓ 格式化代码"
echo "✓ Linter 通过"
echo "⚠️ 类型检查发现 2 个警告"
```

**实现**（概念示例 — P1 实现时须严格遵循上方 6 个 P0 决策）：

```bash
#!/bin/bash
# PostToolUse hook — CONCEPTUAL SKETCH, not production-ready.
# 实际 P1 实现必须覆盖全部 6 个 P0 决策，下方注释标出对应位置。

set -uo pipefail

MODIFIED_FILE="$1"
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"

# ── 决策 1: opt-in ──
# P0 决策要求先 opt-in，通过 .mancode/config.json 显式开启。
# 未开启时直接退出，不执行任何格式化或 lint。
CONFIG_FILE="$PROJECT_ROOT/.mancode/config.json"
if [ ! -f "$CONFIG_FILE" ] || ! grep -q '"postToolUse"[[:space:]]*:[[:space:]]*true' "$CONFIG_FILE" 2>/dev/null; then
    exit 0
fi

# ── 决策 2: 处理范围 ──
# 只处理本次 Edit/Write 命中的单个文件；跳过非项目内文件。
case "$MODIFIED_FILE" in
    .git/*|.mancode/*|node_modules/*|dist/*|build/*|coverage/*|*.min.js|*.map)
        exit 0 ;;
esac

# 真实实现应根据 project-profile 中的 manifest 与验证能力选择命令。
if [ ! -f ".mancode/project-profile.json" ]; then
    exit 0
fi

# ── 决策 3: format 行为 ──
# formatter 只改 Agent 刚修改的 $MODIFIED_FILE，不得格式化整仓。
if command -v prettier >/dev/null 2>&1; then
    # ── 决策 5: 超时降级 ──
    # 单步限时；超时后 warning 退出，不阻塞用户继续编辑。
    timeout 5 prettier --write "$MODIFIED_FILE" 2>&1 | grep -v "^$" || true
    echo "✓ 格式化代码"
fi

# ── 决策 4: lint 阻断 ──
# lint/typecheck 失败返回非零并阻断"完成"声称。
# ── 决策 6: 并发冲突 ──
# 只对当前文件运行幂等命令，不做跨进程锁。
if command -v eslint >/dev/null 2>&1; then
    # 直接捕获 eslint 退出码，不通过 grep 管道检查
    # （grep -v "^$" 对空输出返回 1，会在 lint 通过时误报失败）
    lint_output=$(timeout 10 eslint --fix "$MODIFIED_FILE" 2>&1)
    lint_exit=$?
    if [ "$lint_exit" -ne 0 ]; then
        echo "$lint_output" | grep -v "^$" || true
        echo "⚠️ Linter 检查失败，需修复后才能声称完成"
        exit 1
    fi
    echo "✓ Linter 检查"
fi
```

---

## 3. 上下文注入机制

### 3.1 注入层次

```
┌─────────────────────────────────────┐
│  User Prompt                        │
├─────────────────────────────────────┤
│  UserPromptSubmit Hook 注入         │  ← solo 六问、条件审美 token
├─────────────────────────────────────┤
│  System Prompt (SessionStart Hook) │  ← 模式、项目状态
├─────────────────────────────────────┤
│  SKILL.md (solo / mamba / man...)   │  ← 模式规则
├─────────────────────────────────────┤
│  Claude 基础能力                     │
└─────────────────────────────────────┘
```

### 3.2 注入优先级

| 优先级 | 来源 | 内容 | 可覆盖 |
|---|---|---|---|
| 1 | User Prompt | 用户的具体任务 | — |
| 2 | UserPromptSubmit Hook | 追问、审美提醒 | 可选 |
| 3 | SKILL.md | 模式规则 | ❌ 不可覆盖 |
| 4 | SessionStart Hook | 项目状态 | ❌ 不可覆盖 |

---

## 4. `.mancode/state.json` 结构

### 4.1 完整结构

```json
{
  "version": "0.1.0",
  "currentMode": "solo",
  "lastMode": "solo",
  "currentTask": null,
  "skippedSteps": [],
  "techStack": "<detected stack or Unknown>",
  "uiLibrary": "<detected UI library or None>",
  "packageManager": "npm",
  "buildTool": "vite",
  "linter": "eslint",
  "formatter": "prettier",
  "teamModeAutoDetected": false,
  "contributors": 1,
  "recentActivity": {
    "lastScan": "2026-06-27T10:30:00Z",
    "lastTask": "add logout button",
    "lastUpdated": "2026-06-27T10:30:00Z"
  },
  "aesthetics": {
    "scanned": true,
    "lastUpdate": "2026-06-27T10:30:00Z",
    "tokensFile": ".mancode/aesthetics/style-tokens.json"
  },
  "installedPlatforms": ["claude-code"]
}
```

### 4.2 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | mancode 版本 |
| `currentMode` | string | 当前模式（solo / mamba / man / manteam / manps）|
| `lastMode` | string | 上一次模式 |
| `currentTask` | string \| null | 当前任务（如在 /man 流程中）|
| `skippedSteps` | string[] | 跳过的步骤（/man 流程中用户选择跳过的步骤）|
| `techStack` | string | 检测到的技术栈摘要（未知时为 Unknown） |
| `uiLibrary` | string | 检测到的 UI 库；非 UI 项目为 None |
| `packageManager` | string | 包管理器（npm / yarn / pnpm） |
| `buildTool` | string | 构建工具（vite / webpack / next / none）|
| `linter` | string | Linter（eslint / none）|
| `formatter` | string | 格式化工具（prettier / none）|
| `teamModeAutoDetected` | boolean | 是否自动检测到多人协作 |
| `contributors` | number | 贡献者数量 |
| `recentActivity` | object | 最近活动记录 |
| `aesthetics` | object | 审美扫描状态 |
| `installedPlatforms` | array | 已安装平台 |

### 4.3 读写操作

**读取**（hook 脚本）：
```bash
# 用 jq（推荐）
MODE=$(jq -r '.currentMode' .mancode/state.json)

# 无 jq fallback（grep + sed）
MODE=$(grep '"currentMode"' .mancode/state.json | sed 's/.*: "\(.*\)".*/\1/')
```

**写入**（CLI）：
```typescript
import fs from 'fs-extra';

const statePath = path.join(projectRoot, '.mancode/state.json');
const state = await fs.readJson(statePath);
state.currentMode = 'mamba';
state.lastMode = 'solo';
state.recentActivity.lastUpdated = new Date().toISOString();
await fs.writeJson(statePath, state, { spaces: 2 });
```

---

## 5. 与 Claude Code 的集成流程

### 5.1 安装流程

```
用户执行：mancode init
  ↓
检测平台（Claude Code / Cursor / Codex）
  ↓
创建 .mancode/ 目录
  ↓
生成 state.json
  ↓
安装平台适配器
  ↓
  ├─ Claude Code: 
  │    ├─ 写入 .claude/settings.json (hooks配置)
  │    ├─ 写入 .claude/skills/solo/SKILL.md
  │    └─ 安装 hook 脚本到 .mancode/hooks/
  │
  ├─ Cursor:
  │    └─ 写入 .cursor/rules/mancode.mdc
  │
  └─ Codex:
       └─ 写入 AGENTS.md (受控区块)
  ↓
扫描项目
  ↓
生成 style-tokens.json（如有前端）
  ↓
完成
```

### 5.2 Claude Code settings.json 配置

```json
{
  "hooks": {
    "SessionStart": [
      {
        "command": "bash .mancode/hooks/session-start.sh"
      }
    ],
    "UserPromptSubmit": [
      {
        "command": "bash .mancode/hooks/user-prompt-submit.sh"
      }
    ]
  },
  "skills": {
    "solo": ".claude/skills/solo/SKILL.md"
  }
}
```

### 5.3 运行时集成

```
Claude Code 启动
```
Claude Code 启动
  ↓
读取 .claude/settings.json
  ↓
发现 hooks.SessionStart
  ↓
执行 .mancode/hooks/session-start.sh
  ↓ 输出系统 prompt
  ↓
Claude Code 注入到系统 prompt
  ↓
用户输入 prompt
  ↓
Claude Code 发现 hooks.UserPromptSubmit
  ↓
执行 .mancode/hooks/user-prompt-submit.sh
  ↓ 输出追问
  ↓
Claude 看到：
  - 系统 prompt（项目状态）
  - 追问（6 个问题）
  - 用户 prompt
  ↓
Claude 处理
```

---

## 6. 借鉴来源

本文档参考了以下项目的设计思路（仅用于内部开发参考，对外文档不提及）：

| 项目 | License | 借鉴内容 |
|---|---|---|
| **Ponytail** | MIT | Hook 注入机制、系统 prompt 生成方式 |
| **grill-me** | MIT | 追问模式的早期参考 |
| **Superpowers** | MIT | SessionStart hook 的项目检测逻辑 |
| **Trellis** | AGPL-3.0 | state.json 的**结构思路**（仅看 README，未看源码）|

---

## 7. 实施顺序

| 阶段 | 实现内容 |
|---|---|
| **MVP-1** | SessionStart hook + UserPromptSubmit hook + state.json 读写 |
| **MVP-2** | 多模式切换（PostToolUse hook 计划中，尚未实现） |
| **MVP-3** | 多平台适配（Cursor / Codex）|
