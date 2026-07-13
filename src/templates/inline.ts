/**
 * Hook 和 Skill 模板（内联，避免打包后路径问题）
 */

export const SESSION_START_HOOK = String.raw`#!/usr/bin/env node
// .mancode/hooks/session-start.mjs
// mancode SessionStart hook - cross-platform project context
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const state = readJson(path.join(projectRoot, '.mancode', 'state.json'));
const profile =
  readJson(path.join(projectRoot, '.mancode', 'project-profile.json')) || {};

if (!state) {
  console.log('ℹ️ mancode 未初始化。运行 mancode init 开始。');
  process.exit(0);
}

const storedMode = text(state.currentMode) || 'solo';
const mode = storedMode === 'mamba' ? 'manba' : storedMode;
const techStack = sanitize(state.techStack);
const uiLibrary = sanitize(state.uiLibrary);
const output = [
  'mancode_mode: ' + mode,
  'project_type: ' + techStack,
  'ui_library: ' + uiLibrary,
  '',
  '## mancode · ' + mode + ' mode',
  '',
  '你正在使用 mancode ' + mode + ' 模式。',
  '',
  '### 核心原则',
  '1. **优先复用项目已有代码**',
  '   - 检查已检测到的源码目录和已有类似实现',
  '   - 复用现有组件、函数、样式',
  '',
];

if (profile.uiAssets === 'detected') {
  output.push(
    '2. **应用项目审美 token**（仅在项目 profile 确认有 UI 资产且任务涉及 UI 时）',
    '   - UI library: ' + uiLibrary,
    '   - 使用项目已有的设计 token',
  );
} else {
  output.push(
    '2. **按项目能力工作**',
    '   - 不假定存在 UI、浏览器或特定技术栈',
    '   - 先读取 project-profile 与项目现有验证方式',
  );
}

output.push(
  '',
  '3. **最小改动**',
  '   - 只改用户要求的部分',
  '   - 不重构无关代码',
);

if (state.teamModeAutoDetected === true && mode === 'solo') {
  output.push(
    '',
    '### 团队协作提醒',
    '检测到团队项目（contributors: ' +
      (Number.isFinite(state.contributors) ? state.contributors : 2) +
      '）。',
    '- 涉及多人协作、交接、PR、共享模块时，优先使用 /manteam <task>。',
    '- 只做个人小改动时，可以继续 solo；需要退出流程用 /mansolo。',
  );
}

if (
  mode === 'solo' &&
  state.activeSoloPlan &&
  typeof state.activeSoloPlan.taskId === 'string'
) {
  output.push(
    '',
    '### 已确认的 solo 实施计划',
    'Task: ' + sanitize(state.activeSoloPlan.taskId),
    'Plan version: ' + sanitize(state.activeSoloPlan.planVersion || 1),
    '- 收到继续实施指令时，先读对应 workflow 的 requirements.md 和 plan.md。',
    '- 按已确认范围轻量开发，不重新进入 /man，不运行独立 reviewer。',
  );
}

console.log(output.join('\n'));

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function sanitize(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
}
`;

export const USER_PROMPT_SUBMIT_HOOK = String.raw`#!/usr/bin/env node
// .mancode/hooks/user-prompt-submit.mjs
// mancode UserPromptSubmit hook - cross-platform prompt and style context
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const mancodeDir = path.join(projectRoot, '.mancode');
const state = readJson(path.join(mancodeDir, 'state.json')) || {};
const profile = readJson(path.join(mancodeDir, 'project-profile.json')) || {};
const mode = typeof state.currentMode === 'string' ? state.currentMode : '';
const output = [];

if (mode === 'solo') {
  output.push(
    '## 动手前，先想六个问题：',
    '',
    '1. **为什么做？**',
    '   - 这个改动解决什么问题？',
    '',
    '2. **已经有什么？**',
    '   - 项目里有没有类似的实现可以复用？',
    '',
    '3. **最少改多少？**',
    '   - 能用一行解决吗？能复用现有代码吗？',
    '',
    '4. **能不能不拆新系统？**',
    '   - 不新建文件或模块能完成吗？',
    '',
    '5. **非平凡逻辑怎样最小运行验证？**',
    '',
    '6. **有什么没把握的？**',
    '   - 先自行查代码或文档，最多 2 次工具调用；仍不确定再问用户。',
    '',
  );
}

const rawInput = readFileSync(0, 'utf8');
const userPrompt = readPrompt(rawInput);
const planningPattern = /先(?:别|不要|看|看看|调研|分析|评估)|给.*方案|给.*计划|怎么.*做|如何.*做|怎么.*实现|如何.*实现|应该怎么|怎么.*拆|拆分|只给.*计划|不要.*改代码|别.*改代码|不要.*动代码|别.*动代码|评估.*风险|风险.*评估|设计.*方案|架构|迁移|集成|\b(?:plan|planning|research|investigate|approach|proposal|architecture|risk|migration|integration)\b|how (?:should|would|to)|do not (?:edit|modify|change)|don.t (?:edit|modify|change)|no code changes|without changing code/iu;
const approvedPlanExecutionPattern = /按.*计划|继续.*计划|执行.*计划|实现.*计划|(?:implement|execute|continue|resume).*(?:approved )?plan/iu;
const hasActiveSoloPlan =
  mode === 'solo' &&
  state.activeSoloPlan &&
  typeof state.activeSoloPlan.taskId === 'string';

if (hasActiveSoloPlan) {
  output.push(
    '## mancode 已确认计划',
    '',
    '当前 solo 计划：.mancode/workflows/' +
      sanitize(state.activeSoloPlan.taskId) +
      '/plan.md（v' +
      sanitize(state.activeSoloPlan.planVersion || 1) +
      '）。',
    '实施前同时读取 requirements.md；只执行确认范围，完成后运行 workflow handoff <taskId> --complete。',
    '',
  );
}

if (
  mode === 'solo' &&
  planningPattern.test(userPrompt) &&
  !(hasActiveSoloPlan && approvedPlanExecutionPattern.test(userPrompt))
) {
  output.push(
    '## mancode 自动路由',
    '',
    '这个请求是规划/调研类任务。不要直接进入 solo 实施。',
    "必须先调用 Skill tool，skill='man'，把用户原始请求作为 task，执行 Scout 调研、澄清和 Plan Coach plan。",
    '用户只要计划时，在 Step 4 选择“只要计划”；不要切到另一个命令。',
    '',
  );
}

const uiPattern = /\b(?:button|component|page|style|ui|design|layout|css|color|font|theme|card|input|modal|dialog|header|footer|sidebar|dropdown|tooltip|toast|avatar|badge)\b|界面|页面|按钮|样式|颜色|字体|布局|组件|弹窗|导航|卡片|输入框|主题|美化|优化.*界面|调整.*样式/iu;

if (profile.uiAssets === 'detected' && uiPattern.test(userPrompt)) {
  appendAestheticSummary(
    output,
    readJson(path.join(mancodeDir, 'aesthetics', 'style-tokens.json')),
  );
}

if (output.length > 0) console.log(output.join('\n'));

function appendAestheticSummary(lines, tokens) {
  if (!tokens || tokens.matchLevel !== 'high') return;

  const colors = safeEntries(tokens.colors, 8).map(
    ([key, value]) => key + '=' + String(value),
  );
  const fonts = safeEntries(tokens.fonts, 4)
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([key, value]) => key + '=' + String(value[0]));
  const components = Array.isArray(tokens.components)
    ? tokens.components
        .filter(
          (value) =>
            typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,79}$/.test(value),
        )
        .slice(0, 8)
    : [];
  const cssVariables = safeEntries(tokens.cssVariables, 8).map(
    ([key, value]) => '--' + key + '=' + String(value),
  );

  lines.push('## 审美 token 摘要');
  appendValue(lines, 'UI', tokens.uiLibrary);
  appendValue(lines, 'Dark', tokens.darkMode);
  appendValue(lines, 'Match', tokens.matchLevel);
  appendValue(lines, 'Colors (前 8)', colors.join(', '));
  appendValue(lines, 'Fonts (前 4)', fonts.join(', '));
  appendValue(lines, 'Components (前 8)', components.join(', '));
  appendValue(lines, 'CSS variables (前 8)', cssVariables.join(', '));
  lines.push('完整 token: .mancode/aesthetics/style-tokens.json', '');
}

function safeEntries(value, limit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([key]) => /^[A-Za-z0-9_-]{1,80}$/.test(key))
    .slice(0, limit);
}

function appendValue(lines, label, value) {
  const clean = sanitize(value);
  if (clean) lines.push(label + ': ' + clean);
}

function readPrompt(input) {
  try {
    const parsed = JSON.parse(input);
    return typeof parsed.prompt === 'string' && parsed.prompt
      ? parsed.prompt
      : input;
  } catch {
    return input;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sanitize(value) {
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
}
`;

export const SOLO_SKILL = `# mancode · solo mode

你正在使用 mancode solo 模式。

## 核心原则

### 1. YAGNI 阶梯
在写新代码前，检查：
1. 已存在？→ 复用
2. 标准库？→ 用它
3. 平台特性？→ 用它
4. 已装依赖？→ 用它
5. 一行能解决？→ 一行
6. 只有以上都不行，才写最小实现

### 2. 项目一致性
- 先读 \`.mancode/project-profile.json\`，不假定项目类型、语言、UI 或浏览器能力。
- 只有 profile 确认 UI 资产且任务涉及 UI 时，才使用已有设计 token；复用组件，不重新造。
- 所有项目都匹配已有命名、错误处理、测试与交付规范。

### 3. 外科手术式修改
- 只改用户要求的部分
- 不重构无关代码
- 不"顺便优化"
- 保持 diff 最小

## 工作流

### 读取项目上下文
每次任务前：
1. 读取 \`.mancode/state.json\`（了解项目状态）
2. 读取 \`.mancode/project-profile.json\`（了解检测到的源码目录、能力和验证方式）
3. 搜索相似实现（"这个项目里有没有？"）
4. 检查可复用资源

### 执行已确认的 /man 计划
当 \`.mancode/state.json\` 的 \`activeSoloPlan\` 非空且用户要求继续该计划时：
1. 读取对应 workflow 的 \`requirements.md\` 和 \`plan.md\`，确认 taskId 与 planVersion。
2. 开工前回执目标、技术方案、包含范围、排除范围、验证方式和残余假设。
3. 只按计划轻量实施；不重新规划、不调用 Film Reviewer、不创建新的 /man workflow。
4. 发现会改变架构、范围或验收的缺口时暂停并询问，不自行扩大计划。
5. 完成最窄有效验证和一次受限 diff 自检后，运行 \`mancode workflow handoff <taskId> --complete\`；由 CLI 原子清理 \`activeSoloPlan\`、把 workflow 标记 completed 并移出 Active Plans，保留计划文件。

### UI 任务（条件执行）
仅当 project-profile 确认有 UI 资产且任务确实涉及界面时：
1. UserPromptSubmit hook 会注入项目审美 token（如有）
2. 严格使用已有 token 和组件；没有可靠 token 时先检查现有界面，再提出最小一致方案
3. 不把特定框架、组件名、色板或交互范式当作默认
4. 以项目既有的无障碍、响应式与反馈方式为准

### 界面质量检查（条件执行）
只检查本次 diff 新增或改变的界面行为：复用已有层级、token 和组件；新增异步或交互路径时才检查对应的加载、失败和可达性状态。不要借 UI 自检巡查未改动页面或补齐推测性状态。

### 验证
代码完成后：
1. 选择与本次改动直接相关的最窄 test、lint、typecheck、build 或 smoke check
2. 文案、注释或纯静态资源改动不强制运行完整测试矩阵
3. 确认实际执行结果后才声称完成

### 完成后的一次受限自检
- 只做一次，只看本次 diff、需求和直接受影响路径；不调用额外 reviewer，不生成审查报告，不重复巡检。
- 验证失败、行为回归或遗留 debug 可直接修复并复验；复验不是新一轮 review。
- 命名、可读性、DRY、loading/error 形式等建议不自动扩大改动；与需求无关时不输出。
- 只有鉴权、支付、敏感数据、迁移/删除、公开 API、未可信输入、并发或基础设施等硬风险出现时，才用一句话建议 \`/man\`；用户说“继续 solo”即可继续。

## 你的风格

- 直接、简洁、不废话
- 改最少代码，达到最大效果
- 主见强，不啰嗦问用户
- 错误信息也要符合项目风格
`;
