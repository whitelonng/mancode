export { SCOUT_AGENT } from './scout.js';
export { HEAD_COACH_AGENT } from './head-coach.js';
export { FILM_ANALYST_OFFENSE_AGENT } from './film-analyst-offense.js';
export { FILM_ANALYST_DEFENSE_AGENT } from './film-analyst-defense.js';

import { FILM_ANALYST_DEFENSE_AGENT } from './film-analyst-defense.js';
import { FILM_ANALYST_OFFENSE_AGENT } from './film-analyst-offense.js';
import { HEAD_COACH_AGENT } from './head-coach.js';
import { SCOUT_AGENT } from './scout.js';

/**
 * Agent 规格（用于生成 .claude/agents/<name>.md）。
 *
 * frontmatter 字段（name / description / tools）由 Claude Code 文档约束。
 * body 是 markdown，原样写入文件。
 */
export interface AgentSpec {
  /** agent 名称，也是文件名（不含 .md） */
  name: string;
  /** frontmatter description，Claude Code 用于决定何时调用 */
  description: string;
  /** 允许该 agent 使用的工具列表（限制爆炸半径） */
  tools: string[];
  /** 完整 prompt markdown */
  body: string;
}

/** 所有 MVP-2 agent，install 时遍历 */
export const ALL_AGENTS: AgentSpec[] = [
  SCOUT_AGENT,
  HEAD_COACH_AGENT,
  FILM_ANALYST_OFFENSE_AGENT,
  FILM_ANALYST_DEFENSE_AGENT,
];

/**
 * 渲染 agent 为 .claude/agents/<name>.md 的内容（YAML frontmatter + body）。
 */
export function renderAgent(spec: AgentSpec): string {
  const frontmatter = [
    '---',
    `name: ${spec.name}`,
    `description: ${yamlString(spec.description)}`,
    `tools: ${spec.tools.join(', ')}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${spec.body}\n`;
}

/**
 * 简单 YAML 字符串序列化：含特殊字符时加引号。
 */
function yamlString(s: string): string {
  if (/[:\n#"']/.test(s) || /^\s|\s$/.test(s)) {
    const escaped = s.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return s;
}
