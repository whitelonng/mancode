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

# 清洗函数：去换行、限制长度（防止脏数据污染 prompt）
sanitize() {
    printf '%s' "\$1" | tr '\\n\\r' ' ' | head -c 200
}

MODE=$(json_get "currentMode" "$STATE_FILE")
TECH_STACK=$(json_get "techStack" "$STATE_FILE")
UI_LIBRARY=$(json_get "uiLibrary" "$STATE_FILE")

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
`;

export const USER_PROMPT_SUBMIT_HOOK = `#!/bin/bash
# .mancode/hooks/user-prompt-submit.sh
# mancode UserPromptSubmit hook - 注入 3 问追问 + 审美 token
set -uo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
STATE_FILE="$PROJECT_ROOT/.mancode/state.json"
AESTHETICS_FILE="$PROJECT_ROOT/.mancode/aesthetics/style-tokens.json"

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

# 前端任务关键词检测（用 \b 词边界避免子串误匹配）
if echo "$USER_PROMPT" | grep -qiE "\\b(button|component|page|style|design|layout|css|tailwind|color|font|theme|card|input|modal|dialog|header|footer|sidebar|dropdown|tooltip|toast|avatar|badge)\\b"; then
    if [ -f "$AESTHETICS_FILE" ]; then
        MATCH_LEVEL=$(json_get "matchLevel" "$AESTHETICS_FILE")

        if [ "$MATCH_LEVEL" = "high" ]; then
            # 有完整设计 token，注入实际值
            echo "## 审美 token（必须遵循）"
            echo ""
            echo "已从项目扫描到设计 token，前端任务必须使用以下值："
            echo ""

            UI_LIB=$(json_get "uiLibrary" "$AESTHETICS_FILE")
            if [ -n "$UI_LIB" ] && [ "$UI_LIB" != "null" ]; then
                echo "- **UI 库**: $(sanitize "$UI_LIB")"
                echo "  优先复用已有组件，不要自己造"
                echo ""
            fi

            DARK_MODE=$(json_get "darkMode" "$AESTHETICS_FILE")
            if [ -n "$DARK_MODE" ] && [ "$DARK_MODE" != "null" ]; then
                echo "- **Dark mode**: $(sanitize "$DARK_MODE")"
                echo ""
            fi

            # 注入 colors（有 jq 时用 jq 遍历，无 jq 时提示读文件）
            if [ "$HAS_JQ" = "1" ]; then
                COLORS_COUNT=$(jq -r '.colors | length' "$AESTHETICS_FILE" 2>/dev/null || echo 0)
                if [ "$COLORS_COUNT" -gt 0 ] 2>/dev/null; then
                    echo "- **颜色**（不要引入新颜色，只用这些）:"
                    jq -r '.colors | to_entries[] | "\\(.key): \\(.value)"' "$AESTHETICS_FILE" 2>/dev/null | while IFS= read -r line; do
                        echo "  - $(sanitize "$line")"
                    done
                    echo ""
                fi

                FONTS_COUNT=$(jq -r '.fonts | length' "$AESTHETICS_FILE" 2>/dev/null || echo 0)
                if [ "$FONTS_COUNT" -gt 0 ] 2>/dev/null; then
                    echo "- **字体**（不要引入新字体，只用这些）:"
                    jq -r '.fonts | to_entries[] | "\\(.key): \\(.value | join(\", \"))"' "$AESTHETICS_FILE" 2>/dev/null | while IFS= read -r line; do
                        echo "  - $(sanitize "$line")"
                    done
                    echo ""
                fi
            else
                echo "- **颜色/字体**: 见 .mancode/aesthetics/style-tokens.json"
                echo "  读取该文件获取项目的 colors 和 fonts"
                echo ""
            fi

            echo "### 禁止事项"
            echo "- ❌ 不要引入项目色板以外的新颜色"
            echo "- ❌ 不要用 inline style 写颜色值"
            echo "- ❌ 不要引入新字体"
            echo "- ❌ 不要自己造已有 UI 库的组件"
            echo ""

        elif [ "$MATCH_LEVEL" = "low" ]; then
            echo "## 审美提示"
            echo ""
            echo "检测到 Tailwind CSS 依赖，但未找到 tailwind.config 配置文件。"
            echo "建议运行 'mancode refresh-style' 重新扫描，或手动添加 tailwind.config.js。"
            echo ""

        elif [ "$MATCH_LEVEL" = "none" ]; then
            # 无设计 token，给 3 个风格选项
            echo "## 审美提示（新项目）"
            echo ""
            echo "未检测到项目设计风格。选一个基线风格，或描述你想要的："
            echo ""
            echo "**🅐 Minimal Pro**（极简专业）"
            echo "  - 主色: #0f172a | 字体: Inter | 圆角: 0.5rem"
            echo "  - 适合: SaaS、Dashboard、技术产品"
            echo ""
            echo "**🅑 Bold Expressive**（大胆表达）"
            echo "  - 主色: #6366f1 | 字体: Geist | 圆角: 0.75rem"
            echo "  - 适合: 营销站、创意产品"
            echo ""
            echo "**🅒 Warm Friendly**（温暖友好）"
            echo "  - 主色: #f97316 | 字体: Nunito | 圆角: 1rem"
            echo "  - 适合: 工具、社区、内容产品"
            echo ""
            echo "输入 a / b / c，或描述你想要的风格。"
            echo "选定后运行 'mancode refresh-style' 更新 token。"
            echo ""
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
