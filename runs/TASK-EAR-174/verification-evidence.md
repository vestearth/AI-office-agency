# TASK-EAR-174 — verification evidence

Run date: 2026-07-30. Lane: Claude advisory (manual), operator-authorized.
Branch `feature/TASK-EAR-174-player-admin-failure-feedback`, commit `fdb9749`,
PR SparqLab/Games-Labs-backoffice#61. All 5 Done-when items now carry evidence.

## Method — and what it deliberately did NOT do

`npm run dev` off the feature branch (configured port 3000 was already taken by
another session's server, so this ran on 58465).

Auth was satisfied by writing a **dummy string** into `localStorage`
(`backoffice-auth = 'smoke-test-invalid-token'`) purely to get past the
`auth.global.ts` route guard. No password was entered and no real session was
used. The gateway then rejects every call with 401 — which is exactly the
failure path under test, so the missing credential is a feature here, not a
limitation.

**No product code was modified to run this smoke.** `git status` showed no
changes to any file in the diff afterwards. The task.md suggestion ("point a
write at a bad URL") was replaced with a strictly stronger technique for Part 2
— a `window.fetch` stub returning HTTP **200** with an error body, which is the
actual failure mode Part 2 exists to catch. A bad URL only produces a transport
error, which the old code already handled.

## 1. Part 1 — failure branches paint red (Done-when 1)

Loaded `/admin/manage/player`. The list `$fetch` 401s and lands in the catch at
`index.vue:333`.

Observed: toast top-right rendered **red background, red X-circle icon, title
"Error"**, body "Failed to fetch players."

Before this change that same branch called `openAdminSaveToast`, which paints
green with the literal title "Success!".

## 2. Part 3 — failed wallet GET leaves nothing savable (Done-when 3, 4)

Loaded `/admin/manage/player/edit/1?tab=wallet`. Console confirmed the real
failure: `[player/edit] wallet balance GET failed: FetchError: [GET]
".../api/v1/admin/wallet/balance/1": 401`.

Settled DOM state, read directly rather than eyeballed:

    inputs:  ["0", "0", "0"]
    text:    "Invalid or expired token"
    button:  { "t": "Edit", "d": true }     // d = disabled

So the mock seed (diamond 56 / point 90 / coin 90054) is gone, the 401 reason is
surfaced, and Edit/Save is not clickable. Note the request path ends in `/1`,
the route id — `walletBalanceResourceId` no longer goes through the mock module
(Done-when 4).

**Residual confirmed live, not a regression:** during the in-flight window
before the 401 returns, the fields DO briefly display 56 / 90 / 90054, because
`watch(player, …)` still seeds from `mockPlayerDetail()`. They cannot be saved
(button disabled), and a screenshot taken mid-flight will show them. This is the
known item recorded for the Detail-page silent-mock-fallback task.

## 3. Part 2 — HTTP 200 + error envelope is treated as failure (Done-when 2)

`window.fetch` stubbed so the VIP catalog/user GETs succeed (panel renders
VIP 1 Bronze, levels 1-3) and **only** the `PATCH .../vip-level` returns:

    HTTP 200  {"status":{"code":500,"description":"Envelope error (stubbed) — must not look like success"}}

Clicked Edit → stepper to 2 → Save → Confirm.

Observed: **red "Error" toast carrying the stubbed `description` verbatim**, and
the level card still reading **VIP 1** — i.e. `savedLevel` was not written
optimistically, which was the second half of the Part 2 defect.

Before this change the same response produced a green "Success!" and a VIP level
the UI believed had changed.

## 4. Success path regression check

Same flow, stub switched to `{"status":{"code":200,"description":"OK"}}`.

Observed: PATCH fired exactly once (`__patchHit === 1`), the panel left edit
mode normally, and **no error toast appeared**. The green toast auto-dismisses
after 4.5s and expired between tool round-trips, so it is not captured visually;
the meaningful signal is that the new assertion does not false-positive on a
real success envelope.

## 5. Envelope assertion against real service shapes (deterministic)

`app/utils/apiError.ts` transpiled with the repo's own esbuild and exercised
directly. Success shapes were taken from service source, not invented:
`shared-lib/errors/status.go:11-13` (StatusOK = code 200) and
`Games-Labs-Missions/internal/handlers/adminmission/http/handler.go:225`
(give-pass returns the literal `{"status":"success","message":"pass granted"}`).

    PASS  Wallet PATCH ok (basepb StatusResponse)     -> passes
    PASS  VIP PATCH ok (basepb StatusResponse)        -> passes
    PASS  give-pass ok (Missions literal)             -> passes
    PASS  body with no envelope at all                -> passes
    PASS  null body                                   -> passes
    PASS  Wallet PATCH err (ToStatus MetaError)       -> throws: wallet locked
    PASS  VIP PATCH err (invalid request)             -> throws: level not found
    PASS  Missions Struct error                       -> throws: pass type unknown
    PASS  legacy success:false                        -> throws: forbidden
    PASS  code as string "500"                        -> throws: boom

    ALL PASS (10/10)

This is what covers the wallet PATCH and give-pass POST assertions, which could
not be reached by clicking: the wallet Save button is (correctly) disabled while
the balance GET fails, and give-pass needs a loaded pass catalog.

## 6. Build (Done-when 5)

`npm run build` clean — the repo uses npm + `package-lock.json`, not pnpm. No
new `WARN Duplicated imports`. Remaining warnings are pre-existing: the
`promotion/coupon-edit` vs `promotion/coupon/edit` route-name collision, and a
chunk-size note.

One build failure along the way was **not** caused by this change: a stale
`node_modules` missing `xlsx`, which arrived with `d2505b7` (E-Voucher import)
in the same pull. `npm install` resolved it and `package-lock.json` is
unmodified.

## Still open at merge time

- Merging backoffice `main` is a **live deploy** (k3s/ArgoCD) — not the
  no-deploy lane the other repos have.
- **No CI check reports on the PR branch**; a green PR is not a signal here.
- No reviewer run has been dispatched. The two judgment calls that go beyond the
  letter of task.md are recorded in `status.yaml` history for cheap rejection.
