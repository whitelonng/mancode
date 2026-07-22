# 0.4.2 Continuity 发布验收

自动化 contract 必须覆盖 Continuity runtime/schema、条件式需求澄清、Policy 2、project upgrade、local reframe、operation recovery、团队协调、git-ref publication/rebind、五个平台生成结果和 Windows smoke path。条件式需求澄清必须证明清晰请求不被机械提问阻塞，决策性歧义会在 requirements finalize 或实施前停下、提问并等待用户回答。以下证据完成前，不得发布 mancode 0.4.2 或执行 `npm publish`。

## 唯一候选身份

- `develop` 只用于开发集成；最终 release candidate 是已经合并并推送到 `origin/main` 的单个提交。
- 本地 `HEAD`、`origin/main`、Quality/Windows checks、release-check、真实宿主证据、Beta gate、待发布 package version 和 npm `gitHead` 必须指向同一完整 SHA。
- 候选建立后，release-check 会记录检查前后的 `origin/main`。检查期间发生任何 main 更新都会使候选失效；后续修复必须形成新的 main 提交并重新执行受影响的全部门禁。

## 发布条件

- 在最终 main 候选运行 `npm run release:check -- --candidate <完整提交 SHA>`；该命令必须从 `origin/main` 创建干净 checkout，运行 `npm ci`、`npm run prepublishOnly`、跨 clone、legacy、audit、pack 和安装 smoke，并输出绑定提交与 tarball SHA-256 的本地 JSON 证据。
- release-check 先运行 `npm pack --dry-run`，再执行实际 `npm pack`，保留生成的 tarball 并完成 CLI/module smoke；npm beta/rc 不能替代该字节级验证。
- GitHub Quality gate 与 Windows required check 必须在同一个 main 候选成功；Windows 覆盖 CMD、PowerShell 和 Git Bash。
- Claude Code、Codex、Cursor、GitHub Copilot 和 ZCode 都完成真实双窗口 session 验证。每个平台可证明受信宿主 session，或证明两个真实显式 session 隔离；显式证据只满足发布验收，不授权运行时信任宿主 key。
- 每个平台证明子命令传播；支持子 agent 的平台还需证明继承，或记录合法的 `not_applicable` 原因。缺失、伪造、错误 client、关闭或碰撞的显式 session 证据必须拒绝。
- 完成跨真实宿主 resume、claim、handoff 和恢复路径。
- release-check 中两个真实独立 clone 完成 git-ref pull、并发 CAS、handoff、receipt recovery、代码基线交接，以及原子 mutation 投影提交后的同 revision code-head rebind 和第二 clone resume。
- release-check 中的真实 0.3.18 legacy fixture 完成 stage、activation、每个中断点恢复和严格条件下的 rollback；人工 smoke 不能替代 crash matrix。
- 最终执行 `mancode context beta --release-candidate <COMMIT> --json` 返回 `ready: true` 和空 blockers。
- 上述条件全部成功后，才允许从该 main checkout 发布 release-check 验证过的候选版本；发布后必须核对 npm version、integrity 与 `gitHead`。
- npm 验证成功后，在同一个 candidate SHA 创建 `v0.4.2` tag 和 GitHub Release，并记录 tarball SHA-256。tag 或 Release 不得指向另一个提交，也不能替代发布前门禁。

## 发布顺序

1. 在 `develop` 完成实现、文档和本地验证，通过评审后合并到 `main`。
2. 推送最终 main 合并提交，记录完整 candidate SHA，并等待该提交的 Quality 与 Windows checks 成功。
3. 在本地检出同一 main 提交，从 `origin/main` 运行 release-check。
4. 使用 release-check 保留的候选 tarball 完成真实宿主 spike、跨宿主恢复和最终 Beta gate。
5. 确认所有证据仍绑定同一个 main SHA 后执行唯一一次正式 npm 发布，并核对 registry metadata。
6. 为同一 SHA 创建并推送 `v0.4.2` tag，发布 GitHub Release 并附上候选与 tarball digest。

任何测试失败、main 提交变化、package version 变化或发布文档变化都会使已有验收失效。修复后必须形成新候选并重新验证；不得先发布 npm 再补证据。

## 证据规则

所有证据必须绑定同一个 `origin/main` commit、mancode version、操作系统和宿主版本。`develop` 提交、历史祖先提交、未推送提交或替代宿主结果只能用于调试，不能用于最终 Beta gate。

session evidence 不保存原始 key、token、绝对业务路径或任务正文。屏幕截图和日志应脱敏，并保存在发布流程约定的本地证据目录，而不是长期开发文档中。

## 当前未完成项

- 将 0.4.2 实现、测试和文档合并为最终 `origin/main` candidate。
- 在最终 main 候选上完成 Quality gate 与 Windows CMD、PowerShell、Git Bash required gate。
- 在最终 main 候选上完成 release-check，包括自动双 clone git-ref、code-head rebind、legacy、tarball SHA-256、安装和 CLI/module smoke。
- 五个平台在最终候选上的完整 session spike，以及跨真实宿主协作与恢复验收。
- ZCode 项目级 skill 发现和 workspace command 路径确认。
- 汇总全部证据后的最终 Beta gate。
- npm registry version/integrity/`gitHead` 核对，以及绑定同一提交的 `v0.4.2` tag 和 GitHub Release。

完成一项时更新本文件的未完成列表；不要创建新的平行验收计划。
