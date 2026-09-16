<!-- mancode:plan-baseline:start -->
# mancode 执行门禁实施交接方案

日期：2026-09-16。已核对基线：`0958c9f`。

状态：用户已授权实施。TaskRef：`local:01M2MXNCPZ0VF1EZSX7K44MY1S`；分支：`codex/execution-gates`。首期0958c9f已独立推送develop。以下为批准实施目标，不冒充当前已实现能力。

## 1. 目标与既有约束

让受管工作在缺少 TDD、修复预算或准确提交的 CI 证据时无法宣称完成，同时保证所有执行有限时、失败可解释、中断可恢复。

已有授权取向：基础设施最多自动重试一次；同根因两次实质修复失败后停止自动编辑；时间预算按任务约定，不统一硬编码为十五分钟。TDD 第一阶段已经是风险适配指导，本阶段再实现可选机器门禁，不追溯伪造旧任务证据。

本期延续首期：man 管实施与正式验收；manba 诊断保留旧语义；独立 manba 审核默认出报告、没有 TaskRef 或修改权限。只读审核不得为了计数而自动创建任务。已有 Man TaskRef 的审核复用原任务，不切换 mode、不默认创建 child。

不承诺零缺陷，不将模型判断当成客观测试结果。门禁保护公共 CLI 的受管执行及完成路径；阻止任意宿主工具编辑文件需要另做宿主接入，本方案不声称已经做到。

## 2. 当前实现事实

| 文件 | 已有能力及缺口 |
| --- | --- |
| `src/commands/man-delivery.ts` | verify 执行 argv、采集结果、检查内容是否改变；当前 execFile 有输出上限，没有显式执行超时，也没有执行前持久化的尝试预约。 |
| `src/context/verification-ledger.ts` | V1 严格字段校验，记录当前自动/人工验收结果，没有 Red/Green 历史、预算或 CI 身份。 |
| `src/context/man-delivery-evidence.ts` | 已有内容与环境 subject、观察层、review coverage；不能仅凭摘要证明行为正确。 |
| `src/context/man-delivery-runtime.ts` | 现有完成门覆盖计划、审查、验证、记录、提交范围；上游包含提交不等于远端 CI 通过。 |
| `src/context/verification-record.ts` | 通过 journal/CAS 登记验证结果；新实现必须保留这条权威写入路径。 |
| `src/runtime/operation-*` | 已有事务与 repair，可复用；不能让长时间测试始终持有任务锁。 |
| `src/system/review-subject.ts` | HEAD/index/worktree 分层只读清单；它不是不可变测试快照，也不是验收通过证据。 |
| `scripts/project-checks.mjs` | 本地与 CI 已共用检查；保留现有步骤、Node 矩阵和 Windows 三 shell。 |

## 3. 推荐架构与兼容策略

推荐升级既有 verification ledger 到显式 V2，并配套新的 verification policy/capability，而不是向 V1 偷加字段。新 reader 兼容 V1/V2；旧 reader/writer 在接触 V2 权威前明确拒绝。具体版本号以接手时注册表为准，禁止复用已有编号改变含义。

V2 保留当前验收 slots，同时新增受控 execution 记录：

- 策略引用：版本、适用场景、批准的检查集合和任务预算。
- run：稳定 runId、purpose、acceptance/finding 引用、argv/cwd、环境与相关配置身份、源代码/测试身份、状态、超时、结果和脱敏产物引用。
- TDD pair：scenarioId、Red/Green run 引用、断言或测试身份、适用性、替代验证或例外引用。
- attempt：problemId、分类、假设、预算预约、执行结果、进展证据和后续动作。
- CI observation：目标提交/集成对象、workflow/job/matrix/run attempt、查询结果及有效性。
- decision：预算追加、适用性例外或检查契约变更的批准记录。

只存影响门禁的过程记录，不记录每次工具调用。大输出放有大小限制与隐私过滤的 artifact，ledger 留引用和摘要。当前最终验收 slot 与 Red 过程失败必须分开，Red 不得覆盖最终状态，更不能让历史 Green 自动覆盖新的失败。

所有公共 verify/apply/complete 路径都检查同一门禁函数；禁止从旧 apply 入口提交一个 passed 就绕过新策略。整份 ledger 写入必须保留受保护历史，不能用调用者提供的空数组抹掉尝试和例外。

只对显式启用新策略的任务生效。旧任务、旧诊断 outcome、普通 Solo、现有 child 合并不自动迁移；受管 Solo handoff 继承原任务策略。单独设计并测试显式迁移，不能凭当前文件推断历史 TDD。

## 4. 有限执行与崩溃恢复：先做这一层

建议 run 状态：`reserved → running → succeeded | failed | timed_out | cancelled | interrupted`。这些是执行记录状态，不应直接扩充 workflow.status 制造第二套任务生命周期。

执行协议：

1. 在短事务内校验权限、subject、预算，分配 runId，预约额度并提交；随后释放任务锁。
2. 通过受控 runner 启动命令，记录执行身份和启动确认。外部过程不处于可自动重放的 journal step 内。
3. runner 持续提供有界输出和心跳；超时/取消后清理自己启动的进程树，再以独立短事务登记结果。
4. 结果提交使用当前 revision/CAS，并核对任务、需求、测试及代码身份；过期结果留历史，但不能覆盖当前验收。
5. 恢复先检查该 run 的执行身份和存活状态，再选择附着、结算或标记 interrupted。PID 不能单独证明同一进程，必须防 PID 复用。

每个命令有有限 command timeout，每批 CI 等待有有限 observation budget；具体值由任务或批准的项目默认配置提供，启用时持久化。等待到期返回可解释状态，不能无限等待，也不能把超时当失败断言或通过。

必须处理启动失败、子进程失败、超时、用户取消、输出超限、CLI 被杀、结果写入中断，以及进程退出但结果提交失败。启动前取消且有证据证明未执行时可释放预约；启动结果不明时保守保留预约，repair 后结算，不凭超时猜测归还。

取消只影响本任务执行的进程，不能杀其他任务。Unix 与 Windows 分别验证进程树清理；无法确认子进程结束时标记 interrupted/需恢复，不报告取消干净完成。任何自动恢复都不得重新执行不确定是否成功的外部副作用。

## 5. 修复预算门禁

### 计数规则

- 基础设施：首次执行失败后，最多一次有依据的自动重试；总共最多两次执行。
- 同根因：两次实质修复都未解决问题，停止进一步自动修复。一次修复尝试从预约到补丁和约定验证结束，不能按每条测试命令重复收费。
- 测试命令数量和补丁行数都不等于修复次数。未经修改的重复复现归入诊断；诊断同样受约定的时间/调用预算约束。
- 还需任务级总修复额度，防止不断改 problemId 绕过限制。额度由任务预先声明，不在本方案替用户批准一个固定数值。
- 同一任务跨 session、agent、handoff 和恢复共用预算；问题合并保留既有消耗，拆分不得返还额度。
- 子调查/后继任务若用于继续同一次修复，应显式继承预算来源；新建同名任务不是机器能自动识别的同一根因，不能宣称语义级防绕过。

### 故障分类

分类包括 implementation、test_or_ci、infrastructure、flaky、pre_existing、contract_conflict、unknown。模型可提出分类，记录必须附证据；未证明的分类保持 unknown，不能借 infrastructure 标签反复获得重试额度。

修改 CI/测试之前需依据批准契约说明它错在哪里。合法纠错可以复用现有修复授权；删除必需检查、改变阈值/预期行为等契约变化必须另行批准，修改后旧证据失效。

### 额度用完以后

拒绝新增自动修复尝试及任务完成，给出 problemId、消耗、已试方案、剩余未知项、建议下一步。允许读取、查看日志、恢复事务、取消运行和提交批准决定。会执行程序的进一步诊断必须仍有相应额度或新的授权。

可选择：有证据后追加预算；批准修正检查契约；标记外部依赖等待；按已有协议暂停/放弃任务。追加是新决定，保留原计数，不清零，不自动完成。保留 failed/pending 与“已批准暂不处理”的区别。

## 6. CI 验收门禁

任务先声明交付目标 `local` 或 `remote_required`。local 不因没有 GitHub 或远端权限而被新增门禁拦住；remote_required 必须有准确远端证据才能完成，不能事后自动降级成 local。

第一版仅做薄 GitHub 查询适配器，通过现有认证渠道读取；不建设通用 CI 平台，不自动推送、触发 workflow、重跑远端任务、合并或部署。

证据至少绑定：repository、candidate SHA、tested SHA、事件、workflow 身份与配置版本、job/check 身份、必需 matrix、runId、attempt、结论及查询时间。PR 要区分 head、base 与 synthetic merge，并依批准的验收契约决定必须验证哪个对象；目标变化使旧证据失效。

可信来源与必需检查集合来自预先批准的项目/远端策略，不能接受任意同名 check。修改 workflow 或检查定义不能自动缩小必需集合。

规则：

- 最新分支绿灯、旧 SHA、旧 run attempt、同名非可信 check、缺少 matrix 或空结果不能算通过。
- required 的 skipped/neutral 不默认通过；只有预先声明且已证实的不适用条件才允许例外。
- 权限缺失、限流、API 超时、无运行记录、查询歧义都保持 unverified，不等同代码失败，也不等同通过。
- 轮询有退避、请求限流和批次截止时间；不持任务锁等待。到期返回 pending/unverified 与可恢复游标，后续显式继续查询同一目标。
- 只读重新查询不触发远端重跑。任何会产生远端执行的动作必须有独立授权与预算。

## 7. TDD 门禁

策略为场景级 `required | alternative | not_applicable`，与验收项关联。新可自动化行为及可复现缺陷适合 required；文档、保持行为的重构或无法自动化的宿主行为采用有理由的替代验证。不能声称用户已经同意对所有项目强制 TDD。

required 的顺序：先明确行为和测试 → 在未实现/未修复代码上运行 Red → 最小实现 → 同一行为断言 Green → 必需回归/项目检查。重构按需要发生，不强迫制造改动。

门禁校验：

- runner 捕获实际执行、版本身份与顺序，不能接收 agent 一句“已通过”作为自动化证据。
- 测试收集成功且目标行为断言失败才是有效 Red；语法、依赖、网络、超时、no-tests-found 不能满足 Red。
- 优先支持一个具体测试框架的结构化结果适配，本仓库从 Vitest 开始；不声称任意 argv 的非零退出都能自动识别为有效 Red。
- Green 引用相同 scenario 和适用的测试断言身份；修改/删除/跳过测试或改变断言后重新配对，合法测试修正保留原因及旧证据。
- 对代码已经存在的审查，可在隔离 fixture 回放旧代码验证回归测试；明确标为 regression replay，不冒称历史 test-first。
- 遇到无法识别的框架或输出，保留未验证，走预先声明的替代证据路径，不伪造严格 TDD。
- 语义测试质量仍需 review：实现无关的假测试即使满足结构与顺序，也不能被宣称由机器证明正确。

Red 与 Green 的相关测试/实现版本不同是正常现象，不能要求两次整个仓库 digest 相同。分别记录测试身份、实现身份及变更关系，Green 和最终验收再绑定当前待交付内容。

## 8. 统一门禁结果与恢复出口

不把所有问题都折叠成布尔 false。内部返回结构化 `code、subject、missingEvidence、run/problem 引用、下一步、允许动作`；CLI 区分成功、检查失败/缺证据、执行器错误等退出类别，并与仓库现有退出码规范统一。

建议原因类别：TDD_EVIDENCE_MISSING、TDD_PAIR_STALE、REPAIR_BUDGET_EXHAUSTED、RUN_INTERRUPTED、CI_PENDING、CI_TARGET_MISMATCH、REQUIRED_CHECK_FAILED、CAPABILITY_UNAVAILABLE、CONTRACT_DECISION_REQUIRED。具体命名在实施时按项目惯例冻结。

所有拦截都必须有合法出口：补证据、修契约、恢复 run、取消、明确追加预算、暂停或放弃。不能要求先验收通过才能修错误检查，也不能为了恢复反复创建新任务。

例外记录包含：范围、原因、证据、批准者、决定来源、约束、有效期或失效条件。例外可使任务按已批准条件完成，但报告必须写“有例外的验收”，不能把 waived/not_applicable 改写为测试已通过。agent 自填 actorId 不构成真实的人类批准证明；按实际宿主授权能力标明信任边界。

## 9. CLI 接口建议（均未实现）

尽量扩展已有 workflow delivery/verify 和 operation repair，而不是另造第二套入口。

| 操作 | 职责 |
| --- | --- |
| inspect/check | 展示策略、预算、当前执行、缺失证据与下一步；供完成门复用 |
| verify | 支持已声明 purpose、scenario、超时；预约后运行并结算 |
| attempt reserve/finish | 为宿主执行的修复绑定问题、假设和预算；不得把调用它当成实际文件写入已被拦截 |
| CI observe | 只读有界查询，支持恢复同一目标 |
| budget extend / exception decide | 记录合法授权与理由；CAS更新，不重置历史 |
| run inspect/cancel/recover | 查看、停止自己的执行、恢复不确定结果 |

第一阶段不要求 agent 编写含内部canonical字段的整份 ledger。语义输入由服务生成ID、修订与摘要；恢复与幂等使用固定 runId/operationId。

## 10. 分阶段开发与文件所有权

不要让“man agent”和“manba agent”各造一套计数器。两模式共享同一权威和门禁计算。

| 阶段 | 内容 | 完成条件 |
| --- | --- | --- |
| P0 契约 | 新policy、V2/schema、预算与授权模型、状态机、兼容拒绝 | 冻结数据契约和AC，绑定实际文件范围 |
| P1 执行基础 | 预约、超时、取消、输出、crash恢复、能力门禁 | 无长持锁；各中断点可恢复且不重复执行 |
| P2 修复预算 | 分类、问题/任务预算、暂停和明确追加 | 并发不超支、重启不清零；无法执行恢复路径则不能宣称完成 |
| P3 CI | 准确对象、必需集合、有限查询、完成门 | 错SHA/旧attempt/缺job/权限故障不误通过 |
| P4 TDD | Vitest结构化Red/Green、场景适用性、替代验证 | 目标失败有效、断言变化不借旧Red、历史回放诚实标记 |
| P5 集成 | man/manba入口、旧模式兼容、文档、真实目录验收 | 总审与全量检查通过，未执行平台明确标识 |

推荐分工：

- Agent A：V2权威、policy、journal/CAS、预约与预算；独占共享schema和写入服务。
- Agent B：有界runner、进程恢复、GitHub观察、Vitest证据适配；使用A已冻结接口，不直接改权威文件。
- 主 agent：CLI/完成门/模式生成器接线、需求计划、集成和最终review。公共文件单owner，先完成接口再并行实现。

若只有一个执行agent，按P0至P5顺序实施，无需为并行拆出新框架。

重点现有落点：`src/context/verification-ledger.ts`、`verification-record.ts`、`man-delivery-evidence.ts`、`man-delivery-runtime.ts`、`task-complete.ts`、`workflow-metadata.ts`、`manifest.ts`，`src/runtime/operation-*`、task operation/store，`src/commands/man-delivery.ts`、workflow/CLI，`src/installers/v3-adapter.ts`及审查指导模块。新增runner/CI/TDD模块放对应现有层，实施前列出准确文件和同名测试。不要把本节当成整个src目录的编辑授权。

## 11. 必需验收清单

| AC | 必须观察的行为 |
| --- | --- |
| G-1 | 旧任务仍可读且原完成语义不变；新任务显式启用；旧writer在创建journal前拒绝新能力。 |
| G-2 | 两个并发agent争抢最后一次额度只有一个成功；重复runId/结果提交不重复扣费。 |
| G-3 | 预约后未启动、启动后未回执、执行中、执行结束未记账、提交中崩溃均有可验证恢复；无盲目重放。 |
| G-4 | 命令挂住、输出超限、子进程挂住、取消和PID复用均不会造成无限等待或误杀；未知清理结果不报成功。 |
| G-5 | 一次基础设施重试后停止；两次同根因失败修复后阻止新尝试；换session/agent/问题名不清空既有记录。 |
| G-6 | 预算耗尽仍可inspect/cancel/recover；合法追加后从原任务继续，历史不丢；无授权追加被拒绝。 |
| G-7 | CI旧SHA/旧attempt/错事件/同名不可信check/缺matrix/空结果/skipped/neutral不能默认通过；基线变化使证据过期。 |
| G-8 | CI无权限/限流/离线/超时有限返回；恢复查询不自动重跑CI或推送；local任务不强制远端。 |
| G-9 | 真实目标断言Red→修复→Green可通过；语法/安装/网络/no-tests-found和跳过测试不能伪装TDD。 |
| G-10 | 修改断言、逆序证据、旧代码subject、过期配置、agent手写passed均不能绕过；例外保留批准与局限。 |
| G-11 | 独立manba审核不建任务/改mode；诊断outcome和child父快照协议保持原义；受管handoff继承门禁。 |
| G-12 | 新门禁在所有受管verify/apply/complete入口一致；错误CI可以依法修正，修正契约后旧证据失效，不出现无恢复出口。 |

每个新增业务行为先写可观察的失败场景。预算、CAS、恢复用真实临时仓库和故障注入；外部CI的确定性测试用录制/构造响应覆盖负向，再用获授权的真实远端验证身份匹配。没有真实远端权限就明确保留该项未验证，不能拿mock当已完成远端验收。

按仓库约定先运行受影响同名契约，再 `npm run check`；Windows进程树等改动必须在真实Windows验证，不能用macOS通过代替。测试资料使用 `/Users/whitelonng/code/mancode测试` 下新建的独立子目录，保留既有资料。

## 12. 最终交付要求

交付源码、契约测试、升级/兼容说明、恢复演练记录、真实测试日志及可读报告。完整报告分别说明：已强制的门禁、仍靠宿主配合的步骤、例外、未验证环境、CI目标与实际结论。

不得仅凭单测通过或CLI退出0宣称任务完成；读回正式ledger和完成门。只有全部必需验收满足且无未解决必修问题才完成。发布、远端push、CI触发等按接手任务的实际授权执行，本交接文档不自动授权这些动作。

接手时先报告P0准确scope与既有代码核对结论。不要重复首期已经完成的review inventory/检查脚本，不重新设计全部man流程，不通过放宽验收或删除检查让新门禁变绿。

## P0 收口决定与本任务验收

新任务显式 verification policy 2 / VerificationLedger V2；旧任务本期不提供迁移，维持原语义。沿用 verification_record journal。V2 整表 apply 拒绝，使用专用语义 mutation。TDD pair由场景和run关联推导，避免重复权威。达到额度的最后一次尝试成功可以完成；额度耗尽拦新尝试和未解决失败，不制造永久死锁。任务显式声明有限 maxRuns/maxExecutionMs/maxRepairAttempts、commandTimeoutMs/ci timeout。

Runner采用独立supervisor、nonce控制与回执，authority短事务不等待进程。无法证明清理或tested SHA时明确未验证。Vitest薄reporter保留结构化错误、skip/retry/unhandled信息。

Agent A独占context/runtime权威、兼容、预算与aggregate完成门；Agent B独占execution-protocol/runner/worker、ci-observer、tdd-evidence、vitest-evidence-reporter、对应测试和tsup入口。主agent负责commands、cli、man-delivery-runtime、生成指导、文档与集成。测试文件单owner。implementationScope以绑定的include/exclude为准；context/runtime glob只授权本功能必要的schema引用传播，不授权相邻重构。

本任务 AC-1 对应G-1/G-12的兼容/入口门禁；AC-2对应G-2/G-5/G-6预算；AC-3对应G-3/G-4执行恢复；AC-4对应G-7/G-8 CI；AC-5对应G-9/G-10 TDD；AC-6对应G-11模式兼容和全量检查；AC-7对应指定目录真实CLI演练与真实GitHub只读目标。自动化观察层为component。未运行Windows或真实CI场景不得写成通过，保留具体缺口。

<!-- mancode:plan-baseline:end -->

<!-- mancode:delivery-record:start -->
Task: local:01M2MXNCPZ0VF1EZSX7K44MY1S
Plan version: 2
Review: blocked
Verification: passed

Reviewer declaration: independent
Direction: 一次总审按模块分工：两个子agent交叉检查对方模块，主agent检查CLI接线、最终diff和用户验收。基线0958c9f；覆盖全部任务变更，context/runtime原文件只做必要V2传播。范围外research已隔离、不纳入提交；未删除验收要求。
Correctness: 已修复总审中的完成时CI不刷新、观察结束时漏新run、缺失receipt无法恢复、retryOf遗漏绕过、超时整数越界、Windows清理误报、暂存改动抵消漏检，以及真实CLI路径别名/恢复摘要/TDD退出状态问题；各项定向复验通过。原始失败记录保留。Windows实际执行能力仍缺失，AC-3不能标为满足。 最后一次远端刷新曾返回unverified，原始失败保留；唯一一次同条件只读复查通过，未归因成已确认的基础设施缺陷。
Proportionality: 新增代码限于持久化预算和状态转换、短事务执行协议、薄GitHub/Vitest适配及既有CLI/完成门。nonce/receipt用于防误杀和盲目重放，未建设通用CI或模型框架。只治理受管公共路径；任意宿主编辑、同义根因识别、人类批准身份不由这些字段证明；POSIX只保证原进程组。
Next: 保留任务in_progress；保存本地codex/execution-gates提交，不推送或合并。后续补齐可靠Windows进程归属/清理并在真实Windows验收，定向复核AC-3后再完成。
- AC-1: met — V1/V2严格解析、create显式启用、整表apply拒绝、aggregate/task-complete/solo-handoff统一门禁；兼容与公共CLI契约通过。真实旧reader拒绝新policy或execution字段，旧writer先被adapter完整性拒绝；writer policy直接边界另由契约覆盖。
- AC-2: met — execution-ledger/mutation通过journal与revision预约结算，最终一次合法成功可完成。覆盖并发、幂等、两次失败、基础设施最多一次重试、预算扩展与重启保留；真实CLI耗尽后拒绝新run。
- AC-3: unverified — POSIX runner/worker的nonce控制、start握手、超时、取消和恢复已由契约与macOS强杀演练验证。Windows在spawn前明确windows_process_tree_unsupported，尚未提供并实机验证批准计划要求的Windows进程树清理能力；禁止以旧Windows CI成功替代。
- AC-4: met — ci-observer核对仓库、workflow配置blob、SHA、事件、必需matrix及attempt；结束前重列运行集合，completion在锁外刷新。负向契约及真实GitHub0958c9f两条workflow/三个jobs通过；未知PR merge binding保留unverified，新阶段未推送。
- AC-5: met — Vitest3薄reporter采集断言/收集/hook/skip/retry等信息并关联run与测试配置身份。真实workflow execution Red→实现修改→Green通过，修改断言后失效；环境错误/no-tests/skip等负向契约通过。
- AC-6: met — man/manba共享已有TaskRef策略；独立诊断保留旧语义；生成入口与中英文文档一致。全量build/lint/typecheck/22个dist适配器/184文件1591测试通过。npm audit按既有high阈值通过，但报告Vitest依赖链3项moderate，未自动跨大版本升级。
- AC-7: met — 真实演练位于/Users/whitelonng/code/mancode测试/execution-gates-20260916-b84v27hw/cli-fDrsKM，保留report.json、commands.json、reproduce.mjs和不可变候选dist。实际读取GitHub已发布首期SHA；只对同一可执行JS复用本地行为证据，远端观察另行刷新。macOS arm64 Node25.9.0，未执行的新阶段Windows/远端CI明确列出。
- AC-1: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-2: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-3: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-4: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-5: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-6: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-7: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
<!-- mancode:delivery-record:end -->
