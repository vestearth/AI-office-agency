# TASK-EAR-223 — Wire the E-Voucher audit scope to real data

## Type

feature

## Priority

medium

## Context

Fourth and last scope of the audit modal that has a publisher. Follows
TASK-EAR-208 (`grant_vip`) and TASK-EAR-222 (`grant_pass`, `complete_mission`),
both live.

This scope was deliberately excluded from TASK-EAR-222 because Order's publisher
was disabled on staging and the action had never produced a row. TASK-EAR-221
fixed that plumbing and TASK-EAR-219's enrichment was then proven live on
2026-08-07 — **every field below was observed in a real row**, not inferred.

## The real observed row

```
action        order.redemption_item.grant
actorId       f737e6f3-466b-4db5-b86e-70ac4772b660
outcome       succeeded
occurredAt    2026-08-07T07:00:30.545998Z
before        {}                                          <- empty, always
after         redemption_item_id      = 50df69ca-0c3f-4b3e-b740-e7b68de6e5c2
              user_redemption_item_id = fea00b65-fea5-424f-a2d1-f2d441199e67
              voucher_name            = Code Tops E-Voucher 15.-
              valid_until             = 2026-12-31T23:59:59Z
```

`before` is `{}` on every grant, by design — a grant has no prior state.

## Column mapping

Designed columns (`app/data/mock.ts`, `getPlayerAuditLogDefinition`):
`sentAt`, `voucher`, `code`, `available`, `sendVia`, `byAdmin`.

| Column | Source |
|---|---|
| `sentAt` | `occurredAt` |
| `voucher` | `after.voucher_name` |
| `available` | `after.valid_until` — see the format trap below |
| `byAdmin` | `actorId`, raw UUID (no actor name exists anywhere; do not invent a lookup) |
| `code` | 🔴 **permanently `-`** |
| `sendVia` | ⛔ **permanently `-`** |

### 🔴 `code` — permanently a dash, and that is correct

The redeemable voucher code is **deliberately never published**. TASK-EAR-188
forbade it, Order's publisher has a test scanning every audit field for it, and
TASK-EAR-219's live verification confirmed on a real row that no fragment of the
code reaches the store. TASK-EAR-217 is what a secret in this table costs: staff
bearer tokens sat in `admin_actions` for six days and were served over this very
API.

**Render `-`. Do not add a masked or truncated form** — masking is a rendering
decision that cannot be made from data the FE does not have, and asking for the
code to be stored would reverse a security fix closed one day earlier.

### ⛔ `sendVia` — permanently a dash until a product decision

There is no delivery-channel concept anywhere in Games-Labs-Order: granting a
redemption item is not a "send". TASK-EAR-219 grepped `send_via`, `sendvia`,
`delivery_channel`, `send_channel`, `notify_channel` and channel literals — zero
hits. The only adjacent field, `user_redemption_items.source`, is provenance
(`player` / `admin_grant`) and was **correctly rejected** as a substitute.
Render `-`; do not repurpose anything.

### ⚠️ Format trap — `valid_until` is NOT the same shape as `grant_pass`'s `expires_at`

Two scopes in the same modal use two different time encodings:

| Scope | Field | Encoding |
|---|---|---|
| `grant_pass` | `after.expires_at` | **Unix epoch integer** (e.g. `253402559999`) |
| `send_e_voucher` | `after.valid_until` | **RFC3339 string** (`2026-12-31T23:59:59Z`) |

Do not reuse the `grant_pass` formatter unchanged. Handle both explicitly, and
make a wrong-type value render `-` rather than `Invalid Date` or a raw number.

### The `available` column shows a range, we only have an end

The mock renders `12/12/2024-12/01/2025`. The event carries only `valid_until`
(the end). **Render just the end date** rather than inventing a start —
`occurredAt` is when the grant happened, not when the voucher becomes usable, and
presenting it as a range start would assert something untrue.

## Rules

- **Preserve the designed UX**: columns, order, chrome, pagination all stay. Data
  source only.
- Reuse the composable extended by TASK-EAR-222
  (`app/composables/useAdminPlayerAuditEvents.ts`) and its live-scope map — do not
  add a third parallel implementation.
- ⚠️ **`actions` must be sent as REPEATED query params.** The comma-joined form
  returns `total: 0` with HTTP 200 and no error — it reads exactly like "no rows".
  This bit TASK-EAR-222 on its first live probe.
- `before`/`after` keys are **snake_case** (Struct passthrough); top-level typed
  fields are camelCase.
- Server-side pagination from `limit`/`offset` + `total`.
- Loader failure → the existing fallback, never mock.
- Keep filtering `outcome=succeeded`, consistent with the other three scopes. That
  hidden-failed-rows gap is tracked on TASK-EAR-222 and is not this run's to change.
- The two remaining scopes (`manual_wallet`, `reset_password`) stay on mock.
- **PR only, do NOT merge** — backoffice `main` merge is a real k3s/ArgoCD deploy.

## Acceptance criteria

- The scope renders real rows, with `code` and `sendVia` as `-`.
- Tests (`tests/*.test.mjs`): the normalizer, RFC3339 formatting, the permanent
  dashes, a wrong-shaped `valid_until` degrading to `-`, scope isolation (the two
  mock scopes untouched), loader-failure fallback.
- Authenticated staging smoke with a screenshot on player
  `8218a35f-e869-437a-8844-3c97f08ed428` (`test01`), which holds a real granted
  voucher (`fea00b65-…`) as of 2026-08-07. Harness scripts are in
  `runs/TASK-EAR-208/artifacts/`, `runs/TASK-EAR-218/`, `runs/TASK-EAR-222/artifacts/`;
  memory note `backoffice-authenticated-smoke`. Login body is
  `{email, password, requestId}` — `email`, not `username`. If it cannot run, say
  exactly why — do not fabricate a screenshot.

## Out of scope

- `manual_wallet` (Wallet) and `reset_password` (Auth) — no publisher exists;
  Wallet also captures no staff identity at its admin handler.
- Changing the `outcome=succeeded` filter.
- The Export button (still a demo alert in five places).
