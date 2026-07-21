# 项目检测与健康扫描

mancode 先检测项目事实，再决定可用工作流和验证方式。扫描结果是证据，不是对技术栈的猜测。

## Project Profile

Project Profile 记录：

- 项目类型：backend、web、mobile、desktop、CLI、library、data、mixed 或 unknown。
- 语言、framework、manifest 和源码根目录。
- 可用的 build、lint、test 与平台验证命令。
- 是否检测到 UI 资产和浏览器自动化能力。
- high、medium 或 low 置信度。

普通 V3 初始化把可共享项目事实写入 `.mancode/shared/context/project.json`。项目结构变化后运行：

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
```

扫描器不解析任意 `theme.json`、Design Tokens Community Group 文件、Figma 或运行时动态主题。Agent 可以人工读取这些资料，但必须标明它们不是自动检测结果。

## Preseason

`mancode manps` 是确定性健康扫描，支持 `all`、`deps`、`security`、`dead-code` 和 `config`。它检查脚本、依赖重叠、TODO、测试、配置、审美、架构和基础安全信号。

```bash
mancode manps deps
mancode manps all --json
mancode manps config --remediate
```

报告和问题库保存在 `.mancode/local/`。`--remediate` 仍逐项要求决定，只自动执行白名单内的低风险修复。扫描结果不授权批量改代码，也不能代替项目测试或人工安全审查。
