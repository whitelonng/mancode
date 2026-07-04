# MVP-2 Beta 人工测试计划

日期：2026-07-03
分支：`develop`
版本：`0.1.0-beta.0`

## 审核状态

人工测试开始前，自动化发布检查已经通过：

- `npm run lint`
- `npm run build`
- `npm test`
- 严格 CLI 烟测：覆盖 init、skills、agents、审美扫描、`manps --remediate`、commit hook、workflow list

当前没有已知阻断问题。人工测试重点放在 Claude Code 真实运行时行为，因为这部分单元测试只能验证安装产物和 CLI 输出，不能完全证明 slash command 交互体验。

## 前置条件

- Node.js 20+
- Git
- 已安装 Claude Code，并且 Claude Code 能加载项目内 `.claude/skills`
- 一个一次性 git 测试仓库

先在 mancode 仓库里构建本地 beta 候选版本：

```bash
cd /Users/whitelonng/code/mancode/.claude/worktrees/objective-poincare-22ba7c
npm ci
npm run build
```

下面测试命令默认使用本地构建产物：

```bash
node /Users/whitelonng/code/mancode/.claude/worktrees/objective-poincare-22ba7c/dist/cli.js
```

如果你要测试已经发布或全局安装的 npm beta 包，可以把命令替换成：

```bash
mancode
```

## 测试项目准备

创建一个一次性测试项目：

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
git init
cat > package.json <<'JSON'
{
  "name": "mancode-mvp2-beta-manual",
  "dependencies": {
    "react": "^18.0.0",
    "tailwindcss": "^3.4.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "typescript": "^5.0.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
JSON
mkdir -p src/components/ui src/app
cat > tailwind.config.js <<'JS'
module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      colors: { primary: "#2563eb" },
      fontFamily: { sans: ["Inter", "sans-serif"] }
    }
  }
};
JS
cat > src/components/ui/button.tsx <<'TS'
export function Button() {
  return null;
}
TS
cat > src/app/globals.css <<'CSS'
:root {
  --radius: 8px;
  --background: #ffffff;
}
CSS
```

设置一个本地测试命令，后续步骤直接使用 `mancode_local`。这个写法兼容 zsh 和 bash：

```bash
mancode_local() {
  node /Users/whitelonng/code/mancode/.claude/worktrees/objective-poincare-22ba7c/dist/cli.js "$@"
}
```

## 测试用例

### 1. 初始化 MVP-2 Beta 安装

测试方法：

```bash
mancode_local init --force --team --style clean
```

预期结果：

- 退出码是 `0`。
- 输出中识别出 React、TypeScript、Tailwind CSS。
- `.mancode/state.json` 存在。
- `.mancode/aesthetics/style-tokens.json` 存在。
- `.claude/settings.json` 存在。
- `.claude/skills/solo/SKILL.md` 存在。
- MVP-2 skills 存在：
  - `.claude/skills/man8/SKILL.md`
  - `.claude/skills/man/SKILL.md`
  - `.claude/skills/manteam/SKILL.md`
  - `.claude/skills/manps/SKILL.md`
  - `.claude/skills/mansolo/SKILL.md`
- 教练组 agents 存在：
  - `.claude/agents/scout.md`
  - `.claude/agents/head-coach.md`
  - `.claude/agents/film-analyst-offense.md`
  - `.claude/agents/film-analyst-defense.md`

### 2. 验证审美扫描结果

测试方法：

```bash
cat .mancode/aesthetics/style-tokens.json
```

预期结果：

- `colors.primary` 是 `#2563eb`。
- `fonts.sans` 包含 `Inter`。
- `components` 包含 `Button`。
- `cssVariables.radius` 是 `8px`。
- `darkMode` 是 `class`。
- `matchLevel` 是 `high`。

### 3. 验证 status 和 hook 注入预算

测试方法：

```bash
mancode_local status
```

预期结果：

- 退出码是 `0`。
- 输出显示已安装平台 `Claude Code`。
- 输出显示两个 hooks 都存在并已注册。
- 输出包含 `Hook injection: ~... tokens (cap 800)`。

### 4. 验证 Claude Code Slash Skill 加载

测试方法：

1. 用 Claude Code 打开这个一次性测试项目。
2. 如果 Claude Code 已经打开过该项目，先重启 Claude Code。
3. 输入 `/`，查看可用的项目 skills。

预期结果：

- `/man8`、`/man`、`/manteam`、`/manps`、`/mansolo`、`/solo` 可见或可直接调用。
- 调用任意 skill 时，不应报 skill 文件缺失。

### 5. 测试 `/man8`

测试方法：

在 Claude Code 中输入：

```text
/man8 评估如何给这个项目添加登录页，不要改代码
```

预期结果：

- Claude 进入调研/规划流程，而不是直接实现。
- 响应会读取项目上下文，并体现 Scout / Head Coach 风格的计划过程。
- `.mancode/state.json` 更新为 `currentMode: "man8"`。
- 创建 `.mancode/workflows/<taskId>/metadata.json`。
- 响应最终给出计划，或在写代码前请求确认。

### 6. 测试 `/man`

测试方法：

在 Claude Code 中执行一个很小、可丢弃的任务：

```text
/man 给 README 增加一行测试说明
```

预期结果：

- Claude 进入完整 `/man` workflow。
- 流程包含 scout、plan、implementation、review、fix、review。
- `.mancode/state.json` 更新为 `currentMode: "man"`。
- `.mancode/workflows/` 下创建 workflow 目录。
- 不应静默跳过 review 步骤。

测试后清理：

```bash
git checkout -- README.md 2>/dev/null || true
```

### 7. 测试 `/manteam`

测试方法：

在 Claude Code 中输入：

```text
/manteam 准备一个多人协作的登录页改造计划
```

预期结果：

- Claude 读取或创建 `.mancode/memory/prd.md`、`spec.md`、`decisions.md`。
- Claude 检查团队上下文，例如 git history、handoff notes。
- 响应引用 `.mancode/team/commit-template.txt`。
- 如果讨论 PR 输出，响应引用 `.github/PULL_REQUEST_TEMPLATE.md`。
- 不覆盖已有 memory 或 template 内容。

### 8. 测试 `/manps` 扫描

测试方法：

在 Claude Code 中输入：

```text
/manps config
```

预期结果：

- Claude 执行 `mancode manps config`。
- `.mancode/preseason-report.md` 被创建或更新。
- `.mancode/preseason-issues.json` 被创建或更新。
- `.mancode/preseason-reports/` 下出现带时间戳的报告。
- 响应总结 P1/P2 问题。
- 默认扫描不修改项目文件。

CLI 交叉验证：

```bash
mancode_local manps config
```

预期 CLI 结果：

- 退出码是 `0`。
- 输出包含 `mancode preseason scan`。
- 输出包含 `Area:     config`。

### 9. 测试 `/manps --remediate`

测试方法：

用显式答案运行 CLI 整改：

```bash
printf 'y\ny\ny\ny\ny\n' | mancode_local manps config --remediate
```

预期结果：

- 退出码是 `0`。
- 输出包含 `Remediation review`。
- 输出显示 accepted 和 fixed 数量。
- 如果缺失，创建 `.gitignore`。
- 如果缺失，创建 `.editorconfig`。
- `package.json` 增加安全推断出的 scripts：
  - `test`: `vitest run`
  - `lint`: `biome check .`
  - `build`: `vite build`
- `.mancode/preseason-issues.json` 记录 fixed remediation 条目。

负向验证：

```bash
tmpdir2="$(mktemp -d)"
cd "$tmpdir2"
git init
mkdir -p .mancode
echo '{"currentMode":"solo"}' > .mancode/state.json
echo '{}' > package.json
printf 'y\ny\ny\n' | mancode_local manps config --remediate
cat package.json
```

预期负向结果：

- 因为没有匹配的工具依赖，不会添加 scripts。
- scripts 类问题会记录 accepted，但不会自动 fixed。

### 10. 测试 `/mansolo`

测试方法：

在 `/man8` 或 `/man` 之后，在 Claude Code 中输入：

```text
/mansolo
```

预期结果：

- Claude 切回 solo mode。
- `.mancode/state.json` 满足：
  - `currentMode: "solo"`
  - `currentTask: null`
  - `currentWorkflowMode: null`
  - `skippedSteps: []`
- 如果仍有进行中的 workflow，Claude 会在放弃前询问确认。

### 11. 测试可选 commit hook

测试方法：

```bash
mancode_local install claude-code --commit-hook
test -x .mancode/team/commit-msg.sh
test -x "$(git rev-parse --git-path hooks/commit-msg)"
printf 'feat(beta): manual smoke\n' > good-msg.txt
"$(git rev-parse --git-path hooks/commit-msg)" good-msg.txt
printf 'bad message\n' > bad-msg.txt
if "$(git rev-parse --git-path hooks/commit-msg)" bad-msg.txt; then
  echo "unexpected pass"
  exit 1
fi
```

预期结果：

- 合法 Conventional Commit message 退出码是 `0`。
- 非法 message 退出码非 `0`。
- 错误输出提到 Conventional Commits。
- 除非已有 hook 是 mancode 管理的 hook，否则不覆盖用户自定义 hook。

### 12. 测试 Workflow CLI

测试方法：

```bash
mancode_local workflow list
```

预期结果：

- 退出码是 `0`。
- 没有 workflow 时不会崩溃。
- 有 workflow 时正常列出。

### 13. 测试 Minimal Install

测试方法：

```bash
mancode_local install claude-code --force --minimal
```

预期结果：

- `.claude/skills/solo/SKILL.md` 保留。
- MVP-2 skills 被移除：
  - `.claude/skills/man8`
  - `.claude/skills/man`
  - `.claude/skills/manteam`
  - `.claude/skills/manps`
  - `.claude/skills/mansolo`
- `.claude/agents` 被移除。

测试后恢复完整安装：

```bash
mancode_local install claude-code --force
```

预期恢复结果：

- MVP-2 skills 和 agents 被重新创建。

## 通过标准

满足以下条件即可认为 MVP-2 beta 人工测试通过：

- 所有 CLI 命令退出码符合预期。
- Claude Code 可以调用所有 MVP-2 slash skills。
- `/man8`、`/man`、`/manteam`、`/manps`、`/mansolo` 按预期更新或保留状态。
- `manps --remediate` 只在显式输入 `y` 后执行文档列出的安全修复。
- 可选 commit hook 默认不启用，启用后能强制 Conventional Commits。
- 不意外覆盖用户已有 templates、memory files 或自定义 hooks。

## 已知非阻塞限制

- `/warmup`、`/playoffs`、`/team`、`/preseason`、`/back-to-solo` 这些别名仍是计划项，尚未启用。
- `manps` security scan 目前是启发式扫描，还没有接真实漏洞数据库。
- dead-code scan 目前是启发式扫描，还没有构建完整 import graph。
- Claude Code 的 slash 行为必须在真实 Claude Code 会话中人工验证；单元测试只能验证 skill 文件和 CLI 输出。
