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
command -v jq >/dev/null 2>&1 && HAS_JQ=1

json_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\\"$key\\"" "$file" 2>/dev/null | sed 's/.*: "\\(.*\\)".*/\\1/' || true
    fi
}

if [ ! -f "$STATE_FILE" ]; then
    echo "ℹ️ mancode 未初始化。运行 \\\`mancode init\\\` 开始。"
    exit 0
fi

MODE=$(json_get "currentMode" "$STATE_FILE")
TECH_STACK=$(json_get "techStack" "$STATE_FILE")
UI_LIBRARY=$(json_get "uiLibrary" "$STATE_FILE")

echo "mancode_mode: \${MODE:-solo}"
echo "project_type: $TECH_STACK"
echo "ui_library: $UI_LIBRARY"
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
echo "   - UI library: $UI_LIBRARY"
echo "   - 使用项目已有的设计 token"
echo ""
echo "3. **最小改动**"
echo "   - 只改用户要求的部分"
echo "   - 不重构无关代码"
`;

export const USER_PROMPT_SUBMIT_HOOK = `#!/bin/bash
# .mancode/hooks/user-prompt-submit.sh
# mancode UserPromptSubmit hook - 注入 3 问追问
set -uo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
STATE_FILE="$PROJECT_ROOT/.mancode/state.json"

HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

json_get() {
    local key="$1"
    local file="$2"
    if [ "$HAS_JQ" = "1" ]; then
        jq -r ".$key // empty" "$file" 2>/dev/null || true
    else
        grep "\\"$key\\"" "$file" 2>/dev/null | sed 's/.*: "\\(.*\\)".*/\\1/' || true
    fi
}

MODE=$(json_get "currentMode" "$STATE_FILE")

if [ "$MODE" = "solo" ] || [ -z "$MODE" ]; then
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
# 读取 prompt 字段
if [ "$HAS_JQ" = "1" ]; then
    USER_PROMPT=$(jq -r '.prompt // ""' 2>/dev/null || echo "")
else
    # 无 jq fallback: 读取整个输入作为 prompt
    USER_PROMPT=$(cat)
fi

if echo "$USER_PROMPT" | grep -qiE "button|component|page|style|ui|design|layout|css|tailwind"; then
    AESTHETICS_FILE="$PROJECT_ROOT/.mancode/aesthetics/style-tokens.json"
    if [ -f "$AESTHETICS_FILE" ]; then
        echo "## 审美 token 已加载"
        echo ""
        echo "使用项目已有的设计 token（颜色、字体、组件）。"
        echo ""
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
- 使用项目已有的设计 token（颜色、字体）
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
1. 读取 \`.mancode/aesthetics/style-tokens.json\`（如有）
2. 使用项目的颜色、字体、组件
3. 不要猜颜色值，用 token

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
