# 隐私保护实施计划与验收记录

用户于 2026-09-11 批准按 `research/maskit-integration-2026-09-11/report.md` 与 `review.md` 开发，并明确要求在 `develop` 分支由子 Agent 开发、主 Agent 统筹。原研究文档保留当时的授权状态和源码行号；本文件记录批准后的实现进展，适用于 0.6.5。

## 已批准的交付边界

1. P1：TypeScript 共用检测核心、只读扫描和不可逆副本预览；保留旧共享数据解析契约与原文，完整扫描失败不产出副本。
2. P2：共享策略由命令事务提交，版本/摘要绑定；首次初始化可明确启用，旧项目显式升级；历史原件不可变，激活范围和隔离/迁移路径必须可执行。
3. P3：可选、本机单用户单 checkout 的前台模型网关；启用意愿与进程/路由证据分开；故障不明文透传；未验证的可执行工具参数不能无条件回填。
4. 初始化首次询问两个独立选项；非交互缺省关闭，`--yes` 不代表启用；重复初始化保留选择。状态只报告可验证事实。
5. P4 的真实宿主/模型验证和生产性能声明需要实际证据；本机假上游及协议测试不能替代真实宿主验收。首版不自动改用户 provider、登录或计费配置。

## 并行分工

- 核心/CLI Agent：`src/privacy/`、scan/preview、统一根命令、init/status 聚合、用户文档和打包来源。
- 共享策略 Agent：manifest、策略事务、共享写入/输出、transport 兼容与历史处理。
- 网关 Agent：严格 JSON、占位映射、HTTP/SSE 协议、前台进程、本地设置与诊断。
- 主 Agent：接口协调、独立审查、整体验证和用户沟通；不直接承包实现。

## P1 当前实现

- `scanSensitiveText`：1 MiB UTF-8 预算、4,096 条 finding 预算、500 ms 完成预算；严格文本有效性；规则版本和安全元数据；合并重叠区间时覆盖尾部。
- `privacy scan --file <path> --profile shared --json` 或 stdin：读取字节有界、严格 UTF-8 解码，文件输入只接受普通文件。返回码 0=无命中、1=有命中、2=失败。
- `privacy preview --output <new-file>`：完整扫描后写 0600 临时文件、sync、独占发布新副本；不覆盖源、既有目标或符号链接。成功返回 0。
- 输出不含正文、输入路径、原值 hash 或 token。错误保留内部 cause，仅输出安全原因和白名单系统错误码。
- 上游固定提交、版权声明、AGPL 许可副本已纳入 npm 包来源记录。

## 已运行的验证（仅对应当时实现）

| 命令/探针 | 结果 | 证据意义 |
|---|---|---|
| `npx vitest run tests/privacy-detect.test.ts tests/privacy-contracts.test.ts` | 30/30 通过 | 核心首轮与旧解析契约 |
| `npx vitest run tests/privacy-command.test.ts tests/privacy-detect.test.ts tests/cli-v3-surface-contracts.test.ts` | 37/37 通过 | 输入/输出命令与公开注册首轮 |
| `npx vitest run tests/privacy-command.test.ts tests/privacy-detect.test.ts` | 37/37 通过 | PEM 大小写/Unicode修正与完整副本发布实现 |
| `npx vitest run tests/privacy-detect.test.ts tests/privacy-command.test.ts tests/privacy-contracts.test.ts` | 46/46 通过 | 增补多类别标记幂等、冒号前缀邮件、跨行凭据与 ENOSPC 失败不发布；长负例独立子进程回归 |
| `npx vitest run tests/init-onboarding.test.ts tests/v3-init-command.test.ts tests/cli-v3-surface-contracts.test.ts` | 51/51 通过 | 原初始化行为兼容（首次接口接入后） |
| `npx vitest run tests/init-privacy.test.ts tests/cli-v3-surface-contracts.test.ts` | 7/7 通过 | 共享启用/关闭、重复保持、--yes、取消、部分显式选择、相反 flags 冲突 |
| 限时子进程 1 MiB 探针，每场景 9 次，3 秒硬超时 | 6 场景全部完成 | 不是生产并发保证；消除重叠空白量词的失控回溯 |

1 MiB 子进程实测 p95：普通文本 28.82 ms，`password` 后超长空白 8.01 ms，重复 secret 近似匹配 12.63 ms，email 近似匹配 13.02 ms，PEM 近似匹配 14.50 ms，JWT 近似匹配 11.44 ms。输入均为合成内容。500 ms 预算只能检测已返回的扫描工作，不能中断一次正则执行；因此保留这些长负例回归，网关仍须使用有界 worker 执行模型。

## P2 已实现边界

- 本地 manifest 升级至格式 3，策略和历史排除表各自 revision CAS、摘要绑定、同一 operation ID；启用、关闭、apply 和重试统一通过 `privacy_policy_update`。关闭保留格式、排除表、最低 0.6.5 客户端要求和原 basic checks。
- 策略更新持项目 schema barrier，提交前后校验基线与 pending operations；共享写入和恢复目标在持锁时读取当前策略。直接编辑 live policy 不构成合法更新。
- git-ref manifest 格式 2 保存完整策略/排除快照，通过远端 CAS 先提交，再完成本地 journal 的三个权威文件。远端成功但本地中断必须 repair；不会宣称仅本地启用已完成。旧 clone 和旧版本不能继续写；接收共享权威文件后可恢复普通同步。
- 历史 confirmed decision/checkpoint 不修改原件，永久排除后不能通过 Context Pack、共享写入或恢复重新导出。当前远端 task bundle 含敏感 checkpoint 时必须先产生安全 checkpoint 并同步。
- 不扩展 actor/claim/handoff 的历史修改语义。远端这些不可变对象命中时，dry-run 按实体类型/数量/原因返回 `retain_basic_or_new_workspace`，允许保留 basic protection，或由用户明确新建 workspace 并迁移清理后的内容；不删除旧 ownership 历史。
- 独立 materialization 及其旧 journal 恢复也持 schema barrier，并检查当前策略和永久排除；旧缓存与当前策略不同则不可复用。增强规则关闭后，旧 applying journal 仍不能恢复 excluded checkpoint。
- local→git-ref 迁移带入完整策略快照；迁移准备和配置 CAS 与策略升级共用 barrier，既有迁移恢复路径保持可用。

## P3 已实现边界

网关配置、token 与运行状态保存在用户/checkout 的私有位置；公开配置与运行命令要求已有 workspaceId 和 checkoutId。`init` 只在新项目提交后保存可选偏好；不启动进程、不改宿主 provider 或登录设置。`run` 前台运行并绑定 loopback；状态分开报告配置有效性、进程确认、loaded/configured digest 和路由观察，`routeVerified` 不以端口可达替代为 true。

OpenAI Responses 和 Anthropic Messages 的支持范围包括严格 JSON 与增量 SSE 文本往返；对象键值语义扫描、工具 schema 的 prose 字段扫描、opaque block 排除、未知/危险可执行参数回填阻断、生命周期隔离与容量限制、故障关闭、关闭活动请求、线程外有界扫描与心跳。真实宿主版本绑定、上游类型和配置 digest 分别校验。协议内工具描述可能脱敏，但 `enum`/`const` 等约束保持不改。

## 最新验证补充

| 命令/探针 | 结果 | 证据意义 |
|---|---|---|
| `privacy-detect`、`privacy-command`、`init-privacy`、`cli-v3-surface-contracts`、`git-ref-cache-contracts`、`git-ref-materialization-contracts`、`transport-migration-adapters-contracts`、`transport-migration-contracts` 八组 Vitest | 99/99 通过 | 含核心58、命令11、init8、materialization6、adapter4及既有迁移8；四种初始化组合、gateway配置写失败保留项目、扫描句尾标点、2-series卡、schema barrier和禁用后排除恢复 |
| 核心句末标点回归 | 19种全通过 | 真宿主canary发现英文句号漏检后修正规则；保留mailto、域名内部点号和原1MiB近似email限时负例 |
| owned 24个源/测试文件 `biome check` | 通过，无诊断 | 未格式化全仓或无关用户改动 |
| `npm pack --dry-run --ignore-scripts` | 来源文档和AGPL副本在包内，research目录不入包 | 完整使用指南和验收记录亦纳入显式files列表 |
| 主线程性能探针，合成1,020,024 bytes请求×1与×8 | 均HTTP 200；单请求51.26 ms，8并发各约233.65–234.66 ms；主事件循环延迟p95 1.42 ms、max 5.66 ms | 有界worker版本本机样本；不构成生产并发承诺 |
| 30个delta：假上游实际发出→本机客户端接收 | p95 1.15 ms、max 1.20 ms | 该测量没有直连A/B对照，不称为纯网关增量开销 |
| `node scripts/privacy-gateway-spike.mjs --hosts-only` | Codex CLI 0.153.4 Responses、Claude Code 2.1.142 Messages 均exit 0、canary受保护并还原 | 真实CLI→网关→本机假上游→CLI；非真实付费模型 |
| 同一探针的 Claude Read 两轮往返 | 2次上游调用、pathMasked/resultMasked/canaryRestored均true，hostPermissionBypass=false | 精确已捕获Read schema；真实宿主默认权限读取本次创建的临时合成文件，未读取用户真实文件 |
| Gateway九组契约测试 | 44/44通过 | lifecycle、config、JSON、mapping、protocol、SSE、server等；完整结果在下述证据文件 |
| `website-docs` 与最新 `git-ref-materialization-contracts` | 15/15通过 | 两语言完整公开CLI索引、0.6.5版本标签及materialization策略保护；网站只补文档，沿用原结构 |
| 原跨clone workflow scope/update 两个失败案例定向重验 | 2/2通过 | originating operation→repair→materialize传递实际schema lock owner，并核对持久operationId与当前processId，避免二次拿锁 |
| 最新 `privacy-policy-transport` | 13/13通过 | 远端策略CAS并发、六处journal崩溃边界恢复、禁用/重启用、双clone接收、tamper/旧writer拒绝、安全dry-run、失败无本地/远端变化 |
| 完整 `git-ref-cross-clone-e2e` | 7/7通过 | 加入schema锁复用及独立actor写入有界等待后的全路径回归 |
| shared privacy/actor/glossary 相关回归与当前 `npm run typecheck` | 31项通过；类型检查通过 | schema竞争只重试拿锁，不重试实体CAS，等待后重读新策略 |

## 最终全仓验收（2026-09-12）

主 Agent 在首轮收尾源码上完成以下检查。这一快照早于独立复测发现的命名凭据漏检；该修复的最终验收须重新运行，不能复用此表宣布修复后全仓通过。

| 命令/探针 | 最终结果 | 证据意义 |
|---|---|---|
| `npm run lint` | 348个文件全部通过 | 全仓源代码与测试通过Biome检查 |
| `npm run typecheck` | 通过 | 全仓TypeScript类型检查 |
| `npm run build` | ESM与DTS构建通过 | CLI、模块和独立gateway worker均生成成功 |
| `npm run test:dist` | 16个adapter全部通过 | 验证实际构建产物的适配器内容 |
| 允许loopback的 `npx vitest run` | 147个测试文件、1,278项测试全部通过；100.55秒 | 含真实本机HTTP服务的完整契约回归；日志为 `/private/tmp/mancode-privacy-final-tests-20260912.log` |
| 实际 `dist/gateway/worker.js` Worker启动探针 | `builtWorker: true` | 向构建产物发送begin及合成句末email canary，验证独立worker真实执行路径 |
| `npm pack --dry-run --ignore-scripts`，使用任务临时cache | v0.6.5，39个entries；worker、规则来源、AGPL副本和使用指南均包含；research目录不包含 | 核对最终npm包文件清单，未发布软件包 |

网关证据保存在 `tests/fixtures/privacy-protocols/host-roundtrip-evidence.json`、`implementation-evidence.json` 和 `performance-evidence.json`。支持范围限上述CLI的API-provider路径，不包括桌面、订阅登录、云路由和未列出的宿主版本。除精确Read schema外，需恢复占位符的可执行工具参数仍被阻断；opaque思考/签名/加密块不改写。`routeVerified`始终false，只报告本实例路由观察。SSE的after_emit审计不负责拦截，HTTP审计当前仅partial。

以上性能和协议样本使用合成数据及本机假上游。真实付费模型、桌面客户端、订阅与云路由、真实上游网络抖动及生产规模性能仍是未验证边界；本次全仓通过不扩大这些支持声明。

## 独立复测后的命名凭据修复

独立安装包复测发现 `client_password` / `DB_PASSWORD` 等带前缀的字段漏检，以及带引号多词密码只覆盖首词。修复集中在 `src/privacy/` 的公共扫描路径：完整匹配有界字段名，再用单向游标读取值，正确处理同一行多个赋值、转义引号与反斜杠、空值、未闭合引号，以及占位标记后追加敏感内容。原 UTF-16 偏移、失败关闭、1 MiB / 4,096 findings / 500 ms 预算保持不变。

回归覆盖 raw JSON 与普通文本、CLI scan/preview、真实 shared workflow 写入前拒绝、两个协议的 gateway prose 及实际 HTTP 发往假上游的请求。保留 gateway 原有 metadata/嵌套 JSON 键语义路径；不改旧 `src/context/privacy.ts` 六分类契约、不迁移 live policy、不变更用户 provider 或本地开关。这些修复在首个 ruleset 发布前完成，因此保持 `mancode-sensitive-text:1`，已发布规则变更仍要求显式版本和兼容性审查。

修复冻结前的定向验证：10 个测试文件、138 项全部通过，其中命名凭据 14、scanner 58、CLI 12、shared policy 22、旧 privacy 契约 2、gateway protocol/server/engine/mapping/SSE 共 30 项。包含 0/1/2 个前导短横线兼容、metric 负例与 1 MiB 长值/未闭合引号子进程硬期限回归；实际 HTTP 测试在允许 loopback 的本机环境运行。`npm run typecheck`、相关 9 个源/测试文件的 `biome check` 与 `git diff --check` 均通过。全量覆盖率及重新打包后的独立验收由主 Agent 另行记录，此处不宣称完成。
