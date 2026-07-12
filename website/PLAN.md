# mancode Website V1 Plan

## Objective

Turn the approved visual sample into a polished, deployable static landing page that explains why mancode exists, shows how its modes change workflow intensity, and gets a developer from first impression to installation without reading the full README.

The page should feel like a live engineering broadcast: industrial, restrained, fast, and unmistakably tied to mancode's practice-to-playoffs metaphor.

## Audience and primary action

- Primary: developers already using Claude Code, Cursor, Codex, Copilot, or ZCode.
- Secondary: engineering teams that want repeatable AI-assisted planning and review without sending project memory to another service.
- Primary action: copy `npm install -g mancode`.
- Secondary actions: open GitHub and read the README.

## Verified product claims

Only claims already documented in the repository will appear on the page:

- Five working modes: `solo`, `/manba`, `/man`, `/manteam`, and `/manps`.
- `/man` uses a nine-step workflow with targeted or full risk-based review and one remediation round.
- mancode detects project context and UI design signals when relevant.
- Workflow artifacts and team memory stay in the repository.
- mancode sends no telemetry.
- Adapters exist for Claude Code, Cursor, Codex, GitHub Copilot, and ZCode, with capability differences clearly represented.

## Information architecture

1. **Hero** — memorable outcome, install command, visual `/man` workflow card.
2. **Problem / response** — contrast generic AI over-building with mancode's reuse-first ladder.
3. **Mode selector** — interactive presentation of the five working modes and when to use each.
4. **Playoffs workflow** — compact nine-step `/man` sequence, grouped into scout, plan, execute, verify, and review phases.
5. **Project awareness** — show the files/signals mancode reads and the local artifacts it leaves behind.
6. **Platform matrix** — distinguish full Claude Code integration from adapter-based support without overstating parity.
7. **Quick start** — install, initialize, and choose a mode.
8. **Final call to action / footer** — repeat the install action and link to GitHub, English README, Chinese README, license, and privacy section.

## Visual and interaction system

- Keep the approved black, warm white, cyan, orange, and lime palette.
- Keep condensed sports-broadcast typography paired with monospace UI text.
- Extend the court-grid, scorebug, route, and numbered possession motifs through the page.
- Use large editorial section numbers instead of generic rounded feature cards.
- Add one mode-selector interaction, command copy buttons, anchor navigation, and scroll reveals.
- Respect `prefers-reduced-motion`; the page remains readable and complete with JavaScript disabled.

## Technical implementation

- Remain framework-free and deployable as a static directory.
- Split the current prototype into `index.html`, `styles.css`, and `site.js` so the completed page stays maintainable.
- Keep the existing local logo asset; add no external fonts, analytics, cookies, trackers, or third-party runtime dependencies.
- Use semantic sections, keyboard-accessible buttons, visible focus states, descriptive labels, and sufficient contrast.
- Use relative asset paths so the site works from a subdirectory or static host.

## Responsive behavior

- Desktop: asymmetric two-column hero and wide workflow/platform layouts.
- Tablet: collapse complex grids while keeping the visual card beside or below the copy.
- Mobile: single-column reading order, touch-friendly mode tabs, no horizontal page overflow, and preserved headline impact.

## Verification

- Run a local static server and inspect at 1440×900, 1024×768, and 390×844.
- Check the main navigation, all internal anchors, external links, mode selector, and every copy button.
- Check for console errors and horizontal overflow.
- Confirm reduced-motion and JavaScript-free fallbacks do not hide content.
- Run `git diff --check` and review the final change set for unrelated edits.

## Explicitly out of scope

- Deployment configuration or publishing to an external service.
- Blog, CMS, authentication, pricing, analytics, newsletter signup, or backend services.
- A separate documentation system or framework migration.
- Claims, testimonials, download numbers, or benchmarks not verified in this repository.

## Plan self-review

- **Value hierarchy:** The install action appears in the hero, quick start, and final CTA; supporting details do not block it.
- **Differentiation:** Modes, reuse-first behavior, project awareness, and the basketball workflow metaphor stay central instead of generic "AI productivity" claims.
- **Complexity:** A three-file static implementation is sufficient; no framework or build pipeline is justified.
- **Accuracy:** Platform parity is not implied, and all statements trace to the README.
- **Risk:** The main risks are mobile density, motion excess, and stale hard-coded metrics. The plan addresses these with responsive QA, reduced-motion support, and no volatile metrics.
- **Decision:** Approved for implementation with no blocking questions.
