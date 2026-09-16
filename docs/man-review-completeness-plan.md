<!-- mancode:plan-baseline:start -->
# man / manba 完整审核与检查对齐

TaskRef：`local:01M2MEJFAJ5BCFX8MNCP99JMPF`。日期：2026-09-16。

用户批准方案 B，并选择首期实现完整审核和检查对齐；后续再加持久化硬门禁。原规划研究已由 reframe 归档，Git 历史保留原文。本计划替代仅规划的执行边界。

## 目标与边界

- man：保留一次模块总审与既有 completion gates，补全文件和行为覆盖、测试有效性、项目级检查及实际环境差异。
- manba：原诊断保持不变；显式审核支持一次性报告，默认不修源码、不创建诊断任务、不借 typed outcome 宣称验收。已有 Man TaskRef 维持原任务权限、mode、policy 与账本。
- 共用审查协议与只读 `mancode review inspect --base <ref> --json` 清单。明确基线，不猜 PR base；覆盖至 HEAD 与当前工作区，包括删除、重命名、未跟踪文件。无 Git、无有效基线或采集失败必须显式失败。清单不等于完成语义审查。
- 本项目统一 `npm run check`（Quality）和 `npm run check:windows`（Windows 准备检查），CI 保留原矩阵与真实 shell 冒烟。
- 风险适配 TDD 与有界修复先做流程指导；基础设施重试最多一次，同根因两次修复失败停止自动编辑，时间预算按任务约定。
- 本次不新增 audit purpose/outcome、TDD/预算/远端 CI 机器门禁、模型服务、OCR 依赖或权威数据库，不推送、合并或发布。

## 依据

[架构](architecture.md)、[工程约定](engineering.md)、[工作流](workflows.md) 定义现有 authority、journal 和兼容边界。根目录没有已发现的 `架构/`，不假设私有设计。

F-1（acceptance / repository_fact）：现有完成门有当前 review/verification，publication 只确认上游包含提交；因此本地结果不能冒充准确 SHA 的远端 CI 结果。

F-2（technical / repository_fact）：当前入口由 v3-adapter 生成，部分 legacy 模板仍限制三个问题；共享质量指导需消除矛盾，但不迁移旧任务 policy。

F-3（acceptance / repository_fact）：Quality 和 Windows 分别定义步骤；统一脚本避免本地遗漏，但不能以本机运行替代平台矩阵。

OCR 分析固定于 [a694be568d9b9a935b2ba11a867d5a91d7ffd833](https://github.com/alibaba/open-code-review/tree/a694be568d9b9a935b2ba11a867d5a91d7ffd833)。借鉴完整待审集合、关联分组、按风险取上下文、finding 定位/去重/事实复核。不照搬排除测试、只看新增行、限制发现数量或固定多轮审查。

## 设计契约

审查清单和报告为可读产物，不是新 authority。文件清单包括变更类型和路径；reviewer 将文件关联行为链与验收，记录已审、缺口及排除理由。任何工具失败、预算耗尽、未验证环境必须可见，不能用空清单或命令 exit 0 声称审核通过。

man / manba 使用相同规则：检查实现、调用方、测试、CI/config/deps、生成源和契约文档；检查新增、删除、重命名；按仓库契约选择规则；必修 finding 不截断，保留稳定 ID、因果证据和误报撤销原因。一次总审后仅定向复核真实修复和新风险。

原 Man 任务通过现有 delivery review（或对应旧 policy 的合法 review 协议）登记结果，读回状态；不向严格 ledger 塞未支持字段。plan_only、完成任务、只读请求不获得额外写权限，不默认建立 child。独立审核报告区分覆盖完成、问题和未验证项。

TDD：可复现缺陷优先先证实目标失败，再最小修复、回归；新增自动化行为适用时测试先行；不把依赖/语法/网络故障当 Red，不以改弱断言获得 Green；纯文档和行为不变重构不制造失败。回放旧版本回归不冒称历史 test-first。

CI 失败先分实现缺陷、测试/CI 错误、基础设施、偶发性、预存失败、契约冲突；必须依据契约修复，不删测试或降阈值换绿灯。保留尝试摘要，跨会话不清零。以上次数和时间约定本次为流程规则，非机器保证。

检查脚本顺序执行 lint、typecheck、build、dist adapters、audit、coverage，使用新 dist 的两项 CLI 环境变量并透传失败。Windows 共用 build + 原锁契约，保留 CMD/PowerShell/Bash 真运行。release-check 的额外发布验证保留。

## 分工与阶段

1. 主 agent：需求/范围绑定、共同 review guidance、CLI/adapter 接线、文档和集成；不直接编辑子 agent 文件。
2. man agent：man 专属指导、legacy man/film review 质量语义、项目检查脚本/package/CI及相关测试。
3. manba agent：只读 review command/subject helper、manba 专属指导及相关测试。
4. 集成：主 agent接入两个模块，检查 adapter生成与dist产物、全量验证；子 agent交叉检查对方变更，修复后定向复核。

单 owner 文件边界由 implementationScope 的明确文件清单和本分工约束；不修改 workflow/ledger/outcome schema。补齐中英文网站命令文档；正式 adapter 升级产生的 AGENTS.md 托管投影纳入范围，不手动篡改。无未解决阻塞决策。

## 验收与证据

- AC-1：所有现有平台生成入口拥有共用规则且保留 mode 权限、诊断、单次总审契约。adapter/template/dist tests。
- AC-2：review inspect 覆盖 rename/delete/untracked/特殊路径，base/Git错误失败，不产生任务或源码写入。真实临时 Git 仓库与 CLI 契约。
- AC-3：共享检查保留步骤、失败传播、新dist环境及CI矩阵/shell。脚本执行与配置契约测试。
- AC-4：对应契约先运行，再lint/typecheck/build/dist和完整测试覆盖。本机未执行的远端环境明确保留未验证；不降低已有验收。

- AC-5：在 `/Users/whitelonng/code/mancode测试` 的新隔离子目录运行真实候选CLI：HEAD/index/worktree抵消场景、错误出口和生成入口，保留既有资料。

所有自动化验收 observation surface 为 component。记录真实命令，不为填槽重复同一套测试。必要网络不可用时保留检查失败/未验证，不改成通过。
<!-- mancode:plan-baseline:end -->

<!-- mancode:delivery-record:start -->
Task: local:01M2MEJFAJ5BCFX8MNCP99JMPF
Plan version: 5
Review: passed
Verification: passed

Reviewer declaration: independent
Direction: 完整diff按AC-1至AC-5核对；两个开发agent交叉审查对方模块及共同接线，主agent整合。共享质量规则未改变旧policy/诊断outcome，文件范围含获批的双语文档和官方adapter生成投影。
Correctness: R-1由独立agent真实Git复现，再由作者新增3个Red回归修复到Green，交叉复核10测试通过；R-2用Copilot原语法契约复验；R-3补双语命令文档并通过原网站完整性契约。完整173文件1533测试成功；指定目录真实候选CLI五类场景通过且authority不变。
Proportionality: 只读Git分层inventory、共用提示规则和固定检查脚本，无新持久化schema/模型服务/远端CI硬门禁；未使用任意脚本作为验收替代。真实CLI使用临时隔离fixture，并不声称真实Windows矩阵或所有宿主对话已验证。
Next: 同步交付记录、提交任务改动、通过现有delivery check后完成本地交付；不推送。
- R-1: resolved — review-subject.ts只比较base到worktree；base safe→index broken→worktree safe时输出空清单，但commit将包含broken。须覆盖HEAD/index/worktree并标记层。
- R-2: resolved — mode-skills.ts新增硬编码/manba使Copilot生成入口含不支持的slash命令；tests/copilot-adapter.test.ts:258复现失败，须使用平台调用语法。
- R-3: resolved — src/cli.ts新增review及review inspect后website中英文命令目录未同步，tests/website-docs.test.ts:92失败；须按批准扩展文件边界补文档，不删契约。
- AC-1: met — 八平台adapter契约、原诊断兼容测试及22个dist生成入口通过；共同规则和mode专属权限均验证。
- AC-2: met — review-subject 10项真实Git测试及compiled CLI集成通过；layers保留HEAD/index/worktree抵消、不同状态、特殊路径、失败出口和只读行为。
- AC-3: met — project-checks完整顺序、每步真实exit7透传、fresh dist环境、原Node/OS/shell矩阵契约通过；npm run check实际执行成功。
- AC-4: met — npm run check：lint/typecheck/build/22dist adapters/audit --audit-level=high/coverage成功；173测试文件1533测试通过，行覆盖86.82%。审计保留3 moderate，未降低原high阈值。
- AC-5: met — /Users/whitelonng/code/mancode测试/review-20260916-Ew4f4g/report.json及commands.json：5类真实macOS候选CLI场景通过；实际Man task/session/ledger全量快照不变。
- AC-1: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-2: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-3: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-4: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-5: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
<!-- mancode:delivery-record:end -->
