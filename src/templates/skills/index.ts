export { MAN8_SKILL } from './man8.js';
export { MAN_SKILL } from './man.js';
export { MANSOLO_SKILL } from './mansolo.js';

import { MAN_SKILL } from './man.js';
import { MAN8_SKILL } from './man8.js';
import { MANSOLO_SKILL } from './mansolo.js';

/**
 * Skill 规格（用于生成 .claude/skills/mancode-<name>.md）。
 *
 * skill 文件是纯 markdown（Claude Code 加载后按指令执行）。
 * name 是命令名（如 man8 → \`/man8\`）。
 */
export interface SkillSpec {
  /** 命令名，不含前缀 /，也是文件名中段（mancode-<name>.md） */
  name: string;
  /** 一句话描述，告诉 Claude 这个 skill 是干什么的 */
  description: string;
  /** 完整 prompt markdown（Claude 加载后照着执行） */
  body: string;
}

/** 所有 MVP-2 skill（不含 solo，solo 由 inline.ts 提供） */
export const MVP2_SKILLS: SkillSpec[] = [MAN8_SKILL, MAN_SKILL, MANSOLO_SKILL];

/**
 * 渲染 skill 为 .claude/skills/mancode-<name>.md 的内容。
 *
 * skill 是纯 markdown，不需要 frontmatter（区别于 agent）。
 */
export function renderSkill(spec: SkillSpec): string {
  return `${spec.body}\n`;
}
