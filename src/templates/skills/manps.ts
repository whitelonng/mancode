import type { SkillSpec } from './index.js';

/**
 * /manps skill — Preseason（README MVP-2）。
 *
 * 项目健康检查：扫描技术债、旧 TODO、未使用依赖、测试缺口和陈旧模式，
 * 输出可执行的 cleanup plan；只有 --remediate 且用户确认时才执行白名单安全修复。
 */
export const MANPS_SKILL: SkillSpec = {
  name: 'manps',
  description:
    'Preseason project health check. Scans for tech debt, stale TODOs, unused dependencies, missing tests, risky patterns, and optional safe remediation.',
  body: `# mancode · /manps (Preseason)

用户用 \`/manps [area]\` 触发你。这是项目健康检查模式：先运行 mancode 的确定性扫描引擎，再基于报告补充判断。默认只扫描；需要逐项确认和安全修复时使用 \`<mancode-cli> manps [area] --remediate\`。

## 输入

- \`area\` 可选，但 CLI 只支持固定扫描域：\`all\`、\`deps\`、\`security\`、\`dead-code\`、\`config\`。
- 如果用户输入的是目录、模块、功能名或主题，不要把它传给 CLI；先运行默认扫描，再把该输入作为 Step 2 的补充扫描范围。
- 如果为空，扫描整个项目，优先看根配置、src、tests、README。

## Step 1: 解析并运行确定性扫描

先读取 \`.mancode/config.json\`。如果其中有 \`cliCommand\`，优先使用它作为 \`<mancode-cli>\`，例如 \`mancode\` 或 \`node /abs/path/dist/cli.js\`。

如果 \`config.cliCommand\` 不存在，再用 Bash 解析可用 CLI：

\`\`\`bash
MANCODE_CLI="$(node -e 'const fs=require("fs"); try { const c=JSON.parse(fs.readFileSync(".mancode/config.json","utf8")); if (typeof c.cliCommand === "string" && c.cliCommand.trim()) process.stdout.write(c.cliCommand.trim()); } catch {}')"
if [ -z "$MANCODE_CLI" ]; then
  if command -v mancode >/dev/null 2>&1; then
    MANCODE_CLI="mancode"
  elif [ -x ./node_modules/.bin/mancode ]; then
    MANCODE_CLI="./node_modules/.bin/mancode"
  fi
fi
if [ -z "$MANCODE_CLI" ]; then
  echo "mancode CLI not found. Run mancode init with the same CLI you want Claude Code to use, or install mancode in PATH."
  exit 127
fi
\`\`\`

如果 CLI 解析失败，停下来报告错误；不要用手写扫描替代确定性扫描，因为那会让报告格式和严重级别偏离 CLI。

然后用 Bash 执行：

\`\`\`bash
eval "$MANCODE_CLI" manps <area>
\`\`\`

其中 \`<area>\` 必须是 \`all\`、\`deps\`、\`security\`、\`dead-code\`、\`config\` 之一。

如果 \`area\` 为空，或用户给的是目录/模块/主题，运行：

\`\`\`bash
eval "$MANCODE_CLI" manps
\`\`\`

扫描会生成：

- \`.mancode/preseason-reports/<date>.md\`
- \`.mancode/preseason-report.md\`
- \`.mancode/preseason-issues.json\`

如果用户要求逐项确认，或者明确说要进入整改审核，运行：

\`\`\`bash
eval "$MANCODE_CLI" manps <area> --remediate
\`\`\`

\`--remediate\` 会对本次扫描问题逐条询问 \`y/n/skip/show files\`，并把 accepted/skipped/fixed 决策写回 \`.mancode/preseason-issues.json\`。它只执行白名单内、低风险且用户明确选择 \`y\` 的安全修复；当前自动执行范围包括创建缺失的 \`.gitignore\`、\`.editorconfig\`，以及从已安装工具依赖安全推断 \`test\` / \`lint\` / \`build\` package scripts。

CLI 成功后，再按下面的手动扫描清单做补充判断；补充判断不能覆盖 CLI 的 P0/P1/P2 结果，只能增加上下文和人工建议。

## Step 2: 补充扫描清单

### 1. Project Shape

- 读取 \`package.json\`、README、测试配置、lint/build 脚本
- 识别 tech stack、测试命令、构建命令
- 读取 \`.mancode/state.json\` 和 \`.mancode/aesthetics/style-tokens.json\`（如存在）

### 2. Tech Debt

使用 \`rg\` 搜索：

- \`TODO|FIXME|HACK|XXX|deprecated|legacy|temporary|workaround\`
- 大文件、重复实现、明显死代码
- 过时命名或与当前技术栈不一致的模式

### 3. Dependency Health

- 对照 \`package.json\` dependencies/devDependencies 与源码 import
- 标记疑似未使用依赖，但不要直接删除
- 标记缺少脚本的风险：无 test、无 lint、无 build

### 4. Test Gaps

- 找出有实现但无对应测试的核心模块
- 标记高风险区域：auth、billing、data migration、file IO、CLI destructive ops
- 给出最小补测建议

### 5. Aesthetic Drift（前端项目）

- 检查是否绕过已有 design tokens
- 检查硬编码颜色、字体、spacing
- 检查是否混用 UI library

## 输出文件

确认已经写入 \`.mancode/preseason-report.md\`：

\`\`\`
# mancode preseason report

## Summary

## P0: Must Fix Before Shipping

## P1: Should Fix Soon

## P2: Cleanup Backlog

## Suggested Order

## Commands Checked
\`\`\`

## 输出规则

- 默认扫描不修改代码；\`--remediate\` 只执行白名单内安全修复
- 不删除依赖
- 未经过 \`--remediate\` 的 y/n 确认，不进入整改
- 不制造大型重构计划
- 每条问题必须有文件路径或可复现命令
- 优先给 3-7 条最高价值问题
- 没发现问题就明确说没有 P0/P1，只列 residual risk

收到 \`/manps\` 触发后立即扫描并生成报告。`,
};
