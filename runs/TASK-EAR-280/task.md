# TASK-EAR-280 — Fix the two pre-existing backoffice test failures

## Summary

- Short name: `backoffice-stale-freecoin-test-and-icon-mismatch`
- Type: bugfix
- Workstream: frontend / Games-Labs-backoffice
- Priority: low
- Created: 2026-08-20
- Target environment: local (test-only + one client-side icon path)
- Origin: operator noticed `npm test` on `Games-Labs-backoffice` main sits at
  451/453 with 2 pre-existing failures unrelated to whatever feature branch is
  in flight (`adminFreeCoinManage`, `gameReportDetailAuth`) and asked why they
  are still open.

## Investigation (debugging skill, evidence-based)

Reproduced directly on `Games-Labs-backoffice` main:

```
node --test tests/adminFreeCoinManage.test.mjs tests/gameReportDetailAuth.test.mjs
```

Both fail deterministically, independent of any other branch/stash state.

### 1. `adminFreeCoinManage` — stale test assertion

- `tests/adminFreeCoinManage.test.mjs:86` still asserts
  `pageData` matches `'monitoring/reports/free-coins':`.
- `app/composables/useAdminPageData.ts` no longer has that key — commit
  `cea652d` ("feat(monitoring): add player log and gameplay tracking
  components", 2026-08-13) deliberately removed all `monitoring/reports/*`
  mock entries in favor of dedicated pages (matches the established
  "dedicated page exists → no catch-all mock" pattern already used for
  `manage/payment-gateway`, TASK-EAR-238). The dedicated Free Coin monitoring
  page is `app/pages/admin/monitoring/player-log/free-coin.vue` and it exists
  and is wired.
- Root cause: the mock removal was correct; the test was never updated to
  match. Fix belongs in the test, not in restoring a dead mock key.

### 2. `gameReportDetailAuth` — icon copy-paste bug, present since introduction

- `tests/gameReportDetailAuth.test.mjs:31-38` ("puts the joystick on Total
  Game Round") asserts the `Total Game Round` stat card uses
  `stadia-controller.svg` and explicitly rejects `stat-360.svg`.
- `app/pages/admin/monitoring/report/game/[id].vue:332-335` uses
  `/svg/stat-360.svg` for that card.
- Both the `.vue` file and the test were added together in commit `a935377`
  ("feat(auth): enhance authentication handling and add game report
  components") — this is a same-commit Figma-icon copy/paste mismatch, not a
  later regression. Both SVG assets exist under `public/svg/`.
- Root cause: wrong icon shipped against the Figma spec the test encodes.
  Fix belongs in the `.vue` file (swap the icon path), not the test.

## Acceptance criteria

- [ ] `tests/adminFreeCoinManage.test.mjs` reflects the current
      dedicated-page behavior (no `monitoring/reports/free-coins` mock
      key expected) without weakening what the test actually verifies
      (redirect + no catch-all mock key).
- [ ] `app/pages/admin/monitoring/report/game/[id].vue` renders
      `stadia-controller.svg` (not `stat-360.svg`) on the `Total Game Round`
      stat card.
- [ ] `node --test tests/adminFreeCoinManage.test.mjs
      tests/gameReportDetailAuth.test.mjs` passes clean.
- [ ] Full `npm test` re-run shows 453/453 (no new failures introduced).

## Provenance

Conducted solo by Claude (conductor lane, not a configured runner). Root
cause found via the `debugging` skill in the prior conversation turn before
this run was opened.
