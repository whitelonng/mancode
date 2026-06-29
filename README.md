# mancode

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square)](./LICENSE)
[![Status](https://img.shields.io/badge/status-MVP--2%20alpha-green?style=flat-square)]()
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

### Team Memory (Codex platform)
When using Codex CLI, mancode writes to `AGENTS.md`:
```markdown
<!-- User's long-term memory -->
## Lessons
2026-06-20: Don't use lodash.merge for React state

## Architecture Decisions  
2026-06-15: Chose shadcn/ui over MUI (team familiarity)

<!-- mancode managed section -->
<!-- mancode:start -->
## mancode Configuration
[auto-generated, don't edit]
<!-- mancode:end -->
```

**Boundary**: mancode only touches the controlled section. Your notes stay safe.

---

## Install

**Status**: MVP-2 alpha for Claude Code.

```bash
# Once alpha releases:
npm install -g mancode@alpha

# Initialize in your project
cd your-project
mancode init

# Or as Claude Code plugin (marketplace - coming soon)
# /plugin install mancode
```

**Platform support**:
- ✅ **Claude Code** (MVP-2 alpha)
- 🔄 Cursor, Codex CLI, GitHub Copilot (MVP-3)
- 📋 Windsurf, Cline, Roo Code (planned)

---

## Commands

### CLI

```bash
mancode init              # Initialize .mancode/ directory + solo mode
mancode status            # Show project status, mode, recent activity
mancode workflow list     # List mancode workflows
mancode workflow show     # Show workflow metadata
mancode workflow clean    # Clean completed/old workflows
mancode refresh-style     # Rescan style tokens
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
/man8                     # 4 AM Warmup: scout + plan (auto-used for planning/research prompts)
/man                      # Playoffs: full 8-step flow
/manps                    # Preseason: health check
/manteam                  # Team mode (or auto-detected)
/mansolo                  # Back to solo
```

---

## Modes Explained

| Mode | When to Use | What It Does |
|---|---|---|
| **solo** (default) | Daily work | Quiet, efficient, style-aware. Reuses existing code. |
| **man8 skill** (MVP-2) | Planning/research prompts; `/man8` is optional | Scout investigates codebase → Draft plan → Ask for approval |
| **/man** (MVP-2) | Critical features | Full 8 steps: scout → plan → code → review (offense) → fix → review (defense) → fix → merge |
| **/manteam** (MVP-2) | Team projects | Multi-dev memory, commit templates, coordination |
| **/manps** (MVP-2) | Project cleanup | Scan for tech debt, unused deps, stale TODOs, missing tests |

**Philosophy**: Light by default. Opt into rigor when you need it.

---

## Design Principles

### 1. YAGNI Ladder
Before writing new code, check:
1. Already exists in this codebase? → **reuse it**
2. Stdlib does it? → **use it**
3. Native platform feature? → **use it**
4. Already installed dependency? → **use it**
5. One line? → **one line**
6. Only then: write the minimum that works

### 2. Aesthetic Consistency
- Scan project's existing design tokens (colors, fonts, spacing)
- Reuse components, not recreate
- Match naming conventions
- Apply project's style guide

### 3. Team Memory
- Track contributors, commits, decisions
- Avoid conflicting changes
- Surface project context to all agents

### 4. Surgical Changes
- Change only what the task requires
- No "drive-by refactoring"
- No formatting unrelated code
- Keep diffs minimal

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
├── Skills (5 modes)            # SKILL.md files
│   ├── solo.md                # Default mode
│   ├── man8.md                # 4 AM Warmup
│   ├── man.md                 # Playoffs (8 steps)
│   ├── manteam.md             # Team mode
│   └── manps.md               # Preseason cleanup
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

MVP-2 alpha targets **Claude Code**. MVP-3 adds Cursor, Codex CLI, and GitHub Copilot.

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

**Status**: Design phase complete, implementation starting.

Once MVP-1 releases, contributions welcome for:
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

### 团队记忆（Codex 平台）
使用 Codex CLI 时，mancode 写入 `AGENTS.md`：
```markdown
<!-- 用户的长期记忆 -->
## 经验教训
2026-06-20: 不要用 lodash.merge 处理 React state

## 架构决策  
2026-06-15: 选择 shadcn/ui 而非 MUI（团队熟悉度）

<!-- mancode 管理区 -->
<!-- mancode:start -->
## mancode 配置
[自动生成，请勿编辑]
<!-- mancode:end -->
```

**边界**：mancode 只修改受控区块。你的笔记保持安全。

---

## 安装

**状态**：Claude Code 的 MVP-2 alpha。

```bash
# Alpha 版本发布后：
npm install -g mancode@alpha

# 在项目中初始化
cd your-project
mancode init

# 或作为 Claude Code 插件（市场即将上线）
# /plugin install mancode
```

**平台支持**：
- ✅ **Claude Code**（MVP-2 alpha）
- 🔄 Cursor、Codex CLI、GitHub Copilot（MVP-3）
- 📋 Windsurf、Cline、Roo Code（计划中）

---

## 命令

### CLI

```bash
mancode init              # 初始化 .mancode/ 目录 + solo 模式
mancode status            # 显示项目状态、模式、最近活动
mancode workflow list     # 列出 mancode workflow
mancode workflow show     # 显示 workflow 元数据
mancode workflow clean    # 清理已完成/过旧 workflow
mancode refresh-style     # 重新扫描审美 token
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
/man8                     # 凌晨四点热身：侦查 + 计划（规划/调研类请求会自动使用）
/man                      # 季后赛：完整 8 步流程
/manps                    # 季前赛：健康检查
/manteam                  # 团队模式（或自动检测）
/mansolo                  # 回到 solo 模式
```

---

## 模式说明

| 模式 | 何时使用 | 做什么 |
|---|---|---|
| **solo**（默认） | 日常工作 | 安静、高效、风格感知。复用现有代码。 |
| **man8 skill**（MVP-2） | 规划/调研类请求；`/man8` 可选 | Scout 调查代码库 → 草拟计划 → 等待批准 |
| **/man**（MVP-2） | 关键功能 | 完整 8 步：侦查 → 计划 → 编码 → 审查（进攻）→ 修复 → 审查（防守）→ 修复 → 合并 |
| **/manteam**（MVP-2） | 团队项目 | 多开发者记忆、提交模板、协调 |
| **/manps**（MVP-2） | 项目清理 | 扫描技术债、未使用依赖、过时 TODO、缺失测试 |

**哲学**：默认轻量。需要时选择严格。

---

## 设计原则

### 1. YAGNI 阶梯
写新代码前，检查：
1. 代码库已存在？→ **复用它**
2. 标准库能做？→ **用它**
3. 平台原生特性？→ **用它**
4. 已安装依赖？→ **用它**
5. 一行能解决？→ **一行**
6. 只有以上都不行：写最小实现

### 2. 审美一致性
- 扫描项目现有设计 token（颜色、字体、间距）
- 复用组件，不重新创建
- 匹配命名规范
- 应用项目风格指南

### 3. 团队记忆
- 跟踪贡献者、提交、决策
- 避免冲突变更
- 向所有代理提供项目上下文

### 4. 外科手术式修改
- 只改任务要求的部分
- 不"顺便重构"
- 不格式化无关代码
- 保持 diff 最小

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
├── Skills（5 种模式）           # SKILL.md 文件
│   ├── solo.md                # 默认模式
│   ├── man8.md                # 凌晨四点热身
│   ├── man.md                 # 季后赛（8 步）
│   ├── manteam.md             # 团队模式
│   └── manps.md               # 季前赛清理
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

MVP-2 alpha 目标是 **Claude Code**。MVP-3 添加 Cursor、Codex CLI 和 GitHub Copilot。

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

**状态**：设计阶段完成，实施开始。

MVP-1 发布后，欢迎贡献：
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
