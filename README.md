# mancode

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Status](https://img.shields.io/badge/status-MVP--1%20in%20progress-yellow?style=flat-square)](./docs/10-mvp-scope.md)
[![Platform](https://img.shields.io/badge/platform-Claude%20Code-5865F2?style=flat-square)](https://claude.ai/code)

**AI coding agent harness. One tool, five modes. Professional-grade output.**

Default: quiet and efficient. When needed: hardcore, methodical, team-aware. Like a pro team — practice mode stays light; playoffs mode brings full rigor.

---

## The Problem

AI agents today:
- 🔴 **Overengineer by default** — add auth middleware when you just want a logout button
- 🔴 **Forget project style** — output MUI when your whole app is shadcn/ui
- 🔴 **No team memory** — two devs working on the same codebase, agents don't know about each other's changes
- 🔴 **One speed only** — "just fix this typo" gets the same ceremony as "rebuild auth flow"

## The Solution

**mancode** gives you **five modes** for different tasks:

```
solo           # Default: quiet, efficient, respects your style
               # Fixes, features, refactors — no ceremony

/man8          # 4 AM Warmup: investigate + plan before coding
               # Use when you need research first

/man           # Playoffs: full 8-step flow with dual code review
               # Critical features, production changes

/manteam       # Team Game: multi-dev memory + coordination
               # Detected automatically when >1 active contributor

/manps         # Preseason: project health check + cleanup
               # Old TODOs, unused deps, stale patterns
```

**Key difference**: The default is light. Heavy modes are opt-in when you need rigor.

---

## Before / After

### Before (vanilla Claude Code)
```
You: "add a logout button to the settings page"

Claude: Creates new component, new styles, new color variables,
        doesn't reuse existing Button component, guesses colors,
        outputs 80 lines.
```

### After (mancode solo mode)
```
You: "add a logout button to the settings page"

man:  Scans project → finds Button component → uses primary color
      → outputs 3 lines:

      <Button variant="default" onClick={handleLogout}>
        Logout
      </Button>
```

**Why?** mancode:
1. **Scans your project's existing patterns** (components, colors, UI library)
2. **Applies YAGNI** (already exists → reuse → stdlib → minimal implementation)
3. **Remembers team context** (commits, contributors, style decisions)

---

## How It Works

### Auto-detection
mancode automatically detects your project:
- **Tech stack**: React/Vue/Svelte, TypeScript, Tailwind/styled-components
- **UI library**: shadcn/ui, MUI, Ant Design, headlessUI
- **Design tokens**: colors, fonts, spacing, components
- **Team status**: >1 active contributor → auto-suggests `/manteam`

### Aesthetic Matching
When you work on frontend:
```javascript
// mancode scans:
tailwind.config.js  → primary: #3b82f6, font: Inter
package.json        → shadcn/ui installed
src/components/     → Button, Input, Card components exist

// Then outputs code using YOUR style:
<Button className="bg-primary">  // uses #3b82f6, not generic "blue"
```

### Team Memory (Codex platform)
When using Codex CLI, mancode writes to `AGENTS.md`:
```markdown
<!-- User's long-term memory -->
## Lessons
2026-06-20: Don't use lodash.merge for React state

## Architecture Decisions  
2026-06-15: Chose shadcn/ui over MUI (team familiarity)

<!-- mancode managed section -->
<!-- mancode:start -->
## mancode Configuration
[auto-generated, don't edit]
<!-- mancode:end -->
```

**Boundary**: mancode only touches the controlled section. Your notes stay safe.

---

## Install

**Status**: MVP-1 in progress. Alpha release coming soon.

```bash
# Once alpha releases:
npm install -g mancode@alpha

# Initialize in your project
cd your-project
mancode init

# Or as Claude Code plugin (marketplace - coming soon)
# /plugin install mancode
```

**Platform support**:
- ✅ **Claude Code** (MVP-1 target)
- 🔄 Cursor, Codex CLI, GitHub Copilot (MVP-3)
- 📋 Windsurf, Cline, Roo Code (planned)

---

## Commands

### MVP-1 (Current Development)

```bash
mancode init              # Initialize .mancode/ directory + solo mode
mancode status            # Show project status, mode, recent activity
mancode version           # Show version
```

**In Claude Code** (after init):
```
# Just work normally — solo mode is automatic
"add a logout button"
"fix the login bug"  
"refactor the auth module"
```

### Coming in MVP-2

```bash
/man8                     # 4 AM Warmup: scout + plan
/man                      # Playoffs: full 8-step flow
/manps                    # Preseason: health check
/manteam                  # Team mode (or auto-detected)
/mansolo                  # Back to solo
```

---

## Modes Explained

| Mode | When to Use | What It Does |
|---|---|---|
| **solo** (default) | Daily work | Quiet, efficient, style-aware. Reuses existing code. |
| **/man8** (MVP-2) | Research needed | Scout investigates codebase → Draft plan → Ask for approval |
| **/man** (MVP-2) | Critical features | Full 8 steps: scout → plan → code → review (offense) → fix → review (defense) → fix → merge |
| **/manteam** (MVP-2) | Team projects | Multi-dev memory, commit templates, coordination |
| **/manps** (MVP-2) | Project cleanup | Scan for tech debt, unused deps, stale TODOs, missing tests |

**Philosophy**: Light by default. Opt into rigor when you need it.

---

## Design Principles

### 1. YAGNI Ladder
Before writing new code, check:
1. Already exists in this codebase? → **reuse it**
2. Stdlib does it? → **use it**
3. Native platform feature? → **use it**
4. Already installed dependency? → **use it**
5. One line? → **one line**
6. Only then: write the minimum that works

### 2. Aesthetic Consistency
- Scan project's existing design tokens (colors, fonts, spacing)
- Reuse components, not recreate
- Match naming conventions
- Apply project's style guide

### 3. Team Memory
- Track contributors, commits, decisions
- Avoid conflicting changes
- Surface project context to all agents

### 4. Surgical Changes
- Change only what the task requires
- No "drive-by refactoring"
- No formatting unrelated code
- Keep diffs minimal

---

## Architecture

```
mancode/
├── CLI                         # npm package + platform adapters
│   ├── mancode init           # Setup .mancode/ directory
│   ├── mancode status         # Show current state
│   └── mancode install <platform>
│
├── Hooks (Claude Code)         # Inject context automatically
│   ├── session-start          # Read .mancode/state.json
│   └── user-prompt-submit     # Ask: why? what exists? minimal change?
│
├── Skills (5 modes)            # SKILL.md files
│   ├── solo.md                # Default mode
│   ├── man8.md                # 4 AM Warmup
│   ├── man.md                 # Playoffs (8 steps)
│   ├── manteam.md             # Team mode
│   └── manps.md               # Preseason cleanup
│
└── Agents (Coaching Staff)     # Multi-agent orchestration
    ├── Scout                  # Investigate codebase
    ├── Head Coach             # Main decision-maker
    ├── Film Analyst (Offense) # Code quality review
    └── Film Analyst (Defense) # Security/edge review
```

---

## Roadmap

| Phase | Timeline | Focus |
|---|---|---|
| **MVP-1** | 2-3 weeks | solo mode + aesthetics + hooks (Claude Code only) |
| **MVP-2** | 3-4 weeks | /man8, /man, /manteam, /manps modes + coaching staff |
| **MVP-3** | 2-3 weeks | Multi-platform (Cursor, Codex, Copilot) |
| **Public Release** | After MVP-3 | npm stable release + marketplace + docs + demos |

See [docs/10-mvp-scope.md](./docs/10-mvp-scope.md) for details.

---

## FAQ

### Why not just use Cursor/Claude/etc directly?

mancode is a **harness**, not a replacement. It works *with* your agent, adding:
- Project-aware context (style, patterns, team)
- Mode switching (light vs. rigorous)
- YAGNI enforcement
- Team memory

Think: workflow layer on top of your agent.

### Does it work with my agent?

MVP-1 targets **Claude Code**. MVP-3 adds Cursor, Codex CLI, and GitHub Copilot.

The architecture is adapter-based — other platforms can be added.

### Will it change my existing workflow?

**solo mode** (default) is invisible. It enhances your agent's output but doesn't add ceremony.

Heavy modes (`/man`, `/manteam`) are opt-in when you need structure.

### What about privacy/security?

- **Local-first**: All scans stay in `.mancode/` directory
- **No telemetry**: mancode doesn't phone home
- **Git-ignored**: `.mancode/` is in .gitignore by default (optional to commit)
- **Controlled boundaries**: AGENTS.md has clear managed sections (Codex only)

---

## Contributing

**Status**: Design phase complete, implementation starting.

Once MVP-1 releases, contributions welcome for:
- Platform adapters (Windsurf, Cline, etc.)
- Additional modes
- Aesthetic scanning for other UI libraries
- Language support (currently focuses on JS/TS ecosystem)

---

## License

MIT © 2026

---

## Acknowledgments

Built with inspiration from modern AI agent workflows. Special focus on:
- **Minimalism over maximalism** (YAGNI at core)
- **Project context awareness** (not generic one-size-fits-all)
- **Team coordination** (multi-dev memory)
- **Mode flexibility** (light default, opt-in rigor)
