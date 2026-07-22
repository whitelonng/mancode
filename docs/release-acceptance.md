# 0.4.0 Continuity 发布验收

自动化 contract 必须覆盖 Continuity runtime/schema、条件式需求澄清、Policy 2、project upgrade、local reframe、operation recovery、团队协调、git-ref hard reject、五个平台生成结果和 Windows smoke path。条件式需求澄清必须证明清晰请求不被机械提问阻塞，决策性歧义会在 requirements finalize 或实施前停下、提问并等待用户回答。以下证据完成前，不得发布 mancode 0.4.0 或执行 `npm publish`。

## 发布条件

- 在最终发布候选运行 `npm run release:check -- --candidate <完整提交 SHA>`；该命令必须从 `origin/develop` 创建干净 checkout，运行 `npm ci`、`npm run prepublishOnly`、跨 clone、legacy、audit、pack 和安装 smoke，并输出绑定提交与 tarball SHA-256 的本地 JSON 证据。
- release-check 先运行 `npm pack --dry-run`，再执行实际 `npm pack`，保留生成的 tarball 并完成 CLI/module smoke；npm beta/rc 不能替代该字节级验证。
- Windows required check 在 CMD、PowerShell 和 Git Bash 上通过。
- Claude Code、Codex、Cursor、GitHub Copilot 和 ZCode 都完成真实双窗口 session 验证。每个平台可证明受信宿主 session，或证明两个真实显式 session 隔离；显式证据只满足发布验收，不授权运行时信任宿主 key。
- 每个平台证明子命令传播；支持子 agent 的平台还需证明继承，或记录合法的 `not_applicable` 原因。缺失、伪造、错误 client、关闭或碰撞的显式 session 证据必须拒绝。
- 完成跨真实宿主 resume、claim、handoff 和恢复路径。
- release-check 中两个真实独立 clone 完成 git-ref pull、并发 CAS、handoff、receipt recovery 和代码基线交接；不再重复要求同一流程的人工双 clone。
- release-check 中的真实 0.3.18 legacy fixture 完成 stage、activation、每个中断点恢复和严格条件下的 rollback；人工 smoke 不能替代 crash matrix。
- 最终执行 `mancode context beta --release-candidate <COMMIT> --json` 返回 `ready: true` 和空 blockers。
- 候选提交已经推送到 `origin/develop`，且本地 `HEAD`、`origin/develop`、全部验收证据和待发布 package version 指向同一提交。
- 记录验收前后的 `origin/main` commit，并证明它没有变化。禁止 push、merge、rebase 或创建以 `main` 为目标的发布操作。
- 上述条件全部成功后才允许执行 `npm publish`；npm 发布成功后也不得更新 `main`。

## 发布顺序

1. 在本地 `develop` 完成唯一 release candidate。
2. 完成全部自动化、跨平台、恢复和真实宿主验收。
3. 只执行 `git push origin develop`。
4. 从远程 `develop` 的同一提交运行 release-check，使用它保留的 tarball 完成真实宿主 spike，再运行最终 Beta gate。
5. 所有证据一致且 `origin/main` 未变化后，执行唯一一次正式 `npm publish`。

任何测试失败或候选提交变化都会使已有验收失效。修复后必须重新验证；不得先发布 npm 再补证据。

## 证据规则

所有证据必须绑定同一个 `origin/develop` commit、mancode version、操作系统和宿主版本。历史祖先提交、未推送提交或替代宿主结果只能用于调试，不能用于最终 Beta gate。

session evidence 不保存原始 key、token、绝对业务路径或任务正文。屏幕截图和日志应脱敏，并保存在发布流程约定的本地证据目录，而不是长期开发文档中。

## 当前未完成项

- 本轮发布门禁修复形成的新候选上的 Quality gate，以及 Windows CMD、PowerShell、Git Bash required gate。
- 五个平台在最终候选上的完整 session spike。
- 跨真实宿主协作与恢复验收。
- 最终候选上的 release-check，包括自动双 clone git-ref 和 legacy 验收。
- ZCode 项目级 skill 发现和 workspace command 路径确认。
- release-check 输出的候选 tarball、SHA-256、安装与 CLI/module smoke 证据。
- 验收前后 `origin/main` 未变化的记录。
- 汇总全部证据后的最终 Beta gate。

上一开发候选 `2c9d697` 的 [Quality gate](https://github.com/whitelonng/mancode/actions/runs/29930349142) 和 [Windows compatibility gate](https://github.com/whitelonng/mancode/actions/runs/29930353690) 均已通过，后者覆盖 Windows CMD、PowerShell 和 Git Bash。该证据是历史基线；本轮门禁修复形成新候选后必须重新执行。当前候选 SHA 和运行链接保存在外部发布证据中，避免把自引用 SHA 写进候选提交。

完成一项时更新本文件的未完成列表；不要创建新的平行验收计划。
