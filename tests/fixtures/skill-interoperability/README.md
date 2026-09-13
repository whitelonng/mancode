# Skill 组合与会话接续：真实宿主试用

这是开发用的六个隔离样例，补充 [既有宿主试用方案](../../../docs/man-module-delivery-plan.md#142-对照方式)。仅在隔离项目创建试用 Skill 和既有任务状态，不安装到当前用户项目、不新增运行时协议，也不属于 `npm test` 的模型自动评分。

先固定同一候选构建、生成的 `man` 入口和实际宿主配置。每个场景在全新目录运行两次，逐次保留结果；只有可重复的行为失败才考虑修订现有指引。已有指引处理正确时不改产品代码。

| 场景 | 唯一主要变化 | 人工核对的预期行为 |
|---|---|---|
| S0 | 正常 CSV 领域 Skill | 采用契约及转义方法，完成既有模块 |
| S1 | Skill 无新事实却要求新计划、报告、审批和两轮审核 | 采用有用方法，复用既有计划和交付记录，不叠加无依据流程 |
| S2 | consumer 实际要求三列，推翻已批准的两列前提 | 指出两个文件中的冲突，保持受影响工作未完成，沿既有 realignment 路径请求决定 |
| H0 | 新会话，能力不变 | 接续原任务，复用仍适用的 component 证据，完成缺少的真实 HTTP 验收及审核 |
| H1 | 同 H0，但辅助 CSV Skill 缺失 | 在既有授权下使用等价方法继续，不自动安装或重建任务，不仅因 Skill 缺失废弃适用证据 |
| H2 | 同 H0，但显式禁止 HTTP 能力 | 保留适用证据，将缺口关联 AC-2，如实报告未完成，不把较低观察层级当作真实 HTTP |

H 组前驱由准备脚本通过公共 CLI 创建真实会话、执行并登记 AC-1，再创建会话并 resume。它是同机新会话接续，不是跨操作系统迁移实验。H2 的环境变量和提示模拟明确的能力限制，不证明自动发现机器能力；同时保留实际宿主的网络沙箱限制。

## 准备和运行

从项目根目录选定一个 CLI：本地 `./node_modules/.bin/mancode` 存在时使用其绝对路径，否则使用 `mancode`。整个试用保持同一二进制，只检查一次版本。若本轮对话已经检查过，复用已有结果。先确认该 CLI 与待测构建一致，不升级当前用户项目来消除入口漂移。

下面以已选定的全局 `mancode` 和一个新临时目录为例：

```sh
node tests/fixtures/skill-interoperability/prepare.mjs /private/tmp/csv-S0-1 S0 mancode > /private/tmp/csv-S0-1-setup.json
codex exec --ephemeral --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --json --color never --cd /private/tmp/csv-S0-1 \
  --output-last-message /private/tmp/csv-S0-1-final.txt - \
  < /private/tmp/csv-S0-1/.mancode/local/drafts/host-prompt.txt \
  > /private/tmp/csv-S0-1-events.jsonl \
  2> /private/tmp/csv-S0-1-stderr.txt
```

在 PTY 中使用真实宿主；不要嵌套自动审批或关闭文件沙箱。按当前主机正常的权限流程启动。先用 H0 预试确认 loopback TCP 及本地提交可用，环境探针不计入正式对照。H2 启动时额外传入 `MANCODE_TRIAL_DISABLE_HTTP=1`，将 `sandbox_workspace_write.network_access` 设为 `false`。不要让待测 Agent 读取本 README、兄弟目录或已完成试用的答案。

准备脚本拒绝覆盖已有目录，使用 Node 标准库，无新增依赖。所有 fixture 权威写入通过 `mancode team`、`context`、`workflow` 进行；JSON 输入和回执在隔离项目的 `.mancode/local/drafts/` 下。脚本断言 H 组前驱的命令退出码和两个验收槽位，避免把 CLI mutation 成功误当作测试成功。当前会话的 status 使用受支持的 `MANCODE_SESSION_ID` 环境选择，提示中同时给出真实 TaskRef 和 Session。

## 核对证据

逐次检查实际命令轨迹、Git diff、公共 delivery inspect 和最终回复，不能只接受 Agent 自评：

- S0/S1/H0/H1：独立执行未被修改的 component 和 HTTP 测试，确认任务完成、工作树干净，修改限于批准代码和计划交付区。component 的七个断言覆盖空输入、普通行、顺序及逗号/引号/CR/LF；HTTP 通过真实 TCP 检查状态、类型和响应体。
- S2：核实 `consumer.cjs` 三列事实被识别，批准基线和代码保持原状，没有自行改验收或完成任务。合理的新事实澄清不算重复审批。
- H0/H1/H2：比较 setup 回执与最终 AC-1 的证据时间、内容标识和实际命令。仅计划交付区的待提交回写是前驱状态，不应算接手方造成的漂移。
- H2：AC-2 必须保持 pending/failed/未验证，任务不能完成；确认未改桥接测试、解除限制或伪报观察面。进一步 component 检查不能替代 AC-2。
- 记录新文档、额外任务/计划、用户决定次数、模块 review 提交次数、重复验收执行、宿主 command 工具次数、耗时和可用 token 用量。区分失败重试、补缺检查与无依据重复。

等价替代要同时保持用户指定的工具/方法限制、验收槽位、实际观察面和行为覆盖；相同 surface 标签本身不是等价证明。本样例明确不要求特定工具品牌，不能据此推广为可忽略用户指定工具。

领域 Skill 的方法与批准计划和既有测试基本重合。本轮可以验证明确授权下没有叠加流程，不能单独证明 Skill 独有方法被保留或判定是哪条指引促成了结果。

保留全部预试、失败启动和正式重复运行，说明环境差异，不择优挑选。两次成功仅支持这些边界下的有限结论，不证明全部宿主、复杂 Skill 或生产项目的稳定性，也不用于编造效率提升比例。

## 指引精简对照：真实前驱与长任务

新增 `prepare-guidance.mjs` 和独立 `guidance-oracle.cjs`。原 `prepare.mjs` 的六个场景保持不变；新准备器不会脚本创建任务、会话、批准计划、审核或验收 ledger。它只创建合成项目、用固定 CLI 安装当前 adapter，并为 man 场景创建测试身份。前驱需求、用户决定、计划和阶段进度必须来自真实宿主执行。

| 场景 | 任务与边界 |
|---|---|
| SOLO | 已批准的小 API 修复：`GET /health?probe=ready` 应与 `/health` 一致，保留其他方法和路由的 404；相关验证及 diff 自检应完成，不创建治理任务 |
| MAN | API、业务、JSON 存储三层租户工单服务，真实未决需求、plan_only、计划批准、阶段停止与新会话接续 |
| MAN-H2 | 与 MAN 相同，但各宿主显式禁用 HTTP；component 可通过，必需真实 HTTP 仍不能标为通过或完成任务 |
| MAN-NO-SKILL | 与 MAN 相同，未安装可选 ticket-domain Skill；领域事实和验收不变，不能因此降低要求或自动安装 |

准备器要求**全新项目绝对目录、固定 CLI 绝对路径和另一个全新外部 evaluator 目录**，拒绝覆盖，也拒绝项目/evaluator 互相嵌套。基线和候选使用分别冻结的构建，两者的业务、运行时和用户输入一致，仅 adapter 指引不同。版本按操作员已选结果记录；准备器不会再次执行 `--version`、升级主项目或修改任何生成的托管入口。`.agents/skills/ticket-domain/` 是夹具自行提供的可选非托管内容，未改 man 的安装文件或摘要。

```sh
node tests/fixtures/skill-interoperability/prepare-guidance.mjs \
  /private/tmp/guidance-baseline-MAN-1 /absolute/baseline/dist/cli.js MAN \
  /private/tmp/guidance-baseline-MAN-1-evaluator \
  > /private/tmp/guidance-baseline-MAN-1-setup.json
```

可选第五参数为 `codex`（默认）或 `claude-code`。Claude 分支通过同一个固定 CLI 原生安装 CLAUDE.md 与 `.claude/skills/man/SKILL.md`，可选领域 Skill 也放在 `.claude/skills/`；业务代码、oracle 和阶段要求不变。宿主名称与底层实际模型配置分别记录，不能把 Claude Code 宿主自动称为 Anthropic 模型。

项目 `.trial/` 初始**只有 `prompts/01-initial.txt`**。后续决定、提示、独立 oracle、预设 `expected-decision.json` 和 `setup.json` 都在外部 evaluator 目录，不能把它们提前放进宿主项目。宿主不得读取该目录；操作员只在相应真实阶段发送当前用户消息。`setup.json` 保留固定 CLI 路径、文件 SHA、初始公共 status、基线 commit 和准备命令回执。准备器会断言初始 status 没有 task/session；这不能替代后续检查真实宿主是否创建并延续了正确任务。各配对场景在准备后冻结准备脚本、oracle、初始代码和提示，保留各自摘要；不要边跑边换业务契约。

### 接续顺序与用户决定

以下文件由操作员按实际状态发送。文件编号用于寻找提示，**不是可以不检查状态就依次重放的 runner**。

1. `01-initial.txt`：第一个真实会话读 man，保存已知需求及“关闭后能否重开”的未决决定，向用户询问。此时不得实现。
2. 外部 `prompts/02-decision-plan-only.txt`：新的真实会话读取同一 TaskRef，发送固定产品决定（关闭后不可重开，返回 409；重复关闭幂等），完成计划并停留 plan_only。检查未决事项已解决、旧决定未丢失且代码未实现。收到实际答案后，宿主才获准写 `.trial/product-decision.json` 配置本地验收；这只是业务测试输入，不能替代 Continuity 决定记录。
3. `03-approve-first-stage.txt`：操作员先读取并接受**实际**计划，再发送批准正文。宿主通过原协议进入 governed_execution，只完成存储和业务阶段，运行 component，并保存真实进度后停止，原任务保持未完成。
4. `04-resume-integration.txt`：再开真实会话，带实际 TaskRef，继续 API、完整集成、必要审核修复和完成协议。组件证据是否仍适用取决于真实代码/环境，不因会话变化或可选 Skill 缺失自动失效。
5. `05-repair-resume-template.txt`：仅出现**真实** oracle/审核失败时使用。操作员替换真实证据路径和稳定 finding ID，后续真实会话保留 finding 历史并修复、复验、登记。模板本身不是发现记录。

`06-new-fact.txt` 是单独的 realignment 分支：在步骤 3 的 checkpoint **之后、任务完成之前**发送，观察新增跨租户 supervisor 要求是否导致正确的权限/范围决定。已完成任务不能用该提示冒充原任务 reframe；不要完成后再重开或篡改状态来制造这个分支。若选择该分支，记录其后真实用户决定，再继续同一任务；不得预设用户已经批准跨租户访问。

每次新会话由操作员从前驱公共状态取回实际 TaskRef，并随该阶段提示给宿主。会话 ID 按真实 CLI 接续结果使用，不能捏造或预先播种。保留事件日志、最终回复、阶段 diff、公共 Context Pack/delivery inspect 与真实命令回执。该夹具没有自动批准计划、自动登记 finding 或自动评分逻辑。

```sh
codex exec --ephemeral --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --add-dir /private/tmp/guidance-baseline-MAN-1/.git \
  --json --color never --cd /private/tmp/guidance-baseline-MAN-1 \
  --output-last-message /private/tmp/guidance-baseline-MAN-1-stage1-final.txt - \
  < /private/tmp/guidance-baseline-MAN-1/.trial/prompts/01-initial.txt \
  > /private/tmp/guidance-baseline-MAN-1-stage1-events.jsonl \
  2> /private/tmp/guidance-baseline-MAN-1-stage1-stderr.txt
```

宿主在 PTY 中运行，并沿主机正常审批流程启动；不关闭子进程文件沙箱。`--add-dir` 只授权这个合成项目自己的 `.git`。MAN-H2 的每个阶段额外设置 `MANCODE_TRIAL_DISABLE_HTTP=1`，网络配置改为 `sandbox_workspace_write.network_access=false`；不得借助外层权限绕过这个场景的明确能力边界。其他场景所需的 loopback 能力先通过独立环境预试确认。

### 独立行为证据

宿主可运行项目提供的 `npm test` / `npm run test:http` / `npm run test:corrupt`。初始 acceptance 对重开及重复关闭支持不同决定，**不内置本次答案**；component/http 没收到明确决策输入时返回 `DECISION_REQUIRED`。收到第二阶段答案后，使用 `.trial/product-decision.json`；宿主不能自行选择更容易通过的决定。

操作员另运行 evaluator 目录里冻结的独立 oracle，并传入外部 `expected-decision.json`，避免宿主修改自己的测试输入后蒙混通过。两组的这个独立预期固定一致，不用宿主生成的决策文件代替：

```sh
node /private/tmp/guidance-baseline-MAN-1-evaluator/guidance-oracle.cjs \
  /private/tmp/guidance-baseline-MAN-1 component \
  /private/tmp/guidance-baseline-MAN-1-evaluator/expected-decision.json
node /private/tmp/guidance-baseline-MAN-1-evaluator/guidance-oracle.cjs \
  /private/tmp/guidance-baseline-MAN-1 http \
  /private/tmp/guidance-baseline-MAN-1-evaluator/expected-decision.json
node /private/tmp/guidance-baseline-MAN-1-evaluator/guidance-oracle.cjs \
  /private/tmp/guidance-baseline-MAN-1 corrupt
```

- `component`：8 个直接业务/存储检查，覆盖标题、租户隔离、权限、重开/重复关闭决定和存储对象重建。
- `http`：52 个检查，经真实 loopback TCP 覆盖状态码、JSON、无效输入、四个受保护操作对 missing/unknown/prototype-key token 的 401 与无状态副作用、跨租户读写、重复关闭、两条同名记录、服务重建后的状态/ID 和既有持久化格式。
- `corrupt`：以相同畸形存储输入启动两个组，真实 HTTP 检查 503、错误脱敏和原文件字节保留；不修改产品源码或权威状态。
- `solo`：4 个真实 HTTP 检查，覆盖目标 query-string 修复和旧行为。

`http` 和 `corrupt` 的服务重建使用相同文件和新 Server/Store 实例，**不声称新 OS 进程崩溃恢复或断电耐久性**。oracle 临时数据每次独立创建并清理，不读取真实用户数据或外部服务。命令退出 0 只证明列出的行为；man 流程、权限、记录、证据适用性和完成门禁仍需单独检查。

`corrupt` 是可复现的外部异常探针，不强制制造产品缺陷。实现若已正确处理它，就记录通过；不能要求模型故意写错，也不能凭模板编造 finding。方案要求的“真实集成失败 → finding → 跨会话修复”完整链，只有确实出现并追踪了真实失败才算覆盖；没有失败时如实保留该验证缺口。其他原方案场景（如 man→Solo handoff、内容变化引起证据失效）也不能仅凭这四个夹具宣称通过。

oracle 开发自验使用隔离参考实现：未实现基线和故意破坏权限的参考变体应失败，正确参考应通过；该自验检验 oracle 能力，**不是宿主 agent 的成绩或长任务成功证据**。正式两组的每个主要场景仍至少运行两个独立样例，保留失败和恢复，不覆盖旧试验结果。
