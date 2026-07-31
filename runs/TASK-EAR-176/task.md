# TASK-EAR-176 — 7 backoffice test files never execute (Nuxt `~` alias unresolvable)

## Type

bugfix

## Workstream

frontend

## Priority

medium

## Created

2026-07-31

## Epic

Test-infrastructure hygiene. Found while running the TASK-EAR-169 runtime
smoke, not by a failing build — nothing in CI runs these tests at all.

## Context

`node --test 'tests/*.test.mjs'` on `Games-Labs-backoffice` `main` reports
**107 pass / 7 fail**. All 7 failures are the same error, and none of them is a
logic failure:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '~' imported from
  /Users/earth/Documents/GitHub/Games-Labs-backoffice/app/utils/missionName.ts
```

The files never execute. A test that cannot run is not a passing test and is
not a failing test — it is absent, while still being counted in a suite total
that gets reported as green.

Affected files:

- `tests/adminCouponApi.test.mjs`
- `tests/adminStoreItemsApi.test.mjs`
- `tests/missionBoardGameNames.test.mjs`
- `tests/missionName.test.mjs`
- `tests/missionPointCurrency.test.mjs`
- `tests/passGameSupport.test.mjs`
- `tests/weeklyPlanBoardBonus.test.mjs`

## Root cause — verified, not inferred

The suite has two shapes of test, and only one of them ever touches app code:

- **The 107 that pass** mostly read source files as *text* and assert on their
  contents, e.g. `tests/playerMissionComplete.test.mjs:5` does
  `await readFile(new URL('../app/components/CompleteMissionPanel.vue', ...))`.
  They never import app modules, so no alias is ever resolved.
- **The 7 that fail** genuinely `import` app modules, e.g.
  `tests/missionName.test.mjs:5` imports `../app/utils/missionName.ts`. That
  module then imports through the Nuxt alias
  (`missionName.ts:1-3`: `~/composables/useAdminMissionApi`, `~/data/mock`,
  `~/utils/gameCategory`), and plain Node has no idea what `~` means.

So the majority-green number is not evidence that app behaviour is covered.

Two things already ruled out, so nobody re-walks them:

- **`--experimental-strip-types` does not fix it.** Verified:
  `node --test --experimental-strip-types tests/missionName.test.mjs` fails
  with the identical `Cannot find package '~'`. The type stripping was never
  the blocker; the alias is.
- **`package.json` `"imports"` cannot fix it.** Node's subpath-imports field
  only matches specifiers beginning with `#`, so it cannot map `~/`.

## Why it went unnoticed

`.github/workflows/deploy.yml` is build-and-push only — **CI never runs the
test suite**, so nothing has ever failed on this. It surfaces only when a human
runs the tests locally, and the obvious invocation is the one that breaks.

There is also no `test` script in `package.json` (only `build`, `dev`,
`generate`, `preview`, `postinstall`), so every prior run invented its own
command. That is how the TASK-EAR-169 handoff came to report "all 160
Backoffice tests" green while these 7 were not executing: a different
invocation, never written down.

## Objective

Make all 7 files actually execute, under one documented command, and record
honestly what they report once they do.

## Required work

1. **Give the runner an alias resolver.** The minimal fix is a Node module
   customization hook — a small `resolve()` that rewrites a `~/x` specifier to
   the `app/x` file URL — loaded with `node --import ./tests/<hook>.mjs`.
   Adopting a Nuxt-aware runner (e.g. vitest with the project's alias config)
   is the heavier alternative; if you take it, say why in the output, because
   it adds a dependency to a repo that currently has no test dependency at all.

2. **Do not change app source to suit the runner.** `~/` imports are the
   codebase idiom and are correct under Nuxt. Rewriting them to relative paths
   to make a test runner happy would be the tail wagging the dog.

3. **Add a `test` script to `package.json`** so there is exactly one blessed
   invocation, and reference it wherever the repo tells contributors how to
   verify (README or the equivalent).

4. **Report what the 7 actually say once they run.** Some may genuinely fail —
   they have not executed in an unknown number of weeks while the code they
   cover kept moving. **A real failure is the finding, not an obstacle.** Do
   not adjust an assertion to make it pass without saying so explicitly and
   explaining why the assertion, and not the code, was wrong.

5. Consider whether CI should run the suite. Recommend, do not implement —
   `deploy.yml` currently deploys backoffice `main` to the live k3s/ArgoCD
   lane, so adding a gate there is an operator-visible change to the deploy
   path and needs its own decision.

## Acceptance criteria

- All 7 files execute; none reports `ERR_MODULE_NOT_FOUND`.
- One documented command runs the whole suite, wired as `npm test`.
- Real pass/fail counts reported from that command, with any genuine failures
  described rather than silenced.
- No app-source import rewritten purely to satisfy the runner.
- `npm run build` still clean, no new `WARN Duplicated imports`.

## Out of scope

- Adding a CI test gate (recommend only — see item 5).
- Rewriting the 107 source-reading tests into behavioural tests. Their weakness
  is real and worth its own discussion, but conflating it with this fix makes
  the diff unreviewable.
- Any app behaviour change.

## Notes

Found 2026-07-31 during the TASK-EAR-169 verification smoke. Claude advisory
lane. See `runs/TASK-EAR-169/verification-evidence.md` section 3 for the
original observation.
