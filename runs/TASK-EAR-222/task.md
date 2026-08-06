# TASK-EAR-222 — Wire the Grant Pass and Missions audit scopes to real data

## Type

feature

## Priority

medium

## Context

Follows TASK-EAR-208 (which wired `grant_vip`, the first live scope) and
TASK-EAR-219 (which enriched the publishers so these columns could be filled).

**Scope deliberately excludes E-Voucher.** TASK-EAR-219's live verification found
Order's audit publisher is disabled on staging — `RABBITMQ_URL` never reaches the
container — so `order.redemption_item.grant` has never produced a single row.
Wiring that scope now would mean building against data nobody has seen. It is
blocked on **TASK-EAR-221** and gets its own run afterwards.

The two scopes here were **verified live on staging** on 2026-08-06; every field
below was observed in a real `admin_actions` row via
`GET /api/v1/admin/audit-events`, not inferred from source.

## The endpoint

`GET /api/v1/admin/audit-events` — already wired and live. Params: `target_user_id`,
`actions`, `actor_id`, `outcome`, `limit`, `offset`. Response
`{status:{code}, items:[…], total:"N"}`.

⚠️ **camelCase vs snake_case**: top-level typed proto fields are camelCased by the
gateway (`occurredAt`, `actorId`, `targetUserId`), but `before`/`after` are
`google.protobuf.Struct`, so **keys inside them stay exactly as the publisher
wrote them — snake_case**. This trap has bitten this platform before; see the
memory note `missions-checkin-camelcase-trap`.

Reuse the existing composable from TASK-EAR-208
(`app/composables/useAdminPlayerAuditEvents.ts`) rather than writing a second one.

## Scope 1 — Grant Pass (`grant_pass`)

Action: `mission.pass.grant`. Designed columns (`app/data/mock.ts`,
`getPlayerAuditLogDefinition`): `updatedAt`, `specialPass`, `previous`, `updated`,
`remaining`, `byAdmin`.

**Real observed row** (two consecutive grants on the same player, proving the
extend path):

```
before {pass_type:"Level Access Pass", had_active_pass:true, expires_at:253402387199}
after  {pass_type:"Level Access Pass", pass_name:"Golden Pass", days_added:2,
        expires_at:253402559999}
```

| Column | Source |
|---|---|
| `updatedAt` | `occurredAt` |
| `byAdmin` | `actorId` (raw UUID — no actor name exists anywhere; do not invent a lookup) |
| `specialPass` | `after.pass_name` |
| `updated` | `after.days_added`, rendered like the design's `7d` |
| `previous` | `before.had_active_pass` / `before.expires_at` — `-` when there was none |
| `remaining` | derived from `after.expires_at` |

⚠️ **`expires_at` is a Unix epoch integer, not RFC3339.** The FE must format it.
Values like `253402559999` (year 9999) are real on staging.

⚠️ **`pass_name` can legitimately be absent.** `PassDisplayName` matches the Order
catalog's `pass_type` values (`Level Access Pass`, `Point Multiplier`); a legacy
slug like `golden_pass` resolves to nothing and the publisher omits the field
rather than echoing the key as a fake name. **Render `-`, never fall back to
`pass_type`** — that would display a slug as if it were a product name.

## Scope 2 — Missions (`complete_mission`, titled "Update mission progress")

Actions: `mission.force_complete`, `mission.daily.reset`, `mission.streak.reset`.
Designed columns: `updatedAt`, `mission`, `previous`, `updated`, `byAdmin`.

**Real observed rows:**

| action | before | after |
|---|---|---|
| `force_complete` (daily) | `{mission_scope:"mission", mission_title:"Play by SLOTS Game", mission_id:"daily-sched-2026-08-06-category_turnover", type:"daily_mission", progress_current:0, progress_target:3000, is_complete:false, claimed:false}` | same + `progress_current:3000`, `is_complete:true`, `completed:true` |
| `daily.reset` | `{mission_scope:"daily_all", progress_current:0, progress_target:7, daily_completed_count:0, watch_ad_daily_count:0}` | same shape |
| `streak.reset` | `{mission_scope:"turnover_streak", progress_current:0, current_streak:0, is_broken:true}` | same shape |
| `force_complete` (monthly, failed) | `{mission_scope:"monthly_challenge", progress_current:0, progress_target:31, …}` | `{}`, `outcome:"failed"` |

**Mapping rule** (from TASK-EAR-219): a row with `mission_title` renders it; a row
with only `mission_scope` renders that scope's label. `mission_scope` values:
`mission`, `daily_all`, `turnover_streak`, `monthly_challenge`. The last three have
**no title and never will** — they are not individual missions. Choose readable
labels for them in the FE (that is a display concern and belongs here), but do not
invent a *mission name*.

| Column | Source |
|---|---|
| `mission` | `after.mission_title` if present, else the `mission_scope` label |
| `previous` | `before.progress_current` / `before.progress_target` |
| `updated` | `after.progress_current` / `after.progress_target` |

`progress_target` is absent for `turnover_streak` by design — render progress
alone, not `0/0`.

## Rules

- **Preserve the designed UX** (standing operator rule): columns, order, modal
  chrome, pagination all stay as designed. Data source only.
- Server-side pagination from `limit`/`offset` + response `total`, as TASK-EAR-208
  did — not a client-side slice.
- **Any field with no real source renders `-`.** Never a mock value, never a
  fabricated one, never a raw key standing in for a name.
- Loader failure → the existing fallback/empty state, **never** mock data.
- The other scopes (`manual_wallet`, `reset_password`, `send_e_voucher`) keep their
  current mock behaviour untouched.
- **PR only, do NOT merge** — backoffice `main` merge is a real k3s/ArgoCD deploy.
  Say so in the PR body.

## Acceptance criteria

- Both scopes render real rows for a player who has them.
- Tests in the repo's existing style (`tests/*.test.mjs`): the normalizers, the
  absent-`pass_name` → `-` case, the epoch formatting, the
  title-vs-scope-label rule, scope isolation (the other three still mock), and the
  loader-failure fallback.
- Authenticated staging smoke with screenshots on player
  `8218a35f-e869-437a-8844-3c97f08ed428` (`test01`), which has real rows for both
  scopes as of 2026-08-06. Harness scripts are in `runs/TASK-EAR-208/artifacts/`
  and `runs/TASK-EAR-218/`; the memory note is `backoffice-authenticated-smoke`.
  If the harness cannot run, say exactly why — do not fabricate a screenshot.

## Out of scope

- E-Voucher (`send_e_voucher`) — blocked on TASK-EAR-221.
- `manual_wallet` and `reset_password` — no publisher exists at all; Wallet also
  has no staff-identity capture. Separate runs.
