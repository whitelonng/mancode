# AGENTS.md

AI coding agent workflow harness with mancode Continuity for cross-conversation tasks, decisions, verification, and team coordination.

## 命令

```bash
npm run build       # tsup
npm test            # vitest run
npm run lint        # biome check src tests
npm run typecheck   # tsc --noEmit
npm run format      # biome format --write src tests
```

## 模块路由

| 目录 | 职责 |
|---|---|
| `src/context/` | schema、Task Aggregate、任务 mutation 和 Context Pack |
| `src/team/` | actor、claim、handoff、checkpoint 和 transport |
| `src/runtime/` | session、锁、operation、reservation、recovery 和 retention |
| `src/commands/` | CLI 解析后的应用服务边界 |
| `src/templates/` | agents、skills 模板与默认配置 |
| `src/installers/` | 平台 bootstrap、managed block 和 capability 检查 |
| `src/system/` | 项目检测、扫描和 legacy 辅助功能 |

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/engineering.md](docs/engineering.md)。

## 变更约束

修改 `src/` 下代码后，先运行 `tests/` 中对应的同名契约测试：

```bash
npx vitest run tests/<affected-file>.test.ts
```
