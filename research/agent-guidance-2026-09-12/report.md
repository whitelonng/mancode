# mancode 的 AGENTS.md、CLAUDE.md 与 Skill 约束研究

日期：2026-09-12。范围：三个子 agent 的独立只读审核、主 agent 源码核对、原始研究阅读与静态文本测量。本轮产出建议，没有修改产品规则、运行时或已安装入口，也没有执行新的模型对照试验。

## 判断

应该调整。当前最值得修正的是约束的适用范围、重复确认条件和加载位置，而不是降低项目的验收与授权标准。

强模型既更能自行决定实施方法，也更可能认真执行文档中的额外要求。应保留用户承诺、项目特有事实和可核验的结果要求；让调查路径、工具组合和表达形式随任务变化。不能用文件长度衡量严谨性，也不能把每一条旧流程改写成新的强制 hook。

需要修正此前讨论中的一个过强判断：不是所有规则都必须先有事故证据才值得保留。用户明确要求、数据边界、兼容性承诺和验收标准本身就有正当来源；低频严重风险不能因为几次试验没发生就忽略。额外报告、重复审批、固定角色与轮次等步骤要求，应承担更高的收益证明责任。

## 实际审核对象

当前根目录存在 AGENTS.md，没有 CLAUDE.md。Claude 相关判断来自源码生成器，没有冒称已在 Claude 宿主验证。当前源码的共同入口是 [renderV3Bootstrap](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1505) 与 [renderV3ModeEntry](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1578)，man 模式正文来自 [man.actions](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1707)。

磁盘安装版本与源码候选不同：[已安装 man 入口](/Users/whitelonng/code/mancode/.agents/skills/man/SKILL.md:25) 未使用 --delivery；源码已经包含模块交付、verificationSurfaces，以及更多常驻工程规则。旧的 [mode-skills.ts](/Users/whitelonng/code/mancode/src/installers/mode-skills.ts:66) 和 src/templates/skills 仍有 legacy 路径，不能把它们全部算成本会话正在执行的规则，也不能只改它们来修正新入口。

静态测量使用当前工作区 renderer 和 cl100k_base，同一计数器用于比较：

| 对象 | token 数 | 口径 |
|---|---:|---|
| 当前磁盘 AGENTS.md | 1,832 | 含本项目命令、模块说明及 managed block |
| 当前磁盘 man Skill | 2,363 | 显式读取后的完整正文 |
| 源码生成的 Codex bootstrap | 2,845 | 仅 managed block，不含用户自写项目说明 |
| 源码生成的 Codex man Skill | 4,074 | 完整模式入口 |
| 源码生成的 Claude bootstrap / man Skill | 2,784 / 4,000 | 源码候选，未安装 |

这些数值只描述信息量，不是实际模型账单、完整上下文、速度或性能下降证据。不得据此设定“必须少于某个 token 数”的新门槛。重现脚本见 [measure.mjs](/Users/whitelonng/code/mancode/research/agent-guidance-2026-09-12/measure.mjs)，具体输入摘要见 [measurements.json](/Users/whitelonng/code/mancode/research/agent-guidance-2026-09-12/measurements.json)。源码 HEAD 为 8651f21e052fca3a8bfcd396f098701a9a9f2823；工作区另有此前未提交修复，HEAD 不能代表全部文件内容。

## 外部证据与局限

以下区分对照研究与经验建议；不同研究不能直接平均，也不能直接推算本项目的收益。

| 原始来源 | 能支持的判断 | 不能外推的内容 |
|---|---|---|
| [Evaluating AGENTS.md，v2，2026-06-23](https://arxiv.org/html/2602.11988v2) | 在 300 个 SWE-bench Lite 和 138 个 CTXbench Python 任务上，上下文文件未稳定显著提高成功率，增加了执行成本。附录没有发现长度与效果的清晰关系。 | 模型组合、任务和评分有限；未完整衡量安全、维护性及项目流程合规。不能推出所有说明文件有害，或不该运行测试。 |
| [AGENTS.md 效率研究，2026-01-28](https://arxiv.org/html/2601.20404v1) | 10 仓库、124 个小 PR 的对照报告效率改善，说明影响并非单向。 | 质量抽查较弱，没有全面证明正确性不退化。 |
| [SkillsBench，v4，2026-06-14](https://arxiv.org/html/2602.12670v4) | 87 个任务、18 种模型与执行框架组合，精选 Skill 平均通过率提升 16.6 个百分点，强模型也有收益。 | 构建时排除了无可测差异的任务；没有等长度普通资料对照。不能据此推算日常编码收益，或单独证明 Skill 格式、强制步骤有效。 |
| [Claude Code 官方实践](https://code.claude.com/docs/en/best-practices) | 常驻文件保留普遍适用、难以从代码推断的信息；偶尔需要的知识按需读取；观察精简后的实际行为。 | 这是实践建议，不是最佳字数或步骤数量的实验定律。 |
| [OpenAI Harness engineering，2026-02-11](https://openai.com/index/harness-engineering/) | 用简短导航连接深层资料，以可执行检查维护结构边界，允许实现方式灵活。 | 内部项目经验，不是随机对照；不照搬其团队和合并策略。 |
| [Anthropic Skill 设计说明，2025-10-16](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 按真实能力缺口组织专业信息、脚本与逐步加载的参考资料。 | 没有证明每项任务必须使用 Skill，或所有 Skill 都有用。 |
| [Anthropic Agent 评估实践，2026-01-09](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 验证真实产物和环境终态，结合轨迹；避免把指定工具顺序当作正确性的替代。 | 评估设计经验，不是 mancode 已经通过的效果实验。 |

由这些证据推导出的本项目建议：分别评价信息是否必要、步骤是否有帮助、结果是否达标；不能把三者混为“遵守的规则越多越好”。

## 具体取舍

| 位置与现有规则 | 建议 | 保留的严谨性与证据边界 |
|---|---|---|
| [AGENTS.md 的命令、测试入口](/Users/whitelonng/code/mancode/AGENTS.md:5) | 保留准确命令和少量不明显的项目约定。模块导航只保留能节省查找的部分。 | 同名契约不存在时应定位真正受影响的契约，不能只为满足文件命名而空跑；这仍需按变更核对。 |
| [Solo 无需治理身份](/Users/whitelonng/code/mancode/AGENTS.md:51) 与 [所有 mutation 只能通过 CLI](/Users/whitelonng/code/mancode/AGENTS.md:66) | 将后一条明确限定为 Continuity 权威状态；普通代码、文档修改遵循任务授权。 | 防止直接修改 ledger 的约束继续保留。当前是静态歧义，不是已证明模型停止工作的实测。 |
| [无 TaskRef 时报告 no task bound 并停止](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1557) | 明确停止的是无授权的治理操作，普通问题仍应继续回答。 | 不为概念讨论创建身份、session 或 workflow。 |
| [API、并发等 hard-risk 主题触发确认](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1541) | 按具体影响、实际授权和未决决定判断。授权仍适用时复用；只有新增影响、越界或真实冲突才暂停受影响动作。 | 高风险工作仍需相应验证，明确规定的审批仍需遵守。不能把“主题名称”本身当作重复请示理由，也不能默默决定新迁移/删除。 |
| [固定 F-1 至 F-3 及逐项分类](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1715) | 保留核对前提、区分事实与推断；编号、表格和展示方式按任务需要。 | [semantic requirements 输入](/Users/whitelonng/code/mancode/src/commands/requirements-input.ts:32) 不依赖 F-ID。没有证据时允许零发现；不为了填表制造疑问。 |
| [UI 方向选择规则](/Users/whitelonng/code/mancode/src/context/design-guidance.ts:4) | 当前已有局部修复和既有方向例外。先减少无关任务的加载；用户明确委托设计决定的处理可作为单独候选。 | 视觉偏好是用户控制权，不能借“模型更强”直接取消；本轮不改变这项产品选择。 |
| [常驻模块文档交接规则](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:134) | 把特定 delivery 的计划、架构目录、进度页细节放到确实进入该模式时需要的位置。 | 保留计划权威、隐私、正确投影及发布事实。源码虽声明只适用 delivery，当前仍对所有 AGENTS/CLAUDE 入口渲染。 |
| [针对模型习惯的哈希/重复读取提示](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:153) | 作为待消融的效率提示，不永久升级为全局强约束。 | 必需的完整性检查和核验仍保留；现有文字也已包含这些例外，不能按关键词删掉。 |
| [JSON 格式与罕见恢复配方](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1722) | 格式保留但按需读取；特殊 checkpoint 恢复按具体错误查阅。正文保留导航和状态保护。 | 不删协议、不让模型猜命令，也不把原项目 docs 路径当作安装到用户项目后必然存在。 |
| [模块审核与结果回读](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1741) | 保留覆盖目标、审查实际 diff、诚实标记独立/自审。复用已有合格审核，有新证据时补查。 | 不为满足固定轮数新增审核，不把“一次”解释成发现新缺陷也不能检查。流程改变必须与原任务策略兼容。 |

## 代码能保证与不能保证什么

[task-operation](/Users/whitelonng/code/mancode/src/runtime/task-operation.ts:237) 的锁与 revision、[delivery runtime](/Users/whitelonng/code/mancode/src/context/man-delivery-runtime.ts:459) 的 subject/surface 检查、[完成检查](/Users/whitelonng/code/mancode/src/context/man-delivery-runtime.ts:783) 等已经提供可执行约束。应继续用这些契约及对应测试维持状态一致性。

但必须准确描述覆盖边界：

- 文件 scope 检查是完成/治理检查，不是阻止每次编辑的操作系统沙箱；授权文件内仍可能发生语义越界。
- 执行命令并捕获退出码，不等于命令验证了目标行为；surface 标签匹配不证明真实 HTTP 请求发生过。
- reviewer 字段不能认证另一位 reviewer 的身份，coverage 填满也不等于真的完成了审核。
- CLI 保存批准状态，但不能独立证明聊天中的授权来源和内容。模型仍需理解用户意图、事实冲突和证据适用性。

因此结果标准仍要写清楚。第一批精简不改变状态机、必需验收、证据失效规则、作用域门槛或兼容策略。

## 推荐的实施顺序

### 第一批：小范围修正措辞，形成可测试候选

只改 canonical renderer 中作用域歧义、无任务停止的对象和既有授权复用条件；合并同一入口内完全重复的表述。示意语义如下，不是已经发布的指令：

> 仅 Continuity 的任务、会话、计划、审核和验证状态必须通过公共 CLI 修改。普通代码与文档修改遵循用户已授权的任务范围。
>
> 普通问题或 Solo 工作无需创建治理状态。没有 TaskRef 时不要尝试治理操作，继续完成用户的普通请求。
>
> 涉及高风险领域时评估具体影响。已有授权覆盖当前动作且前提未变时继续；发现真实冲突、超出授权的新影响或会改变结果的未决决定时，暂停受影响动作并提出聚焦问题。项目明确要求的审批和验证仍需遵守。

这批不改任务 schema、不增加规则引擎、不自动判断风险级别，也不直接升级用户当前的 managed 文件。保留当前 nextAction 缺陷修复：仅缺证据时不再错误要求改代码。

### 第二批：只在信息可达的前提下减少加载

AGENTS/CLAUDE 留普遍项目事实和边界；模式 Skill 留适用条件、交付结果和必要语义；详细输入及罕见恢复说明按需查阅。已有 Context Pack 可以按 purpose 裁剪状态数据，但它目前不是动态教程注入器，不能把所有说明机械搬进去。

优先合并已有模式正文与常驻块的重复内容，把仅适用于新 man 模块交付的既有段落移入已有 man.actions。第一批不需要引入新的参考文件。

源码补查确认：新增 references 不会自动受管理。[managedTargetSpecs](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:1910) 仅枚举 primary 与五个 mode；[升级目标](/Users/whitelonng/code/mancode/src/installers/v3-adapter.ts:377) 是固定集合，[recovery parser](/Users/whitelonng/code/mancode/src/runtime/operation-recovery-payload.ts:1309) 拒绝未知 target。Context Pack 的 [section 定义](/Users/whitelonng/code/mancode/src/context/context-pack.ts:101) 也没有动态动作教程。

若以后需要 references，应通过现有机制补齐目标身份、平台路径、渲染来源、摘要与 missing/stale 检测、候选预览、冲突/符号链接保护、journal 恢复及卸载保留规则；不要宣称已有任意版本回滚能力。用户项目中不存在本工具源码仓库的 docs，发布后引用必须实际可达。只有测得收益值得这些成本时才做，不额外建立索引或调度器。

### 第三批：用反例验证候选，再考虑更大精简

同一构建、任务、环境、模型配置与授权，比较现状、精简版、无流程 Skill 三组。无 Skill 组仍可访问相同领域资料和 CLI 接口参考，不能故意让它因不知道私有协议失败。普通 Solo 与显式治理任务分开评分；所有组均遵守相同用户标准。

先用少量成对重复发现回退，不把两次成功当作统计证明。保留正常样例，不筛掉“有无 Skill 没差别”的任务。建议覆盖：

1. 已批准的普通修复，包含 API 或并发语境，观察是否产生无必要的再次确认。
2. 新事实与批准行为冲突，必须暂停受影响决策，不能自行改变验收。
3. HTTP 能力不可用，只能如实保持未验证；保留仍适用的旧证据。
4. 关键领域信息需要主动查阅，检验精简后是否漏掉必要知识。
5. 可选 Skill 缺失，以及代码/环境真的变化，分别验证正确复用与重新验证。
6. 新增未授权的不可逆影响，用隔离模拟操作检查是否越界。

先核对功能和流程结果，再比较必要/不必要澄清、额外报告、重复验证、调用数、耗时与 token。观察实际 diff、独立测试、工具轨迹及公共状态，不能只看 agent 自评或命令返回 0。

现有 [adapter 契约测试](/Users/whitelonng/code/mancode/tests/v3-adapter-contracts.test.ts:194) 有大量精确措辞断言。精简时保留必要的入口、CLI 参数、作用域和禁止 legacy 写入等契约；不能把每句建议、固定数量都永久锁成字符串标准。字符串测试能发现生成器丢失内容，不能代替宿主行为验证。评估工具也不得因模型采用另一条有效实现路径而判失败。

伪造证据、越权、篡改验收、错误完成或漏掉必需行为，均不能用效率提升抵消。出现问题先诊断原因并恢复对应最小约束；不要每遇到一个问题就追加一条常驻规则。针对某一宿主有效的候选，不自动宣称对 Claude、Codex 及所有新模型都有效。

## 本轮实际完成与保留事项

完成：三路独立审核、主 agent 复核、七项原始来源整理、源码候选与磁盘入口区分、静态测量、具体取舍和迁移建议。

尚未完成也未声称完成：精简候选的代码实施、真实宿主对照、Claude 宿主验证、安装升级或生产效果证明。已有 CSV/会话试用只是有限证据，领域方法与批准计划/测试基本重合，不能证明整个 Skill 体系有效或无害，见 [试用边界](/Users/whitelonng/code/mancode/tests/fixtures/skill-interoperability/README.md:51)。

当前建议是先实施第一批小改并验证行为。保留项目承诺和真实验收，将额外步骤的必要性逐项交给证据判断。
