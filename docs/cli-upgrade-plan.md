# mancode 一键升级与初始化更新入口方案

状态：用户于 2026-09-17 授权按推荐方案开发并使用子 agent；真实测试根目录为 `/Users/whitelonng/code/mancode测试`。尚未发布。
TaskRef：`local:01M2NJHER7PZMZYA74MRMAKA37`。

<!-- mancode:plan-baseline:start -->

## 1. 目标与交付边界

用户在项目根目录输入 `mancode upgrade`，通过与初始化一致的数字菜单，完成 CLI 包与当前项目规则、Skills 的更新。用户不需要复制 operationId、sessionId、client，也不需要先调用多个底层命令。

首版完整交付两个入口：独立 `upgrade`，以及已初始化项目运行 `init` 时的更新选项。更新完成必须分别说明 CLI 和项目入口的真实结果。

已明确的产品要求：

- 提供顶层 `mancode upgrade`，终端交互采用现有数字选择风格。
- 可以一起更新 CLI 与当前项目入口，也可以仅更新其中一项。
- 保留当前项目已有任务、批准计划、策略和托管区外内容。
- 内部复用现有升级事务，隐藏操作 ID；失败后给用户可直接执行的下一步。
- 不把重新初始化、清空 `.mancode` 或重新创建任务当成更新方式。

已接受的首版范围：自动包更新先覆盖 npm 全局安装和普通项目 npm 本地依赖；其他安装方式准确识别并给原包管理器指引，仍允许使用已安装 CLI 更新项目入口。pnpm、Yarn、Bun 的自动包更新及 npm workspaces 在后续单独补齐，不能冒充支持。

本轮不做包发布、操作者实际全局安装更新、其它项目升级、存储迁移、治理 policy 升级、隐私设置变更、自动增装平台或多项目批量扫描。发布版本在实施验收后确定，不覆盖已经发布的 0.6.8。

## 2. 仓库核验与发现

| ID | 类型／依据 | 已核验事实 | 方案处置 |
|---|---|---|---|
| F-1 | premise / repository_fact | `src/cli.ts` 只注册 `adapter upgrade` 和 `project upgrade` 等分域命令；`src/commands/init.ts` 对已激活项目通常直接返回 already initialized；`src/system/init-onboarding.ts` 已有数字平台菜单 | 新增顶层交互编排，复用菜单风格；不声称原来已有一键升级 |
| F-2 | scope / repository_fact | `src/commands/adapter.ts` 的 `--all` 使用全部支持平台清单，并不等于仅已安装平台 | 新入口从 manifest 的 `managedAdapters` 取得已登记平台，显式传入集合；原 `--all` 的旧语义保留 |
| F-3 | technical / repository_fact | `upgradeV3Adapters` 已有 staging、预览一致性校验、session 校验和 journal；`contextSessionNew` 要求已有本地 actor；现有 CLI 没有包自更新和进程续接实现 | 复用适配器事务和身份服务；新增包安装定位与进程衔接，不能只包一层 shell 命令 |

架构依据：[架构](architecture.md)、[工程约定](engineering.md)、[适配器契约](platform-adapters.md)。上述三个发现分别进入已接受产品行为、兼容边界和技术方案。用户最新指令授权开发，执行范围按本计划绑定。

## 3. 用户交互

### 3.1 默认命令

```text
$ mancode upgrade

当前项目：example
当前 CLI：0.6.x（npm 全局安装）
目标版本：X.Y.Z
已安装平台：Codex、Claude Code
项目规则：需要更新

1. 更新 CLI 和当前项目规则、Skills（推荐）
2. 仅更新当前项目规则、Skills
3. 仅更新 CLI
4. 查看更新信息和影响范围
0. 退出

请选择：
```

数字选择只是确定范围；系统准备准确预览后展示一次执行确认。空输入不执行更新；无效输入重新提示；EOF/Ctrl-C 正常退出。不得使用 emoji 充当状态或菜单图标。中文、英文复用现有 locale 检测与 `--lang`。

`X.Y.Z` 是从当前配置的 registry 解析出的目标，不写死 0.6.8，也不假设本地源码版本等于已发布版本。菜单显示的信息必须区分“已验证”“无法检查”和“候选预览尚未生成”。

### 3.2 执行前的确认

```text
将执行：
  CLI：0.6.x → X.Y.Z
  安装位置：<解析并验证后的实际位置>
  项目：<实际项目根目录>
  平台：Codex、Claude Code
  文件：AGENTS.md 的 mancode 托管区、CLAUDE.md 的托管区、相关 Skills

继续更新？[y/N]
```

本地 npm 依赖更新时，摘要明确列出 package.json、适用 lockfile 和 node_modules 的影响。只更新项目时，明确使用当前已安装 CLI 的版本，不把它描述成联网更新到最新版。

正常已有身份的用户只需选择范围并确认一次。无身份时，在这次操作内补充一次本地显示名，不要求用户运行身份命令。`--yes` 代表同一范围的明确执行请求，不代表允许猜测身份、安装位置、降级或覆盖冲突。

### 3.3 完成结果

```text
CLI：已更新至 X.Y.Z
当前项目规则与 Skills：已更新，2 个已安装平台检查通过
请重新打开 Agent 会话加载新入口。
```

CLI 本来已是目标版本时跳过包安装，仍检查项目入口。全部就绪时返回成功且不新建 session、actor、升级 journal。平台未安装不算待修复项目。

### 3.4 初始化中的更新入口

已初始化项目交互运行 `mancode init` 时显示：

```text
当前项目已经初始化。

1. 更新 CLI 和当前项目规则、Skills
2. 仅更新当前项目规则、Skills
3. 查看当前安装状态
0. 退出
```

选择更新后调用与 `upgrade` 相同的应用服务。保持新项目原有初始化流程。非交互 `init`、`init --yes`、显式平台参数及 legacy 分支维持既有契约，不能让旧脚本意外触发联网升级。`init --force` 不成为 Continuity 升级别名。

## 4. 建议命令契约

| 命令 | 行为 |
|---|---|
| `mancode upgrade` | 交互菜单；非 TTY 且未给出执行范围时返回可操作提示 |
| `mancode upgrade --project-only` | 当前 CLI 更新当前项目已登记入口；无需查询 registry |
| `mancode upgrade --cli-only` | 只更新选定安装位置的 CLI；不修改任何项目入口 |
| `mancode upgrade --yes` | 非交互执行 CLI＋当前项目更新，前提是安装位置、身份等可无歧义确定 |
| `mancode upgrade --project-only --yes` | 脚本化项目更新 |
| `mancode upgrade --to X.Y.Z` | 固定一个准确发布版本；与 `--project-only` 冲突；不用会与版本查询混淆的 `--version` |
| `mancode upgrade --check --json` | 检查版本、安装方式、项目状态、可执行性；无项目写入、身份创建或 adapter staging |

补充参数限于 `--lang`、`--json`、既有 `--session/--client` 兼容以及无身份的非交互显式 `--name`。首版不增加 `--all`，避免与旧“全部支持平台”语义混淆。`--cli-only` 与 `--project-only` 互斥；JSON 模式不发交互提示，无执行授权时不隐式更新。

退出码建议：0 表示成功／已就绪／正常菜单退出，2 表示参数或所需输入不足，3 表示冲突或兼容阻塞，4 表示联网／安装／验证失败或部分完成，130 表示 SIGINT。检查发现可更新本身不算失败，结构化输出用字段表示。

JSON 输出包括 `schemaVersion`、总体状态、CLI 前后版本与安装位置、项目根目录、已选平台、项目结果和下一步；敏感配置与认证值不输出。保留原错误码与因果信息，不能用“升级失败”吞掉所有细节。

## 5. 安装方式、版本与兼容策略

### 5.1 安装位置是真正的更新对象

从当前执行文件的 realpath、包名与版本、npm root/prefix、项目依赖声明共同判断，不能只看 `which mancode`。如果同一项目存在本地与全局两份 CLI，显示差异并要求选择实际使用的目标；非交互无法唯一判断则阻止安装。

| 安装情况 | 推荐首版处理 |
|---|---|
| npm 全局正常安装 | 更新已验证的对应 prefix；不写项目依赖 |
| 普通项目 npm 本地依赖 | 保持 dependencies/devDependencies/optionalDependencies 归属及既有版本声明风格；更新对应 lockfile |
| pnpm / Yarn / Bun / npm workspace | 识别并给原管理器指引；不偷偷改用 npm，不另造 lockfile |
| npm link、file/git 依赖、mancode 源码 checkout | 不用 registry 包覆盖开发源码；项目入口更新仍可用 |
| npx 临时目录／无法识别的包装器 | 不把临时缓存当作持久安装目标；告知如何建立或更新持久安装 |
| 没有 `.mancode` | 可显式只更新 CLI；不自动初始化当前目录 |
| legacy 或非 active 的 Continuity 布局 | 项目更新报告迁移／恢复指引，保留原文件，不自动迁移 |

### 5.2 版本解析

查询使用用户现有 npm registry 配置；不读取或输出 `.npmrc` 的认证内容。默认解析稳定目标，冻结成准确版本后使用该版本完成候选准备、安装和验证。明确检查 SemVer、Node engines 和目标能力，拒绝默认降级；预发布版本仅接受显式 `--to`。

不手写不完整的 SemVer 比较。P0 检查现有可复用能力；若确需新增直接依赖 `semver`，只在实施范围确认后同步 package.json 与 lockfile，不能依赖偶然存在的传递依赖。

联网检查设超时并允许取消。网络失败不显示“已经最新”；离线仍可选择 `--project-only`。`--check` 只读取项目，npm 自身可能写缓存或日志，这不能误报成系统完全零写入。

npm 的 registry 查询、全局 prefix 安装和本地依赖／lockfile 行为分别参考 [npm view](https://docs.npmjs.com/cli/v11/commands/npm-view/) 与 [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/)。具体受支持 npm 版本用实际 Node 22/24 测试矩阵验证，不把单版文档当作所有安装环境的保证。

## 6. 执行架构

### 6.1 编排顺序

```text
读取安装与项目状态
  → 选择范围，冻结目标版本和位置
  → 若需新版 CLI，准备隔离的目标版本候选
  → 由目标版本生成项目入口准确预览
  → 展示影响并获取执行确认
  → 由独立助手更新持久 CLI（若需要）
  → 验证安装位置及新 CLI 的实际版本
  → 通过新 CLI 重新验证并提交同一预览
  → 检查已登记入口状态
  → 分别报告 CLI／项目结果
```

只更新项目时跳过联网、候选包准备和 CLI 安装。只更新 CLI 时跳过项目 staging 和 session。所有路径共享同一结果模型。

### 6.2 为什么需要独立助手

安装完成后，原 Node 进程已经加载的代码不会自动切换版本。仅执行 `npm install -g` 后继续调用旧 renderer，会产生“CLI 是新的、规则由旧代码生成”的错误。

因此新 CLI 的续接必须使用已验证的绝对路径。执行 npm 安装的助手从安装目录外运行，更新期间不再动态加载即将被覆盖的旧包。Windows 下 npm 启动方式、入口 shim 和文件占用在 P0 用实际进程测试决定；不能用拼接 shell 字符串掩盖路径问题。

候选包准备采用 npm 管理的隔离临时安装，包名固定为 mancode、版本为已冻结准确版本。候选下载只在选择升级后发生；确认前允许写候选缓存和既有 staging，但不改持久 CLI、业务依赖或正式入口。取消清理本次临时内容，不删除原有恢复材料。

临时安装与依赖生命周期脚本策略必须在 P0 验证：优先禁止脚本，证明候选 CLI 可用后继续；目标包若要求额外脚本，停止该路径并展示影响，不能静默开放项目任意脚本。普通项目本地安装也必须显式约束该策略，并测试既有依赖不会因脚本未执行而被错误宣称完整就绪。

### 6.3 项目事务与源数据

- 平台集合来自 manifest 的 `managedAdapters`。调用 `upgradeV3Adapters` 传入此集合，不转调 `adapter upgrade --all`。
- 文件渲染、用户内容保护、共享 AGENTS.md 合并、staging 校验、journal 提交及原 operation repair 继续由 `src/installers/adapter-upgrade.ts` 和相关运行时负责。
- 新 CLI、候选版本、目标项目、平台集合或文件内容发生变化时，旧预览失效；重新预览再确认，不能沿用旧确认覆盖新内容。
- 新增的续接记录只记录包安装步骤、固定目标、原 operationId 和步骤结果，不保存新的任务、计划或策略副本。
- 会话和操作记录不作为人类身份认证。续接文件要限制权限、验证格式与路径，并只接受固定操作，不允许从记录里执行任意 argv。

### 6.4 身份和 session 的简化

已有显式有效 session 则复用，并验证 client、actor、项目绑定，不关闭用户原会话。没有有效显式 session 时，使用现有本地 actor 创建仅供此次升级使用的 `mancode-cli` session；不绑定或创建 workflow，不写隐藏全局“当前 session”。

若没有本地 actor，交互收集一次显示名；脚本调用需提供 `--name`，不得用固定虚构用户悄悄创建身份。身份和 session 只在执行已确认的项目更新、且有实际变更时创建；检查或取消不创建。

自动创建的 session 成功后关闭。操作中断且恢复需要原 session 时保留，用户下一次进入 `upgrade` 由本次续接记录定位并校验，恢复后再关闭。错误 session/client 不能通过新建另一个会话绕过原 operation 的归属。

### 6.5 并发与恢复边界

项目写入仍使用既有事务锁。包更新额外按规范化安装位置串行，项目升级编排按 checkout 串行，锁顺序固定。不能把“存在 in_progress 任务”等同于正在执行写操作，也不能只靠 PID 扫描承诺所有宿主已经退出。

包安装和项目事务是两个阶段，不能声称整体原子回滚。新版 CLI 已安装但项目更新失败时，明确报告部分成功，并给 `mancode upgrade --project-only` 或菜单中的“继续上次更新”。既有 adapter operation 未完成时，内部使用原 repair 协议；没有明确属于本次升级的 operation 时只展示原有修复入口，不修复无关任务。

npm 安装期间被取消或强杀，结果记为未知；重新检查实际安装位置、版本和可执行性后再决定重试，不自动重放有副作用的安装命令，不自动降级 CLI 或用备份覆盖用户后续编辑。

## 7. 故障与边界验收

| 场景 | 用户可观察行为 |
|---|---|
| registry 离线／超时 | 说明无法检查或下载；可使用当前 CLI 更新项目；不显示已最新 |
| 目标要求更高 Node 版本 | 安装前报告所需与当前版本，停止更新 |
| 安装目录无写权限 | 保留原错误与准确目录；不给自己提权，不自动 sudo |
| CLI 已最新但 Skills 旧 | 跳过包安装，继续更新入口 |
| 全部已就绪 | 成功退出，不生成多余会话和事务 |
| 本地／全局版本冲突 | 显示目标位置，禁止安装错副本后报成功 |
| 已登记平台文件缺失 | 在预览中列为修复项；未登记平台不增装 |
| 共享 AGENTS.md 多平台 | 合并为一次物理写入，保留其它托管区和自定义内容 |
| 预览后文件被编辑 | 拒绝旧预览，刷新影响范围并重新确认 |
| 符号链接／目录越界 | 保留现有适配器目标契约，不引入放宽规则 |
| 包已更新但入口失败 | 分项显示部分完成，继续入口更新时不重装包 |
| adapter journal 中断 | 定位并修复原操作，不删除 journal 或新造任务 |
| npm 安装结果不确定 | 验证安装状态后提示继续，不能直接报告成功 |
| 无身份／非交互 | 明确所缺输入；不要求用户复制 sessionId，不生成虚构身份 |
| legacy／迁移中布局 | 保留数据并给出已有迁移／恢复入口 |

## 8. 文件与模块计划

优先复用既有服务；以下是批准的实施文件上限。P0 若证明需要额外文件，先调整范围再实施。

| 路径 | 责任 |
|---|---|
| `src/cli.ts` | 注册公开 upgrade 参数与必要内部续接入口 |
| `src/commands/upgrade.ts`（新） | 统一应用服务：检查、选择、确认、编排、分项结果 |
| `src/system/upgrade-onboarding.ts`（新） | 升级菜单、无 TTY 行为与中英文文案 |
| `src/system/upgrade-installation.ts`（新） | 安装来源、目标路径、包管理器与版本兼容判定 |
| `src/system/upgrade-package.ts`（新） | 固定版本 registry 查询、隔离候选与 npm 调用 |
| `src/runtime/upgrade-continuation.ts`（新） | 安装位置锁、有限续接记录和分阶段恢复 |
| `src/commands/init.ts` | 已初始化交互分支接入同一升级服务 |
| `src/system/init-onboarding.ts` | 扩展可注入菜单接口，保留原平台选择契约 |
| `src/installers/adapter-upgrade.ts` | 仅在必要时暴露既有 staging／恢复的窄服务，不重写事务 |
| `src/installers/v3-adapter.ts` | 入口过期提示优先指向简易命令，保留底层诊断入口 |
| `tests/upgrade.test.ts`、`tests/upgrade-onboarding.test.ts`、`tests/upgrade-installation.test.ts`、`tests/upgrade-package.test.ts`、`tests/upgrade-continuation.test.ts`（新） | 直接同名契约与行为测试 |
| `tests/upgrade-e2e.test.ts`（新） | 真实 npm、隔离 registry、两版包、跨进程与中断验收 |
| `tests/cli.test.ts`、`tests/cli-v3-surface-contracts.test.ts`、`tests/v3-init-command.test.ts`、`tests/init-onboarding.test.ts`、`tests/adapter-upgrade-contracts.test.ts`、`tests/v3-adapter-contracts.test.ts` | 现有接口与保护回归 |
| `README.md`、`README.en.md`、`docs/platform-adapters.md`、`website/docs.html`、`website/docs.zh-CN.html` | 一键更新、兼容范围及首次安装说明 |
| `.github/workflows/quality.yml`、`.github/workflows/windows-smoke.yml`、`scripts/windows-smoke.mjs` | 按需接入真实升级进程及 Windows 三种 shell 验证 |
| `package.json`、`package-lock.json` | 仅经批准的必要依赖或测试入口；本方案不修改发布版本 |
| `docs/cli-upgrade-plan.md`、`.gitignore` | 方案与真实交付记录，以及方案单文件版本化白名单 |
| `tsup.config.ts` | 如独立助手需要，增加打包入口 |

模块：commands、system、runtime、installers、tests、docs。不得直接修改 `.mancode` 权威、手改已安装 Skills 或扩展到业务模块重构。架构设计以本文和现有架构文档为准；实施前检查本地 `架构/` 的适用资料，缺失仅阻止受影响的决定。

## 9. 分阶段实施与验收

| 阶段 | 输出与依赖 | 完成条件 |
|---|---|---|
| P0：验证自更新关键路径 | 在临时项目／临时 prefix 构造两版包，验证 npm 来源判定、新进程接管、脚本策略与 Windows 文件行为；固定首版安装支持矩阵 | 新包实际执行且 renderer 可区分；安装目标不误判；未解决平台能力不得宣称支持 |
| P1：项目一键更新 | 菜单、已登记平台选择、预览与确认、会话封装、结果检查；依赖现有 adapter journal | `upgrade --project-only` 无手动 ID 完成，取消／就绪不造多余身份，原文件保护有效 |
| P2：CLI 自更新与续接 | npm 全局／本地支持、目标候选、独立助手、版本回读和部分完成恢复；依赖 P0 和 P1 | 一条入口更新实际使用的 CLI，并用同一目标版本完成项目更新 |
| P3：init 与公开入口 | 已初始化菜单、脚本参数、帮助、中英文文档及网站参考 | init 与 upgrade 行为一致；旧脚本及底层命令保持兼容 |
| P4：模块验收 | 全范围代码审查、故障注入、真实进程／PTY／平台矩阵、项目通用检查 | 所有必需验收有对应证据，缺口明确；再进入单独发布流程 |

P1、P2 是同一功能的内部实施顺序；只有 P1 完成时不得把整体“一键更新 CLI 和项目”标为交付。为了加快交付，首版收敛包管理器范围，不删除恢复与安装目标校验。

## 10. 验收清单

| ID | 必需验收 | 观察层／方法 |
|---|---|---|
| AC-1 | 根命令可发现，交互菜单编号、确认、取消、中英文及非 TTY 行为符合契约 | component 自动化＋真实 PTY manual_observation |
| AC-2 | CLI 已是目标版本而入口过期时仍修复；全就绪时不安装、不造 session/journal | component |
| AC-3 | 只更新 manifest 已登记平台；多平台共享文件保留其它区块；缺失入口可修复 | component |
| AC-4 | 无身份输入一次显示名后完成；已有／自建 session 的保留、关闭和恢复正确；无任务被创建或切换 | component |
| AC-5 | init 已初始化菜单复用 upgrade；新初始化与非交互旧行为不变 | component＋真实 PTY manual_observation |
| AC-6 | 实际 npm 全局 prefix 内的旧包更新为新包，新进程生成新版入口；没有改开发机全局安装 | real_http：真实子进程＋回环 fixture registry |
| AC-7 | 实际普通 npm 本地依赖保留依赖归属与声明风格，lockfile 一致；没有误更新全局或其它 workspace | real_http |
| AC-8 | 双安装、源码 link、临时 npx、非支持包管理器、legacy 与迁移中布局准确分流 | component |
| AC-9 | 目标版本固定；拒绝默认降级、无效目标及不满足 engines；离线项目更新可用 | component＋real_http 分设验收记录 |
| AC-10 | 预览改变后拒绝提交；用户自定义内容、符号链接保护与现有任务／policy 未被改写 | component |
| AC-11 | 在包安装前后、adapter 提交前后中断，准确报告状态并恢复原操作；未知安装不自动重放 | real_http：真实进程故障注入 |
| AC-12 | 权限错误、网络超时、两次升级并发、Ctrl-C 保留可诊断原因且不会误报全成功 | component＋real_http 分设验收记录 |
| AC-13 | macOS、Linux 和 Windows CMD／PowerShell／Git Bash 的空格／中文路径与实际 npm 续接通过 | 各平台实际进程观察；未跑矩阵不得代填 |
| AC-14 | help、参数冲突、退出码、JSON 结果与中英文公开文档一致 | component＋manual_observation 文档复核 |

登记正式 requirements 时，涉及多观察层的条目拆成独立 ID 或合法 hybrid slot，不能将一个 automated slot 写成多个 surface，也不能以 mock 成功代替 AC-6/7/11 的真实安装链。

修改 `src/` 后先跑对应同名契约，再跑相关调用链回归；候选统一执行 `npm run check`。Windows 使用现有 `npm run check:windows` 和真实三种 shell 流程，增加此次升级的实际进程覆盖。测试包安装只在临时 prefix／fixture 项目运行；不为了测试更改操作者的全局 CLI。文档阶段只校验文档、引用与仓库契约，不制造无意义 TDD 或宣称功能测试通过。

## 11. 发布与老用户首次进入

旧版二进制没有 `upgrade`，因此不能靠向已经发布的 0.6.8 补命令解决首次进入。包含此功能的新版本发布后，老用户只需先用原包管理器更新 CLI 一次，再运行 `mancode upgrade` 更新项目。此后升级统一从新入口进入。

文档中的 npm 全局安装首次操作为 `npm install -g mancode@latest`；本地安装使用原依赖归属的安装方式。不能对所有旧项目一律推荐全局安装。新功能版本号以真正发布结果为准，不在计划里声称已经可用。

新版本向后调用能力必须显式检测：如果目标包不支持所需续接／预览协议，应在持久安装前停止完整升级，给出清楚的兼容指引，不能安装后才发现无法继续。候选与正式包必须来自同一冻结版本及 registry 完整性绑定。

## 12. 已接受决策与实施约束

1. 推荐首版自动包更新覆盖 npm 全局和普通 npm 本地依赖；其它包管理器只给指引。用户在推荐方案后明确要求开始开发，按该推荐范围实施。
2. 建议保留一次执行摘要确认；`--yes` 供明确脚本调用。无本地身份时仍需一次显示名输入，不能凭空移除现有 identity 契约。
3. 自更新关键路径以 P0 真进程验证为实施前置条件。若结果要求更改 session／operation 的权威模型，必须单独评审，不能作为交互封装暗中引入。

用户已授权代码实施及指定目录的真实测试；不授权发布或操作者全局安装更新。真实测试使用测试根下此次新建的独立目录，保留所有历史测试材料。

<!-- mancode:plan-baseline:end -->

<!-- mancode:delivery-record:start -->
Task: local:01M2NJHER7PZMZYA74MRMAKA37
Plan version: 2
Review: blocked
Verification: pending

Reviewer declaration: independent
Direction: Targeted independent follow-up after user-authorized repairs to R-9 through R-11, retaining the original full module review against approved plan 2 and bound base adb7f3889427ac8dfa29256f9009429f8a245e7c. A repair subagent changed command orchestration and regressions; the original independent reviewer checked the concrete repairs and the four-state persistent-install recovery boundary. Parent independently exercised real CLI/SIGINT/version-drift and PTY behavior, reviewed new shell test drivers and CI wiring, and inspected original test output. Prior scope coverage remains applicable; existing research/** and unrelated README typo remain excluded and preserved.
Correctness: R-9 now clears only unused version-stale previews after verified project-phase installation or a local project-only receipt; unknown installations and existing journals retain recovery material. Four-state contracts and real 0.6.7-to-0.6.8 interruption followed by npm installation of fixture 0.6.9 prove fresh confirmation and recovery. R-10 passes real SIGINT without an injected throw, retaining unchanged managed files and recoverable receipt, then resumes. R-11 reloads the installed entry metadata so JSON declaration matches package.json. Valid Red logs, the trace-assertion failure, follow-up persistent-install Red and Green results are preserved. Final npm run check passes 190 files/1685 tests against the current subject; real CLI HTTP and Bash shim outcomes are recorded separately. Independent targeted code review found no remaining defect in these repairs. Linux/Windows host acceptance remains unavailable.
Proportionality: The command reuses adapter staging, journal recovery, identity and sessions. New code is limited to user choices, installation identification, integrity-bound candidate/install supervision, typed continuation and tests. No lifecycle scripts are silently enabled, no arbitrary shell command is assembled, and CLI/project stages do not claim atomic rollback.
Next: R-9 through R-11 repaired and locally verified. Keep overall delivery unfinalized until required Linux/Windows runtime and real shell/console evidence is obtained; do not publish or change the user global CLI. Final local repair evidence is in /Users/whitelonng/code/mancode测试/upgrade-repair-20260917/RESULTS.md.
- R-1: resolved — Earlier revision retained an installing receipt after a pre-install failure and could not retry. Fixed by checking verified persistent old CLI state, retaining history, and requesting a fresh preview; component and actual before-install interruption pass.
- R-2: resolved — Earlier receipt recovery could execute an unverified absolute entry and create directories through redirected ancestors. Fixed persistent npm bin verification before spawn and existing-parent validation before mkdir; negative contracts pass.
- R-3: resolved — Earlier human check output omitted target/install/guidance and preview showed logical target names. Fixed human details, real relative file paths and Chinese status labels; PTY and contracts verified.
- R-4: resolved — Earlier receipt-write failure leaked an automatically created session. Fixed cleanup before rethrow; a concurrent filesystem obstacle regression verifies session close without published entry changes.
- R-5: resolved — Earlier target/engines/downgrade errors and cancellation in check mode returned generic failure codes. Fixed outer error mapping and check cancellation propagation; explicit exit-code regressions pass.
- R-6: resolved — Earlier stale preview receipt caused an endless retry loop. Fixed no-journal stale cleanup and required fresh confirmation; command regression passes and original aborted journals remain retained.
- R-7: resolved — Earlier completed JSON kept pre-upgrade ready=false. Fixed ready=true only after verified commit/resume, with command and actual target-CLI assertions.
- R-8: resolved — Directly killing the install supervisor on Windows could leave npm writing after lock release. Fixed controlled stdin cancellation and supervisor-owned timeout; real npm cancel/timeout close and no-further-write evidence passes on macOS. Windows host verification remains AC-13.
- R-9: resolved — src/commands/upgrade.ts:750-767: a project-only receipt made by a different CLI version before any adapter journal causes PREVIEW_VERSION_CHANGED on every retry. Only PREVIEW_STALE removes an unused preview/session/receipt, so the recovery instruction loops indefinitely instead of obtaining a new preview and confirmation required by plan 6.3. Two actual CLI retries exit 4 with unchanged receipt and no journal; independent-review-20260917/version-drift/result.json.
- R-10: resolved — src/commands/upgrade.ts:476-508,752-757: after receipt creation, the local project commit path does not observe the abort signal. Actual SIGINT without an artificial throw still updates managed files and reports completed with exit 0. tests/upgrade-e2e.test.ts:41-43 throws CANCELLED after sending SIGINT, masking this missing production check. Violates AC-12; independent-review-20260917/project-sigint/result.json.
- R-11: resolved — src/commands/upgrade.ts:518-522 retains the pre-install cliState.declaration when reporting success. Saved real local upgrade output has version 0.6.8/status updated/declaration ~0.6.7 while package.json contains ~0.6.8. Consumers receive inconsistent current installation state; tests/upgrade-e2e.test.ts:380-388 checks disk declaration but not response. Violates AC-14; upgrade-e2e-bNmaVv/local-result.json.
- AC-1: met — Final real macOS PTY and full component check: numeric menu, invalid input reprompt, Ctrl-C 130, Chinese/English confirmation and non-TTY INPUT_REQUIRED 2. See pty-project-w89teuf6/pty-result.json.
- AC-2: met — Ready/no-op paths skip candidate installs and new identities/sessions; stale registered entries repair with current CLI. Actual global upgrade second invocation is a no-op.
- AC-3: met — Selection comes from manifest managedAdapters; command tests preserve custom AGENTS content and do not install extra platforms; existing adapter transaction contracts cover shared files and missing targets.
- AC-4: met — Real project/session services cover first identity, reused active session, automatic close, interruption reuse, receipt-write failure cleanup, and no workflow creation.
- AC-5: met — Final real PTY initialized init menu 1/2/3/0 observed; unchanged new/noninteractive/legacy init contracts pass in final full check.
- AC-6: met — Real npm global replacement and target renderer verified in final build E2E, including invocation through actual npm-generated Bash entry. Version fixtures are built current code with distinct metadata/renderer markers, not historical release packages.
- AC-7: met — Final actual npm ordinary local upgrade preserves dependency sections/range style/lockfiles and JSON declaration equals disk. Real package spike covers dependencies/dev/optional plus caret/tilde/exact; Bash E2E exercises local npm bin entry.
- AC-8: met — Installation tests cover npm prefix/bin identity, local/global ambiguity, source links, npx, workspace and other package-manager guidance; existing init/migration contracts retain layout gates.
- AC-9: met — Direct SemVer dependency freezes exact registry version/integrity, checks engines and scripts, rejects downgrades; project-only checks never invoke registry dependencies.
- AC-10: met — Preview freshness, path symlinks and redirected receipt ancestors, candidate integrity, original session ownership, custom content and original task policy boundaries reviewed and regression tested.
- AC-11: met — R-9 resolved: both local-only and verified persistent-install project-phase version drift discard only unused stale preview and require new confirmation. Actual three-version npm case returns interruption130, stale-preview4, unconfirmed2, then completed0. Four-state contracts retain installing/repair_required journal evidence. Existing before/after-install and adapter repair/crash cases remain passing.
- AC-12: met — R-10 resolved: real POSIX SIGINT after receipt save returns130 without writing managed content or starting a journal; same receipt resumes successfully. SIGINT fixture no longer injects a throw. Actual npm cancellation/timeout closes connections and stops writes in final full check; lock/error contracts pass.
- AC-13: unverified — Unverified for Linux/Windows and Node22/24. Actual local environment macOS arm64 Node25.9.0. CI now enables real npm cancellation/timeout and routes persistent installations through CMD .cmd, PowerShell .ps1 and discovered Git Bash entries. Local Bash shim run validates the POSIX path only. Windows faults remain exception injection, not console Ctrl-C evidence.
- AC-14: met — R-11 resolved: installation metadata is reread from the verified installed entry and returned declaration now matches actual manifest. Component and actual local npm E2E assert it. Final PTY/help and bilingual docs readback match the public contract; feature remains unreleased.
- AC-1: automated=passed(surface=component); manual=passed(surface=manual_observation); Executed argv in project root; captured exit code 0.
- AC-2: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-3: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-4: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-5: automated=passed(surface=component); manual=passed(surface=manual_observation); Executed argv in project root; captured exit code 0.
- AC-6: automated=passed(surface=real_http); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-7: automated=passed(surface=real_http); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-8: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-9: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-10: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-11: automated=passed(surface=real_http); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-12: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-13: automated=n/a; manual=pending(surface=unspecified); No evidence yet.
- AC-14: automated=passed(surface=component); manual=passed(surface=manual_observation); Executed argv in project root; captured exit code 0.
<!-- mancode:delivery-record:end -->
