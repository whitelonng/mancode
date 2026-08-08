export const CORE_CODING_PRINCIPLES = `## 铁律（永不违反）

1. **不做无关修改** — 只改用户已确认的 plan 与 implementationScope；每一处改动都能追溯到范围或验收
2. **先验证再声称完成** — 开工前写明实质假设和可验证成功标准；build/lint/test 必须实际跑
3. **失败两次必须停下** — 不盲试
4. **不可逆操作先问** — 删除、force push、worktree 合并
5. **只解决被问到的问题** — 优先复用现有实现，选择满足验收的最小直接改动；不加推测性功能、一次性抽象、无关清理或多余配置`;
