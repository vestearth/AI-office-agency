# TASK-EAR-232 — Wire the last two audit scopes: Wallet and Security

## Type

feature

## Priority

medium

## Context

The final FE step of the audit epic. Four scopes are already live
(TASK-EAR-208, 222, 223). The two remaining publishers shipped and were verified
on staging this week: Wallet (TASK-EAR-226/227) and Auth password reset
(TASK-EAR-231). **After this run, all six modal scopes are on real data.**

Every field shape below was **observed in a real staging row**, not inferred.

## The endpoint

`GET /api/v1/admin/audit-events` — live, already used by four scopes. Reuse the
composable and live-scope map that TASK-EAR-222/223 built
(`app/composables/useAdminPlayerAuditEvents.ts` + `LIVE_AUDIT_FETCHERS` in
`app/components/PlayerAuditLogModal.vue`). **Do not add a third pattern.**

⚠️ **`actions` must be sent as REPEATED query params.** Comma-joined returns
`total: 0` with HTTP 200 and no error — it reads exactly like "no rows" and has
caused a false conclusion twice in this epic.

⚠️ Top-level typed fields are camelCase (`occurredAt`, `actorId`); keys **inside**
`before`/`after` are protobuf Struct passthrough and stay **snake_case**.

## Scope 1 — Wallet (`manual_wallet`)

Action: `wallet.balance.update`. Columns: `updatedAt`, `currency`, `previous`,
`updated`, `byAdmin`.

**Real observed rows:**

```
before {"balance":227550,"currency":"COIN"}     after {"balance":227560,"currency":"COIN"}
before {"balance":4915,"currency":"DIAMOND"}    after {"balance":4920,"currency":"DIAMOND"}
before {"balance":4900,"currency":"DIAMOND"}    after {"balance":0,"currency":"DIAMOND"}
```

| Column | Source |
|---|---|
| `updatedAt` | `occurredAt` |
| `currency` | `after.currency` |
| `previous` | `before.balance` |
| `updated` | `after.balance` |
| `byAdmin` | `actorId` (raw UUID — no actor name exists anywhere; do not invent a lookup) |

### 🔴 The trap that will break this if you're not careful

**`0` is now a legitimate balance.** TASK-EAR-227 shipped this week specifically so
an admin can set a balance to zero, and the third row above is a real
set-to-zero from that verification.

A falsy check — `after.balance || '-'`, `if (!balance)`, a truthiness guard in a
formatter — **renders a real zero as a dash**, silently reporting that nothing is
known about a balance that is in fact zero. On a money audit trail that is a
worse failure than a crash, because it looks fine.

Use explicit null/undefined checks. `0` renders as `0`. Write a test with a real
`after.balance: 0` row asserting the cell shows `0` and not `-`.

**One PATCH can produce several rows** — the publisher emits one event per
currency that actually moved, by design (per-currency contract, operator-decided).
They are separate rows in the table, which is correct; do not try to merge them.

## Scope 2 — Security (`reset_password`)

Action: `auth.password_reset.send`. Columns: `resetAt`, `sendVia`, `byAdmin`.

**Real observed row:**

```
action     auth.password_reset.send
outcome    succeeded
before     {}
after      {"send_via":"email"}
occurredAt 2026-08-07T17:34:53.013139Z
```

| Column | Source |
|---|---|
| `resetAt` | `occurredAt` |
| `sendVia` | `after.send_via` — currently always `"email"` |
| `byAdmin` | `actorId` |

`before` is `{}` on every row, by design — a reset has no prior state.

`send_via` is a **server-side constant**: email is the only delivery channel that
exists (the SMS radio in the panel is disabled, and the proto carries no channel
field). Render whatever the row says; do not hardcode the string in the FE, and
do not add a fallback that invents a channel when the key is missing — an absent
`send_via` should render `-`.

## Rules

- **Preserve the designed UX** (standing operator rule): columns, order, modal
  chrome, pagination all stay. Data source only — no restyling.
- Server-side pagination from `limit`/`offset` + response `total`, as the other
  four scopes do.
- **Any field with no real source renders `-`** — but see the zero trap above; a
  present `0` is a real source.
- Loader failure → the existing fallback/empty state, **never** mock data.
- Keep filtering `outcome=succeeded`, consistent with the four live scopes. The
  hidden failed/denied rows are a known gap tracked on TASK-EAR-222 and are
  explicitly not this run's to change.
- Delete only the mock rows for these two scopes; leave everything else in
  `app/data/mock.ts` alone.
- **PR only, do NOT merge** — backoffice `main` merge is a real k3s/ArgoCD deploy.
  State that in the PR body.

## Acceptance criteria

- Both scopes render real rows; all six scopes are then live.
- Tests (`tests/*.test.mjs`): the two normalizers, **a `after.balance: 0` row
  rendering `0` not `-`**, an absent `send_via` rendering `-`, multi-currency rows
  from one PATCH appearing as separate rows, and the loader-failure fallback.
- Note `tests/backofficeUiFixes.test.mjs` has one **pre-existing** failure ("Add
  Avatar…") that reproduces on untouched `origin/main` — confirm it is still that
  same single unrelated failure rather than something you caused.
- Authenticated staging smoke with screenshots on player
  `8218a35f-e869-437a-8844-3c97f08ed428` (`test01`), which has real rows for
  **both** scopes as of 2026-08-07 — including a genuine zeroing row and a
  password-reset row. Harness scripts are in `runs/TASK-EAR-222/artifacts/`,
  `runs/TASK-EAR-223/artifacts/` and `runs/TASK-EAR-230/artifacts/`; memory note
  `backoffice-authenticated-smoke`. Login body is `{email, password, requestId}` —
  `email`, not `username`. If the harness cannot run, say exactly why — do not
  fabricate a screenshot.
- ⚠️ **Do not trigger a password reset during the smoke** — it sends a real email
  and the endpoint has no rate limiting. The existing row is enough to render.

## Out of scope

- The `outcome=succeeded` filter (TASK-EAR-222).
- The Export button (still a demo alert).
- Anything backend.
