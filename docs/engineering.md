# 工程约定

mancode 的实现原则是：外科手术式修改、可验证、可恢复。

## 开发规则

- 只修改需求涉及的路径，不顺带重构相邻模块。
- 优先复用现有实现、标准库、平台能力和已安装依赖。
- schema parser 拒绝未知字段；跨实体写入必须有 revision 和 operation journal。
- shared 内容先做隐私筛查，再 canonicalize 和计算 digest。
- adapter 只管理自己的文件或明确标记的托管区。
- 探测失败应安全降级；业务一致性失败应停止写入并进入 repair。

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
npm test
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
- `docs/` 只描述当前契约和未完成验收，不保存已完成实施计划。
- 新 CLI 入口必须同步 help、测试和公开参考。
- 平台能力声明必须区分自动化 contract 与真实宿主证据。
- 发布版本由 `package.json` 与 `src/version.ts` 共同约束。
