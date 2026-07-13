# TASK-EAR-095: Figma-first frontend UI review workflow

## Short Name

`figma-first-frontend-ui`

## Type

feature (shared AI guidance + Casper frontend design contract)

## Priority

medium

## Scope

1. `ai-skills`
   - Add one reusable `frontend-ui-review` skill for Figma-to-code work,
     frontend implementation review, visual fidelity, state coverage,
     responsive behavior, accessibility, and existing-component reuse.
   - Keep project facts and design tokens out of the shared skill.
   - Route the skill through README/VERSION/AGENTS and the Codex/Cursor
     adapters, then run the canonical validators.
2. `casperacc`
   - Add a project-local `AGENTS.md` with the design source-of-truth order.
   - Add `DESIGN.md` documenting the current Nuxt UI/component/token contract,
     intentional visual language, and the missing canonical Figma URL.
   - Do not add shadcn, another component system, or a committed Impeccable
     dependency.
3. Impeccable pilot
   - Run the detector against `casperacc/app` in report-only mode.
   - Record results and false-positive risk; do not add a CI gate.

## Non-goals

- No UI redesign or production component changes.
- No shadcn dependency, registry, skill, or MCP configuration for Casper.
- No wholesale copy of UI/UX Pro Max or Impeccable into shared `ai-skills`.
- No Code Connect mapping without a canonical Casper Figma file/node URL.
- No automatic knowledge-base publication.

## Acceptance

- `frontend-ui-review` has the repository-required skill sections and concise
  Codex UI metadata.
- Shared routing is discoverable from the current workspace policies and thin
  adapters.
- Casper records Figma first, existing code/tokens second, and framework-native
  components before external design heuristics.
- Casper's intentional gradient/glass visual language is documented so generic
  anti-slop rules cannot silently override it.
- `ai-skills` validation, quick skill validation, `git diff --check`, and
  Casper's available lint/typecheck/build checks pass or have exact blockers.
- Impeccable detector output is advisory only; no dependency or CI file changes.

## Evidence

- `casperacc/package.json` uses Nuxt UI and Tailwind, not shadcn.
- `casperacc/app/assets/css/main.css` already owns Casper tokens and intentional
  gradient/glass styling.
- `Games-Labs-backoffice/skills-lock.json` already carries project-scoped
  Impeccable skills, so shared duplication would add routing noise.
- The current `ai-skills` taxonomy has no visual/Figma frontend review skill;
  `deslop` targets code noise rather than UI fidelity.

## Impeccable Pilot Result (2026-07-10)

`npx --yes impeccable detect app/` completed in report-only mode and returned
four `bounce-easing` findings in `app/assets/css/main.css` at lines 301, 311,
337, and 361. No source file was changed. These findings need design/interaction
review before any motion change and are not a CI gate.
