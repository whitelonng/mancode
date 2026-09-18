# 网关退役与 Secrets V1 验收记录

基线：`78d7e8ba64a236762da750e161b788a4cf1c813d`。本地环境：macOS arm64、Node 25.9.0，原生后端 `@napi-rs/keyring` 2.1.0。使用合成数据，没有生产凭据、npm 发布或远端变更。原交付记录保留历史结果；其后独立审核发现实现缺陷和验收缺口，当前状态以本文件及 [修复记录](secrets-remediation.md) 为准。不得据原任务的 passed 状态认定所有必需环境分支均已验证。

## 网关退役

| 项目 | 结果与证据 |
|---|---|
| G01–G04 | 通过：删除运行模块及命令，旧命令和 flags 非零拒绝；CLI 契约与 retirement 测试。 |
| G05–G08 | 通过：init 只保留原共享询问、非交互默认、取消、互斥与重复初始化语义；init-privacy 测试。 |
| G09–G11 | 通过：status 仅输出版本 2 和 shared；不访问旧目录、不探测实际监听的旧端口，共享损坏仍返回 2。 |
| G12–G14 | 通过：clean build、bundle/map、真实 tarball 与隔离安装。A 阶段已独立验收，新增 Secrets 后再次检查。 |
| G15–G16 | 通过：退役指南要求先停止旧实例、人工恢复连接；新代码没有杀旧进程、读取或删除旧配置、重写 provider。 |
| G17–G19 | 通过：现有 scanner、preview、共享隐私、manifest、历史排除、团队/运行时回归；相应生产模块未修改。 |
| G20–G22 | 当前文档/站点索引、历史标记与许可保留；完整项目门禁由 `npm run check` 记录。 |

## Secrets

| 项目 | 结果与证据 |
|---|---|
| S01 | 通过：8 种类型存储测试；真实 PTY + Keychain 验证邮箱、手机号、API Key、多行 Unicode、无回显及取消。 |
| S02、S07 | 通过：密文检查、只返回最少目录/固定错误；不将值或摘要放入展示目录及运行回执。 |
| S03 | 成功与密钥丢失：真实 Keychain 读写/删除及固定错误，丢失后零业务请求。部分通过：原先替换整个 KeyProvider 的错误注入只证明领域错误传播，不能证明原生锁定/拒绝行为。原生接口边界异常测试及真实环境状态见修复记录；真实锁定/人工拒绝仍待专用环境验证。 |
| S04–S05 | 通过：密文/tag/nonce/entryId 篡改拒绝、nonce/revision 更新、旧批准失效。 |
| S06 | 通过进程中断替代验收：在原有锁、EACCES 和缓存测试之外，新增六阶段 EIO 与真实 SIGKILL 共 12 项，新进程验证旧/新权威一致和锁恢复。详见修复记录；未做物理断电试验。 |
| S08–S11 | 通过：跨工作区、缺失、未授权引用、未知字段、重复键、非法 UTF-8、嵌套/大小限制、symlink、shell/argv 入口拒绝。 |
| S12 | 通过：独立包快照保留；安装内容篡改拒绝；真实编译的 Mach-O 执行文件及 dylib 改变后拒绝。 |
| S13 | 通过：读取后替换输入文件只使用原快照。 |
| S14–S17 | 通过：原始 stdout/stderr、Base64、异常不转发；输出限额、超时、取消；等子进程 ready 后取消，回执为 outcome_unknown 且迟到写入没有发生。 |
| S18 | 通过：受控程序检查 argv/环境不含秘密或无关环境凭据；存储写入为密文，执行输入走管道。 |
| S19 | 已确认边界：测试执行器可故意写出合成秘密；输出抑制不等于文件/网络隔离。 |
| S20 | 已确认边界：同一用户可直接读取本次测试 Keychain 项；未宣称隔离同权限恶意进程。 |
| S21–S23 | 通过/已确认边界：实际本地 HTTP 副作用后超时只发送一次；绕过 secret run 直接读取目标响应仍可见合成数据。 |
| S24 | 新增 Secrets 后重跑退役、共享、全量检查以及 tarball 安装回归。 |
| S25 | 通过：真实 Codex 0.153.4 和 Claude Code 2.1.142 调用相同受审查 Ticket API 执行器，各一条业务请求。Codex 默认沙箱拒绝在前，精确命令的正常审批成功在后，原失败证据保留。原脚本成功词匹配有误报缺陷；修复后要求宿主正常退出、每次唯一认证请求、独立 runner 成功事件及不同 runId，重跑结果见修复记录。 |
| S26 | 通过/已确认边界：registry 不扩权、未认证批准拒绝；有效旧密文快照可回放，不宣称防恶意回滚。 |
| S27 | 通过：实际包在缺少可选 Keychain 后端时，普通 CLI、scan、preview 和 status 仍工作。 |
| S28 | 通过：运行已启动后更新/删除被锁拒绝，完成后更新/删除提交，新调用拒绝旧授权；已有副作用不被假称撤回。 |

业务执行器已审查：只访问用户指定测试项目的本地 Ticket fixture；固定目标、GET、redirect:error；不输出原始响应、不衍生携密 argv/env，无生产写入。终端探针还覆盖显式模板确认和批准后的 CLI 执行。

## 复现与限制

先构建，再在**新的隔离测试目录**运行；宿主探针依赖本机已登录的 Codex/Claude 和指定测试项目的 fixture。脚本只创建合成密钥，结束清除自身创建的 Keychain 项和保险箱，不清理现有用户数据。

```sh
npm run check
npx vitest run tests/secrets.test.ts tests/privacy-gateway-retirement.test.ts
node scripts/secrets-terminal-spike.mjs <绝对测试目录>
node scripts/secrets-package-spike.mjs <绝对测试目录>
node scripts/secrets-host-spike.mjs <绝对测试目录> --hosts --codex-reviewed
```

本地证据位于用户指定测试目录下 `gateway-retirement-secrets-20260918/`。保留初始失败和修复后结果：隐藏录入提示时序、原生 dylib install ID 解析、默认 Codex 沙箱限制以及测试自身初始化前提错误。最终契约测试包含相应回归，未把失败改写成成功。

未运行 GitHub Node 22/24 与 Windows/Linux CI 矩阵；Secrets 生产能力仅启用 macOS，其他平台失败关闭。依赖审计的 high 门禁通过时仍可能存在 moderate 级开发依赖告警，未擅自强制升级。这里没有声称物理断电、所有 Keychain 授权配置、所有宿主或同账号强隔离已验证。
