# 工程约定

mancode 的实现原则是：外科手术式修改、可验证、可恢复。

## 开发规则

- 只修改需求涉及的路径，不顺带重构相邻模块。
- 优先复用现有实现、标准库、平台能力和已安装依赖。
- schema parser 拒绝未知字段；跨实体写入必须有 revision 和 operation journal。
- shared 内容先做隐私筛查，再 canonicalize 和计算 digest。
- adapter 只管理自己的文件或明确标记的托管区。
- 探测失败应安全降级；业务一致性失败应停止写入并进入 repair。

## 主动发现与执行授权

受管 `/man` 与 `/manteam` 把主动发现作为只读证据阶段，而不是隐式扩权：

- Scout 保持只读，核验用户前提并只报告最多三个会改变目标、范围、验收、架构或
  风险的高影响项。finding 使用稳定 ID `F-1`…`F-3` 和类型 `premise`、`scope`、
  `technical`、`risk` 或 `acceptance`，并区分有仓库证据的 `repository_fact` 与尚需
  用户确认的 `domain_hypothesis`。后者用于覆盖行业失败路径和边界条件，但只能触发
  聚焦问题，不能被写成事实；发现只有证据与建议权。
- 每个 finding 按语义只落到合适的位置：blocking 进入 `blockingUnknowns`；用户接受
  的范围或行为进入 V3 `functionalScope.inScope`（legacy `confirmedScope`）和匹配的
  `acceptanceCriteria`；接受的技术选择进入 `technicalDecisions`；只有明确排除的行为
  进入 V3 `functionalScope.outOfScope`（legacy `excludedScope`）；低影响、可逆细节才
  进入 `defaults`。未接受的建议仍未获授权，但不会被自动复制到排除范围或所有字段。
- confirmed requirements、confirmed plan 与同次计划修订绑定的 `implementationScope`
  共同构成现有执行授权。`include` 是 repo-relative 文件写入上限，`exclude` 优先，
  `modules` 只描述归属、不单独授权写文件；没有非空 include 时不能开始 governed
  execution 或 Solo handoff。
- 升级前已经进入执行阶段的本地 Man 任务若缺少可执行 scope，完成门同样拒绝它。
  用户确认完整边界后，可以用内容完全不变的当前 plan 和 `--scope-file` 走一次兼容
  plan revision；该操作只补绑 scope、递增 plan version、使旧 review/verification 失效，
  不允许改变 plan、行为、验收或已存在的非空边界。
- 团队执行中仅调整文件边界、且不改变已确认行为或验收时，必须由用户明确同意后走
  既有 `workflow scope change` mutation。它递增 plan authority、使旧 review/verification
  失效并重签兼容 claim；行为或验收变化仍走 reframe。
- 实施前显式写明实质假设和可验证成功标准，优先复用现有代码和依赖，选择满足验收
  的最小直接方案；每一处改动必须同时能追溯到已确认行为/验收并位于文件边界内。
- 实施中新发现的范围外问题只允许返回只读 `NEEDS_REALIGNMENT`。用户明确同意
  reframe 前，不得修改对应区域。
- review 必须把实际 diff 同时对照 requirements 与 `implementationScope`；未经授权、
  触碰行为排除项、落在 include 外或匹配 exclude 的改动都是 blocker，不能作为
  “顺手修复”带入任务。

Plan Coach 在写计划前先返回 `READY_FOR_PLAN` 或 `NEEDS_CLARIFICATION`。所有真实选项
必须解决同一个目标、验收边界和 scope，写明复杂度由谁承担及可观察成本，并只给出一个
推荐和明确的停止条件。简单任务可以只有一个真实方向，不为凑数制造伪选项。

入口跨平台不一致、semantic owner 或 source of truth 不清、状态/contract 语义变化，
或者涉及跨 workflow、团队、transport、迁移与多版本兼容时，可以在 `plan.md` 中加入
Domain Matrix。它只辅助计划审查，不是新的 authority。

实施中返回 `NEEDS_REALIGNMENT` 与 `MANCODE_REFRAME_REQUIRED` 是只读诊断。它必须保留
metadata、requirements、plan、ledger、claim 和 handoff；只有受支持的 reframe operation
才能归档旧权威、释放 claim 并返回需求澄清步骤。

默认 Solo 不主动运行这套深入发现；普通小任务仍保持轻量。Solo 接手已有 `/man`
计划时必须继承其 requirements、plan 和 `implementationScope`，不能重新规划或扩权。
这些状态写入既有 ledger、plan revision 和 workflow metadata，不建立第二套提示词 authority。

## 基于已接受状态的交付叙事

最终用户可见的标题、文件名、注释、commit、PR、summary 和 handoff 叙事应从已接受
目标、权威基线、实际读回状态和本任务 diff 生成，并假设读者没有参与工作会话。仅在
会话中被否决的方案或措辞修正不进入最终产物的交付身份；只有当它们构成必要的审计事实、
引用或用户明确要求的比较时才保留。

这条规则只约束交付叙事，不修改执行授权或审计事实。requirements、计划中的真实方案
比较、`excludedScope`、review/verification 证据、失败与 blocker、迁移和兼容影响、
安全事实、引用内容以及 handoff 的结构化状态和 resolution reason 必须保留。工具、hook
或外部平台创建或改写用户可见表面后，应在能力允许时读回实际结果；无法读回时报告该
表面未验证，不能把提示词规则描述成确定性保证。

## 代码地图

| 目录 | 职责 |
|---|---|
| `src/context/` | schema、Task Aggregate、任务 mutation 和 Context Pack |
| `src/runtime/` | session、锁、operation、reservation、recovery 和 retention |
| `src/team/` | actor、claim、handoff、checkpoint 和 transport |
| `src/installers/` | 平台 bootstrap、managed block 和 capability 检查 |
| `src/commands/` | CLI 解析后的应用服务边界 |
| `src/system/` | 项目检测、扫描和 legacy 辅助功能 |
| `tests/` | contract、crash matrix、E2E 和 adapter 回归 |

## 验证

从最窄验证开始，再按风险扩大：

```bash
npx vitest run tests/<affected-file>.test.ts
npm run typecheck
npm run lint
npm audit --audit-level=high
npm run test:coverage
npm run build
npm run test:dist
```

发布候选先运行 `npm run prepublishOnly`。开发集成通过后把最终变更合并并推送到
`main`，等待该 main 提交的 Quality/Windows checks 成功，再运行
`npm run release:check -- --candidate <完整提交 SHA>`。脚本必须从同一个
`origin/main` 提交创建干净 checkout，重跑完整门禁、跨 clone、legacy、audit、pack
和 tarball 安装 smoke，并生成本地 SHA-256 证据。涉及 Windows 原子文件行为时追加
`npm run test:windows-smoke`；涉及网站时运行对应网站测试和浏览器检查。只有所有真实
宿主与 Beta 证据也绑定该 main SHA 后才允许发布；npm `gitHead`、tag 和 GitHub Release
必须继续指向同一个提交。

不要把历史测试数量写入长期文档。报告当前命令、退出码和失败原因即可。

## 文档与发布

- `README.md` 和 `README.en.md` 面向用户并保持功能声明一致。
- `docs/` 只描述当前契约和长期发布门禁，不保存版本候选清单或已完成实施计划。
- 新 CLI 入口必须同步 help、测试和公开参考。
- 平台能力声明必须区分自动化 contract 与真实宿主证据。
- 发布版本由 `package.json` 与 `src/version.ts` 共同约束。
