# MVP-2 Beta Manual Test Plan

Date: 2026-07-03
Branch: `develop`
Version: `0.1.0-beta.0`

## Audit Status

Automated release checks already passed before manual testing:

- `npm run lint`
- `npm run build`
- `npm test`
- strict CLI smoke for init, skills, agents, aesthetics scan, `manps --remediate`, commit hook, and workflow list

No blocking issues are known. Manual testing should focus on Claude Code runtime behavior that unit tests cannot fully prove.

## Prerequisites

- Node.js 20+
- Git
- Claude Code installed and able to load project `.claude/skills`
- A disposable git repository for testing

Use the local beta candidate from this repository:

```bash
cd /Users/whitelonng/code/mancode/.claude/worktrees/objective-poincare-22ba7c
npm ci
npm run build
```

In test commands below, use:

```bash
node /Users/whitelonng/code/mancode/.claude/worktrees/objective-poincare-22ba7c/dist/cli.js
```

Replace that with `mancode` only when testing an installed npm beta package.

## Test Project Setup

Create a disposable project:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
git init
cat > package.json <<'JSON'
{
  "name": "mancode-mvp2-beta-manual",
  "dependencies": {
    "react": "^18.0.0",
    "tailwindcss": "^3.4.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "typescript": "^5.0.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
JSON
mkdir -p src/components/ui src/app
cat > tailwind.config.js <<'JS'
module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      colors: { primary: "#2563eb" },
      fontFamily: { sans: ["Inter", "sans-serif"] }
    }
  }
};
JS
cat > src/components/ui/button.tsx <<'TS'
export function Button() {
  return null;
}
TS
cat > src/app/globals.css <<'CSS'
:root {
  --radius: 8px;
  --background: #ffffff;
}
CSS
```

Set a helper variable:

```bash
MANCODE="node /Users/whitelonng/code/mancode/.claude/worktrees/objective-poincare-22ba7c/dist/cli.js"
```

## Test Cases

### 1. Initialize MVP-2 Beta Install

Method:

```bash
$MANCODE init --force --team --style clean
```

Expected result:

- Exit code is `0`.
- Output shows React, TypeScript, Tailwind CSS detection.
- `.mancode/state.json` exists.
- `.mancode/aesthetics/style-tokens.json` exists.
- `.claude/settings.json` exists.
- `.claude/skills/solo/SKILL.md` exists.
- MVP-2 skills exist:
  - `.claude/skills/man8/SKILL.md`
  - `.claude/skills/man/SKILL.md`
  - `.claude/skills/manteam/SKILL.md`
  - `.claude/skills/manps/SKILL.md`
  - `.claude/skills/mansolo/SKILL.md`
- Coaching agents exist:
  - `.claude/agents/scout.md`
  - `.claude/agents/head-coach.md`
  - `.claude/agents/film-analyst-offense.md`
  - `.claude/agents/film-analyst-defense.md`

### 2. Verify Aesthetic Scan Output

Method:

```bash
cat .mancode/aesthetics/style-tokens.json
```

Expected result:

- `colors.primary` is `#2563eb`.
- `fonts.sans` includes `Inter`.
- `components` includes `Button`.
- `cssVariables.radius` is `8px`.
- `darkMode` is `class`.
- `matchLevel` is `high`.

### 3. Verify Status And Hook Budget

Method:

```bash
$MANCODE status
```

Expected result:

- Exit code is `0`.
- Output shows installed platform `Claude Code`.
- Output shows both hooks present and registered.
- Output includes `Hook injection: ~... tokens (cap 800)`.

### 4. Manual Claude Code Slash Skill Load

Method:

1. Open the disposable project in Claude Code.
2. Restart Claude Code if it was already open.
3. Type `/` and inspect the available project skills.

Expected result:

- `/man8`, `/man`, `/manteam`, `/manps`, `/mansolo`, and `/solo` are visible or invocable.
- Invoking each skill does not report missing skill files.

### 5. Test `/man8`

Method:

In Claude Code, run:

```text
/man8 评估如何给这个项目添加登录页，不要改代码
```

Expected result:

- Claude starts a research/planning flow, not implementation.
- It reads project context and mentions Scout / Head Coach style planning.
- `.mancode/state.json` is updated to `currentMode: "man8"`.
- A `.mancode/workflows/<taskId>/metadata.json` file is created.
- The response ends with a plan or asks for approval before coding.

### 6. Test `/man`

Method:

In Claude Code, run a tiny disposable task:

```text
/man 给 README 增加一行测试说明
```

Expected result:

- Claude enters the full `/man` workflow.
- It follows scout, plan, implementation, review, fix, review flow.
- `.mancode/state.json` is updated to `currentMode: "man"`.
- A workflow directory is created under `.mancode/workflows/`.
- It should not skip review steps silently.

Cleanup after this test:

```bash
git checkout -- README.md 2>/dev/null || true
```

### 7. Test `/manteam`

Method:

In Claude Code, run:

```text
/manteam 准备一个多人协作的登录页改造计划
```

Expected result:

- Claude reads or creates `.mancode/memory/prd.md`, `spec.md`, and `decisions.md`.
- Claude checks team context such as git history and handoff notes.
- It references `.mancode/team/commit-template.txt`.
- It references `.github/PULL_REQUEST_TEMPLATE.md` when discussing PR output.
- It does not overwrite existing memory/template content.

### 8. Test `/manps` Scan

Method:

In Claude Code, run:

```text
/manps config
```

Expected result:

- Claude runs `mancode manps config`.
- `.mancode/preseason-report.md` is created or updated.
- `.mancode/preseason-issues.json` is created or updated.
- A timestamped report appears under `.mancode/preseason-reports/`.
- Response summarizes P1/P2 issues and does not modify files by default.

CLI cross-check:

```bash
$MANCODE manps config
```

Expected CLI result:

- Exit code is `0`.
- Output includes `mancode preseason scan`.
- Output includes `Area:     config`.

### 9. Test `/manps --remediate`

Method:

Run CLI remediation with explicit answers:

```bash
printf 'y\ny\ny\ny\ny\n' | $MANCODE manps config --remediate
```

Expected result:

- Exit code is `0`.
- Output includes `Remediation review`.
- Output shows accepted and fixed counts.
- `.gitignore` is created if missing.
- `.editorconfig` is created if missing.
- `package.json` gains safe inferred scripts:
  - `test`: `vitest run`
  - `lint`: `biome check .`
  - `build`: `vite build`
- `.mancode/preseason-issues.json` records fixed remediation entries.

Negative check:

```bash
tmpdir2="$(mktemp -d)"
cd "$tmpdir2"
git init
mkdir -p .mancode
echo '{"currentMode":"solo"}' > .mancode/state.json
echo '{}' > package.json
printf 'y\ny\ny\n' | $MANCODE manps config --remediate
cat package.json
```

Expected negative result:

- No scripts are added because there are no matching tool dependencies.
- Issues are accepted but not auto-fixed for scripts.

### 10. Test `/mansolo`

Method:

In Claude Code, after `/man8` or `/man`, run:

```text
/mansolo
```

Expected result:

- Claude switches back to solo mode.
- `.mancode/state.json` has:
  - `currentMode: "solo"`
  - `currentTask: null`
  - `currentWorkflowMode: null`
  - `skippedSteps: []`
- If a workflow is in progress, Claude asks before abandoning it.

### 11. Test Optional Commit Hook

Method:

```bash
$MANCODE install claude-code --commit-hook
test -x .mancode/team/commit-msg.sh
test -x "$(git rev-parse --git-path hooks/commit-msg)"
printf 'feat(beta): manual smoke\n' > good-msg.txt
"$(git rev-parse --git-path hooks/commit-msg)" good-msg.txt
printf 'bad message\n' > bad-msg.txt
if "$(git rev-parse --git-path hooks/commit-msg)" bad-msg.txt; then
  echo "unexpected pass"
  exit 1
fi
```

Expected result:

- Good Conventional Commit message exits `0`.
- Bad message exits non-zero.
- Error output mentions Conventional Commits.
- Existing custom hooks are not overwritten unless already managed by mancode.

### 12. Test Workflow CLI

Method:

```bash
$MANCODE workflow list
```

Expected result:

- Exit code is `0`.
- Output is empty or lists existing workflows.
- It does not crash when no workflows exist.

### 13. Test Minimal Install

Method:

```bash
$MANCODE install claude-code --force --minimal
```

Expected result:

- `.claude/skills/solo/SKILL.md` remains.
- MVP-2 skills are removed:
  - `.claude/skills/man8`
  - `.claude/skills/man`
  - `.claude/skills/manteam`
  - `.claude/skills/manps`
  - `.claude/skills/mansolo`
- `.claude/agents` is removed.

Restore full install after the test:

```bash
$MANCODE install claude-code --force
```

Expected restore result:

- MVP-2 skills and agents are recreated.

## Pass Criteria

MVP-2 beta manual test passes when:

- All CLI commands exit with the expected code.
- Claude Code can invoke all MVP-2 slash skills.
- `/man8`, `/man`, `/manteam`, `/manps`, and `/mansolo` update or preserve state as expected.
- `manps --remediate` only applies documented safe fixes after explicit `y`.
- The optional commit hook is opt-in and enforces Conventional Commits.
- No user-authored templates, memory files, or custom hooks are overwritten unexpectedly.

## Known Non-Blocking Limits

- Alias commands such as `/warmup`, `/playoffs`, `/team`, `/preseason`, and `/back-to-solo` are documented as planned, not wired.
- `manps` security scan is heuristic and does not yet run a real vulnerability database audit.
- Dead-code scan is heuristic and does not yet build a full import graph.
- The final Claude Code slash behavior must be validated in a live Claude Code session because unit tests can only verify installed skill files and CLI outputs.
