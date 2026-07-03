# mancode

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square)](./LICENSE)
[![Status](https://img.shields.io/badge/status-MVP--2%20beta-blue?style=flat-square)]()
[![Platform](https://img.shields.io/badge/platform-Claude%20Code-5865F2?style=flat-square)](https://claude.ai/code)

**AI coding agent harness. Five modes: practice to playoffs. Stop your AI from over-engineering. Elbow out bloat. Score clean.**

**AI 编码代理调度框架。五种模式：训练到季后赛。别让你的 AI 过度设计一切。像个 man 一样，肘开冗余，干净得分。**

---

[English](#english) | [中文](#中文)

---

## English

## The Problem

AI agents today:
- 🔴 **Overengineer by default** — add auth middleware when you just want a logout button
- 🔴 **Forget project style** — output MUI when your whole app is shadcn/ui
- 🔴 **No team memory** — two devs working on the same codebase, agents don't know about each other's changes
- 🔴 **One speed only** — "just fix this typo" gets the same ceremony as "rebuild auth flow"

## The Solution

**mancode** gives you **five modes** for different tasks:

```
solo           # Default: quiet, efficient, respects your style
               # Fixes, features, refactors — no ceremony

/man8          # 4 AM Warmup: investigate + plan before coding
               # Use when you need research first

/man           # Playoffs: full 8-step flow with dual code review
               # Critical features, production changes

/manteam       # Team Game: multi-dev memory + coordination
               # Detected automatically when >1 active contributor

/manps         # Preseason: project health check + cleanup
               # Old TODOs, unused deps, stale patterns
```

## The System

| What | Tagline | 中文 |
|---|---|---|
| **solo** (default) | Practice day. Save your gas. | 日常训练，省着点打。 |
| **/man8** | 4 AM. Already warmed up. | 凌晨 4 点，已经热身完了。 |
| **/man** | Playoffs. Every possession counts. | 季后赛，每球必争。 |
| **/manteam** | Five on the floor, one mind. | 上场五人，一条心。 |
| **/manps** | Knock the rust off before tip-off. | 开季前，先把锈磨掉。 |
| **Aesthetics** | Soft side. | 柔情瞬间。 |
| **Coaching Staff** | Your agent's crew. | 你的教练组。 |

*Honoring the professional spirit. / 致敬职业精神。*

**Note**: `solo` is on by default. `Aesthetics` and `Coaching Staff` are built-in features — no command needed.

**Key difference**: The default is light. Heavy modes are opt-in when you need rigor.

---

## Before / After

### Before (vanilla Claude Code)
```
You: "add a logout button to the settings page"

Claude: Creates new component, new styles, new color variables,
        doesn't reuse existing Button component, guesses colors,
        outputs 80 lines.
```

### After (mancode solo mode)
```
You: "add a logout button to the settings page"

man:  Scans project → finds Button component → uses primary color
      → outputs 3 lines:

      <Button variant="default" onClick={handleLogout}>
        Logout
      </Button>
```

**Why?** mancode:
1. **Scans your project's existing patterns** (components, colors, UI library)
2. **Applies YAGNI** (already exists → reuse → stdlib → minimal implementation)
3. **Remembers team context** (commits, contributors, style decisions)

---

## How It Works

### Auto-detection
mancode automatically detects your project:
- **Tech stack**: React/Vue/Svelte, TypeScript, Tailwind/styled-components
- **UI library**: shadcn/ui, MUI, Ant Design, headlessUI
- **Design tokens**: colors, fonts, spacing, components
- **Team status** *(MVP-2)*: >1 active contributor → auto-suggests `/manteam`

### Aesthetic Matching
When you work on frontend:
```javascript
// mancode scans:
tailwind.config.js  → primary: #3b82f6, font: Inter
package.json        → shadcn/ui installed
src/components/     → Button, Input, Card components exist

// Then outputs code using YOUR style:
<Button className="bg-primary">  // uses #3b82f6, not generic "blue"
```

### Three Questions (solo mode)
On every prompt in solo mode, mancode injects three questions before the agent acts:

1. **Why?** — What problem does this change solve?
2. **What exists?** — Is there an existing implementation to reuse?
3. **How minimal?** — Can it be one line? Can it reuse existing code?

This is the **lightweight YAGNI enforcement** that makes solo mode more than just "vanilla agent + aesthetics". The agent doesn't always answer out loud, but it always considers before writing.

### Team Memory (manteam mode)
When you run `/manteam`, mancode reads and updates shared memory under `.mancode/memory/`:

```
.mancode/memory/
├── prd.md           # What the team is building (shared context)
├── spec.md          # How it should behave (agreements)
└── decisions.md     # Dated ADR-style entries (why X over Y)
```

`/manteam` also installs team coordination templates without overwriting existing files:

```
.mancode/team/commit-template.txt
.github/PULL_REQUEST_TEMPLATE.md
```

Teams that want enforcement can opt in to a managed Conventional Commit hook:

```bash
mancode install claude-code --commit-hook
```

This writes `.mancode/team/commit-msg.sh` and wires Git's resolved `commit-msg` hook path only when the hook is missing or already managed by mancode.

Example entry appended to `decisions.md` on each `/manteam` run:

```markdown
## 2026-06-30: Chose shadcn/ui over MUI

- Decision: Use shadcn/ui for the settings redesign
- Context: Team already familiar with it; MUI bundle is larger
- Task: settings-redesign
```

The next agent (or teammate) inherits this context — no more "why did we pick this?" reruns.

**Boundary**: mancode only writes to `.mancode/memory/`. Your source code and `AGENTS.md` (if you use Codex CLI later) stay untouched on Claude Code.

---

## Install

**Status**: MVP-2 beta for Claude Code.

```bash
# Install globally
npm install -g mancode@beta

# Initialize in your project
cd your-project
mancode init

# Or as Claude Code plugin (marketplace - coming soon)
# /plugin install mancode
```

**Platform support**:
- ✅ **Claude Code** (MVP-2 beta)
- 🔄 Cursor, Codex CLI, GitHub Copilot (MVP-3)
- 📋 Windsurf, Cline, Roo Code (planned)

---

## Commands

### CLI

```bash
mancode init              # Initialize .mancode/ + solo mode + aesthetic scan
mancode status            # Show project status, mode, style, hooks
mancode status --json     # Output as JSON (for scripts)
mancode install [platform]# Install/reinstall platform adapter
mancode install claude-code --commit-hook
                          # Opt into /manteam Conventional Commit enforcement
mancode workflow list     # List mancode workflows
mancode workflow show     # Show workflow metadata
mancode workflow clean    # Clean completed/old workflows
mancode manps [area]      # Preseason health scan, write report
mancode manps [area] --remediate
                          # Review issues, record decisions, apply safe fixes
                          # Safe fixes: config files + inferred package scripts
                          # Areas: all (default) | deps | security | dead-code | config
                          # Writes .mancode/preseason-report.md, .mancode/preseason-issues.json,
                          # and .mancode/preseason-reports/<ts>-<area>.md
mancode refresh-style     # Rescan Tailwind config, update style-tokens.json
mancode version           # Show mancode/node/platform versions
```

**Options**:
```bash
mancode init --force      # Reinstall (keep scanned tokens)
mancode init --yes        # Skip confirmations (CI mode)
mancode install --force   # Reinstall adapter (keep scanned tokens)
```

**In Claude Code** (after init):
```
# Just work normally — solo mode is automatic
"add a logout button"
"fix the login bug"  
"refactor the auth module"
```

### Claude Code Skills

```bash
/man8                     # 4 AM Warmup: scout + plan (hook suggests it for planning/research prompts; also invocable manually)
/man                      # Playoffs: full 8-step flow
/manps                    # Preseason: health check
/manteam                  # Team mode (or auto-detected)
/mansolo                  # Back to solo
```

> **Planned aliases** (not yet wired up): `/warmup`, `/playoffs`, `/team`, `/preseason`, `/back-to-solo`.

---

## Modes Explained

| Mode | When to Use | What It Does |
|---|---|---|
| **solo** (default) | Daily work | Quiet, efficient, style-aware. Reuses existing code. |
| **man8 skill** (MVP-2) | Planning/research prompts (hook suggests `/man8`; user can also call it manually) | Scout investigates codebase → Draft plan → Ask for approval |
| **/man** (MVP-2) | Critical features | Full 8 steps: scout → plan → code → review (offense) → fix → review (defense) → fix → merge |
| **/manteam** (MVP-2) | Team projects | Multi-dev memory, commit templates, coordination |
| **/manps** (MVP-2) | Project cleanup | Runs `mancode manps`, writes Markdown reports + `.mancode/preseason-issues.json` |

**Philosophy**: Light by default. Opt into rigor when you need it.

---

## Design Principles

### 1. Light by Default, Heavy on Demand
- solo mode is the default — 3 enhancements, no ceremony
- Heavy flows (`/man`, `/manteam`) are opt-in when the task actually warrants it
- Don't burn 30k tokens fixing a typo

**YAGNI Ladder** (checked before writing new code):
1. Already exists in this codebase? → **reuse it**
2. Stdlib does it? → **use it**
3. Native platform feature? → **use it**
4. Already installed dependency? → **use it**
5. One line? → **one line**
6. Only then: write the minimum that works

### 2. Pro-Grade When It Counts
- Critical code gets the full coaching staff: Scout → Head Coach → two Film Analysts
- Dual review: offense (code quality) + defense (security, edges, concurrency)
- 8-step flow, 30-90 min, no silent skipping

### 3. Aesthetics Is Not Optional
- Frontend tasks always match your existing design tokens (colors, fonts, components)
- No "generic blue" — use the project's actual primary color
- New projects without design tokens get 3 style options, not AI slop

### 4. Ask Before Swinging
- `/manps` beta applies only safe, y-confirmed remediation actions
- Irreversible operations (force push, schema migrations, bulk deletes) need explicit confirmation
- The user is always the decision maker

### 5. One Tool, All Agents
- One core, multiple platform adapters
- Claude Code today; Cursor, Codex CLI, Copilot in MVP-3
- Adapter-based architecture — other platforms can be added without rewriting core

---

## Architecture

```
mancode/
├── CLI                         # npm package + platform adapters
│   ├── mancode init           # Setup .mancode/ directory
│   ├── mancode status         # Show current state
│   └── mancode install <platform>
│
├── Hooks (Claude Code)         # Inject context automatically
│   ├── session-start          # Read .mancode/state.json
│   └── user-prompt-submit     # Ask: why? what exists? minimal change?
│
├── Skills (5 modes)            # .claude/skills/<name>/SKILL.md
│   ├── solo/SKILL.md          # Default mode
│   ├── man8/SKILL.md          # 4 AM Warmup
│   ├── man/SKILL.md           # Playoffs (8 steps)
│   ├── manteam/SKILL.md       # Team mode
│   └── manps/SKILL.md         # Preseason cleanup
│
└── Agents (Coaching Staff)     # Multi-agent orchestration
    ├── Scout                  # Investigate codebase
    ├── Head Coach             # Main decision-maker
    ├── Film Analyst (Offense) # Code quality review
    └── Film Analyst (Defense) # Security/edge review
```

---

## Roadmap

| Phase | Timeline | Focus |
|---|---|---|
| **MVP-1** | 2-3 weeks | solo mode + aesthetics + hooks (Claude Code only) |
| **MVP-2** | 3-4 weeks | /man8, /man, /manteam, /manps modes + coaching staff |
| **MVP-3** | 2-3 weeks | Multi-platform (Cursor, Codex, Copilot) |
| **Public Release** | After MVP-3 | npm stable release + marketplace + docs + demos |

---

## FAQ

### Why not just use Cursor/Claude/etc directly?

mancode is a **harness**, not a replacement. It works *with* your agent, adding:
- Project-aware context (style, patterns, team)
- Mode switching (light vs. rigorous)
- YAGNI enforcement
- Team memory

Think: workflow layer on top of your agent.

### Does it work with my agent?

MVP-2 beta targets **Claude Code**. MVP-3 adds Cursor, Codex CLI, and GitHub Copilot.

The architecture is adapter-based — other platforms can be added.

### Will it change my existing workflow?

**solo mode** (default) is invisible. It enhances your agent's output but doesn't add ceremony.

Heavy modes (`/man`, `/manteam`) are opt-in when you need structure.

### What about privacy/security?

- **Local-first**: All scans stay in `.mancode/` directory
- **No telemetry**: mancode doesn't phone home
- **Git-ignored**: `.mancode/` is in .gitignore by default (optional to commit)
- **Controlled boundaries**: AGENTS.md has clear managed sections (Codex only)

---

## Contributing

**Status**: MVP-2 beta for Claude Code is live. Early testing and feedback welcome.

Current focus areas:
- Final MVP-2 beta smoke testing for the slash command suite (`/man8`, `/man`, `/manteam`, `/manps`, `/mansolo`)
- Last review pass before tagging/publishing the beta
- Exercise `/manteam` commit/PR templates and optional commit hook in team repos

Manual release testing: [MVP2_BETA_TEST_PLAN.md](MVP2_BETA_TEST_PLAN.md)

After MVP-3 (multi-platform), contributions welcome for:
- Platform adapters (Windsurf, Cline, etc.)
- Additional modes
- Aesthetic scanning for other UI libraries
- Language support (currently focuses on JS/TS ecosystem)

---

## License

GNU Affero General Public License v3.0 © 2026

---

## Acknowledgments

Built with inspiration from modern AI agent workflows. Special focus on:
- **Minimalism over maximalism** (YAGNI at core)
- **Project context awareness** (not generic one-size-fits-all)
- **Team coordination** (multi-dev memory)
- **Mode flexibility** (light default, opt-in rigor)

---
---

# 中文

## 问题

当前的 AI 代理：
- 🔴 **默认过度设计** — 你只想加个退出按钮，它给你整个 auth 中间件
- 🔴 **忘记项目风格** — 你整个项目用 shadcn/ui，它输出 MUI 代码
- 🔴 **没有团队记忆** — 两个开发者同一代码库，代理不知道彼此的改动
- 🔴 **只有一个速度** — "修个错字"和"重构认证流程"得到同样的仪式感

## 解决方案

**mancode** 提供 **五种模式** 应对不同任务：

```
solo           # 默认：安静、高效、尊重你的风格
               # 修复、功能、重构 — 无多余仪式

/man8          # 凌晨四点热身：先调研 + 计划再动手
               # 需要先研究时使用

/man           # 季后赛：完整 8 步流程 + 双重代码审查
               # 关键功能、生产变更

/manteam       # 团队赛：多开发者记忆 + 协调
               # 检测到 >1 活跃贡献者时自动建议

/manps         # 季前赛：项目健康检查 + 清理
               # 旧 TODO、未使用依赖、过时模式
```

## 系统概览

| 内容 | 口号 | English |
|---|---|---|
| **solo**（默认） | 日常训练，省着点打。 | Practice day. Save your gas. |
| **/man8** | 凌晨 4 点，已经热身完了。 | 4 AM. Already warmed up. |
| **/man** | 季后赛，每球必争。 | Playoffs. Every possession counts. |
| **/manteam** | 上场五人，一条心。 | Five on the floor, one mind. |
| **/manps** | 开季前，先把锈磨掉。 | Knock the rust off before tip-off. |
| **审美** | 柔情瞬间。 | Soft side. |
| **教练组** | 你的教练组。 | Your agent's crew. |

*致敬职业精神。 / Honoring the professional spirit.*

**说明**：`solo` 默认开启。`审美`和`教练组`是内置功能，无需命令。

**核心区别**：默认轻量。需要严格流程时按需选择。

---

## 前 / 后对比

### 之前（原生 Claude Code）
```
你："给设置页面加个退出按钮"

Claude：创建新组件，新样式，新颜色变量，
        不复用已有的 Button 组件，猜颜色，
        输出 80 行代码。
```

### 之后（mancode solo 模式）
```
你："给设置页面加个退出按钮"

man：扫描项目 → 找到 Button 组件 → 使用 primary 颜色
     → 输出 3 行：

     <Button variant="default" onClick={handleLogout}>
       退出登录
     </Button>
```

**为什么？** mancode：
1. **扫描你项目的现有模式**（组件、颜色、UI 库）
2. **应用 YAGNI**（已存在 → 复用 → 标准库 → 最小实现）
3. **记住团队上下文**（提交、贡献者、风格决策）

---

## 工作原理

### 自动检测
mancode 自动检测你的项目：
- **技术栈**：React/Vue/Svelte、TypeScript、Tailwind/styled-components
- **UI 库**：shadcn/ui、MUI、Ant Design、headlessUI
- **设计 token**：颜色、字体、间距、组件
- **团队状态** *（MVP-2）*：>1 活跃贡献者 → 自动建议 `/manteam`

### 审美匹配
前端任务时：
```javascript
// mancode 扫描：
tailwind.config.js  → primary: #3b82f6, font: Inter
package.json        → 已安装 shadcn/ui
src/components/     → 已有 Button、Input、Card 组件

// 然后用你的风格输出代码：
<Button className="bg-primary">  // 使用 #3b82f6，不是通用的 "blue"
```

### 三问追问（solo 模式）
在 solo 模式下，每次提交 prompt，mancode 会在 agent 动手前注入三个问题：

1. **为什么做？** — 这个改动解决什么问题？
2. **已经有什么？** — 项目里有没有可以复用的实现？
3. **最少改多少？** — 能一行解决吗？能复用现有代码吗？

这是 solo 模式的**轻量 YAGNI 强制**——让 solo 不只是"原生 agent + 审美"。agent 不一定每次都说出来，但一定会先想再写。

### 团队记忆（manteam 模式）
运行 `/manteam` 时，mancode 会读取并更新 `.mancode/memory/` 下的共享记忆：

```
.mancode/memory/
├── prd.md           # 团队在做什么（共享上下文）
├── spec.md          # 应该怎么做（共识）
└── decisions.md     # 带日期的 ADR 式条目（为什么选 X 不选 Y）
```

`/manteam` 也会安装团队协作模板，且不会覆盖已有文件：

```
.mancode/team/commit-template.txt
.github/PULL_REQUEST_TEMPLATE.md
```

需要强制规范的团队可以显式启用受管 Conventional Commit hook：

```bash
mancode install claude-code --commit-hook
```

它会写入 `.mancode/team/commit-msg.sh`，并且只在 Git 解析出的 `commit-msg` hook 缺失或已经由 mancode 管理时接管该 hook。

每次 `/manteam` 运行会向 `decisions.md` 追加一条记录：

```markdown
## 2026-06-30: 选择 shadcn/ui 而非 MUI

- Decision: 设置页改版使用 shadcn/ui
- Context: 团队已经熟悉；MUI 的 bundle 更大
- Task: settings-redesign
```

下一个 agent（或队友）会自动继承这些上下文 —— 不再重复"我们为什么选这个？"。

**边界**：mancode 只写 `.mancode/memory/`。在 Claude Code 上，你的源码和 `AGENTS.md`（如果以后用 Codex CLI）都不会被动到。

---

## 安装

**状态**：Claude Code 的 MVP-2 beta。

```bash
# 全局安装
npm install -g mancode@beta

# 在项目中初始化
cd your-project
mancode init

# 或作为 Claude Code 插件（市场即将上线）
# /plugin install mancode
```

**平台支持**：
- ✅ **Claude Code**（MVP-2 beta）
- 🔄 Cursor、Codex CLI、GitHub Copilot（MVP-3）
- 📋 Windsurf、Cline、Roo Code（计划中）

---

## 命令

### CLI

```bash
mancode init              # 初始化 .mancode/ + solo 模式 + 审美扫描
mancode status            # 显示项目状态、模式、风格、hooks
mancode status --json     # JSON 输出（脚本用）
mancode install [platform]# 安装/重装平台适配
mancode install claude-code --commit-hook
                          # 显式启用 /manteam Conventional Commit 校验
mancode workflow list     # 列出 mancode workflow
mancode workflow show     # 显示 workflow 元数据
mancode workflow clean    # 清理已完成/过旧 workflow
mancode manps [area]      # 季前赛健康扫描，写入报告
mancode manps [area] --remediate
                          # 审核问题、记录决策，并执行安全修复
                          # 安全修复：配置文件 + 可从已安装工具推断的 package scripts
                          # area: all（默认）| deps | security | dead-code | config
                          # 生成 .mancode/preseason-report.md、.mancode/preseason-issues.json
                          # 和 .mancode/preseason-reports/<时间戳>-<area>.md
mancode refresh-style     # 重扫 Tailwind 配置，更新 style-tokens.json
mancode version           # 显示 mancode/node/平台版本
```

**参数**：
```bash
mancode init --force      # 重装（保留已扫描 token）
mancode init --yes        # 跳过确认（CI 用）
mancode install --force   # 重装适配（保留已扫描 token）
```

**在 Claude Code 中**（初始化后）：
```
# 正常工作即可 — solo 模式自动生效
"加个退出按钮"
"修复登录 bug"  
"重构认证模块"
```

### Claude Code Skills

```bash
/man8                     # 凌晨四点热身：侦查 + 计划（hook 在规划/调研类请求时会建议；用户也可手动调用）
/man                      # 季后赛：完整 8 步流程
/manps                    # 季前赛：健康检查
/manteam                  # 团队模式（或自动检测）
/mansolo                  # 回到 solo 模式
```

> **计划中的别名**（尚未启用）：`/warmup`、`/playoffs`、`/team`、`/preseason`、`/back-to-solo`。

---

## 模式说明

| 模式 | 何时使用 | 做什么 |
|---|---|---|
| **solo**（默认） | 日常工作 | 安静、高效、风格感知。复用现有代码。 |
| **man8 skill**（MVP-2） | 规划/调研类请求（hook 会建议 `/man8`；用户也可手动调用）| Scout 调查代码库 → 草拟计划 → 等待批准 |
| **/man**（MVP-2） | 关键功能 | 完整 8 步：侦查 → 计划 → 编码 → 审查（进攻）→ 修复 → 审查（防守）→ 修复 → 合并 |
| **/manteam**（MVP-2） | 团队项目 | 多开发者记忆、提交模板、协调 |
| **/manps**（MVP-2） | 项目清理 | 运行 `mancode manps`，写入 Markdown 报告 + `.mancode/preseason-issues.json` |

**哲学**：默认轻量。需要时选择严格。

---

## 设计原则

### 1. 默认轻量，需要时硬核
- solo 是默认模式 —— 3 条增强，零仪式感
- 重型流程（`/man`、`/manteam`）按需选择，任务真需要时才上
- 别为了修个 typo 烧 30k token

**YAGNI 阶梯**（写新代码前依次检查）：
1. 代码库已存在？→ **复用它**
2. 标准库能做？→ **用它**
3. 平台原生特性？→ **用它**
4. 已安装依赖？→ **用它**
5. 一行能解决？→ **一行**
6. 只有以上都不行：写最小实现

### 2. 关键时刻，职业级
- 关键代码动用完整教练组：Scout → Head Coach → 两位 Film Analyst
- 双重审查：进攻（代码质量）+ 防守（安全、边界、并发）
- 8 步流程，30-90 分钟，不静默跳过

### 3. 审美不是可选项
- 前端任务必须匹配项目已有的设计 token（颜色、字体、组件）
- 不输出"通用蓝色" —— 用项目实际的 primary color
- 没有设计 token 的新项目给 3 个风格选项，不是 AI slop

### 4. 出手前先问
- `/manps` beta 只执行用户 y 确认过的安全整改动作
- 不可逆操作（force push、schema 变更、批量删除）必须明确确认
- 用户始终是决策者

### 5. 一个工具，所有 agent
- 一份核心，多平台适配
- 现在支持 Claude Code；Cursor、Codex CLI、Copilot 在 MVP-3
- 基于适配层的架构 —— 加新平台不用重写核心

---

## 架构

```
mancode/
├── CLI                         # npm 包 + 平台适配器
│   ├── mancode init           # 设置 .mancode/ 目录
│   ├── mancode status         # 显示当前状态
│   └── mancode install <platform>
│
├── Hooks（Claude Code）        # 自动注入上下文
│   ├── session-start          # 读取 .mancode/state.json
│   └── user-prompt-submit     # 问：为什么？已有什么？最少改多少？
│
├── Skills（5 种模式）           # .claude/skills/<name>/SKILL.md
│   ├── solo/SKILL.md          # 默认模式
│   ├── man8/SKILL.md          # 凌晨四点热身
│   ├── man/SKILL.md           # 季后赛（8 步）
│   ├── manteam/SKILL.md       # 团队模式
│   └── manps/SKILL.md         # 季前赛清理
│
└── Agents（教练组）             # 多代理编排
    ├── Scout                  # 调查代码库
    ├── Head Coach             # 主决策者
    ├── Film Analyst (Offense) # 代码质量审查
    └── Film Analyst (Defense) # 安全/边界审查
```

---

## 路线图

| 阶段 | 时间线 | 重点 |
|---|---|---|
| **MVP-1** | 2-3 周 | solo 模式 + 审美 + hooks（仅 Claude Code）|
| **MVP-2** | 3-4 周 | /man8、/man、/manteam、/manps 模式 + 教练组 |
| **MVP-3** | 2-3 周 | 多平台（Cursor、Codex、Copilot）|
| **公开发布** | MVP-3 后 | npm 稳定版 + 市场 + 文档 + 演示 |

---

## 常见问题

### 为什么不直接用 Cursor/Claude 等？

mancode 是**调度框架**，不是替代品。它与你的代理协同工作，添加：
- 项目感知上下文（风格、模式、团队）
- 模式切换（轻量 vs 严格）
- YAGNI 强制执行
- 团队记忆

理解为：代理之上的工作流层。

### 它能用在我的代理上吗？

MVP-2 beta 目标是 **Claude Code**。MVP-3 添加 Cursor、Codex CLI 和 GitHub Copilot。

架构基于适配器 — 其他平台可以添加。

### 会改变我现有的工作流吗？

**solo 模式**（默认）是无感的。它增强代理输出但不添加仪式感。

重型模式（`/man`、`/manteam`）是需要结构时按需选择。

### 隐私/安全如何？

- **本地优先**：所有扫描保存在 `.mancode/` 目录
- **无遥测**：mancode 不上报数据
- **Git 忽略**：`.mancode/` 默认在 .gitignore（可选提交）
- **受控边界**：AGENTS.md 有明确管理区（仅 Codex）

---

## 贡献

**状态**：Claude Code 的 MVP-2 beta 已发布。欢迎早期测试和反馈。

当前重点：
- 对 slash 命令套件（`/man8`、`/man`、`/manteam`、`/manps`、`/mansolo`）做 MVP-2 beta 最终烟测
- beta tag / publish 前做最后一轮审核
- 在团队仓库中验证 `/manteam` commit/PR 模板和可选 commit hook

人工发布测试：[MVP2_BETA_TEST_PLAN.md](MVP2_BETA_TEST_PLAN.md)

MVP-3（多平台）之后，欢迎贡献：
- 平台适配器（Windsurf、Cline 等）
- 额外模式
- 其他 UI 库的审美扫描
- 语言支持（目前专注于 JS/TS 生态）

---

## 许可证

GNU Affero General Public License v3.0 © 2026

---

## 致谢

从现代 AI 代理工作流中汲取灵感。特别专注于：
- **极简主义而非极繁主义**（YAGNI 为核心）
- **项目上下文感知**（非通用一刀切）
- **团队协调**（多开发者记忆）
- **模式灵活性**（默认轻量，按需严格）
