# 项目检测与健康扫描

mancode 先检测项目事实，再决定可用工作流和验证方式。扫描结果是证据，不是对技术栈的猜测。

## Project Profile

Project Profile 记录：

- 项目类型：backend、web、mobile、desktop、CLI、library、data、mixed 或 unknown。
- 语言、framework、manifest 和源码根目录。
- 可用的 build、lint、test 与平台验证命令。
- 是否检测到 UI 资产和浏览器自动化能力。
- high、medium 或 low 置信度。

普通 Continuity 初始化把可共享项目事实写入 `.mancode/shared/context/project.json`。项目结构变化后运行：

```bash
mancode refresh-project
```

检测不到的 framework 不会写入 profile。Git、manifest 或源码目录缺失时，初始化可以安全降级，但不会把 unknown 项目伪装成 Web 项目。

## 设计资产扫描

只有 profile 确认存在 UI 资产时，mancode 才扫描设计信号。当前实现识别：

- Tailwind 配置中的顶层颜色、字体和 dark mode。
- CSS custom properties。
- 常见组件文件名。
- 已检测到的 UI library。

结果写入 checkout-local cache。`matchLevel=high` 表示存在可复用配置、CSS token 或组件；`low` 只表示依赖提示；`none` 表示没有可靠资产。

```bash
mancode refresh-style
mancode refresh-style --root apps/web
```

Monorepo 的 `--root` 必须是仓库内已存在的相对路径。绝对路径、路径穿越和逃逸仓库的符号链接会被拒绝。扫描结果仍写入 `.mancode/local/cache/style-tokens.json`，其中 `scopeRoot` 标记本次扫描范围。

扫描器不解析任意 `theme.json`、Design Tokens Community Group 文件、Figma 或运行时动态主题。Agent 可以人工读取这些资料，但必须标明它们不是自动检测结果。

## 设计策略

设计策略与检测事实分离：样式扫描是 checkout-local、可重建的事实缓存；可选的人类策略保存在 `.mancode/shared/context/design-policy.json`。初始化不会自动创建策略，没有有效策略时始终安全使用 `preserve`。Legacy 项目可以读取安全上下文，但只有当前 Continuity 项目能写入共享策略。

```bash
mancode design status --json
mancode design configure --expected-revision 0 --preset refine --icons lucide --emoji forbid-as-interface-icon --motion purposeful --browser-validation when-available
mancode design context --json
```

`design context` 只输出代码生成的固定指导、质量门槛和经过大小/字符限制清洗的样式摘要。策略文件只接受严格枚举和独立 revision，拒绝未知字段与自由文本提示词。`experimental` 需要 `--confirm-experimental`，且任何 preset 都不能扩大任务范围、授权产品变更或隐式新增依赖。

对于新建 UI 或视觉重做，如果用户尚未选定方向，固定指导会要求 Agent 先提出 2–3 个差异明确的产品化方向，简述取舍并推荐一个，等待用户选择后再实现；局部 UI 修复、既有设计系统内的改动和已选定方向的任务直接继续。`experimental` 会让品牌型页面把最强视觉信号集中在首屏，并将同一母题延续到全页；任务型产品仍以工作流清晰度优先。

策略命令只修改当前 checkout。共享策略应像仓库配置一样经过 review 和 commit；它不参与 Context Pack 必填字段，也不会伪造 git-ref 远端同步回执。策略文件损坏时，`design context` fail-open 为 `preserve`，普通开发命令不被阻断。

## Preseason

`mancode manps` 是确定性健康扫描，支持 `all`、`deps`、`security`、`dead-code` 和 `config`。它检查脚本、依赖重叠、TODO、测试、配置、审美、架构和基础安全信号。审美检查只在 `package.json` 确实声明两个不同图标系统时产生一个 P2；它不扫描 UI 文案中的表情，避免把合法内容误报为图标问题。

```bash
mancode manps deps
mancode manps all --json
mancode manps config --remediate
```

报告和问题库保存在 `.mancode/local/`。`--remediate` 仍逐项要求决定，只自动执行白名单内的低风险修复。扫描结果不授权批量改代码，也不能代替项目测试或人工安全审查。
