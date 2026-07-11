/**
 * Hook 和 Skill 模板（内联，避免打包后路径问题）
 */

export const SESSION_START_HOOK = `#!/bin/bash
# .mancode/hooks/session-start.sh
# mancode SessionStart hook - 加载项目上下文
# 系统依赖：bash、git、（可选）jq
set -uo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
STATE_FILE="$PROJECT_ROOT/.mancode/state.json"
PROFILE_FILE="$PROJECT_ROOT/.mancode/project-profile.json"

HAS_JQ=0
if [ "\${MANCODE_DISABLE_JQ:-0}" != "1" ]; then
    command -v jq >/dev/null 2>&1 && HAS_JQ=1
fi

json_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\\"$key\\"" "$file" 2>/dev/null | sed -E 's/.*: *"([^"]*)".*/\\1/' || true
    fi
}

json_any_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\\"$key\\"" "$file" 2>/dev/null | head -n 1 | sed -E 's/.*: *"?([^",}]*)"?[,]?.*/\\1/' || true
    fi
}

if [ ! -f "$STATE_FILE" ]; then
    echo "ℹ️ mancode 未初始化。运行 \\\`mancode init\\\` 开始。"
    exit 0
fi

# 清洗函数：去换行、限制长度（防止脏数据污染 prompt）
sanitize() {
    printf '%s' "\$1" | tr '\\n\\r' ' ' | head -c 200
}

MODE=$(json_get "currentMode" "$STATE_FILE")
TECH_STACK=$(json_get "techStack" "$STATE_FILE")
UI_LIBRARY=$(json_get "uiLibrary" "$STATE_FILE")
TEAM_AUTO=$(json_any_get "teamModeAutoDetected" "$STATE_FILE")
CONTRIBUTORS=$(json_any_get "contributors" "$STATE_FILE")

echo "mancode_mode: \${MODE:-solo}"
echo "project_type: $(sanitize "$TECH_STACK")"
echo "ui_library: $(sanitize "$UI_LIBRARY")"
echo ""

echo "## mancode · \${MODE:-solo} mode"
echo ""
echo "你正在使用 mancode \${MODE:-solo} 模式。"
echo ""
echo "### 核心原则"
echo "1. **优先复用项目已有代码**"
echo "   - 检查已检测到的源码目录和已有类似实现"
echo "   - 复用现有组件、函数、样式"
echo ""
if [ "$(json_get "uiAssets" "$PROFILE_FILE")" = "detected" ]; then
    echo "2. **应用项目审美 token**（仅在项目 profile 确认有 UI 资产且任务涉及 UI 时）"
    echo "   - UI library: $(sanitize "$UI_LIBRARY")"
    echo "   - 使用项目已有的设计 token"
else
    echo "2. **按项目能力工作**"
    echo "   - 不假定存在 UI、浏览器或特定技术栈"
    echo "   - 先读取 project-profile 与项目现有验证方式"
fi
echo ""
echo "3. **最小改动**"
echo "   - 只改用户要求的部分"
echo "   - 不重构无关代码"

if [ "$TEAM_AUTO" = "true" ] && [ "\${MODE:-solo}" = "solo" ]; then
    echo ""
    echo "### 团队协作提醒"
    echo "检测到团队项目（contributors: \${CONTRIBUTORS:-2}）。"
    echo '- 涉及多人协作、交接、PR、共享模块时，优先使用 /manteam <task>。'
    echo '- 只做个人小改动时，可以继续 solo；需要退出流程用 /mansolo。'
fi
`;

export const USER_PROMPT_SUBMIT_HOOK = `#!/bin/bash
# .mancode/hooks/user-prompt-submit.sh
# mancode UserPromptSubmit hook - 注入 6 问追问 + 审美 token
set -uo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
STATE_FILE="$PROJECT_ROOT/.mancode/state.json"
AESTHETICS_FILE="$PROJECT_ROOT/.mancode/aesthetics/style-tokens.json"

HAS_JQ=0
if [ "\${MANCODE_DISABLE_JQ:-0}" != "1" ]; then
    command -v jq >/dev/null 2>&1 && HAS_JQ=1
fi

json_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\\"$key\\"" "$file" 2>/dev/null | sed -E 's/.*: *"([^"]*)".*/\\1/' || true
    fi
}

# 清洗注入到 prompt 的动态值：去换行、限制长度，避免脏 token 污染上下文结构
sanitize() {
    printf '%s' "$1" | tr '\\n\\r' ' ' | head -c 200
}

MODE=$(json_get "currentMode" "$STATE_FILE")

# 只在 solo 模式下输出 6 问
if [ "$MODE" = "solo" ]; then
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
    echo "4. **能不能不拆新系统？**"
    echo "   - 不新建文件或模块能完成吗？"
    echo ""
    echo "5. **非平凡逻辑怎样最小运行验证？**"
    echo ""
    echo "6. **有什么没把握的？**"
    echo "   - 先自行查代码或文档，最多 2 次工具调用；仍不确定再问用户。"
    echo ""
fi

# Claude Code 通过 stdin 传入 JSON: {"prompt": "...", ...}
# 先读取完整输入，再解析
INPUT=$(cat)

if [ "$HAS_JQ" = "1" ]; then
    USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)
    # jq 失败或返回空，fallback 到原始输入
    if [ -z "$USER_PROMPT" ]; then
        USER_PROMPT="$INPUT"
    fi
else
    # 无 jq: 使用 sed 提取 JSON 中的 prompt 字段
    USER_PROMPT=$(echo "$INPUT" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    # sed 失败，fallback 到原始输入
    if [ -z "$USER_PROMPT" ]; then
        USER_PROMPT="$INPUT"
    fi
fi

if [ "$MODE" = "solo" ] && echo "$USER_PROMPT" | grep -qiE "先(别|不要|看|看看|调研|分析|评估)|给.*方案|给.*计划|怎么.*做|如何.*做|怎么.*实现|如何.*实现|应该怎么|怎么.*拆|拆分|只给.*计划|不要.*改代码|别.*改代码|不要.*动代码|别.*动代码|评估.*风险|风险.*评估|设计.*方案|架构|迁移|集成|\\b(plan|planning|research|investigate|approach|proposal|architecture|risk|migration|integration)\\b|how (should|would|to)|do not (edit|modify|change)|don.t (edit|modify|change)|no code changes|without changing code"; then
    echo "## mancode 自动路由"
    echo ""
    echo "这个请求是规划/调研类任务。不要直接进入 solo 实施。"
    echo "必须先调用 Skill tool，skill='man'，把用户原始请求作为 task，执行 Scout 调研、澄清和 Plan Coach plan。"
    echo "用户只要计划时，在 Step 4 选择“只要计划”；不要切到另一个命令。"
    echo ""
fi

# UI token 仅在 profile 确认存在 UI 资产且任务明确涉及 UI 时注入。
PROFILE_FILE="$PROJECT_ROOT/.mancode/project-profile.json"
UI_ASSETS=""
if [ -f "$PROFILE_FILE" ]; then
    UI_ASSETS=$(json_get "uiAssets" "$PROFILE_FILE")
fi
if [ "$UI_ASSETS" = "detected" ] && echo "$USER_PROMPT" | grep -qiE "\\b(button|component|page|style|ui|design|layout|css|color|font|theme|card|input|modal|dialog|header|footer|sidebar|dropdown|tooltip|toast|avatar|badge)\\b|界面|页面|按钮|样式|颜色|字体|布局|组件|弹窗|导航|卡片|输入框|主题|美化|优化.*界面|调整.*样式"; then
    if [ -f "$AESTHETICS_FILE" ]; then
        MATCH_LEVEL=$(json_get "matchLevel" "$AESTHETICS_FILE")

        if [ "$MATCH_LEVEL" = "high" ]; then
            if [ "$HAS_JQ" = "1" ]; then
            # 提取摘要 + cap（docs/07 §4.1：colors ≤8, fonts ≤4, 总 < 800 tokens）
            UI=$(jq -r '.uiLibrary // empty' "$AESTHETICS_FILE" 2>/dev/null)
            DARK=$(jq -r '.darkMode // empty' "$AESTHETICS_FILE" 2>/dev/null)
            MATCH=$(jq -r '.matchLevel // empty' "$AESTHETICS_FILE" 2>/dev/null)
            COLORS=$(jq -r '.colors | to_entries | map(select(.key | test("^[A-Za-z0-9_-]{1,80}$"))) | .[0:8] | map("\\(.key)=\\(.value)") | join(", ")' "$AESTHETICS_FILE" 2>/dev/null)
            FONTS=$(jq -r '.fonts | to_entries | map(select(.key | test("^[A-Za-z0-9_-]{1,80}$"))) | .[0:4] | map("\\(.key)=\\(.value | first)") | join(", ")' "$AESTHETICS_FILE" 2>/dev/null)
            COMPONENTS=$(jq -r '(.components // []) | map(select(test("^[A-Z][A-Za-z0-9]{0,79}$"))) | .[0:8] | join(", ")' "$AESTHETICS_FILE" 2>/dev/null)
            CSS_VARS=$(jq -r '(.cssVariables // {}) | to_entries | map(select(.key | test("^[A-Za-z0-9_-]{1,80}$"))) | .[0:8] | map("--\\(.key)=\\(.value)") | join(", ")' "$AESTHETICS_FILE" 2>/dev/null)

            echo "## 审美 token 摘要"
            [ -n "$UI" ] && echo "UI: $(sanitize "$UI")"
            [ -n "$DARK" ] && echo "Dark: $(sanitize "$DARK")"
            [ -n "$MATCH" ] && echo "Match: $(sanitize "$MATCH")"
            [ -n "$COLORS" ] && echo "Colors (前 8): $(sanitize "$COLORS")"
            [ -n "$FONTS" ] && echo "Fonts (前 4): $(sanitize "$FONTS")"
            [ -n "$COMPONENTS" ] && echo "Components (前 8): $(sanitize "$COMPONENTS")"
            [ -n "$CSS_VARS" ] && echo "CSS variables (前 8): $(sanitize "$CSS_VARS")"
            echo "完整 token: .mancode/aesthetics/style-tokens.json"
            echo ""
        else
            # 无 jq: 只输出指针（cap 无法严格执行）
            echo "## 审美 token"
            echo "读取 .mancode/aesthetics/style-tokens.json"
            echo ""
        fi
    fi
fi
fi
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
