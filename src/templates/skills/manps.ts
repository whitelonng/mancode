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

先读取 \`.mancode/config.json\`。如果其中有 \`cliCommand\` + \`cliArgs\`，优先使用它作为 \`<mancode-cli>\`，例如 \`{"cliCommand":"mancode","cliArgs":[]}\` 或 \`{"cliCommand":"node","cliArgs":["/abs/path/dist/cli.js"]}\`。

如果 \`config.cliCommand\` 不存在，再解析可用 CLI。必须使用下面这个 Node 包装器执行扫描；它只允许白名单命令，并用 \`spawnSync(command, args)\` 传参，禁止 \`eval\` 或拼接 shell 字符串：

\`\`\`bash
AREA=""
REMEDIATE=0
node - "$AREA" "$REMEDIATE" <<'NODE'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const area = process.argv[2] ?? "";
const remediate = process.argv[3] === "1";
const allowedAreas = new Set(["all", "deps", "security", "dead-code", "config"]);

if (area && !allowedAreas.has(area)) {
  console.error("Invalid manps area: " + area + ". Supported areas: " + Array.from(allowedAreas).join(", "));
  process.exit(2);
}

const scanArea = area || undefined;

let config = {};
try {
  config = JSON.parse(fs.readFileSync(".mancode/config.json", "utf8"));
} catch {}

function resolveCli() {
  if (config.cliCommand === "mancode" && Array.isArray(config.cliArgs) && config.cliArgs.length === 0) {
    return { command: "mancode", args: [] };
  }
  if (
    config.cliCommand === "node" &&
    Array.isArray(config.cliArgs) &&
    config.cliArgs.length === 1 &&
    typeof config.cliArgs[0] === "string" &&
    path.isAbsolute(config.cliArgs[0]) &&
    config.cliArgs[0].endsWith("/dist/cli.js")
  ) {
    return { command: "node", args: [config.cliArgs[0]] };
  }
  if (fs.existsSync("./node_modules/.bin/mancode")) {
    return { command: "./node_modules/.bin/mancode", args: [] };
  }
  return { command: "mancode", args: [] };
}

const cli = resolveCli();
const result = spawnSync(
  cli.command,
  [...cli.args, "manps", ...(scanArea ? [scanArea] : []), ...(remediate ? ["--remediate"] : [])],
  { stdio: "inherit" },
);

if (result.error && result.error.code === "ENOENT") {
  console.error("mancode CLI not found. Run mancode init with the same CLI you want Claude Code to use, or install mancode in PATH.");
  process.exit(127);
}

process.exit(result.status ?? 1);
NODE
\`\`\`

如果 CLI 解析失败，停下来报告错误；不要用手写扫描替代确定性扫描，因为那会让报告格式和严重级别偏离 CLI。

其中 \`AREA\` 默认为空，表示运行默认扫描；也可以设成 \`all\`、\`deps\`、\`security\`、\`dead-code\`、\`config\` 之一。如果用户给的是目录/模块/主题，保持 \`AREA=""\`，让包装器运行默认扫描。如果用户给的是非空非法 area，包装器必须失败，不要静默降级。如果用户要求逐项确认，或者明确说要进入整改审核，设置 \`REMEDIATE=1\`。

扫描会生成：

- \`.mancode/preseason-reports/<date>.md\`
- \`.mancode/preseason-report.md\`
- \`.mancode/preseason-issues.json\`

\`--remediate\` 会对本次扫描问题逐条询问 \`y/n/skip/show files\`，并把 accepted/skipped/fixed 决策写回 \`.mancode/preseason-issues.json\`。它只执行白名单内、低风险且用户明确选择 \`y\` 的安全修复；当前自动执行范围包括创建缺失的 \`.gitignore\`、\`.editorconfig\`，以及从已安装工具依赖安全推断 \`test\` / \`lint\` / \`build\` package scripts。

CLI 成功后，再按下面的手动扫描清单做补充判断；补充判断不能覆盖 CLI 的 P0/P1/P2 结果，只能增加上下文和人工建议。

## Step 2: 补充扫描清单

### 1. Project Shape

- 读取检测到的 manifest、README、测试配置、lint/build 脚本
- 识别项目类型、语言、测试命令与构建命令；不假定特定生态
- 读取 \`.mancode/state.json\` 和 \`.mancode/aesthetics/style-tokens.json\`（如存在）

### 2. Tech Debt

使用 \`rg\` 搜索：

- \`TODO|FIXME|HACK|XXX|deprecated|legacy|temporary|workaround\`
- 大文件、重复实现、明显死代码
- 过时命名或与当前技术栈不一致的模式

### 3. Dependency Health

- 对照已检测到的 manifest、锁文件、依赖声明与源码 import
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
