# 项目检测与健康扫描

mancode 先检测项目事实，再决定可用工作流和验证方式。扫描结果是证据，不是对技术栈的猜测。

## Project Profile

Project Profile 记录：

- 项目类型：backend、web、mobile、desktop、CLI、library、data、mixed 或 unknown。
- 语言、framework、manifest 和源码根目录。
- 可用的 build、lint、test 与平台验证命令。
- 是否检测到 UI 资产和浏览器自动化能力。
- high、medium 或 low 置信度。

普通 Continuity 初始化把可共享项目事实写入 `.mancode/shared/context/project.json`。项目结构变化后运行：

```bash
mancode refresh-project
```

检测不到的 framework 不会写入 profile。Git、manifest 或源码目录缺失时，初始化可以安全降级，但不会把 unknown 项目伪装成 Web 项目。

## 项目术语表

`.mancode/shared/context/glossary.json` 保存用户确认的项目术语：每个词条含 term、definition、aliases、可选的 shared TaskRef 来源和确认时间。term 与 alias 全局大小写不敏感唯一，条目上限 200，所有文本经过共享隐私扫描。

术语表只能通过 CLI 写入，且每个词条必须先经用户确认，不做自动术语提取：

```bash
mancode context glossary list --json
mancode context glossary add --term "Task Aggregate" --definition "..." --expected-revision 0 --session <id>
mancode context glossary update --term "Task Aggregate" --definition "..." --expected-revision 1 --session <id>
mancode context glossary remove --term "Task Aggregate" --expected-revision 2 --session <id>
```

`list` 是只读命令；文件不存在时读作 revision 0 的空术语表，首次 `add` 使用 `--expected-revision 0`。变更命令需要 active session，在本地锁内执行 revision CAS；并发写入时后写者收到 `MANCODE_GLOSSARY_REVISION_CONFLICT`，不会静默覆盖。

## 设计资产扫描

只有 profile 确认存在 UI 资产时，mancode 才扫描设计信号。当前实现识别：

- Tailwind 配置中的顶层颜色、字体和 dark mode。
- CSS custom properties。
- 常见组件文件名。
- 已检测到的 UI library。

结果写入 checkout-local cache。`matchLevel=high` 表示存在可复用配置、CSS token 或组件；`low` 只表示依赖提示；`none` 表示没有可靠资产。

```bash
mancode refresh-style
mancode refresh-style --root apps/web
```

Monorepo 的 `--root` 必须是仓库内已存在的相对路径。绝对路径、路径穿越和逃逸仓库的符号链接会被拒绝。扫描结果仍写入 `.mancode/local/cache/style-tokens.json`，其中 `scopeRoot` 标记本次扫描范围。

扫描器不解析任意 `theme.json`、Design Tokens Community Group 文件、Figma 或运行时动态主题。Agent 可以人工读取这些资料，但必须标明它们不是自动检测结果。

## 设计策略

设计策略与检测事实分离：样式扫描是 checkout-local、可重建的事实缓存；可选的人类策略保存在 `.mancode/shared/context/design-policy.json`。初始化不会自动创建策略，没有有效策略时始终安全使用 `preserve`。Legacy 项目可以读取安全上下文，但只有当前 Continuity 项目能写入共享策略。

```bash
mancode design status --json
mancode design configure --expected-revision 0 --preset refine --icons lucide --emoji forbid-as-interface-icon --motion purposeful --browser-validation when-available
mancode design context --json
```

`design context` 只输出代码生成的固定指导、质量门槛和经过大小/字符限制清洗的样式摘要。策略文件只接受严格枚举和独立 revision，拒绝未知字段与自由文本提示词。`experimental` 需要 `--confirm-experimental`，且任何 preset 都不能扩大任务范围、授权产品变更或隐式新增依赖。

对于新建 UI 或视觉重做，如果用户尚未选定方向，固定指导会要求 Agent 先提出 2–3 个差异明确的产品化方向，简述取舍并推荐一个，等待用户选择后再实现；局部 UI 修复、既有设计系统内的改动和已选定方向的任务直接继续。`experimental` 会让品牌型页面把最强视觉信号集中在首屏，并将同一母题延续到全页；任务型产品仍以工作流清晰度优先。

策略命令只修改当前 checkout。共享策略应像仓库配置一样经过 review 和 commit；它不参与 Context Pack 必填字段，也不会伪造 git-ref 远端同步回执。策略文件损坏时，`design context` fail-open 为 `preserve`，普通开发命令不被阻断。

## Preseason

`mancode manps` 是确定性健康扫描，支持 `all`、`deps`、`security`、`dead-code` 和 `config`。它检查脚本、依赖重叠、TODO、测试、配置、审美、架构和基础安全信号。审美检查只在 `package.json` 确实声明两个不同图标系统时产生一个 P2；它不扫描 UI 文案中的表情，避免把合法内容误报为图标问题。

```bash
mancode manps deps
mancode manps all --json
mancode manps config --remediate
```

报告和问题库保存在 `.mancode/local/`。`--remediate` 仍逐项要求决定，只自动执行白名单内的低风险修复。扫描结果不授权批量改代码，也不能代替项目测试或人工安全审查。

## 有界上下文索引

支持索引的入口先读取 `format: context-index-v1`，默认输出任务状态和引用，不附带计划、需求或决定正文。命令始终输出紧凑 JSON；不需要为普通项目查询创建身份、session 或任务。

```bash
mancode context index --purpose orient
mancode context index --task local:<ULID> --purpose implement --path src/context/example.ts
mancode context search "状态恢复" --module continuity --purpose plan
mancode context read <ref> --version <version> --purpose implement --task local:<ULID>
```

`ref` 与 `version` 必须来自实际索引。复用同一选择条件及已有 session/client；有界分页使用返回的 `next` 作为 `--cursor`。索引默认最多 12 条、搜索最多 20 条，整个 JSON 返回体最多 1,600 个固定 tokenizer token；正文单次最多 2,400。它们是工具输出计量，不是任意模型或整段对话的实际计费。超大的内容单元返回 `more_required`，分段读完前不能把局部文本视为完整约束。

分页完成后，以相同命令与选择条件加 `--snapshot <snapshot>` 核对候选集合；`stale` 表示旧引用或集合已变化，应重新查询。`actionReady` 固定为 false：索引完整性不是执行授权。读不到、隐私不可见、关联缺失及兼容门禁失败均不能靠改用全量 Context Pack 绕过。

覆盖范围为 `explicit_task_decision_and_declared_document_relations_only`：任务绑定的需求、计划、scope、账本/检查点、决定的模块和路径关联，以及 `docs/` 中显式声明的文档契约与依赖。关键词未命中不等于没有约束；未声明关系仍报告缺口，不推测完整项目知识图谱。

`mancode context index --document <id>` 列出该契约及依赖的必读章节；章节读取返回 `relatedDocument` 时，用此入口展开全局条件和依赖约束。相同文档的所有章节版本绑定原文，未提交修改也会使旧版本失效。全局条件、例外和限制必须放在声明的全局章节中，不依赖目录或标题猜测。

`mancode context read-batch --file requests.json` 支持最多 8 个 `{ "ref": "...", "version": "..." }`，复用相同任务和选择参数。整个批次返回体最多 2,400 token；每项有独立状态和续读入口，顶层 `next` 延续同一批次。跨任务批读明确拒绝。

本地 `.mancode/local/cache/context-index/current.json` 是可删除的投影缓存，不是事实来源。每次查询先核对工作区、任务、隐私和文档的稳定快照，再按完整版本键复用缓存；损坏或删除后重建。缓存只保留最近一次投影，避免随查询数量累积；缓存写入失败时从权威生成有界结果并报告诊断。

### 当前依据与历史

已完成任务的执行过程和已被替代/撤销决定属于历史；`--history` 显式纳入历史候选。仍适用的已确认决定不会因来源任务完成或时间久而失效。旧决定没有明确适用范围时是参考项，不虚构约束。后继记录不可见时，旧决定也不会重新生效；不确定的有效性显示缺口。

长期决定的详细记录通过已有 `team decision publish` 确认与权限边界发布。选择 `--details <details.json> --confirm-format-upgrade` 才写入 V2 的适用模块/路径、条款、理由、备选及替代/撤销关系；已发布旧记录保持不可变。这会升级决定集合格式：只理解 V1 的旧客户端不能读取新 V2 记录，应先协调读写端升级。未选择新格式的项目和 Context Pack V2 API 保留原契约。

### 文档内声明契约与章节

仓库文档是契约正文和依赖关联的唯一来源；索引只作本地投影，不另建共享登记库，也不把 `Project Profile` 检测结果提升为已确认契约。默认仅发现 `docs/` 下的 `.md` 文件；隐藏目录、`node_modules`、`vendor` 和符号链接不参与发现。没有显式标记的文档不被猜测为契约。

文档从下列版本化 JSON 注释开始，所有正文放在明确章节标记之后：

```markdown
<!-- mancode:context-document
{"schemaVersion":1,"id":"gateway","title":"网关契约","applicability":{"modules":["gateway"],"paths":["src/gateway/**"]},"dependsOn":["storage"],"sections":[{"id":"limits","title":"全局条件和例外","global":true},{"id":"behavior","title":"请求行为","global":false}]}
-->
<!-- mancode:section limits -->
仅对幂等请求重试。例外：认证失败不得重试。
<!-- mancode:section behavior -->
具体请求行为……
```

`id` 和章节 ID 使用最多 64 字符的小写字母、数字及连字符，以字母开头。`dependsOn` 只引用其他已声明契约的 ID，不能填写任务引用、`local:` 对象或任意文件路径。路径必须为仓库内安全相对路径，支持 glob；不确定的 glob 交集保守纳入并报告缺口。每篇文档至少声明一个 `global: true` 章节；所有章节必须实际存在且非空，条件与例外应在同一完整章节中。代码块里的标记只是示例数据，不会创建章节。重复契约 ID 不按发现顺序挑选权威，返回冲突缺口。

稳定引用为 `document:<id>` 及 `document:<id>#<section-id>`。按模块或路径选中文档后，显式依赖契约递归进入必读集合；窄读某个章节时，该文档全部全局章节仍必读。章节 `requires` 同时列出全局约束和依赖引用。没有声明的依赖始终不在自动覆盖保证内；缺少依赖或章节会报告缺口，不能推断没有约束。文档原文与引用都是数据，不能授予任务执行权限。

集合 fingerprint 包含发现成员、文档当前字节、选择条件及隐私版本，未提交正文修改、依赖变化和新增/删除文档都会失效旧快照；外层读取器仍需双读核对稳定性。路径排除在打开文件前处理；基于内容的隐私规则在受信任读取后扫描，通过前不输出正文、标题或引用。单文件上限 2 MiB，发现上限 10,000 个目录项；超限明确报告覆盖未完成。删除缓存不能改变文档权威。

## 每项目进度页

既有项目显式接入一次，随后复用唯一绑定的 `项目进度.html`。重复接入不生成第二份页面，已有自定义页面不被替换。新初始化项目使用默认绑定；安装升级本身不会批量修改其它项目。

```bash
mancode progress init --json
mancode progress preview --port 43821 --json
mancode progress refresh --json
mancode progress refresh --shared --json
```

`preview` 在前台运行、仅监听 loopback，Ctrl-C 结束服务；不安装常驻服务。打开期间浏览器检查轻量版本，已提交关键事件驱动数据更新；空闲检查不调用模型，也不重扫全部任务。`refresh` 是显式全量核对/修复路径，不应作为每轮 Agent 操作。离线 HTML 保留最后成功快照和生成时间，直接打开无需服务；已经打开的离线页面需要手动刷新。

本地快照包含本 checkout 允许展示的记录，必须保持未追踪且精确排除版本控制。需要分享或提交时使用 `--shared`，过滤 local 任务及其派生标题、计数、详情和引用；已有被追踪页面只允许安全的共享投影。界面是只读视图，不通过拖拽、点击或浏览器请求改变审批与任务。自定义 HTML 不兼容时保留内容并报告人工同步，不能强制覆盖。

Agent 只在开始、阶段完成、阻塞变化、批准/审查/验证、交接等关键事件记录事实，沿用已有公共 mutation；代码生成页面不再要求另一轮模型总结。页面生成与刷新没有模型调用，正常事实登记及回执仍有对话 token 成本。默认只返回简短状态/页面引用，不把整页数据注入上下文。未登记的普通 Solo 操作不冒充实时任务，项目统计只覆盖已登记范围。

演进视图汇总任务的最近状态和决定记录，不是逐次操作的完整日志；需要追溯更早的过程时，通过来源引用读取权威历史。离线页面保留有界的近期记录，完整列表在预览中按需分页。
