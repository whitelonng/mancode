export { MAN8_SKILL } from './man8.js';
export { MAN_SKILL } from './man.js';
export { MANPS_SKILL } from './manps.js';
export { MANSOLO_SKILL } from './mansolo.js';
export { MANTEAM_SKILL } from './manteam.js';

import { MAN_SKILL } from './man.js';
import { MAN8_SKILL } from './man8.js';
import { MANPS_SKILL } from './manps.js';
import { MANSOLO_SKILL } from './mansolo.js';
import { MANTEAM_SKILL } from './manteam.js';

/**
 * Skill 规格（用于生成 .claude/skills/<name>/SKILL.md）。
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
export const MVP2_SKILLS: SkillSpec[] = [
  MAN8_SKILL,
  MAN_SKILL,
  MANTEAM_SKILL,
  MANPS_SKILL,
  MANSOLO_SKILL,
];

/**
 * 渲染 skill 为 .claude/skills/<name>/SKILL.md 的内容。
 *
 * Claude Code 通过目录名注册 /<name>，SKILL.md frontmatter 提供菜单描述。
 */
export function renderSkill(spec: SkillSpec): string {
  return `---\nname: ${spec.name}\ndescription: ${JSON.stringify(spec.description)}\n---\n\n${spec.body}\n`;
}
