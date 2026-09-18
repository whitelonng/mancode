<!-- mancode:plan-baseline:start -->
# mancode 完整改造方案：退役 Privacy Gateway + Secrets V1

> 修订版 1.1 · 2026-09-18 · 设计与实施方案，尚未改动代码、尚未运行验收。  
> 本文完整替代上一版 `mancode-secrets-v1-plan.md`，不需要两份文件对照实施。  
> **先独立移除本地模型代理网关，再新增“本地保险箱 + 已确认程序执行”。**  
> Secrets 命令、数据格式、新增文件及测试均为拟新增设计，不代表当前仓库已经支持。

## 0. 先看这一页

**这次做两件事，不把两件事混成一次大重构。**

```text
阶段 A：完整退役旧网关

删除：模型转发服务、网关配置/命令、协议还原、网关 Worker
保留：scan / preview、共享保护、任务治理、团队同步
                    │
               独立回归验收
                    ▼
阶段 B：新增 Secrets V1

用户本地录入 → 加密保险箱
                    │
Agent 只交编号 → mancode 校验 → 已确认程序拿到真值并办事
                    │
Agent ←──────── 固定状态回执，不转发原始日志
```

**mancode 不需要自己会发邮件、操作数据库或填写所有网站。** 它只把秘密交给你事先确认的外部程序；业务逻辑仍在那个程序里。

| 你关心的问题 | 本方案的决定 |
|---|---|
| 还要挂一个模型网关吗？ | 不要。Secrets 按调用启动，完成后退出，不新增服务端口 |
| API Key、邮箱、手机号能保存吗？ | 可以，存储层统一按受保护文本处理；会保存不等于自动会操作所有业务 |
| 真实数据从哪里进去？ | 用户在独立本地终端隐藏录入；执行时由 mancode 在内存中解密，通过内部管道交给程序 |
| Agent 会收到明文吗？ | 这个接口不主动返回明文；但接收程序和目标系统会接触明文，不能承诺同权限恶意 Agent 绝对拿不到 |
| 以前的扫描和共享保护呢？ | 保留，不因删网关而关闭或降级 |
| 新功能要额外配置模型 API Key 吗？ | 不需要。只有具体业务需要的凭据才录入保险箱 |

**最终选型：③秘密引用 + ②已确认外部程序执行。不是①由 mancode 包办所有业务，也不是任意命令自动替换。**

阅读路径：只看决策看第 0、1、13 节；实施网关移除看第 2 节；实施 Secrets 看第 3～12 节；发布前看第 14、15 节。

## 1. 对补充方案的审核结论

### 1.1 总体结论

**补充方案的主体可采纳：将“本地模型代理网关退役”作为独立改动，不重构任务治理、团队同步和共享权威数据。** 本文同时保留后续 Secrets 的完整设计，但两阶段分别提交、分别验收；移除网关不必等待 Secrets 开发完成。

不是因为已证实旧实现泄露了数据才退役。公开实现需要显式启动并由用户接入客户端，启动后读取原始请求并用运行环境中的上游凭据转发。这里的决策是减少额外处理环节和接入成本，不能写成“检测到已发生泄露”。此外，现有 `run` 是前台运行，准确说法是“需要额外保持一个网关进程运行”，不是“已自动安装后台守护服务”。[^R16][^R19]

### 1.2 逐项审核与采纳

| 对方方案的内容 | 审核结论 | 整合后的处理 |
|---|---|---|
| 删除 `src/gateway/` 和 `src/commands/privacy-gateway.ts` | 采纳 | 删除完整运行链路，不保留换名后的模型转发服务 |
| 删除 `gateway/worker` 构建入口 | 采纳并补充 | 只删除网关入口；保留任务执行 Worker、Vitest reporter、CI observer |
| 清理 CLI、init、onboarding、privacy status | 采纳 | 一并清理类型、动态 import、提示文字、错误分支和契约测试 |
| 不把网关询问改成共享增强保护 | 采纳 | 保留原有独立共享询问及默认关闭语义；不把 `--yes` 当作同意开启 |
| 保留扫描器、基础检查、共享策略和历史兼容 | 采纳 | 作为独立回归门禁，不因删除网关而改写共享 schema |
| 不需要卸载一个 Maskit npm 包 | 限定采纳 | 已核对 `package.json` 未声明独立 Maskit 依赖；实现时再查锁文件，不假造卸载动作 |
| 删除 `privacy status --json` 的 `gateway` 字段并升版 | 采纳并明确 | 只将这个命令的输出 `schemaVersion` 从 1 改为 2，保留 `shared` 内部结构 |
| 旧命令和选项不再接受 | 采纳 | 明确非零错误；不保留仍能启动服务的兼容壳，不静默忽略 |
| 不自动删除旧配置、不自动修改 provider | 采纳 | 提供“先停止、再恢复连接、再升级、最后选目录清理”的人工流程 |
| 删除网关专用测试、探针和 fixtures | 采纳并补充 | 混合测试只改网关部分；保留扫描器反例，另增“网关已退役”的负向测试 |
| 只需运行受影响测试与 `npm run check` | 采纳并补充 | 再查实际 npm 包、source map、安装后 CLI、旧配置损坏场景 |
| 已有未提交初始化改动，避免覆盖 | 作为实施前必查项 | 公开仓库无法证明本地脏工作区状态；先检查暂存区、工作区、未跟踪文件，不强制 reset |

对应公开依据：构建入口、初始化逻辑、CLI/status、依赖与共享规则来源见 [^R2][^R10][^R11][^R14][^R15][^R17][^R18]。表内“采纳”是本方案的设计决定，不表示代码已经改好。

### 1.3 本次核对范围和未核实项

已经阅读上一版 Markdown 和你提供的补充文本，并静态核对公开 `main` 的 CLI、init、onboarding、privacy 命令、网关配置/服务/映射、构建配置、依赖声明、部分测试、质量检查脚本和隐私文档。

**没有取得整个仓库的固定提交快照；没有访问你的本地工作区；没有运行仓库测试；没有做实际卸载或密钥操作。** 公开 `main` 会变化，网页抓取也可能对应不同缓存时点。实施者必须先记录本地 `git rev-parse HEAD`，再用该提交与实际工作区复核文件清单。本文不会把“已有未提交修改”或“没有其他引用”当成已经实测的结论。

下文区分三类内容：**已核对的具体文件**、**实施时必须检索补齐的外围引用**、**拟新增的实现**。没有逐个打开的文件，不以确定名称伪造完整清单。

### 1.4 对前面安全说法的再次修正

| 容易误解的说法 | 本方案采用的准确边界 |
|---|---|
| 用 Python 包起来就看不到秘密 | 语言不是隔离机制；接收程序仍能输出或发送它拿到的数据 |
| 通过 stdin 传递就绝对安全 | 只减少命令参数暴露；仍须信任接收程序 |
| 禁止 echo、过滤 stdout 就能防泄露 | 不能覆盖文件、网络、编码及其他工具回读；V1 不提供万能命令黑名单 |
| TTY、环境变量可以验证真人 | 只是防误操作，不是恶意同权限代码无法伪造的认证 |
| Keychain 自动隔离同账号 Agent | 取决于实际授权配置；不能仅凭用了 Keychain 作强隔离承诺 |
| 只在最后一刻替换，之后放进 argv 没问题 | 明文参数仍有暴露面；V1 不向 argv 注入秘密 |
| 能“用完彻底销毁所有副本” | 尽量清理可控 Buffer、缩短驻留；不承诺清除运行时和系统所有副本 |

因此 V1 定位为**减少正常使用中的明文暴露**。要求“即使 Agent 恶意、能任意修改本机程序也绝不泄露”，就必须另做系统级隔离。[^R3][^R4][^R5][^R7][^R8][^R13]

---

## 2. 阶段 A：完整退役本地模型代理网关

### 2.1 删除范围和保留范围

| 删除 | 保留 |
|---|---|
| 本地模型 HTTP/SSE 转发与响应还原 | 现有文本扫描和不可逆副本预览 |
| 网关专属配置、认证、状态探测与控制接口 | V3 基础共享检查、术语表检查 |
| 网关占位符映射、网关 Worker 与相关 CLI | 增强共享策略、历史排除、manifest 兼容 |
| 网关专用宿主探针、协议 fixtures 和当前接入教程 | 任务治理、上下文、团队同步、事务恢复 |
| 初始化中的网关选项和偏好写入 | 既有共享保护选项与选择语义 |

**“删除网关”不等于“删除所有 privacy 代码、所有 Worker 或所有本地 HTTP 功能”。** 既有任务执行基础设施、进度功能等不属于本次网关退役范围。Secrets 也不依赖旧网关存活。

### 2.2 实施前先保护本地改动

先在用户授权的工作区记录基线并检查改动，不自动切分支、不自动清空或暂存所有文件：

```sh
git status --short
git diff --stat
git diff --cached --stat
git ls-files --others --exclude-standard
git rev-parse HEAD
```

重点核对 `src/commands/init.ts`、`src/system/init-onboarding.ts` 及对应测试是否已有改动。针对原有改动逐段合并；不执行 `git reset --hard`、`git clean -fd` 或整文件回退来“获得干净起点”。不要把与本任务无关的修改一并提交。

再检索实际工作区，记录引用清单。以下检索用于定位，不是批量删除命令；还需查看未跟踪文件：

```sh
git grep -n -i -E \
  'privacy[-_/ ]gateway|gatewayPrivacy|gateway-privacy|readPrivacyGatewayStatus|registerPrivacyGatewayCommands|startGatewayServer|MANCODE_GATEWAY|gateway/worker' \
  -- src tests scripts docs website README.md README.en.md package.json package-lock.json tsup.config.ts
```

关键词命中应分类为运行代码、混合代码、文档、历史记录或负向测试。`git grep` 返回 1 可以只是“无匹配”，不能据此宣布全项验收通过。

### 2.3 已核对的核心移除清单

| 位置 | 具体动作 | 不要误删 |
|---|---|---|
| `src/gateway/` | 删除网关服务、协议/SSE 处理、原值映射、扫描 Worker、配置、认证与网关错误实现；先检查目录外引用 | `src/privacy/` 公共检测和脱敏核心 |
| `src/commands/privacy-gateway.ts` | 删除命令注册、启停/状态/doctor、宿主验证、配置片段生成 | `privacy enable/disable/policy` 的共享保护命令 |
| `tsup.config.ts` | 删除 `'gateway/worker': 'src/gateway/worker.ts'` | `cli`、`index`、`execution/worker`、`execution/vitest-reporter`、`execution/ci-observer` |
| `src/cli.ts` | 删除两个 gateway 初始化 flag；冲突检测只保留共享 flag 对 | `--shared-privacy`、`--no-shared-privacy` 和普通初始化行为 |
| `src/commands/init.ts` | 删除 `gatewayPrivacy` 类型/传参/局部变量、动态 import、偏好写入、成功提示和写失败分支 | 项目初始化事务、共享选择、已初始化项目处理和其他初始化功能 |
| `src/system/init-onboarding.ts` | 删除网关问题和返回字段；保留共享问题或将方法明确命名为共享选择 | 原有语言选择、平台选择、取消及安全路径交互 |
| `src/commands/privacy.ts` | 删除网关 import、子命令注册、状态读取、网络探测及网关聚合错误 | scan、preview、共享策略命令及其原有退出语义 |
| `scripts/privacy-gateway-spike.mjs` | 删除网关专用宿主/假上游探针 | 其他扫描器反例与发布检查脚本 |
| `tests/init-privacy.test.ts` | 把组合测试收敛为共享选择测试，删除网关配置断言，新增“不生成旧目录”断言 | 重复 init、`--yes`、取消、显式共享选择等有效用例 |
| `tests/cli-v3-surface-contracts.test.ts` | 删除网关正向表面契约；补充已移除命令/选项的非零拒绝 | 全部非网关 CLI 表面契约 |
| `tests/privacy-command.test.ts` | 保留扫描/预览回归；按实际引用调整 status 相关断言 | 输入有效性、失败关闭、不覆盖源文件和敏感输出限制 |
| `tests/website-docs.test.ts` | 按其现有命令索引/页面约束验证新文档，必要时补退役断言 | 两语言完整公开命令索引等其他网站契约 |

核心文件事实见 [^R10][^R11][^R14][^R15][^R16][^R17][^R22][^R23][^R25][^R26][^R30]。这是已核对入口清单，不替代实施前的全仓引用搜索。

外围必须再查：`src/index.ts` 及其他导出、doctor/status 调用、安装/卸载/升级脚本、CI、打包脚本、adapter/instructions 模板、测试 mock、覆盖率配置、站点生成源。**仅当实际存在网关引用时才修改，不为了凑清单改无关文件。**

当前核对到的 `src/index.ts` 只导出 `VERSION`，未导出网关符号；不需要为此次删除制造无意义变更。[^R29]

### 2.4 初始化行为：删网关，不偷偷改产品语义

完成后初始化只保留原来独立的共享增强保护选择。具体规则如下：

| 场景 | 期望行为 |
|---|---|
| 首次交互式 init，未给共享 flag | 只问共享保护，不问网关，不问新保险箱秘密 |
| 首次明确 `--shared-privacy` | 按既有语义开启共享增强保护，不再询问已明确的选项 |
| 首次明确 `--no-shared-privacy` | 按既有语义关闭增强保护，基础检查仍在 |
| 首次非交互 / `--yes`，未给共享 flag | 不提问，增强保护默认关闭；`--yes` 不等于启用 |
| 同时给共享正反 flags | 参数错误，不能写入半初始化项目 |
| 在询问时取消 | 在项目变更前退出，保持原有取消约定 |
| 已初始化项目再次 init | 不改现有共享策略；保留当前已有项目更新流程 |
| 使用旧网关 flags | 非零参数错误，不静默接受，不进入初始化写入 |
| legacy 初始化 | 保留既有 shared flag 处理约定，不隐式迁移项目 |

现有代码确实分别维护两项选择，网关偏好在项目初始化成功后另行写入；删除后该独立失败分支也应消失。[^R14][^R15][^R22]

**不要顺手给 init 增加“录入 API Key / 手机号”步骤。** 新 Secrets 是用户主动调用的独立入口，避免在 Agent 带领的初始化过程中索取真实内容。

### 2.5 `privacy status`：只升输出契约，不迁移共享数据

当前命令输出含 `{ schemaVersion: 1, shared, gateway }`，返回码还受网关配置及运行状态影响。[^R11]

修改后的拟定类型为：

```ts
// 新的命令输出契约；不是项目磁盘 schema。
type PrivacyStatusV2 = {
  schemaVersion: 2;
  shared: Awaited<ReturnType<typeof readPrivacyPolicyStatus>>;
};
```

`shared` 的字段、含义和既有内部版本保持不变。不加入 `gateway: null`、假造 `runtime: stopped` 或含糊的 `protected: true`。

实现要求：仅调用 `readPrivacyPolicyStatus(root)`；删除 gateway 状态行、路由验证行、网关错误行及相关 help 文案。退出码只由共享状态判断：共享状态 `error` 返回 2，其他既有正常状态返回 0。旧网关配置损坏、目录不可读、端口被占用都不能影响这个命令，也不能触发 localhost 探测。

**版本边界必须分开：**

| 对象 | 本次是否改变 |
|---|---|
| `privacy status --json` 的顶层输出版本 | 1 → 2 |
| `.mancode/schema.json` / 共享 manifest | 不因删网关而修改 |
| shared privacy policy / 历史排除表 | 不改版本、不降级、不重写历史 |
| 扫描器规则版本及 scan/preview JSON | 不因删网关而修改 |
| Secrets 新协议 | 自己从 1 开始，与上述版本无关 |

这是公开 CLI 兼容性变化，应列入发布说明并通知依赖旧字段的脚本维护者。不要在旧版本号下静默替换同一已发布包；具体发布版本按项目既有发布策略决定。

### 2.6 测试、fixtures、文档与许可

**测试处理。** 删除只覆盖旧网关实现的测试文件及专用 fixtures。`tests/fixtures/privacy-protocols/` 是已有验收文档记录的网关证据位置，实施时先查所有使用者；仅删除网关专用部分，不删除被其他测试复用的数据。[^R21]

混合用途测试只移除 gateway 分支。如果一个扫描器缺陷最早是在网关探针里发现的，应把对应合成输入/断言留在公共扫描器测试，再删探针。不能为了让测试通过，把整个 `init-privacy` 或扫描安全回归文件删除。

新增 `tests/privacy-gateway-retirement.test.ts`，专门验证“不再支持网关”的负向行为。这个文件中出现旧命令字符串是正常测试证据，不是功能残留。

**当前用户文档。** 更新 `README.md`、`README.en.md`、`docs/privacy-guide.md`、网站两种语言的实际页面/命令索引、平台指引。删除可选网关宣传、启用步骤、模型 base URL 改写示例和网关兼容版本承诺。新增 `docs/privacy-gateway-retirement.md`，说明退役范围、兼容变化和人工退出流程。

**网站契约补充。** 已核对的站点测试涉及 `website/index.html`、`website/index.zh-CN.html`、`website/docs.html`、`website/docs.zh-CN.html`。它从 `createCliProgram()` 动态枚举公开命令，并与文档页的 `data-cli-command` 索引逐项比较；退役时应更新页面与锚点，不要通过削弱这个测试隐藏文档过期。页面实际内容仍需在实施提交上逐页复核。[^R30]

**历史实施记录。** `docs/privacy-implementation-plan.md` 同时含扫描、共享和旧网关验收历史，并进入当前 npm `files` 列表。[^R2][^R21] 不把整篇删除：保留扫描/共享记录，旧网关部分明确标记“历史实现，已退役，不适用于本版本”，或迁入明确标记的历史文档并修正链接。不要删改 Git 历史，也不要把当时通过的测试转述为本次版本已经通过。

**许可与规则来源。** 保留 `docs/privacy-rule-sources.md`、`docs/privacy-upstream-license.txt` 和仍需保留的代码来源说明。扫描器仍含 Maskit 派生规则；删除网关并不等于去除了这些规则，也不构成修改项目许可声明的理由。[^R18]

**依赖。** 核对到 `package.json` 没有独立 Maskit npm 依赖，不执行没有依据的 `npm uninstall maskit`。[^R2] 仅在锁文件与使用者分析确认某个依赖已无其他用途后移除它；不因网关删除而清空通用依赖。

### 2.7 构建和实际 npm 包：不能只看源码目录消失

清理后的构建必须不含网关 Worker、旧服务实现及其类型输出。`tsup.config.ts` 当前启用了清理输出及 source map；仍需验证实际结果，不能以配置项替代验收。[^R17]

检查四层：

| 检查层 | 通过标准 |
|---|---|
| 源码依赖 | 网关模块不再被运行代码 import / 动态 import / 导出 |
| 构建目录 | 无 `dist/gateway/` 及旧网关相关声明、map；其他执行产物保留 |
| bundle 内容 | `dist/cli.js`、公共模块及 source map 的 sources / sourcesContent 不残留打包进来的网关实现 |
| 实际 tarball 与安装 | 实际包文件、安装后 CLI 都满足退役契约，不只是本机源码模式通过 |

`package.json` 的 `files` 列表显式包含 `dist`、隐私指南、实施记录和来源许可文件。[^R2] 文档若更名或新建，应同步列入需要分发的指南，确保相对链接在 npm 包里也可打开；保留许可文件。

可在构建检查完成后执行以下待验收命令；它们仅检查或生成本地包，不会发布软件包。选项含义见 npm 官方文档；实施时同时记录实际 npm 版本。[^R31]

```sh
npm pack --dry-run --ignore-scripts --json
npm pack --ignore-scripts --json
```

第二条产出实际 tarball。解包到隔离临时目录检查文件，再在干净临时安装中测试。不要使用真实业务凭据，安装测试也不运行生产动作。`--ignore-scripts` 不代替质量检查；必须先完成项目要求的构建和验证。

**不能要求全仓所有 `gateway` 字符都消失。** 退役指南、历史记录、负向测试和来源说明可以保留准确提及；禁止的是可运行的旧网关路径及把旧能力当作当前功能的宣传。也不能因发现 `createServer` 就删除无关进度功能。

### 2.8 旧用户迁移：人工可控，不自动删配置

建议发布说明按下面顺序组织：

```text
暂停向旧网关发送新任务
        ↓
用旧版本/原终端停止已确认的旧实例
        ↓
恢复用户原本选用的客户端连接方式
        ↓
升级 CLI，验证普通工作流与 privacy status
        ↓
用户自行选择是否清理对应旧目录
```

**停止。** 最方便是在升级前，于对应 checkout 使用旧版本的 `mancode privacy gateway disable --json`，或在原前台运行终端中停止；以实际确认的实例退出为准。已升级后不能再指望新 CLI 提供被移除的 stop/disable 命令。不能只凭旧 `runtime.json` 里的 PID 杀进程，也不提供 `pkill node`、全局端口清理等宽泛操作。包升级不会自动结束旧进程。[^R16]

**恢复客户端连接。** 由用户恢复原先选择的 provider、订阅或登录配置；只处理为旧网关设置的 base URL、局部 Token、宿主 header 等，不猜测原供应商，也不覆盖整个客户端配置。新版本不扫描或重写这些外部配置文件。

**区分两种凭据。** 当前实现从进程环境取得真实上游密钥；旧配置还包含用于访问本地网关的 `accessToken`，二者不能混为一谈。[^R16][^R19][^R20] 用户只清理明确属于网关的设置；不能全局删除其仍被其他程序使用的供应商 API 环境变量。确有泄露迹象时，到对应服务撤销并换新；删除本地文件本身不能撤销远端 Key。[^R5]

**旧目录。** 公开实现按 checkout 派生目录，已核对到如下结构：[^R16][^R20]

```text
~/.mancode/privacy-gateway/
└── <checkout 派生目录>/
    ├── config.json       # 网关配置、本地 accessToken、上游环境变量名称
    ├── runtime.json      # 运行实例记录；正常退出后可能已移除
    └── config-locks/     # 配置生命周期锁记录，按实际残留为准
```

新版本不读取、不验证、不迁移，也不自动删除这些旧目录。用户停止实例后，通过本地文件管理方式确认要删的确切 checkout 目录，再自行清理。不要展示文件正文，不自动打包“诊断备份”，更不要删除整个 `~/.mancode` 或项目 `.mancode`。

公开网关映射使用内存 Map，指南也说明其为内存映射；不能编造一个旧磁盘保险箱并导入 Secrets。[^R12][^R28] 实施时如发现本地历史版本还留有其他文件，作为敏感残留人工确认，不自动导入。

**删除的含义。** 新包不再提供网关，并不擦除旧 npm 发布版本、Git 历史、系统备份和仍在运行的旧实例。文件删除也不承诺安全擦除所有快照。

### 2.9 阶段 A 不得改变的共享行为

保留基础检查及 `src/context/privacy.ts` 既有解析契约；保留 `src/privacy/` 检测与不可逆预览；保留 `privacy enable/disable/policy`、共享 schema barrier、revision/digest 校验、历史排除、团队 transport、Context Pack 和事务恢复。[^R11][^R12][^R18][^R27]

增强保护关闭后，既有基础检查和历史排除约束不能失效。不为了删网关降级 manifest、降低最低客户端要求或重写历史实体。

用代表性旧工作区进行回归：增强保护开/关、存在历史排除、存在待恢复事务、团队同步/多 checkout 等。**“无需共享数据迁移”是实现约束，必须由回归证明，不是允许跳过兼容测试。**

### 2.10 网关退役验收清单（G01～G22）

全部为待执行项。运行测试时记录固定提交、系统、命令和结果，不能复用旧版本的验收数字。

| ID | 验收场景 | 必须观察到的结果 |
|---|---|---|
| G01 | 搜索运行代码 import、动态 import、导出 | 不再依赖网关模块；不存在换名后保留的模型代理 |
| G02 | 调用旧 `privacy gateway` 各子命令 | 明确非零错误；无监听、无配置写入、无请求转发 |
| G03 | init 传入两个旧网关 flag，包括否定形式 | 在变更前拒绝；不静默接受 |
| G04 | 查看 root/init/privacy help | 无网关可用能力条目，其他公开命令仍在 |
| G05 | 首次交互式 init | 只保留独立共享选择，不问网关或秘密值 |
| G06 | 首次非交互 / `--yes` | 未声明的共享增强默认关闭；不创建网关或保险箱 |
| G07 | 共享 flags、互斥 flags、取消 | 保持既有明确选择和变更前退出语义 |
| G08 | 重复 init / 既有项目更新 | 不改原共享策略、不因残留网关设置失败 |
| G09 | `privacy status --json` | 顶层版本为 2，仅保留 shared；无 gateway/null 替身 |
| G10 | 旧目录含损坏 JSON、错误权限或异常记录 | status 不读取该目录、不被其影响；共享错误仍正确报告 |
| G11 | 假旧端口正在监听 | status 不对其发送健康探测或 Token；不影响其他应用 |
| G12 | clean build | 无网关 Worker/类型产物，任务执行 Worker 等仍正常生成 |
| G13 | bundle 和 source map 检查 | 无打包入 CLI/index 的网关实现与源码内容 |
| G14 | 实际 npm tarball 与干净安装 | 包内容、安装后 CLI 的退役行为与源码一致 |
| G15 | 旧网关实例升级场景 | 文档说明不会自动停止；未进行盲目杀进程 |
| G16 | 旧用户配置与客户端文件 | 没有自动删除旧目录，没有猜测/改写 provider 或登录 |
| G17 | scan / preview 公共回归 | 检测、元数据、退出码、失败不出副本、不覆盖源文件均保留 |
| G18 | 共享开/关、历史排除和旧 manifest | 不降级、不丢历史，基础保护继续生效 |
| G19 | Context Pack、任务、团队同步、恢复 | 既有回归通过；不因网关删除调整任务治理语义 |
| G20 | README、网站、指南、CLI 索引和链接 | 当前文档不再教启用网关；历史与迁移提及明确标注 |
| G21 | 规则来源、许可与依赖 | 仍使用的来源说明/许可进入包；无误删通用依赖 |
| G22 | 本地已有修改与最终 diff | 原有无关修改保留，提交仅包含批准范围 |

### 2.11 建议验证顺序

先确认测试路径与固定提交一致，再运行定向回归。以下包含拟新增的退役测试，须实现后再执行：

```sh
npm exec -- vitest run \
  tests/init-privacy.test.ts \
  tests/cli-v3-surface-contracts.test.ts \
  tests/privacy-command.test.ts \
  tests/website-docs.test.ts \
  tests/privacy-gateway-retirement.test.ts

npm run check
```

另外运行仓库内实际存在的 init-onboarding、V3 init、privacy-detect、privacy-contracts、shared policy、团队 transport 和事务恢复相关回归，覆盖 G17～G19。

当前 `npm run check` 会依次执行 lint、typecheck、build、dist 测试、依赖 audit 和覆盖率测试。[^R24] 某一步因网络、权限或环境限制没有执行完，应标记“未完成/环境受限”，不能改口为全仓通过。不得为本次删除顺便降低覆盖率阈值、移除安全检查或改写无关测试。

定向回归与全量检查之后再做 2.7 的实际打包/干净安装验收。阶段 A 达标即可单独提交或发布；阶段 B 未完成不影响网关退役。

---

## 3. 阶段 B：Secrets V1 的目标与边界

### 3.1 要实现的事情

保存邮箱、电话、姓名、地址、账号、密码、API Key 和有长度上限的普通文本。所有这些在存储层统一作为秘密字符串处理；类型只帮助输入校验和字段绑定，不意味着已经支持相应业务。

Agent 能查到本项目被允许使用的别名、用途、执行模板和输入要求。执行时，mancode 校验请求后，在自己的进程内解密，通过管道交给已确认程序；默认不向 Agent 返回秘密，也不返回原始程序日志。

模块本身不配置模型供应商，不需要额外购买或输入一个“大模型 API Key”。真正要操作的业务系统如果需要凭据，用户仍须通过本地录入把该业务凭据加入保险箱。

### 3.2 不纳入第一版

Secrets 模块不做模型网络网关、不新增监听端口、HTTP 服务或常驻后台守护进程；这不要求删除仓库其他无关功能。不自动重写任意 Agent 的 shell、浏览器、MCP、文件读取或模型请求。

不开放明文 `get`、`reveal`、`decrypt`、`export`。不向任意 shell、任意工作区脚本、环境变量、命令参数或临时明文配置文件自动注入秘密。不恢复已有不可逆脱敏副本。

不承诺保护已经出现在聊天、工作区源文件、浏览器页面、历史记录或其他工具返回中的信息。不提供文件批量自动识别及可逆替换，避免把主动秘密管理与现有扫描混为一谈。需要 Agent 直接查看、分析或解释真实内容的任务，不属于“不给 Agent 真值”的这一工作流。

### 3.3 明确的信任假设

V1 信任本机系统、安装的 mancode、系统凭据服务、已批准执行器及其依赖。V1 不把拥有同账号任意执行、修改安装文件或调试进程能力的 Agent 当成已经隔离的主体。

这意味着：**V1 是防误泄露的实用功能，不是同权限恶意代码的安全沙箱。** 要改变这个结论，必须先改变运行权限，而不是再加一层字符串替换。[^R5][^R7]

已有扫描器和 Secrets 不互相替代：把一个自定义值放进保险箱，不代表扫描器从此能在所有文本中识别这个值。scan/preview 不为匹配新秘密而解锁保险箱，也不对不经过本工具的数据提供自动保护。

---

## 4. 用户与 Agent 的完整使用流程

### 4.1 用户录入秘密

用户在不受 Agent 控制、不被它代输的独立本地终端运行：

```sh
mancode secret set contact-email
```

交互界面示例：

```text
名称：contact-email
类型：email
真实内容：[隐藏输入]
用途：通知收件人

已加密保存。尚未授权任何执行模板使用。
```

真实值不接受 `--value` 参数，不出现在提示信息、命令历史或确认回显中。V1 不提供“把明文写进 printf 再管道传入”的教程。隐藏输入只减少屏幕回显；不能防键盘记录、恶意终端或已被控制的系统。

初次保存会创建主密钥并写入系统凭据存储。凭据存储不可用或用户拒绝授权时，操作失败，不降级成旁边放一个明文 `master.key`。

### 4.2 用户确认一个执行模板

模板就是一张“允许哪个程序、拿哪几个秘密、做哪类操作”的配置单。

例如用户已有一个发送通知的脚本。它接受 JSON stdin，而不是在命令参数里接受邮箱和 token。用户确认其代码、依赖、目的地址及副作用后登记：

```sh
mancode secret action approve --file send-notice.action.json
```

确认界面必须展示程序身份与版本、使用的秘密别名、许可字段、目标系统、输出方式和权限边界；不展示秘密值。模板从未授权状态开始，Agent 生成的模板只是候选，不能自动批准。

登记时读取候选执行器包、形成独立版本快照或固定安装引用，并绑定工作区身份和秘密 revision。不要登记一个仍在 Agent 工作目录中、随时可被覆盖的 `send.py` 路径就当它可信。

### 4.3 Agent 查询目录

```sh
mancode secret list --json
```

示意输出：

```json
{
  "schemaVersion": 1,
  "securityMode": "exposure-reduction",
  "items": [
    {
      "name": "contact-email",
      "type": "email",
      "description": "通知收件人",
      "actions": ["send-notice"]
    }
  ]
}
```

只列出当前项目可用项目。不输出值、密文、密钥位置、值摘要、邮箱域名或手机号尾号。别名与用途本身也可能泄露信息，因此应使用中性名称，不在名称中写真实身份。

### 4.4 Agent 提交引用，不提交秘密

Agent 写入一个只包含普通业务参数和引用的 `request.json`：

```json
{
  "recipient": { "$secret": "contact-email" },
  "subject": "测试通知",
  "body": "这是一条测试消息。"
}
```

然后调用：

```sh
mancode secret run send-notice --input request.json --json
```

人类界面可以采用“secret 协议名称、冒号、双斜线、别名”的显示形式；机器输入统一使用结构化对象。V1 不对任意命令字符串进行这种显示形式的全文搜索替换。

### 4.5 mancode 校验和执行

```text
读取一次输入并保留快照
        ↓
校验模板版本、项目范围、字段和引用
        ↓
检查执行器版本、依赖及运行配置
        ↓
从凭据存储获取主密钥，解密本次需要的记录
        ↓
通过内部 JSON stdin 给已确认程序
        ↓
程序执行；mancode 不转发原始输出
        ↓
生成固定状态回执，释放资源，退出
```

业务程序收到的是实际邮箱和它被授权接收的凭据。Agent 知道“执行了通知动作”，不需要知道秘密值，也不需要隐藏执行程序的名称。

### 4.6 默认返回什么

```json
{
  "schemaVersion": 1,
  "runId": "由mancode生成的随机标识",
  "action": "send-notice",
  "status": "executor_succeeded"
}
```

`executor_succeeded` 只表示执行器按协议成功退出，不自动等于“邮件已送达”。失败、超时或取消后，外部操作是否已经发生可能未知；不能自动重试造成重复发信或重复提交。

需要业务结果时，后续可增加逐模板审查的最小结果协议，但不能把任意文本或“随便几个 JSON 字段”当成不会泄密。

### 4.7 找不到模板时怎么办

返回 `ACTION_NOT_APPROVED` 或 `CAPABILITY_UNAVAILABLE`，说明缺少已确认程序。Agent 可以准备不含真值的候选脚本供用户审查，但不能让新脚本自动获得秘密。接入者把已有程序适配成 JSON stdin 接口并确认一次，后续同版本同范围的调用才复用授权。

某个网站必须依靠 Agent 能读取的浏览器页面展示手机号时，这个场景可能本来就不满足“Agent 不看真值”的目标；不能以万能表单支持作为 V1 发布承诺。

---

## 5. CLI 契约

| 命令 | 角色与行为 | 约束 |
|---|---|---|
| `secret set <name>` | 人类新增或更新 | 隐藏输入；更新产生新 revision，使旧授权失效 |
| `secret list --json` | 查询当前项目可用目录 | 仅最少元数据；不为查询解密全部值 |
| `secret run <action> --input <file> --json` | 执行已授权动作 | 不接受任意尾随命令，不提供 `--shell`、`--env`、`--raw-output` |
| `secret remove <name>` | 人类删除本地记录 | 同时撤销本地绑定；不等于远端 API Key 已作废 |
| `secret action approve --file <spec>` | 人类确认模板 | 明确确认版本、秘密和项目绑定；不能静默批准 |
| `secret action list --json` | 查询可用模板及输入要求 | 不返回原始敏感配置 |
| `secret action remove <name>` | 人类撤销模板 | 新调用立即拒绝；已发生的外部操作不可撤销 |

前四个是日常命令，后三个属于接入与管理。

错误输出使用固定代码，例如 `KEYSTORE_UNAVAILABLE`、`SECRET_UNAVAILABLE`、`ACTION_NOT_APPROVED`、`ACTION_CHANGED`、`INPUT_INVALID`、`EXECUTOR_FAILED`、`EXECUTOR_TIMEOUT`、`CANCELLED`、`CAPABILITY_UNAVAILABLE`、`OUTPUT_LIMIT`。不能把底层异常对象直接序列化到 stdout/stderr。

建议 CLI 退出码：0 表示执行器按协议成功；2 表示校验或授权未通过；3 表示执行失败；4 表示超时或取消且结果需复核；5 表示平台能力不可用。原始子进程退出码不原样传出。

TTY、环境变量和“人类侧命令”划分是产品交互约定，不是同权限恶意程序无法越过的认证边界。强授权需要系统级受保护身份与可信界面，V1 不假装已经具备。

撤销或更新只阻止授权检查发生在其提交之后的新调用；已经解密并启动的程序不可能被“收回数据”。V1 不自动回滚其外部操作。管理界面应说明需要暂停相关调用再做敏感轮换；运行过程中的版本快照和锁提交顺序必须测试。

---

## 6. 执行模板：解决“mancode 不会那么多事”

### 6.1 mancode 只负责传递和约束

发邮件、访问数据库、调用业务 API 的逻辑留在现有外部程序或很薄的适配脚本中。mancode 只负责模板登记、引用解析、授权校验、运行和回执。

每种不兼容输入方式可能需要一层适配。只接受秘密命令参数的旧程序，V1 不直接支持；不得为了“通用”静默改走 argv、env 或明文文件。

### 6.2 模板至少包含的字段

| 字段 | 用途 |
|---|---|
| 模板 ID 与 revision | 确定本次使用的是哪个获准版本 |
| 工作区绑定 | 限定允许在哪个项目使用 |
| 执行器身份 | 绝对安装位置、固定参数、版本／摘要 |
| 依赖与资源清单 | 固定解释器、脚本、依赖和影响执行的配置 |
| 输入 schema | 限定可变字段、类型、大小和额外字段规则 |
| 秘密槽位绑定 | 如 recipient 只能绑定 contact-email；认证值由模板固定选择 |
| 固定目的系统与副作用 | 用户批准发送到哪里、执行何种动作 |
| 返回策略 | V1 固定为 status-only |
| 超时与输出预算 | 拒绝无界运行和无界读取 |

Agent 不得通过输入替换 executable、脚本路径、插件路径、回调 URL、代理地址或任意 shell 参数。业务程序也不能把 stdin 的字符串再解释为代码。

### 6.3 “锁定脚本哈希”还不够

脚本可能从工作区导入其他文件，解释器可能加载用户配置，依赖或插件也可能改变行为。版本校验应覆盖实际执行所需的受信内容，并在运行前检查。先检查一个工作区路径，再从同一路径执行，仍可能存在检查与使用之间的竞态。

V1 应使用独立安装、固定依赖的执行器包，避免从 Agent 可写工作区加载代码。快照与摘要用于识别变更，不是凭空产生的权限隔离：同账号 Agent 若能修改安装目录、校验器或主程序，仍可绕过。

### 6.4 哪些是真正执行的限制

| 控制项 | V1 如何处理 | 不得扩大宣传为 |
|---|---|---|
| 只调用获准模板 | mancode 在运行前校验 | 任意宿主命令都被拦截 |
| 固定 argv、stdin 输入 | mancode 构造子进程调用 | 接收程序无法泄露 stdin |
| 只输出固定回执 | mancode 不转发子进程输出 | 程序不能写其他文件或访问网络 |
| 程序、依赖版本校验 | 运行前校验受信安装 | 同账号恶意进程无法篡改 |
| 固定业务目标 | 模板与受信执行器实现契约 | 写一个 allowedHosts 字段就有了操作系统网络防火墙 |
| 私有文件权限 | 限制其他用户的常规访问 | 同用户 Agent 无法读取 |

网络地址、文件去向和业务副作用，在没有系统级隔离时依赖受信程序正确实现。确实需要“即使程序恶意也只能访问某地址”的保证时，必须实现并验证网络强制约束；不能只把愿望写进 JSON。

### 6.5 外部程序的最小接入协议

统一使用 `json-stdin-v1`：程序从 stdin 读取一次有上限的 UTF-8 JSON，不自行查询整个保险箱。mancode 分离三个命名空间：`data` 放已校验业务参数，`credentials` 放模板固定绑定的凭据，`fixed` 放用户确认的目标和动作配置。Agent 不能用同名输入字段覆盖后两者。

该协议是拟新增约定；并不要求所有已有 CLI 本来就支持它。不兼容时由接入者写一层小适配器，且这个适配器及其调用链一起属于被确认的代码。

接收程序应在可控范围内不写敏感日志、不生成含真值的工作区文件、不把秘密再转成子进程 argv/env，并限制业务数据流向。只接受明文参数的旧工具不纳入 V1；不能套一层适配器后又在内部把秘密拼回命令行。

HTTP 类执行器必须审查目标地址、认证头、重定向、代理、错误回显和返回内容，防止把凭据随重定向发送到另一个目标。模板写了地址约束不等于系统已经强制实施网络隔离；没有网络沙箱时依赖受信执行器兑现契约。

模板默认仅返回状态。程序退出 0 表示按该协议完成，非零或终止映射到固定失败回执；不允许把任意业务文本放在异常或退出码中透传给 Agent。

### 6.6 批准记录不能是可随便改的普通配置

已批准记录必须绑定模板 ID、模板 revision、执行器/依赖摘要、工作区身份、秘密 entryId/revision、输入字段和输出策略，并对批准内容做完整性认证。可用与主密钥分用途管理的认证密钥，对规范化记录做 MAC；或将批准记录作为独立认证加密记录保存。实现时选定一种并形成唯一格式，不同时维护两份授权真相。

展示目录可重建、可缓存，但不能决定权限。运行时重新校验经过认证的批准记录，不能因为 `registry.json` 写着 `approved: true` 就放行。这个机制检测配置变化，并不能抵御能够取到同一密钥或修改 mancode 本身的同权限恶意程序；完整性认证也不能单独防旧授权快照回滚。

---

## 7. 引用与输入解析规则

秘密引用必须是一个完整对象，且只有一个 `$secret` 键。名称格式和长度固定；未知引用、未获授权的引用、额外字段、嵌套异常、非法 UTF-8 和重复 JSON 键都拒绝。

只在模板明确允许的路径解析秘密。例如模板允许 `recipient` 使用联系邮箱，不允许在 `subject`、目标 URL 或输出文件名中放入同一引用。引用不能用来替换可执行文件、命令参数或代码片段。

模板可以把认证秘密直接绑定到内部凭据槽位，不要求 Agent 每次填写它。输入解析完成后，在同一份已校验快照上解析引用，不再次打开可被并发修改的输入文件。

V1 使用结构化 JSON 序列化，不拼接字符串模板，不递归解码多层引用，不将秘密当作 shell、SQL 或模板代码。不同业务协议的安全编码由受信执行器完成。[^R8]

建议初始限额：单个秘密 16 KiB，单份未解析输入 64 KiB，解析后输入 256 KiB，嵌套深度 16，每次最多 16 个秘密引用。它们是可调整的工程起点，不是密码学安全阈值。

名称建议限定为小写字母开头、后接字母/数字/短横线、最长 64 字符；这是首版交互约定，不是密码学边界。严格 JSON 解析必须显式拒绝重复键：不能先 `JSON.parse` 再认为重复键已经被检测。拒绝非普通输入文件、异常链接、未知字段和路径穿越；具体文件安全检查遵循仓库平台兼容约定。

---

## 8. 存储与主密钥

### 8.1 数据位置

下列是逻辑布局，具体根目录按操作系统用户数据规范落地；不得放进项目 Git 目录或团队共享 Context Pack。

```text
用户私有 mancode 数据目录/secrets/
├── vault.json           # 分记录密文及非秘密的加密格式信息
├── registry.json        # 最小别名目录；不是授权真相来源
├── actions/             # 已确认模板与固定执行器引用
└── audit.jsonl          # 有界、最少信息的事件记录

系统凭据存储
└── mancode 主密钥       # 不与 vault 明文并排存放

项目目录
└── request.json         # 只有引用和普通业务输入
```

registry 可被读取或篡改时，不应因此获得授权；实际执行需要核对经过认证的秘密记录和模板绑定。不可在 registry 中保存值哈希供匹配，电话号码等低熵数据可能被枚举。

### 8.2 加密结构

建议使用 Node 标准库的认证加密接口，采用 AES-256-GCM。主密钥为密码学随机生成的 32 字节值；每次加密生成新的 12 字节 nonce，使用 16 字节认证 tag。确保同一密钥下不复用 nonce，不将“脱敏后的字符串”当作密文。[^R6][^R9]

每条记录的机密内容包括真实值、类型、别名及授权 revision。附加认证数据绑定 schemaVersion、vaultId、entryId 和 keyId，避免把一个位置的密文偷换到另一个位置。认证失败立即停止，不返回部分明文；必须等待完整认证通过，才向执行器交付解密结果。认证加密本身不能识别一份旧但仍有效的密文快照，V1 不宣称能够抵御恶意回滚；该能力需要额外的受保护版本记录。

只解密本次获准使用的记录。新增和更新采用有界读取、并发锁、写临时密文文件、刷新后原子提交的方式；不能先落地明文临时文件再加密。

目录与文件采用平台原生的私有权限；POSIX 可使用目录 0700、文件 0600，Windows 需要相应 ACL。不能把 chmod 当作跨平台和同账号 Agent 的完整防线。

### 8.3 系统凭据存储策略

主密钥通过 KeyProvider 接口管理。首个发布目标建议先验证 macOS Keychain；其他平台只有在各自安全后端和验收通过后才启用自动使用，不通过时明确返回能力不可用。

不得为了方便自动调用，把通用解释器的所有脚本无条件视为可信。主密钥也不能经由带明文参数的系统命令录入。Keychain 能减少自行保管密钥的风险，但不是默认拥有“Agent 无法访问”的性质。[^R4]

如果凭据服务锁定、不存在或要求人工授权，Agent 侧返回明确状态，用户在独立可信界面处理；不能要求用户把解锁口令发进聊天。

### 8.4 备份、更新与删除

V1 不提供明文备份。应告知用户：只有 vault 密文但失去系统主密钥，通常无法恢复；可以重新录入。跨设备加密导出需要单独设计恢复密钥与验证，不在首版偷偷实现。

`set` 更新秘密后，关联模板授权失效，重新确认；不能认为新值与旧值有相同用途。`remove` 只删除当前本地记录与授权，不能保证清除文件系统快照或旧备份，也不能使远端 API Key 自动失效。凭据泄露后，应到实际服务端撤销并换新。[^R5]

`registry.json` 是从已认证记录生成的展示缓存。缓存损坏时不扩权、不据此解密未知记录；允许在受控管理操作中重建。批准记录与秘密更新要么通过同一原子事务提交，要么以 revision 校验确保半更新只会拒绝，不会错误授权。audit 文件只记录随机 runId、已校验模板 ID、固定事件码和粗粒度时间，设定大小/轮转上限，不保存请求、密文、真实值、值摘要或底层异常。审计不是防篡改取证系统。

---

## 9. 执行、输出与生命周期

### 9.1 子进程启动

采用明确的绝对 executable 路径和固定参数数组，`shell: false`，秘密经受控 pipe 写入 stdin。不要 `exec(拼接字符串)`，也不要从 Agent 的命令文本中拼出包含秘密的命令。[^R3]

执行器获得最小环境，不继承无关凭据、调试开关或会改变代码加载行为的配置。固定工作目录，不使用 Agent 工作区作为依赖搜索来源。不继承额外文件描述符，不向执行器提供读取整个保险箱的通用接口。

但这些措施仍以 mancode 进程本身没有被同权限恶意代码劫持为前提；JavaScript 启动后的检查无法逆转此前已经发生的运行时注入。

### 9.2 输出默认关闭转发

子进程 stdout、stderr 不使用 `inherit`。V1 不向 Agent 逐块转发；可以接管并有界丢弃，达到预算时终止。建议合并输出预算先取 256 KiB，避免无界内存增长。

回执由 mancode 自己生成，只包含自身 runId、已验证模板 ID、固定状态和固定错误代码，不包含原始 stdout、stderr、异常消息、任意路径或子进程提供的自由文本。

精确匹配脱敏可以用于内部测试和后续有限显示，但不能作为防御恶意泄露的主机制。编码、拆分、哈希、时间、退出状态及其他通道，都说明“过滤器没发现”不等于不存在泄露。

### 9.3 其他泄露通道必须列入模板审查

程序写入工作区的明文文件，会被 Agent 以后直接读取。程序访问允许网站后，该网站也可能回显邮箱或电话，再被浏览器、截图、其他 API 或 MCP 工具读回。即使本次 stdout 没有明文，也不能宣称整个 Agent 世界看不到它。

因此模板应尽量不生成 Agent 可读的含秘密文件，不写敏感调试日志；业务目标必须是用户有意披露信息的地方。远端收到手机号是完成填写动作的必要披露，不是“所有人都看不到手机号”。

### 9.4 退出与取消

执行完成、失败、超时和用户取消，都关闭管道，释放密钥句柄，清理可控 Buffer。不要声称 GC、系统交换区、崩溃转储和依赖字符串副本都可可靠擦除。[^R5]

必须测试子进程及其派生进程的取消行为；POSIX 进程组与 Windows 进程树控制需要分别实现。平台不具备模板要求的控制能力时拒绝运行，不降级成不受控执行。V1 不接受主动后台化／脱离生命周期的执行器。模板必须声明有限超时；初始建议默认 60 秒、需确认才能提高到最多 300 秒，超过该范围的长任务留待单独生命周期设计。具体限额可根据首个真实业务验证调整。

对于可能产生外部副作用的任务，超时不代表“没有执行”。不自动重试；仅在模板明确支持幂等协议并有证据时才允许安全重试。

### 9.5 安全失败不得误触发重复操作

stdin 写入错误、子进程启动失败、输出超限、退出异常和超时都返回固定原因。不把网络失败或 `EXECUTOR_FAILED` 解释为“目标系统一定没有收到数据”。默认不自动重试；需要重试的模板必须单独声明并实现幂等方式。管理记录只保存必要 runId，不为了恢复任务保存明文输入。

---

## 10. Agent 接入方式

复用项目现有 adapter 的 instructions/bootstrap，加入简短的使用说明即可；不依赖修改模型供应商配置或 API 请求协议。[^R1]

建议注入文字：

```text
本项目的受保护数据由 mancode 管理。
使用 mancode secret list --json 查询当前可用别名。
需要真实数据时，只调用已授权的 mancode secret run 执行模板。
输入使用 schema 指定的单键引用对象，键名为美元符号紧接 secret，值为别名（格式见第 4.4 节 JSON 示例）。
不要让用户把真实值输入聊天，不要自行解密或创建明文文件。
缺少秘密或模板时，报告需要用户在独立本地终端完成配置。
```

这只是模型行为指引，不是权限机制。

只有能在相同机器、相同可见环境中执行本地 CLI 的 Agent 才能直接复用该接口。云端 Agent、受限 IDE 或不能访问本地 CLI 的工具不能自动支持。兼容“同一条调用命令”也不等于兼容“所有宿主的安全隔离机制”。

不承诺自动处理 Agent 直接运行的 curl、Python、浏览器或其他工具。用户已经把真值放在工作区或对话里时，这套功能不会追溯消除它。

静态 bootstrap 只保存用法，不把本人的秘密目录、值、密文或密钥位置写进共享说明。运行时目录根据当前项目动态查询。普通 `privacy scan/preview/status` 和任务命令不依赖 KeyProvider；缺少系统密钥后端不得导致整个 mancode 不可用。

---

## 11. Secrets 的仓库接入与最小模块划分

阶段 A 完成后再注册独立 `secret` 命令；不得通过 import 旧 gateway 模块复用它的服务、上游配置或运行状态。

```text
src/commands/secret.ts          # CLI 注册、交互入口与安全错误输出
src/secrets/vault.ts            # 密文、revision、并发锁与原子提交
src/secrets/key-provider.ts     # 系统凭据存储抽象及可用性检测
src/secrets/actions.ts          # 模板登记、批准、绑定和校验
src/secrets/resolve.ts          # 结构化引用与输入校验
src/secrets/run.ts              # 受控运行、管道、取消与固定回执
src/secrets/types.ts            # 格式、状态与错误协议
```

这是建议责任划分，不要求机械拆成这些文件。可复用经过确认的通用锁、错误协议或文件读写工具，但不得为了复用而重新带入旧网关整条依赖，也不得改动团队事务语义。

| 接入点 | 拟修改内容 |
|---|---|
| `src/cli.ts` | 注册独立 secret 命令，不恢复旧网关 flag |
| 原 adapter/bootstrap 生成源 | 增加第 10 节的最小指引，不承诺全局拦截 |
| `package.json` / 锁文件 | 仅添加实际选用并审查过的密钥后端依赖；来源许可和离线指南入包 |
| 系统平台适配 | 首先验证 macOS 后端；未验证平台只让 Secrets 报能力不可用，普通 CLI 继续可用 |
| 新文档 | `docs/secrets-guide.md` 与 `docs/secrets-security.md`，分别描述操作和边界 |
| 新测试 | Secrets 存储、批准、解析、生命周期、命令输出及宿主接入契约 |

需要记录实际选择的 KeyProvider、版本及平台测试证据。本文没有预先指定一个未经审查的第三方 keyring 包，也不允许实现者以明文文件兜底。采用不同平台后端属于实现选择；**不改变本方案的失败关闭要求**。

无需为 V1 建立网络服务、MCP server、插件市场、通用工作流平台或企业 Vault。先接入一个合成测试执行器，再接入一个真实且已审查的业务程序。

---

## 12. Secrets 验收与反例测试清单（S01～S28）

**以下全部是待实现、待运行的验收项，不是已经通过的测试。** 测试只能使用合成秘密和受控本地目标，禁止拿真实客户信息或生产凭据测试泄露。

| ID | 场景 | 预期结果 |
|---|---|---|
| S01 | 录入邮箱、手机号、API Key、Unicode 与换行文本 | 支持规定类型和长度；不回显真值 |
| S02 | 检查 vault、项目文件、日志、CLI 输出与错误 | mancode 管理的这些位置不出现秘密明文 |
| S03 | 系统凭据服务不可用、锁定、用户拒绝授权 | 安全失败；不写明文主密钥，不改走 env |
| S04 | 修改密文、tag、entryId 或认证 metadata | 校验失败，不返回部分明文 |
| S05 | 重复更新同一秘密 | 使用新的 nonce；revision 更新；旧授权失效 |
| S06 | 并发新增／删除、异常断电或写入失败 | 不产生半份可用保险箱；恢复规则明确 |
| S07 | list 请求或失败信息 | 不包含值、值摘要、真实路径、手机号尾号或邮箱域名 |
| S08 | 不存在、跨项目或未授权秘密引用 | 拒绝；不额外泄露全局秘密目录 |
| S09 | 将秘密引用放入目标 URL、代码、未知字段 | 输入校验拒绝 |
| S10 | 重复 JSON 键、非法 UTF-8、超限或过深输入 | 在解密前拒绝 |
| S11 | Agent 指定任意 python -c、sh -c 或额外参数 | 没有这类执行入口；请求被拒绝 |
| S12 | 修改脚本、依赖、解释器或模板 | 原批准失效，执行前拒绝 |
| S13 | 输入文件校验后被并发替换 | 执行只使用已读快照，不读取修改后内容 |
| S14 | 受控测试程序向 stdout/stderr 回显秘密 | Agent 只看到固定回执，不看到原始输出 |
| S15 | 回显分块、换行、Base64 等变形数据 | 原始输出仍不转发，不依赖字符串正则才拦住 |
| S16 | 程序输出过量、挂起、取消或派生子进程 | 有界处理；清理受支持的受管子进程及进程组；平台不足则拒绝 |
| S17 | 程序失败消息包含秘密、路径和请求内容 | 只有固定错误码，不原样打印异常 |
| S18 | 运行后检查 argv、继承环境与临时文件 | mancode 没有通过这些渠道注入明文 |
| S19 | 受控反例：程序把秘密写文件或发向测试服务 | 用来证明 V1 不是强隔离；不能把 stdout 安全误报为整体安全 |
| S20 | 受控反例：同账号修改器或直接访问凭据服务 | 不承诺统一阻断；记录结果与信任假设，不能宣称防恶意 Agent |
| S21 | 外部操作发生后本地超时 | 回执标注未知状态，不自动重复操作 |
| S22 | API 返回／网页显示手机号后 Agent 再读取 | 记录为目标系统回读边界，不宣称透明全局脱敏 |
| S23 | 没有调用 secret run，而直接使用 Agent 工具 | 不声称被本功能覆盖 |
| S24 | Secrets 完成后重跑 G01～G22 | 没有把网关依赖重新带回来；不破坏共享扫描 |
| S25 | 两个本地 Agent 调用相同合成动作 | 验证显式 CLI 复用；不据此宣布所有 Agent 均兼容 |
| S26 | 修改展示 registry、未认证模板或回滚旧批准记录 | registry 不能扩权；未认证记录拒绝；旧合法快照回滚属于已声明边界，不误称完全防住 |
| S27 | KeyProvider 缺失时运行普通 CLI、scan/preview/status | 原有命令继续工作，不触发解锁或读取秘密 |
| S28 | 秘密更新/删除与调用同时发生 | 授权快照、revision 与提交顺序一致；更新后新调用拒绝旧授权，已执行副作用不被假称撤销 |

S19、S20、S22 是用于验证边界的反例，不是本版可以声称已修复的漏洞。如果产品要求这些场景也必须被阻止，V1 的当前架构就不能满足，需要先实施更强隔离再发布对应承诺。

---

## 13. 实施顺序、交付物与发布门禁

### 13.1 四个独立提交单元

| 单元 | 范围 | 完成标准 |
|---|---|---|
| A：网关退役 | 第 2 节删除、迁移、文档和包检查 | G01～G22 有证据；既有 Privacy 和工作流回归通过；可独立发布 |
| B：保险箱 | set/list/remove、KeyProvider、认证加密、原子提交 | 存储与失败路径完成；没有通用 exec、没有明文读取接口 |
| C：受控执行 | 模板批准、结构化输入、stdin、固定回执、生命周期 | 一个合成执行器和一个已审查业务程序验证；关键反例有记录 |
| D：Agent 与交付 | 最小指引、真实宿主验证、用户文档、打包 | 至少两个实际本地宿主有记录，S01～S28 与 G 回归完整标记 |

A 只解决退役，不以“还没开发替代功能”为由继续保留网关。B～D 在 A 之后实施；即使放在同一个开发分支，也应避免把全部变更压成不可区分的一次提交。

本次要求“给方案”不代表授权直接提交、发布 npm 包、删除用户配置、运行生产凭据或修改远端仓库。实际执行仍按用户授权范围推进。

### 13.2 每个单元需要留下的证据

记录实际提交 SHA、改动文件、Node/系统版本、运行命令、退出码、测试报告和未覆盖环境；失败、跳过和边界反例分开标记。报告只使用合成数据，不带真实秘密、原始请求或客户资料。

用例状态建议统一为：`未执行`、`通过`、`失败`、`环境受限`、`已确认边界`。后者只用于明确不保证的反例，不能用来掩盖必需能力未实现。旧历史验收不得充当本次证据。

### 13.3 发布前阻断条件

出现下列情况，不发布相应能力：网关实现仍能从新包启动；共享兼容被破坏；主密钥有明文文件兜底；未经确认的任意脚本可拿到秘密；原始输出/异常仍会转发；没有覆盖密文篡改和生命周期失败测试；平台能力不足却标成支持；文案仍声称“所有 Agent 都绝对读不到”。

阶段 A 可在独立通过后先发布退役；阶段 B～D 不通过时不发布 Secrets，不自动重新启用网关。

### 13.4 回退原则

开发中通过最小补丁修复或回退本次代码变更，不覆盖用户原有修改，不降级共享权威格式。已删除的旧用户目录不可能靠代码回退自动恢复；因此新版本本就不自动删除它们。

如有兼容问题，不能静默恢复旧网关功能或自动改客户端路由。用户是否临时保留旧安装属于显式选择，需清楚告知旧功能仍在、旧进程可能仍运行；不得声称整个机器已经“彻底清除所有历史网关”。

---

## 14. 对外承诺、优劣与后续强隔离

### 14.1 可对用户说什么

建议定位：

> 本地加密保存敏感信息，通过已批准执行模板使用，减少秘密进入 Agent 提示词、命令参数和工具输出的机会。

应同时明确：

> 实际执行程序和目标系统可能接触明文；本功能不是同账号任意代码的隔离沙箱，也不保护绕过本入口的其他工具数据流。

### 14.2 这版的优劣

| 方面 | 优势 | 代价／限制 |
|---|---|---|
| 运行方式 | 按调用启动并退出，无模型网关 | 长任务期间进程仍需存活；不是“瞬间完成” |
| Agent 接入 | 能调用本地 CLI 的宿主复用一个协议 | 不能访问本地 CLI 的 Agent 不直接支持 |
| 业务覆盖 | 复用已有脚本和工具，无需 mancode 包办业务 | 不兼容输入方式的程序需要适配与审查 |
| 数据保护 | 不把真值放进普通输入文件、argv 或默认回执 | 执行器拿到真值；V1 依赖它可信 |
| 实施范围 | 比逐一实现所有业务窄 | 系统密钥、执行生命周期、模板管理仍需认真实现 |
| 调试体验 | 原始敏感日志不进入 Agent 上下文 | 默认只有状态，排错信息比通用 exec 少 |

### 14.3 什么时候必须升级为强隔离

如果要求“即使 Agent 被提示注入诱导，也不能获取秘密”，就需要系统级边界：Agent 无权读取保险箱密钥、无权修改 mancode 与执行器、无权调试相关进程；处理明文的程序在受信侧，Agent 只能提交受限动作。

同时控制网络和文件出口，限制目标地址、读取路径、输出结果及侧效应。不能只隔离文件而放开网络，也不能让 Agent 获得一个可随意执行宿主命令的“逃逸口”。宿主只给 Bash 加 sandbox，并不自动约束它的所有其他读取工具。[^R7]

这种结构可以避免模型 HTTP 网关，但仍要设计真实的受保护调用通道、系统身份与平台适配。不能声称“把程序换成 Python”或“放进容器”就完成了。它应是一个单独的安全版本，而不是 V1 的隐藏前提。

**最终选型：③秘密引用作为表示方式 + ②已确认程序执行作为 V1 使用方式；①专用代办能力不是首版必需。不能把③当成独立的安全等级。**

### 14.4 网关退役发布说明建议稿

> 本版本移除本地模型代理网关及其初始化选项，不再转发、修改或还原模型请求/响应。原有文本扫描、不可逆副本预览和共享内容保护继续保留。`privacy status --json` 顶层输出升级为版本 2，移除 `gateway` 字段；项目共享数据不因此迁移。升级不会自动停止旧网关进程，也不会改写客户端 provider 或删除用户旧配置，请按退役指南完成退出。

Secrets 只有在 B～D 完成并验收后，才出现在“本版本新增”说明中；阶段 A 单独发布时只写“另行提供”，不虚报已支持。

---

## 15. 最终设计自审

本节记录的是方案内部一致性复核，不是代码安全认证或已经通过的测试报告。

| 自审问题 | 本方案的处理 |
|---|---|
| 对方方案要求独立退役，是否被新功能拖住？ | A 可独立提交发布；B～D 完整设计另列但不成为退役前置依赖 |
| 删除清单是否连带误删共享保护？ | 明确保留模块、flags、历史语义，并设置 G17～G19 |
| 是否漏掉构建和 npm 包里的旧代码？ | 源码、构建、bundle/map、tarball/安装四层检查 |
| 是否一边说删命令，一边依赖新 CLI 停旧网关？ | 迁移优先在升级前用旧版本/原终端停止；新版本不保留控制接口 |
| 是否把输出版本升级误当项目数据迁移？ | `privacy status` 顶层 1→2 与共享 schema 分开 |
| 是否把删网关误说成删掉全部 Maskit 派生规则？ | 明确保留公共扫描器来源和许可 |
| 是否确认了用户本地已有修改？ | 未确认；实施前检查工作区/暂存区，不将转述当成实测 |
| 是否给 Agent 暴露“解密输出”接口？ | 没有；仅固定模板执行和状态回执 |
| 是否让 mancode 包办所有业务？ | 没有；复用已审查的外部程序，明确接入成本 |
| 是否又把 stdin、Keychain、TTY 当成绝对隔离？ | 没有；列出信任假设、真实限制和边界反例 |
| 是否能靠修改普通 registry 就获得授权？ | 不允许；展示目录与认证批准记录分离 |
| 是否声称跨平台、全 Agent、全数据自动保护？ | 不声称；只发布已验证后端和显式 CLI 入口 |
| 是否把测试计划写成测试通过？ | 所有验收均待执行；来源中的历史结果不沿用 |

**最终交付口径：删除旧模型网关，保留已有隐私检查；新增按调用运行的秘密保险箱和受控执行入口。先减少不必要的明文暴露，不用“绝对安全”掩盖系统权限边界。**

## 16. 核对来源与版本说明

仓库来源为本次实际打开核对的公开 `main` 页面，不是不可变提交证明。实施前应把下列路径换成所记录 SHA 的固定链接。来源支持“当前入口是什么”和相关技术边界；本文的新增接口、结构、限额及阶段划分都是设计建议。

Node 子进程与加密接口另外核对了仓库声明的最低版本 22.5.0 文档，避免只依据更新版本 API 设计。具体依赖选择及实际支持的平台仍需实现验收。以下引用均为一手仓库或官方安全/运行时资料。

[^R1]: [mancode README：项目定位、工作流与平台接入](https://github.com/whitelonng/mancode)
[^R2]: [package.json：版本、Node 要求、依赖和 npm files](https://raw.githubusercontent.com/whitelonng/mancode/main/package.json)
[^R3]: [Node.js 22.5.0 Child process：spawn、stdio、shell 和生命周期](https://nodejs.org/download/release/v22.5.0/docs/api/child_process.html)
[^R4]: [Apple Keychain data protection：系统凭据存储的安全机制](https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web)
[^R5]: [OWASP Secrets Management：最小权限、驻留、审计和生命周期](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
[^R6]: [OWASP Cryptographic Storage：认证加密和密钥管理](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
[^R7]: [Claude Code sandboxing：系统隔离与工具权限的区别](https://code.claude.com/docs/en/sandboxing)
[^R8]: [OWASP OS Command Injection Defense：数据与命令分离](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
[^R9]: [Node.js 22.5.0 Crypto：认证加密、随机数和认证失败处理](https://nodejs.org/download/release/v22.5.0/docs/api/crypto.html)
[^R10]: [src/cli.ts：初始化 flags 和 CLI 注册](https://raw.githubusercontent.com/whitelonng/mancode/main/src/cli.ts)
[^R11]: [src/commands/privacy.ts：status 输出与网关命令注册](https://raw.githubusercontent.com/whitelonng/mancode/main/src/commands/privacy.ts)
[^R12]: [docs/privacy-guide.md：扫描、共享保护、旧网关边界](https://raw.githubusercontent.com/whitelonng/mancode/main/docs/privacy-guide.md)
[^R13]: [OWASP AI Agent Security：工具最小权限、敏感动作与对抗测试](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
[^R14]: [src/commands/init.ts：网关偏好写入与共享初始化](https://raw.githubusercontent.com/whitelonng/mancode/main/src/commands/init.ts)
[^R15]: [src/system/init-onboarding.ts：两个独立保护选项](https://raw.githubusercontent.com/whitelonng/mancode/main/src/system/init-onboarding.ts)
[^R16]: [src/commands/privacy-gateway.ts：启停、运行状态和配置片段](https://raw.githubusercontent.com/whitelonng/mancode/main/src/commands/privacy-gateway.ts)
[^R17]: [tsup.config.ts：网关与任务执行构建入口](https://raw.githubusercontent.com/whitelonng/mancode/main/tsup.config.ts)
[^R18]: [docs/privacy-rule-sources.md：公共扫描规则来源、许可与旧解析契约](https://raw.githubusercontent.com/whitelonng/mancode/main/docs/privacy-rule-sources.md)
[^R19]: [src/gateway/server.ts：环境凭据、HTTP 转发与内存历史](https://raw.githubusercontent.com/whitelonng/mancode/main/src/gateway/server.ts)
[^R20]: [src/gateway/config.ts：checkout 目录、config 和锁](https://raw.githubusercontent.com/whitelonng/mancode/main/src/gateway/config.ts)
[^R21]: [docs/privacy-implementation-plan.md：混合实施记录、历史验收与 fixtures 位置](https://raw.githubusercontent.com/whitelonng/mancode/main/docs/privacy-implementation-plan.md)
[^R22]: [tests/init-privacy.test.ts：共享与网关组合用例](https://raw.githubusercontent.com/whitelonng/mancode/main/tests/init-privacy.test.ts)
[^R23]: [scripts/privacy-gateway-spike.mjs：网关宿主与假上游探针](https://raw.githubusercontent.com/whitelonng/mancode/main/scripts/privacy-gateway-spike.mjs)
[^R24]: [scripts/project-checks.mjs：npm run check 的实际检查链](https://raw.githubusercontent.com/whitelonng/mancode/main/scripts/project-checks.mjs)
[^R25]: [tests/cli-v3-surface-contracts.test.ts：公开 CLI 契约](https://raw.githubusercontent.com/whitelonng/mancode/main/tests/cli-v3-surface-contracts.test.ts)
[^R26]: [tests/privacy-command.test.ts：命令输入输出回归](https://raw.githubusercontent.com/whitelonng/mancode/main/tests/privacy-command.test.ts)
[^R27]: [src/context/privacy-policy.ts：共享策略状态与校验](https://raw.githubusercontent.com/whitelonng/mancode/main/src/context/privacy-policy.ts)
[^R28]: [src/gateway/mapping.ts：原值与占位符的内存映射](https://raw.githubusercontent.com/whitelonng/mancode/main/src/gateway/mapping.ts)
[^R29]: [src/index.ts：当前仅导出 VERSION 的公共入口](https://raw.githubusercontent.com/whitelonng/mancode/main/src/index.ts)
[^R30]: [tests/website-docs.test.ts：站点与 CLI 索引契约](https://raw.githubusercontent.com/whitelonng/mancode/main/tests/website-docs.test.ts)
[^R31]: [npm pack：dry-run、ignore-scripts、JSON 与本地 tarball](https://docs.npmjs.com/cli/v11/commands/npm-pack/)

## 执行绑定

用户于 2026-09-18 明确授权按完整计划执行。基线 78d7e8ba64a236762da750e161b788a4cf1c813d。A、B、C、D 分阶段实现和验收；不发布软件、不使用真实凭据、不修改外部 provider。AC-G 对应 G01–G22，AC-S 对应 S01–S28；AC-H 对应真实 KeyProvider、两个本地宿主和经审查业务执行器，缺失证据明确未完成。已有网关初始化改动纳入 A，research 目录原样保留。架构目录不存在，以本计划及 docs/architecture.md、docs/engineering.md 为依据。
<!-- mancode:plan-baseline:end -->
<!-- mancode:delivery-record:start -->
Task: local:01M2ST28SJZ21FNV3R2J984MYK
Plan version: 3
Review: passed
Verification: passed

Reviewer declaration: independent
Direction: 按批准基线78d7e8b核对完整网关删除、CLI/init/status、构建与依赖、Secrets存储与执行、adapter和文档测试。原研究16文件已完整备份移出；README既有一行修改保留于独立stash及补丁。任务治理、团队与公共隐私生产模块未修改。
Correctness: 独立总审后定向复核：R-A1历史文档定位、R-A2能力计数、R-S1保留键、R-S2多余解密、R-S3 Unicode退格均修复。新增PTY回显时序、Mach-O install ID与rpath、子进程ready取消证据经复核，无未关闭阻断缺陷。真实Keychain锁定/人工拒绝未实测；组件错误注入覆盖失败关闭，真实缺失密钥测试零业务请求；不宣称该未实测环境已验证。
Proportionality: 删除独立网关，不改共享格式；V1限定macOS Keychain、固定Node包、认证批准、严格JSON、stdin、有限时间/输出与固定回执。复用锁和标准密码库，无网络网关、任意shell或明文兜底。文件/网络回读、同账号访问和旧合法快照回放明确列为边界。
Next: 提交D阶段接入与验收资料，检查公共完成门；不推送、不发布npm。其他操作系统/Node矩阵与真实Keychain锁定拒绝仍保留未实测标记。
- AC-G: met — G01-G22：独立A回归与完整项目check；retirement/init/privacy/共享及团队测试，真实tarball与完整/omitoptional安装均通过；许可保留，旧配置不读不删不改provider，原有修改分别备份。详见docs/secrets-acceptance.md和退役指南。
- AC-S: met — S01-S28组件验收：58项契约通过；真实PTY隐藏录入/多行/取消/批准/执行、认证篡改、更新撤销、EACCES和registry部分失败、竞争写入、快照替换、原生依赖改变、argv/env检查、已启动子进程取消、实际HTTP副作用后超时。S19/S20/S22/S23/S26为已确认边界。S03锁定/拒绝的组件错误注入通过，真实系统这两个环境分支未实测，不混同成功/密钥缺失。
- AC-H: met — 用户指定测试项目Ticket fixture及Node适配器已审查，真实macOS Keychain；Codex0.153.4与Claude2.1.142各一次认证GET完成。默认Codex沙箱先拒绝，精确命令正常自动审批后成功，未关闭沙箱/改provider。真实删除测试密钥后退出5、零新增请求。所有测试仅合成数据。
- AC-G: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-S: automated=passed(surface=component); manual=n/a; Executed argv in project root; captured exit code 0.
- AC-H: automated=passed(surface=external_service); manual=n/a; Executed argv in project root; captured exit code 0.
<!-- mancode:delivery-record:end -->
