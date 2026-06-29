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
        grep "\\"$key\\"" "$file" 2>/dev/null | sed 's/.*: "\\(.*\\)".*/\\1/' || true
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
echo "   - 检查 src/ 是否已有类似实现"
echo "   - 复用现有组件、函数、样式"
echo ""
echo "2. **应用项目审美 token**（前端任务）"
echo "   - UI library: $(sanitize "$UI_LIBRARY")"
echo "   - 使用项目已有的设计 token"
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
# mancode UserPromptSubmit hook - 注入 3 问追问 + 审美 token
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
        grep "\\"$key\\"" "$file" 2>/dev/null | sed 's/.*: "\\(.*\\)".*/\\1/' || true
    fi
}

# 清洗注入到 prompt 的动态值：去换行、限制长度，避免脏 token 污染上下文结构
sanitize() {
    printf '%s' "$1" | tr '\\n\\r' ' ' | head -c 200
}

MODE=$(json_get "currentMode" "$STATE_FILE")

# 只在 solo 模式下输出 3 问
if [ "$MODE" = "solo" ]; then
    echo "## 动手前，先想三个问题："
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
    echo "必须先调用 Skill tool，skill='man8'，把用户原始请求作为 task，执行 Scout 调研和 Head Coach plan。"
    echo "如果用户明确要求不要改代码，生成 plan 后停在确认步骤。"
    echo ""
fi

# 前端任务关键词检测（用 \b 词边界避免子串误匹配）
if echo "$USER_PROMPT" | grep -qiE "\\b(button|component|page|style|ui|design|layout|css|tailwind|color|font|theme|card|input|modal|dialog|header|footer|sidebar|dropdown|tooltip|toast|avatar|badge)\\b"; then
    if [ -f "$AESTHETICS_FILE" ]; then
        MATCH_LEVEL=$(json_get "matchLevel" "$AESTHETICS_FILE")

        if [ "$MATCH_LEVEL" = "high" ]; then
            if [ "$HAS_JQ" = "1" ]; then
            # 提取摘要 + cap（docs/07 §4.1：colors ≤8, fonts ≤4, 总 < 800 tokens）
            UI=$(jq -r '.uiLibrary // empty' "$AESTHETICS_FILE" 2>/dev/null)
            DARK=$(jq -r '.darkMode // empty' "$AESTHETICS_FILE" 2>/dev/null)
            MATCH=$(jq -r '.matchLevel // empty' "$AESTHETICS_FILE" 2>/dev/null)
            COLORS=$(jq -r '.colors | to_entries | .[0:8] | map("\\(.key)=\\(.value)") | join(", ")' "$AESTHETICS_FILE" 2>/dev/null)
            FONTS=$(jq -r '.fonts | to_entries | .[0:4] | map("\\(.key)=\\(.value | first)") | join(", ")' "$AESTHETICS_FILE" 2>/dev/null)

            echo "## 审美 token 摘要"
            [ -n "$UI" ] && echo "UI: $UI"
            [ -n "$DARK" ] && echo "Dark: $DARK"
            [ -n "$MATCH" ] && echo "Match: $MATCH"
            [ -n "$COLORS" ] && echo "Colors (前 8): $COLORS"
            [ -n "$FONTS" ] && echo "Fonts (前 4): $FONTS"
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

### 2. 审美一致性
前端任务：
- 使用项目已有的设计 token（颜色、字体）—— hook 会自动注入
- 复用现有组件，不重新造
- 匹配命名规范

### 3. 外科手术式修改
- 只改用户要求的部分
- 不重构无关代码
- 不"顺便优化"
- 保持 diff 最小

## 工作流

### 读取项目上下文
每次任务前：
1. 读取 \`.mancode/state.json\`（了解项目状态）
2. 搜索相似实现（"这个项目里有没有？"）
3. 检查可复用资源

### 前端任务
如果是 UI / 组件 / 样式任务：
1. UserPromptSubmit hook 会注入项目审美 token（colors/fonts/uiLibrary）
2. 严格使用注入的颜色值，不要猜
3. 项目已有 Button/Card/Input 等组件 → 必须复用
4. 不要引入项目色板以外的新颜色
5. 不要用 inline style 写颜色

### 反 AI slop 检查
前端输出前自检：
- ❌ 所有卡片都是 rounded-2xl shadow-md → 用项目实际 borderRadius
- ❌ 默认深色 + 紫色渐变 → 用项目主色
- ❌ 每个按钮都加 hover:scale-105 → 只在 CTA 用
- ❌ Loading 都用 spinner → 用项目已有 Skeleton

### 验证
代码完成后：
1. 运行 build（如有）
2. 运行 lint（如有）
3. 运行 test（如有）
4. 确认通过后才声称完成

## 你的风格

- 直接、简洁、不废话
- 改最少代码，达到最大效果
- 主见强，不啰嗦问用户
- 错误信息也要符合项目风格
`;
