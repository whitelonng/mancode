# mancode 优化方案

> 基于 `docs/01-15` 全部设计文档 + `src` 核心实现（registry / common / team-memory / preseason / scan-aesthetics / inline / shared-content / skills / agents）的深度审阅，以及 dependency-cruiser vs madge 的实证调研。
>
> 所有判断均已通过代码验证，标注了成立 / 撤回 / 修正状态。本文件仅为方案，不含代码改动。

---

## 一、验证修正摘要

| 判断 | 验证前 | 验证后 | 状态 |
|---|---|---|---|
| 模式债务 | 五铁律散落副本 | 各模式自行裁剪导致不一致；manteam 丢失"先验证再声称完成" | 成立，升级 P1 |
| 子代理信息丢失 | scout-report 压缩丢信息 | `scout.ts:25` 强制 `path:line` 引用，可回查 | 撤回 |
| 扫描浅层 | 简单正则 | 手写花括号深度遍历解析器，正确处理嵌套 / 注释 / 注入 | 修正（非浅层） |
| scanArchitecture 工具 | 正则覆盖 80% | dependency-cruiser 支持自定义规则 + JSON 输出 | 修正（集成 dep-cruiser） |
| hook token 风险 | 软约束有风险 | 已有 `summarizeRecord` 限流 + `sanitize` 截断 | 修正（风险小） |

---

## 二、P0 — 立即做（明确小修，风险最低）

### P0-1 PostToolUse hook 设计策略（先定开关和行为，MVP 实现留到 P1）

- **问题**：`docs/12 §2.3` 设计了 PostToolUse hook（自动 format / lint / typecheck），installer 未注册。这是"先验证再声称完成"铁律的自动化支撑，缺位意味着验证靠 Agent 自觉。
- **方案**：**P0 阶段先输出设计决策文档**（明确 6 个决策点的选择），hook 模板和注册留到 P1。不在此阶段写 hook 脚本。
- **落地路径**（P0 阶段）：
  - 更新 `docs/12 §2.3`，明确 6 个设计决策
  - hook 模板 + 注册留到 P1 实现
- **复用机制**：抽出 `detectSafePackageScripts()` 到共享 utility（当前 `inferSafePackageScript` 是 preseason.ts 私有函数，需抽离并补测试）
- **工作量**：中。docs/12 标注"计划中尚未实现"，是新功能实现非"承诺漏装"。需先明确 6 个设计决策（默认启用/opt-in、处理范围、format 是否改未确认文件、lint/test 是否阻断、超时降级、并发冲突），非"纯实现"。

### P0-2 team-memory 避免 lost update（改用 append-only）

- **问题**：`team-memory.ts` 的 `appendTeamDecision` 是 read-modify-write（读全量 → 拼接 → 覆盖写），并发会丢追加（A 读、B 读、A 写、B 写 → A block 丢失）。`tmp+rename` 只防半写入，不防 lost update。
- **方案**：改用 `fs.appendFile` 直接追加完整 ADR block。`fs.appendFile` 内部用 O_APPEND 偏移追加，避免 read-modify-write 的 lost update。注意：这不等于严格证明多进程大块写入永不交错；如要求严格记录不交错，直接加 `proper-lockfile` 文件锁。单条 ADR 最大字节数只能作为测试/运维护栏，不作为 correctness guarantee。
- **落地路径**：`src/system/team-memory.ts` 的 `appendTeamDecision` 改用 `fs.appendFile`
- **不复用**：`preseason.ts` 的 `writeJsonAtomic`——那是 JSON 全量覆盖用的，不适合追加场景
- **工作量**：小

---

## 三、P1 — 核心（补架构与纪律约束，ROI 最高）

### P1-1 manteam 补回验证纪律（最高优先，真实缺陷）

- **问题**：`manteam.ts:94-100` 的铁律是团队定制版（不覆盖队友改动 / 兼容性说明 / 不自动 commit），**丢失了"先验证再声称完成"**。团队协作的代码最需要强制验证，但 `/manteam` 流程里 Agent 可能不跑 build/lint/test 就声称完成。
- **方案**：manteam 铁律段补回"先验证再声称完成 — build/lint/test 必须实际跑"。
- **落地路径**：`src/templates/skills/manteam.ts` 铁律段增加一条。
- **工作量**：极小（改一处），但影响大。这是唯一已造成实际缺陷（而非潜在风险）的问题。

### P1-2 核心铁律分层结构

- **问题**：四个模式 SKILL 的铁律处理不一致：
  - `man.ts`：完整五条
  - `man8.ts`：只引用"铁律 1.3"
  - `manteam.ts`：团队定制五条，漏了验证纪律
  - `manps.ts`：无铁律段（合理，扫描模式不写业务代码）
- **方案**：建立"核心铁律（所有写代码的模式强制共享）+ 模式扩展"分层结构：
  ```
  核心铁律（单一来源，所有模式强制继承）
    1. 不做无关修改
    2. 先验证再声称完成
    3. 失败两次停下诊断
    4. 不可逆操作先问
    5. 只解决被问到的问题
  + 模式扩展（各模式叠加场景纪律）
    manteam: + 不覆盖队友改动 / 兼容性说明 / 不自动 commit
    manps:   + 扫描纪律（不删依赖 / 不大型重构）
  ```
- **落地路径**：新增 `src/templates/skills/principles.ts` 作为核心铁律单一来源；各 `skills/*.ts` 引用它再叠加模式特有纪律。`shared-content.ts` 的 `renderPracticeRules`（YAGNI 阶梯）**保留不动**——它服务的是无 hooks/skills 的平台（Cursor/Codex/Copilot），和 skill 级五铁律不同层。
- **复用机制**：新建 `templates/skills/principles.ts` 单一来源，各 skill 引用
- **工作量**：中。重构现有铁律段，行为应保持一致。

### P1-3 manps 扫描器 registry 化

- **问题**：`preseason.ts` 的 `scanArea` 是 switch-case dispatch，新增 scanner 要改函数体 + `PreseasonArea` 类型 + `PreseasonIssueType` 联合类型三处，扩展性差。
- **方案**：仿 `installers/registry.ts` 的 `PLATFORM_INSTALLERS` 模式，把 scanner 注册成数组：
  ```typescript
  type MaybePromise<T> = T | Promise<T>;

  interface PreseasonScanner {
    name: string;
    areas: PreseasonArea[];
    scan(ctx: ScanContext): MaybePromise<PreseasonIssue[]>;
  }
  const SCANNERS: PreseasonScanner[] = [
    { name: 'scripts', areas: ['all','config'], scan: scanScripts },
    { name: 'memory-drift', areas: ['all'], scan: scanMemoryDrift },  // P2 advisory，后续才加
    { name: 'architecture', areas: ['all'], scan: scanArchitecture },
    // ...
  ];
  ```
  `scanArea` 改为 async dispatch：
  ```typescript
  const active = SCANNERS.filter((s) => s.areas.includes(area));
  const chunks = await Promise.all(active.map((s) => s.scan(ctx)));
  return chunks.flat();
  ```
- **落地路径**：`src/system/preseason.ts` 重构 `scanArea`。
- **复用机制**：`installers/registry.ts` 的 strategy + registry 模式（mancode 自己最成熟的设计）
- **工作量**：中。纯重构，行为不变，靠现有测试兜底。

### P1-4 scanArchitecture（集成 dependency-cruiser）

- **问题**：mancode 无架构约束，单向依赖靠人记。
- **方案**：manps 运行时调用 dependency-cruiser，解析违规 JSON 转成 `PreseasonIssue`，复用现有 issue database + remediation 流程。
- **落地路径**：新增 `scanArchitecture` scanner，注册到 SCANNERS；按下方检测方式调用 depcruise，解析违规 JSON 转 `PreseasonIssue`。
- **依据（实证）**：
  - dependency-cruiser：活跃维护，支持 `from/to` 自定义规则（依赖方向 + 模块边界）、循环检测、orphan 检测、JSON 输出、TS/tsx/path alias/webpack alias。MIT。
  - madge：不支持自定义规则，只做依赖图 + 循环检测。不适用（能力不足，非 star 数原因）。
- **复用机制**：manps 现有的 `PreseasonIssue` 结构 + issue database + remediation 流程
- **工作量**：中。主要是 JSON 解析 + issue 转换。
- **检测方式**（不用 `npx`，避免联网安装风险）：
  1. 先检测项目本地 `node_modules/.bin/depcruise`
  2. 再检测全局 PATH 里的 `depcruise`
  3. 都没有则跳过，提示"可安装 dependency-cruiser 后启用架构扫描"
  4. 不 bundle、不自动安装、不联网拉包
- **运行保护**：
  - 使用 `spawn` / `execFile` 传 argv，不经过 shell 拼接
  - timeout 10-15s；超时 kill 子进程并把 architecture scan 标记为 skipped advisory，不让整个 `mancode manps` 失败
  - 限制 stdout/stderr 最大字节数，避免异常项目输出撑爆内存
  - 非 0 exit、非 JSON 输出、config 不兼容时降级为 P2 advisory / skipped note，保留错误摘要但不阻断其他 scanner
- **集成方式**：mancode 不 bundle dependency-cruiser，检测到本地或全局 binary 才调用，未装则跳过。

---

## 四、P2 — 记忆系统升级

### P2-1 记忆结构增强（不引入完整 wiki）

- **问题**：`decisions.md` 积累几百条 ADR 后，AI 每次读全量浪费 token；找特定决策要全文扫描。
- **方案**：保持 markdown 基础，加三样轻量结构：
  - `index.md` — 索引页，按主题列出各文件关键条目（Scout 优先读它）
  - decisions 条目加 `tags:` 行（如 `tags: auth, security`），支持 grep 定位
  - `supersede` 机制——新条目写 `supersedes: <old-id/title>`，**不回写旧条目**（保持 append-only）；由 index.md 或读取逻辑解释 supersede 关系
- **落地路径**：`team-memory.ts` 的 `appendTeamDecision` 支持 `supersedes` 参数；`ensureTeamMemory` 额外创建 `index.md`（**同步更新 `tests/init.test.ts` 的三文件预期和文档描述**）；更新 `manteam` / shared mode skill / scout 相关 prompt，使它们优先读取 `index.md`，再按需读取 `prd.md` / `spec.md` / `decisions.md`。
- **工作量**：中。

### P2-2 记忆信任边界（AI 草拟 / 人确认）

- **问题**：`appendTeamDecision` 是无审核追加，AI 自动写的决策质量参差，和人写的混在一起。
- **方案**：`appendTeamDecision` 增加稳定 `id` 和 `status: 'draft' | 'confirmed'` 字段。AI 写入默认 `draft`；manteam/skills 读取 memory 时优先 `confirmed` 决策，`draft` 仅作参考（当前 hook 不读 decisions.md，信任边界在 skill 层）；`draft` 转 `confirmed` 用 **append-only event**（追加 `event: confirmed` + `decision: <decision-id>`，不修改旧条目），避免 read-modify-write 竞态。
- **事件规则**：
  - decision id 用 `adr-YYYYMMDD-<slug>-<shortHash>`，slug 来自 title，shortHash 来自 title + date + decision 文本，保证可 grep 且基本稳定
  - 普通 decision block 必须包含 `id:`, `status:`, `tags:`（可空）, `supersedes:`（可空）
  - event block 必须包含 `event: confirmed | superseded`, `decision: <id>`, `date: <ISO date>`, `source:`（如 `manps-remediation`）
  - 读取逻辑按 append order replay events：confirmed event 覆盖 draft status；superseded event 或新 decision 的 `supersedes` 让旧 decision 在 index/读取结果里降权
- **落地路径**：`team-memory.ts` 加 id/status/event parser 与 renderer；复用 manps 的 remediation 流程暴露 draft 决策。
- **复用机制**：manps 的 `runPreseasonRemediation` 流程
- **工作量**：中。

### P2-3 team-memory 改写操作加锁（视实际需要）

- **问题**：P0-2 改为 append-only 后，追加操作本身无 lost update。但**真正需要覆盖文件内容的操作**（如重建 `index.md`、刷新 `spec.md` 里的 auto-generated project map managed block、未来压缩/归档 memory 文件）仍需 read-modify-write，有竞态风险。
- **方案**：需要覆盖文件内容的操作加 `proper-lockfile` 文件锁；业务状态变更尽量设计为只追加不修改（supersede 用新条目引用旧条目，draft→confirmed 用 append-only event）。
- **工作量**：小。视实际并发频率决定是否需要。

### P2-4 scanMemoryDrift（advisory scanner）

- **问题**：`decisions.md` 记了"选 shadcn/ui"，代码换成 MUI 后 decision 没更新，记忆与代码脱节。
- **方案**：仿 `scanAestheticDrift` 范式——读 `decisions.md` 提取技术选型关键词，比对 `package.json` 实际依赖，不一致报 P2 / low-confidence issue。
- **落地路径**：新增 scanner 函数，注册到 SCANNERS；`PreseasonIssueType` 加 `'memory'`。
- **复用机制**：`scanAestheticDrift` 的"读文件 + 关键词匹配 + 生成 issue"模式
- **工作量**：中。
- **降级说明**：自由格式 markdown 正则提取技术选型误报率偏高（历史背景 vs 当前约束、"考虑" ≠ "选择"、monorepo/后端未必靠根 package.json）。报 P2 / low-confidence，先观察误报率再决定是否升级。

---

## 五、P3 — 盲点治理（按需）

### P3-1 多平台记忆同步提示

- **问题**：同一项目，Claude Code 的 skills 直接读 `.mancode/memory/`（实时），Codex 用 AGENTS.md 静态块（要 `install --force` 才刷新）。团队混用平台时 memory 不一致。
- **方案**：`mancode status` 检测到多平台安装时，提示"memory 更新后需对 Codex/Copilot 执行 `install --force`"。
- **落地路径**：`commands/status.ts` 加提示，复用 `platform-status` 检测。
- **工作量**：小。

### P3-2 隐私边界

- **问题**：`docs/02 §2.6` 说 memory 在 manteam 模式下提交，但什么该提交没规则，可能推送敏感决策。
- **方案**：`appendTeamDecision` 写入前做敏感词扫描（密钥模式、内部域名），命中则打 `do-not-commit` 标记并警告。
- **落地路径**：新增 `scanSecrets` 工具函数，`team-memory.ts` 调用。
- **工作量**：中。

### P3-3 hook token 硬 cap（降级为非优先）

- **问题**：原判断"hook token 预算是软约束，有风险"。
- **验证后**：`shared-content.ts` 的 `renderAesthetics` 已有 `summarizeRecord(limit 8/4)` 限流；`inline.ts` 的 `sanitize` 限单字段 200 char。实际注入可控，200k context 下占比极小。
- **方案**：降级为非优先。除非遇到极小 context 窗口的模型，否则不需要加总量 cap。若未来需要，在 `session-start.sh` 末尾加字节计数 + 截断逻辑。
- **工作量**：小（按需）。

---

## 六、撤回项

### 撤回-1 子代理信息回溯

- **原建议**：scout-report 保留 `文件:行号` 精确引用，让下游 Agent 可按需回查。
- **撤回原因**：`scout.ts:25` 已强制要求 `path:line` 引用，输出格式示例全用 `src/foo/bar.ts:42`；`man.ts:154-158` 的"上下文预算"是有损压缩但保留精确引用。
- **状态**：已实现，无需再做。

---

## 七、执行顺序建议

```
P1-1 (立即)   manteam 补回验证纪律 — 真实缺陷，改一处
    ↓
P0 (1 周内)   team-memory append-only + PostToolUse 设计策略（不实现）
    ↓
P1 (2-3 周)   核心铁律分层 → 扫描器 registry 化 → scanArchitecture → PostToolUse MVP
    ↓
P2 (1 个月)   记忆结构增强 → 信任边界 → 并发锁 → scanMemoryDrift advisory
    ↓
P3 (按需)     多平台同步 → 隐私边界 → hook cap
```

**最关键**：P1-1（manteam 验证纪律）是唯一已造成实际缺陷的问题，优先级最高，改动量最小。

**最值得做的基座**：P1-3（扫描器 registry 化）是后续所有架构 / 记忆检测的扩展基座，复用 mancode 自己最成熟的 registry 模式。

---

## 附：本方案基于的代码验证记录

| 文件 | 验证内容 |
|---|---|
| `src/installers/registry.ts` | strategy + registry 模式，PlatformInstaller 接口 |
| `src/installers/common.ts` | 平台无关共享核心，import 方向单向（→ system + templates） |
| `src/installers/shared-content.ts` | 跨平台单一来源（generateSharedContent + renderPracticeRules） |
| `src/system/team-memory.ts` | 三扁平文件 + appendTeamDecision，普通 writeFile（非原子） |
| `src/system/preseason.ts` | scanArea switch-case + scanAestheticDrift + writeJsonAtomic + remediation |
| `src/system/scan-aesthetics.ts` | 手写花括号深度遍历解析器，非浅层正则 |
| `src/templates/inline.ts` | hook 模板，sanitize 单字段 200 char 截断 |
| `src/templates/skills/man.ts` | 完整硬编码五铁律 |
| `src/templates/skills/man8.ts` | 只引用铁律 1.3 |
| `src/templates/skills/manteam.ts` | 团队定制五铁律，丢失"先验证再声称完成" |
| `src/templates/skills/manps.ts` | 无铁律段（合理） |
| `src/templates/agents/scout.ts` | 强制 path:line 引用（信息回溯已实现） |
| `src/commands/init.ts` | init 流程（10 步），不调 manps，Next 提示缺 manps 衔接 |
| `src/commands/status.ts` | 已整合平台/workflow/hooks/team，只缺技术债摘要 |
| `src/commands/list-platforms.ts` | 与 status 平台段重叠度高（定位不同：诊断 vs 能力发现） |
| `src/commands/workflow.ts` | workflow CRUD，/man8//man skill 内部自动调用 |
| `src/system/detect-team.ts` | 三条件多信号保守判定（contributors>1 + remote + recent>1） |

---

## 八、功能优化与老项目接入（第二轮）

> 基于命令重复分析（读了 list-platforms.ts / workflow.ts / status.ts / detect-team.ts / init.ts）+ 老项目驾驭评估。所有判断已通过代码验证，把握度均为中高或高。

### A. 命令重复处理（高把握，纯文档）

#### A-1 manps 双入口分工说明

- **问题**：`mancode manps`（CLI）和 `/manps`（skill）功能重叠——`/manps` 内部调用 CLI + 补充人工判断，用户不知道该用哪个。
- **方案**：不删功能，文档明确分工：
  - `mancode manps`（CLI）：给 CI / 脚本用，输出确定性扫描结果（JSON / Markdown 报告）
  - `/manps`（skill）：给交互式用，调 CLI + 补充人工判断 + remediation 逐项确认流程
- **落地**：README 命令说明段加"使用场景"标注
- **工作量**：小（纯文档）

#### A-2 workflow create/update 标注"编程接口"

- **问题**：`mancode workflow create` 和 `/man8` `/man` 功能重叠——skill 内部自动创建 workflow（man.ts / man8.ts 直接 Write metadata.json），用户不需手动 create。
- **方案**：README 标注 `workflow create` / `update` 是"编程接口"（CI / 脚本 / 非 Claude Code 场景），日常用 `/man8` `/man` 自动管理。
- **落地**：README workflow 命令段加标注
- **工作量**：小（纯文档）

#### A-3 list-platforms 定位区分（不标废弃）

- **问题**：`list-platforms` 和 `status` 平台段信息重叠度高。
- **验证**：`status.ts` 第 453-462 行遍历全部平台显示 ✓/○ + ready 状态（诊断视角）；`list-platforms.ts` 显示 capabilities 描述如 "skills + agents + hooks"（能力发现视角）。两者信息有差异，不是完全等价。
- **方案**：不标废弃。README 区分定位——"日常看项目状态用 `status`，查看平台能力描述用 `list-platforms`"。长期可考虑把 capabilities 合并进 status 平台段。
- **落地**：README list-platforms 段加定位说明
- **工作量**：小（纯文档）

---

### B. 减少用户思考（中高把握，小到中改）

#### B-1 init 老项目自动衔接 manps

- **问题**：`init.ts` 完成后 Next 提示（第 276-280 行）只建议 `mancode status` + 重启 Claude Code，**不提示 manps**。老项目接入后用户不知道要跑健康扫描，形成"不知道该干什么"的真空期。
- **方案**：
  1. init 增加老项目检测：仿 `detect-team.ts` 的多信号保守判定模式
     - Git 项目：
       - 信号 1：`git log --oneline` 提交数 > 10（有历史）
       - 信号 2：`git ls-files | wc -l` > 50（有规模，git 索引统计）
       - 信号 3：有 `.git` 目录
       - 三条件**同时满足**才判定老项目
     - 非 Git 项目：
       - 信号 1：有 `package.json`
       - 信号 2：early-scan 源码文件数 > 50（下载 zip 的老项目也是真实接入场景）
       - 两条件同时满足才判定老项目
  2. 老项目 init 完成后，Next 提示追加：
     ```
     检测到已有项目（N 次提交，M 个 tracked 文件）。
     建议运行 `mancode manps` 做健康扫描。
     ```
     非 Git 项目使用：
     ```
     检测到已有项目（约 M 个源码文件）。
     建议运行 `mancode manps` 做健康扫描。
     ```
  3. init **不自动调 manps**（保持 init <2 秒的性能契约），只提示
  4. `--yes` 模式（CI）下也只提示不自动调
- **落地路径**：
  - `src/commands/init.ts` 增加 `detectLegacyProject()` 函数（仿 `detectTeamStatus` 多信号模式）
  - `init.ts` Next 输出段（第 276-280 行）增加老项目提示
- **复用机制**：
  - `detect-team.ts` 的多信号保守判定模式（三条件同时满足 + 保守降级）
  - 有 .git → `git ls-files | wc -l`（git 索引统计文件数，最快）
  - 无 .git → early-scan 顶层目录 + `src/` / `app/` / `packages/*/src`（统计源码文件数）
- **阈值参考**：`detect-team.ts` 用 >1（极保守），老项目用 >10 提交 + >50 文件（保守，宁可漏判不误判新项目）
- **性能边界**：非 Git early-scan 最多检查 200 个 directory entries，跳过 `node_modules` / `dist` / `build` / `coverage` / `.next` / `.mancode`；源码文件数超过 50 立即停止，不做完整 walk，避免破坏 init <2 秒契约。
- **工作量**：小

#### B-2 status 升级为仪表盘

- **问题**：用户要看项目全貌得敲 `status` + `list-platforms` + `workflow list` + 回忆 manps 结果，4 个动作。
- **验证**：`status.ts` 已整合项目信息 / 团队 / 当前 workflow / 全部平台状态（✓/○）/ hooks / 注入预算，**只缺技术债摘要**。
- **方案**：status 新增"技术债摘要"段
  - 读 `.mancode/preseason-issues.json`（`PreseasonIssueDatabase` 结构）
  - 统计 open issue 数（按 P0 / P1 / P2 分级）
  - 显示格式：
    ```
    Tech debt:  3 open issues (P0: 0, P1: 2, P2: 1) — last scan: 2026-07-08
    ```
  - 未扫描过（文件不存在）显示：
    ```
    Tech debt:  not scanned yet. Run `mancode manps`.
    ```
- **落地路径**：
  - `src/commands/status.ts` 的 `StatusResult` 增加 `techDebt` 字段
  - `status()` 函数并行读取 `preseason-issues.json`（加入现有 `Promise.all`）
  - `printText()` 增加技术债输出段
- **容错规则**：`preseason-issues.json` 不存在时显示 not scanned；JSON 损坏、schema 旧版或字段异常时显示 `Tech debt: unavailable (run mancode manps to refresh)`，`status` 命令不能失败。
- **复用机制**：
  - `preseason.ts` 的 `PreseasonIssueDatabase` / `PreseasonIssueRecord` 结构（已定义，含 status / severity 字段）
  - `status.ts` 现有的 `Promise.all` 并行收集模式
- **输出长度控制**：技术债摘要 1-2 行，不影响 status 整体长度
- **附带效果**：`status` 整合技术债后成为主要"看全貌"命令；`list-platforms` 保留用于查看平台能力描述
- **工作量**：小（status 已整合大部分，只加一段）

#### B-3 manps 生成项目地图写入 spec.md

- **问题**：老项目 manps 扫描后，memory 仍为空模板，Agent 冷启动零知识。
- **方案**：manps 扫描时顺便生成"项目结构摘要"写入 `.mancode/memory/spec.md`
  - manps 已有 `listProjectFiles` 返回完整文件列表（`walk` 遍历，MAX_PROJECT_FILES=5000）
  - 从文件列表提取：
    - 顶层目录结构（src/ tests/ docs/ examples/ 等）
    - 源码文件数 + 主要语言（按扩展名统计 .ts/.tsx/.js/.jsx/.vue/.svelte）
    - 入口点（package.json main / index.ts / app/）
    - 测试目录位置（tests/ / __tests__/ / *.test.* / *.spec.*）
  - **默认写入 manps report**（临时产物，不产生持久 memory 副作用）
  - **spec.md 只在显式同意时写入**：
    - CLI：`mancode manps --write-memory`
    - skill：`/manps` 扫描完成后用 AskUserQuestion 问"是否将项目地图写入 memory/spec.md 供后续 Agent 使用？"
    - 写入时标记 `## Auto-generated project map (可刷新)`，可替换不无限追加
- **落地路径**：
  - `src/system/preseason.ts` 的 `runPreseasonScan` 增加生成项目地图步骤（默认写进 report）
  - `runPreseasonScan(projectRoot, area, { writeMemory?: boolean })` 增加第三参数；`PreseasonReport` 增加 `projectMap?: ProjectMapSummary`，`renderPreseasonReport` 增加 Project Map section
  - 每次生成 project map 时，同时写入临时 sidecar：`.mancode/preseason-project-map.json`（report artifact，不是长期 memory），供后续显式写入使用
  - `--write-memory` flag 时在同一次 scan 内调用 `writeProjectMapToMemory(projectRoot, projectMap)` 写入 spec.md（需同步改：CLI option、`ManpsOptions`、README、tests）
  - 增加 `mancode manps write-memory` 子命令：读取 `.mancode/preseason-project-map.json` 并写入 spec.md，不重新扫描、不新增 report、不更新 issue occurrences
  - `/manps` skill 扫描后交互确认写入；用户同意时调用 `mancode manps write-memory`，避免再次运行 scan 导致重复 report / issue history 变化
  - `/manps` skill wrapper 同步支持两个动作：scan/remediate 和 write-memory
  - **area 限制**：项目地图只在 `listProjectFiles` 有数据时生成（area=all/dead-code/config）；`--write-memory` 在其他 area 时强制额外收集一次文件快照
- **复用机制**：
  - `preseason.ts` 的 `listProjectFiles` / `walk`（已遍历目录树）
  - `team-memory.ts` 的 `ensureTeamMemory`（已建 memory 目录）+ 新增 `replaceProjectMapBlock()`（managed block 替换，不用 `writeIfMissing`——它只在文件不存在时写入，不能刷新已有 auto-generated 段）
- **不做的事**（明确边界）：
  - 不从 README / git log 提取知识（确定性 CLI 无 AI，正则提取质量不可靠；留给 Agent 第一次 /man8 时做）
  - 不做深度依赖分析（那是 P1-4 scanArchitecture 的事）
- **工作量**：中（摘要生成 + 写入逻辑）

---

### C. README 更新（高把握，纯文档）

#### C-1 新增"命令速查"框

在 README 开头（Quick Start 之后）加命令速查，分三栏，让用户一眼知道日常只用 5 个 slash 命令：

**中文版（README.zh-CN.md）**：
```
## 命令速查

日常开发（Claude Code 对话内）：
  /man8     调研 + 计划      /man      完整 8 步流程
  /manteam  团队模式         /manps    健康扫描
  /mansolo  退回 solo 模式

终端管理（shell 里敲）：
  mancode init            接入项目
  mancode status          查看状态（一站式仪表盘）
  mancode manps           扫描技术债
  mancode install <平台>  装其他平台适配器

低频 / CI（基本不用记）：
  mancode workflow ...    手动管理 workflow（/man8 /man 自动处理）
  mancode refresh-style   刷新审美 token
  mancode list-platforms  查看平台能力（日常用 status 即可）
  mancode version         版本号

说明：日常开发只需 5 个 slash 命令。终端 CLI 主要用于接入和管理。
workflow 命令是编程接口（CI / 脚本），/man8 /man 会自动调用，平时不用手动敲。
```

**英文版（README.md）**：同步翻译上述内容。

#### C-2 命令说明段补充"使用场景"

每个 CLI 命令加"使用场景"标注：

| 命令 | 使用场景标注 |
|---|---|
| `mancode manps` | CI / 脚本用；交互式场景用 `/manps`（含人工判断 + remediation） |
| `mancode workflow create/update` | 编程接口（CI / 脚本），日常用 `/man8` `/man` 自动管理 |
| `mancode list-platforms` | 查看平台能力描述；日常看项目状态用 `mancode status` |
| `mancode refresh-style` | 只刷审美 token；全面重装用 `mancode init --force` |
| `mancode status` | 一站式仪表盘（项目状态 + 平台 + workflow + 技术债） |

#### C-3 老项目接入引导段

README 增加"已有项目接入"说明（Quick Start 之后）：

**中文版**：
```
## 已有项目接入

mancode 支持老项目接入。流程：

1. `mancode init` — 接入。检测到老项目会提示跑 manps。
2. `mancode manps` — 季前赛扫描。生成技术债清单 + 项目结构地图（默认写 report；`--write-memory` 写入 memory）。
3. `/man8 <新功能>` — 先调研再动手。老项目尤其推荐先 /man8，Agent 不了解项目时必须先调研。

新项目直接 `mancode init` 后用 solo 或 /man 即可。
```

**英文版**：同步翻译。

#### C-4 status 输出示例更新

README 的 Command Output Examples 段，`mancode status` 示例增加技术债摘要行：

```text
mancode v0.1.0

Project:     my-app (React + TypeScript + Tailwind)
Mode:        solo (default)
Style:       shadcn/ui, 8 colors, 2 fonts
Initialized: 2026-07-08T10:20:30.000Z
Team:        detected (3 contributors)
Tech debt:   3 open issues (P0: 0, P1: 2, P2: 1) — last scan: 2026-07-08

Installed platforms:
  ✓ Claude Code
  ✓ Cursor
  ○ Codex (available, run `mancode install codex`)
  ○ Copilot (available)

Platform status:
  ✓ Claude Code: ready (.claude/)
  ✓ Cursor: ready (.cursor/rules/)
  ○ Codex: not ready
  ○ Copilot: not ready

Hooks:
  ✓ session-start.sh
  ✓ user-prompt-submit.sh
  ✓ registered in .claude/settings.json
  Hook injection: ~120 tokens (cap 800)
```

#### C-5 中英文同步

README.md 和 README.zh-CN.md 同步更新以下内容：
- C-1 命令速查框（中英文各一份）
- C-2 命令说明段"使用场景"标注
- C-3 老项目接入引导段
- C-4 status 输出示例（加技术债摘要行）

---

### D. 第二轮执行顺序

```
第一批（高把握，纯文档，无代码改动）：
  A-1 / A-2 / A-3 命令重复文档说明
  C-1 / C-2 / C-3 / C-4 / C-5 README 中英文更新
  → 无风险，立即执行

第二批（中高把握，小改，复用现有代码）：
  B-1 init 衔接 manps（init.ts 加 detectLegacyProject + Next 提示）
  B-2 status 仪表盘（status.ts 加技术债摘要段）
  → 复用 detect-team 多信号模式 + preseason issue database

第三批（中高把握，中改，复用扫描能力）：
  B-3 manps 生成项目地图（preseason.ts 加摘要生成；默认写 report，--write-memory 写 spec.md）
  → 默认 area 复用已有 listProjectFiles；其他 area 的 --write-memory 需额外收集一次文件快照
```

### E. 第二轮把握度汇总

| 功能 | 把握度 | 验证依据 |
|---|---|---|
| A-1 manps 双入口说明 | 高 | 纯文档 |
| A-2 workflow create 标注 | 高 | 纯文档 |
| A-3 list-platforms 定位区分 | 高 | status/list-platforms 信息有差异，区分定位不标废弃 |
| B-1 init 衔接 manps | 中高 | 仿 detect-team.ts 多信号模式，阈值保守 |
| B-2 status 仪表盘 | 高 | status.ts 已整合大部分，只缺技术债摘要 |
| B-3 manps 生成项目地图 | 中高 | 默认 area 复用 listProjectFiles；其他 area 显式写 memory 时额外快照 |
| C-1~C-5 README 更新 | 高 | 纯文档 |

---

## 九、GPT 审核修正记录

> 经 GPT 审核 + 二次确认，以下 8 处已修正。GPT 技术判断全部正确，其中 2 处反馈不完整（B-3、B-1），已补充解法。

| 条目 | 原方案问题 | 修正后 |
|---|---|---|
| P0-2 | `writeTextAtomic`（tmp+rename）只防半写入，不防 lost update（A 读 B 读 A 写 B 写 → A 丢失） | 改用 `fs.appendFile`（O_APPEND 偏移追加，避免 lost update）；如需严格不交错加 `proper-lockfile` 或规定单条 ADR 最大字节数 |
| P0-1 | 低估为"小工作量、纯实现、低风险" | 改为中工作量，需先明确 6 个设计决策（默认启用/opt-in、范围、format 改未确认文件、阻断、超时降级、并发冲突）；定位为"新功能实现"非"承诺漏装" |
| P1-2 | 落地 `shared-content.ts` 混淆职责（平台 instructions 层 vs skill prompt 层） | 改为新增 `src/templates/skills/principles.ts`；`shared-content.ts` 的 `renderPracticeRules`（YAGNI 阶梯）保留不动 |
| scanMemoryDrift | 定 P1 但误报风险高（自由格式正则提取技术选型） | 降级为 P2 advisory + low-confidence，先观察误报率再决定是否升级 |
| scanArchitecture | 隐式 `npx depcruise` 有联网安装风险 | 改检测 `node_modules/.bin/depcruise`（本地）→ 全局 PATH `depcruise` → 都没有则跳过提示；不 bundle/不自动安装、不联网 |
| B-3 | 默认写 `spec.md` 产生持久 memory 副作用 | 默认写 manps report（临时产物）；`--write-memory` flag 或 `/manps` skill 交互确认才写 spec.md；标记 auto-generated 可刷新 |
| B-1 | 复用 `listProjectFiles`（私有函数，递归 5000 文件，太重） | Git 项目用 `git ls-files \| wc -l`；非 Git 项目用 capped early-scan 顶层目录 + `src/` / `app/` / `packages/*/src` |
| A-3 | 标"废弃"但 status（诊断视角）和 list-platforms（能力发现视角）信息有差异 | 不标废弃，README 区分定位；长期可考虑合并 capabilities 进 status |

### GPT 反馈不完整处（已补充解法）

- **B-3**：GPT 只说"不该默认写 spec.md"，未解决"不写后 Agent 怎么看到地图"。补充：`/manps` skill 扫描后用 AskUserQuestion 交互确认写入——既不默认产生副作用，又解决 Agent 可见性。
- **B-1**：GPT 只说"别用 listProjectFiles"，未提非 Git 项目怎么办。修正：Git 项目用 git 索引统计；非 Git 项目用 capped early-scan，兼容下载 zip 的老项目。

---

### 第二轮审核修正（GPT 第二次审核）

> GPT 第二次审核发现 9 处自相矛盾 / 技术表述不准确，全部已修正。

| 条目 | 问题 | 修正 |
|---|---|---|
| P0-2 | 引用 PIPE_BUF 不准确（PIPE_BUF 是 pipe/FIFO 保证，非 regular file append） | 改为 O_APPEND 偏移追加语义；不引用 PIPE_BUF；如需严格不交错加 lock 或规定字节数 |
| P2-3 | 与 P0-2 矛盾（P0-2 已改 append-only，P2-3 还说 read-modify-write 竞态） | 改为"覆盖文件内容的操作（重建 index / 刷新 managed block / 压缩归档）加锁"，业务状态变更走 append-only event |
| P2-1 | supersede 回写旧条目与 append-only 冲突 | 改为新条目写 `supersedes: <old-id>`，不回写旧条目，由 index / 读取逻辑解释关系 |
| P0 标题 | "兑现设计承诺"与 P0-1"中工作量需设计决策"矛盾 | P0 标题改为"明确小修"；P0-1 改为"设计策略"，MVP 实现留到 P1 |
| scanMemoryDrift | 标题降级为 P2 但仍在 P1 章节和执行线 | 执行顺序调整：P1 移除 scanMemoryDrift，P2 增加 scanMemoryDrift advisory |
| list-platforms | A-3 改了"不标废弃"但 4 处残留旧说法 | 全局同步：附录 / B-2 附带效果 / C-1 命令速查 / C-2 表格统一改为"定位区分" |
| B-3 | B-3 改了默认写 report 但 README 计划和执行顺序残留"写入 memory / spec.md" | C-3 README 和 D 执行顺序同步为"默认写 report，--write-memory 写 spec.md" |
| B-1 | 三条件含"有 .git"（必需）但复用机制说"无 .git fallback"，逻辑矛盾 | 后续第三轮统一为支持无 Git fallback：Git 项目用 git 索引；非 Git 项目用 capped early-scan |
| P2-2 | "hook 注入只信任 confirmed"基于不存在的实现（当前 hook 不读 decisions.md） | 改为"manteam / skills 读取 memory 时优先 confirmed"（信任边界在 skill 层） |

---

### 第三轮审核修正（GPT 第三次审核）

> GPT 第三次审核发现 10 处技术缺陷 / 结构残留 / 实现细节遗漏，全部已修正。

| 条目 | 问题 | 修正 |
|---|---|---|
| scanMemoryDrift | 降级为 P2 但仍在 P1 章节下 | 移至 P2-4，删除 P1 占位标题 |
| scanner 接口 | `scan(ctx)` 同步，scanArchitecture 调子进程会卡；全改 Promise 又会影响现有同步 scanner 类型 | 改为 `MaybePromise<PreseasonIssue[]>`，dispatch 统一 `await Promise.all(...)` |
| B-3 area | "零额外成本"只在 all/dead-code/config 成立 | 明确：项目地图只在 `listProjectFiles` 有数据时生成；其他 area 的 `--write-memory` 强制收集文件快照 |
| B-3 可刷新 | `writeIfMissing` 不能刷新已有内容 | 改为 `replaceProjectMapBlock()`（managed block 替换） |
| B-1 | 正文"只支持 git"但修正记录残留"无 .git fallback" | 统一为支持无 git fallback（下载 zip 老项目是真实场景） |
| --write-memory | 新 option 但未写进 CLI contract，且 `/manps` 扫描后确认写 memory 会触发重复扫描风险 | 明确同步改：CLI option / `ManpsOptions` / `mancode manps write-memory` / skill wrapper / README / tests；扫描后写 memory 走 sidecar，不重新扫描 |
| P2-1 index.md | 会破坏 `tests/init.test.ts` 三文件预期 | 标注同步更新测试和文档 |
| P2-2 | draft→confirmed 改写旧条目与 append-only 冲突 | 改为 append-only event（追加 `confirmed` 事件，不修改旧条目） |
| dep-cruiser star | star 数不准（实际约 6.9k 非 10125） | 删 star 数，只写能力差异和维护状态 |
| inferSafePackageScript | 是 `preseason.ts` 私有函数 | 改为"抽出 `detectSafePackageScripts()` 到共享模块" |
