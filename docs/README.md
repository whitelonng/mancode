# mancode 开发文档

这里记录当前实现的稳定契约。历史 MVP 计划、一次性审核报告和已完成的网站计划不再保留在仓库中。

## 信息来源

发生冲突时，按以下优先级判断：

1. `src/` 中的 schema、CLI 注册和运行时代码。
2. 对应的自动化测试。
3. `README.md` 与 `README.en.md` 的公开使用说明。
4. 本目录中的开发说明。

文档不能把计划中的功能写成已支持，也不能用旧测试数量或版本号证明当前状态。

## 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | Continuity 权威模型、目录、Task Aggregate 和一致性 |
| [workflows.md](./workflows.md) | 模式、工作流状态、治理门禁与团队协作 |
| [project-intelligence.md](./project-intelligence.md) | 项目检测、设计资产扫描和 preseason |
| [platform-adapters.md](./platform-adapters.md) | 五个平台的 bootstrap、能力差异与边界 |
| [12-lifecycle.md](./12-lifecycle.md) | 初始化、会话、任务、恢复和迁移生命周期 |
| [engineering.md](./engineering.md) | 开发原则、验证要求和代码地图 |
| [release-acceptance.md](./release-acceptance.md) | 尚未完成的真实宿主与发布验收 |

法律和许可证边界单独保存在仓库根目录的 `LEGAL.md`。

## 维护规则

- 新文档优先更新现有专题，不创建新的阶段计划副本。
- 已完成计划应删除；仍有长期价值的决策应写成当前约束。
- 仅在真实宿主验证完成后更新平台能力声明。
- 命令示例必须能在当前 `src/cli.ts` 中找到对应入口。
