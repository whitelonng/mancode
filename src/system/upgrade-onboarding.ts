import { createInterface } from 'node:readline';
import type { InitLocale } from './init-onboarding.js';

export type UpgradeAction = 'both' | 'project' | 'cli' | 'check' | 'exit';
export interface UpgradePrompter {
  selectAction(initialized: boolean): Promise<UpgradeAction>;
  confirm(summary: string): Promise<boolean>;
  displayName(): Promise<string | null>;
  selectInstallation(entries: string[]): Promise<string | null>;
}

export function createUpgradePrompter(
  locale: InitLocale,
  io: {
    ask: (prompt: string) => Promise<string | null>;
    write: (text: string) => void;
  } = { ask: askTerminal, write: console.log },
): UpgradePrompter {
  const zh = locale === 'zh-CN';
  async function choose(entries: string[]): Promise<number | null> {
    io.write(entries.map((entry, i) => `${i + 1}. ${entry}`).join('\n'));
    io.write(zh ? '0. 退出' : '0. Exit');
    while (true) {
      const value = await io.ask(zh ? '请选择：' : 'Selection: ');
      if (value === null || value.trim() === '0') return null;
      if (/^[1-9]\d*$/.test(value.trim())) {
        const index = Number(value.trim()) - 1;
        if (index < entries.length) return index;
      }
      io.write(zh ? '请输入有效编号。' : 'Enter a valid number.');
    }
  }
  return {
    async selectAction(initialized) {
      const actions: UpgradeAction[] = initialized
        ? ['both', 'project', 'check']
        : ['both', 'project', 'cli', 'check'];
      const labels = {
        both: zh
          ? '更新 CLI 和当前项目规则、Skills（推荐）'
          : 'Update CLI and current project rules and Skills (recommended)',
        project: zh
          ? '仅更新当前项目规则、Skills'
          : 'Update current project rules and Skills only',
        cli: zh ? '仅更新 CLI' : 'Update CLI only',
        check: zh
          ? '查看更新信息和影响范围'
          : 'Inspect update information and scope',
        exit: '',
      };
      const selected = await choose(actions.map((action) => labels[action]));
      return selected === null ? 'exit' : (actions[selected] ?? 'exit');
    },
    async confirm(summary) {
      io.write(summary);
      const answer = await io.ask(
        zh ? '继续更新？[y/N] ' : 'Continue updating? [y/N] ',
      );
      return (
        answer !== null &&
        ['y', 'yes', '是'].includes(answer.trim().toLowerCase())
      );
    },
    async displayName() {
      const answer = await io.ask(
        zh
          ? '首次更新需要本地显示名（留空取消）：'
          : 'Local display name (empty to cancel): ',
      );
      return answer?.trim() || null;
    },
    async selectInstallation(entries) {
      io.write(
        zh
          ? '检测到多个安装，请选择要更新的位置：'
          : 'Select the installation to update:',
      );
      const index = await choose(entries);
      return index === null ? null : (entries[index] ?? null);
    },
  };
}

function askTerminal(prompt: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    rl.once('close', () => finish(null));
    rl.once('SIGINT', () => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(new Error('MANCODE_UPGRADE_CANCELLED'));
    });
    rl.question(prompt, finish);
  });
}
