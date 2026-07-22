# 0.4.0 发布验收

自动化 contract 必须覆盖 V3 schema、Policy 2、project upgrade、local reframe、operation recovery、团队协调、git-ref hard reject、五个平台生成结果和 Windows smoke path。以下证据完成前，不得发布 mancode 0.4.0 或执行 `npm publish`。

## 发布条件

- 在最终发布候选的干净 checkout 运行 `npm ci` 和 `npm run prepublishOnly`。
- 先运行 `npm pack --dry-run` 检查包内容，再执行实际 `npm pack`，使用生成的 tarball 完成安装和 CLI 启动 smoke test；不使用 npm beta/rc 发布代替该验证。
- Windows required check 在 CMD、PowerShell 和 Git Bash 上通过。
- Claude Code、Codex、Cursor、GitHub Copilot 和 ZCode 都完成真实双窗口 session 验证。
- 每个平台证明子命令传播；支持子 agent 的平台还需证明继承，或记录合法的 `not_applicable` 原因。
- 完成跨真实宿主 resume、claim、handoff 和恢复路径。
- 两个独立 clone 完成 git-ref pull、并发 CAS、handoff、receipt recovery 和代码基线交接。
- legacy fixture 完成 stage、activation、中断恢复和严格条件下的 rollback。
- 最终执行 `mancode context beta --release-candidate <COMMIT> --json` 返回 `ready: true` 和空 blockers。
- 候选提交已经推送到 `origin/develop`，且本地 `HEAD`、`origin/develop`、全部验收证据和待发布 package version 指向同一提交。
- 记录验收前后的 `origin/main` commit，并证明它没有变化。禁止 push、merge、rebase 或创建以 `main` 为目标的发布操作。
- 上述条件全部成功后才允许执行 `npm publish`；npm 发布成功后也不得更新 `main`。

## 发布顺序

1. 在本地 `develop` 完成唯一 release candidate。
2. 完成全部自动化、跨平台、恢复和真实宿主验收。
3. 只执行 `git push origin develop`。
4. 从远程 `develop` 的同一提交建立干净 checkout，并重跑 `npm ci`、`npm run prepublishOnly`、平台 smoke test、tarball 安装测试和最终 Beta gate。
5. 所有证据一致且 `origin/main` 未变化后，执行唯一一次正式 `npm publish`。

任何测试失败或候选提交变化都会使已有验收失效。修复后必须重新验证；不得先发布 npm 再补证据。

## 证据规则

所有证据必须绑定同一个 `origin/develop` commit、mancode version、操作系统和宿主版本。历史祖先提交、未推送提交或替代宿主结果只能用于调试，不能用于最终 Beta gate。

session evidence 不保存原始 key、token、绝对业务路径或任务正文。屏幕截图和日志应脱敏，并保存在发布流程约定的本地证据目录，而不是长期开发文档中。

## 当前未完成项

- 本轮修复形成的新候选上的 Quality gate，以及 Windows CMD、PowerShell、Git Bash required gate。
- 五个平台在最终候选上的完整 session spike。
- 跨真实宿主协作与恢复验收。
- 当前候选上的双 clone git-ref 人工验收。
- legacy fixture 的 stage、activation、中断恢复和受约束 rollback 验收。
- ZCode 项目级 skill 发现和 workspace command 路径确认。
- `origin/develop` 候选提交上的干净 checkout、tarball 安装和 CLI 启动验收。
- 验收前后 `origin/main` 未变化的记录。
- 汇总全部证据后的最终 Beta gate。

开发候选证据：`4dc2e7e` 的 [Quality gate](https://github.com/whitelonng/mancode/actions/runs/29896302856) 和 [Windows compatibility gate](https://github.com/whitelonng/mancode/actions/runs/29896302904) 均已通过，后者覆盖 Windows CMD、PowerShell 和 Git Bash。该证据只适用于 `4dc2e7e`；后续代码、测试或文档修改进入新候选后，两个 required check 都必须重新执行。

完成一项时更新本文件的未完成列表；不要创建新的平行验收计划。
