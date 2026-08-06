# TASK-EAR-219 — Enrich audit publishers so the E-Voucher / Grant Pass / Missions modal columns can be filled

## Type

feature

## Priority

medium

## Context

The player audit modal has 6 scopes. `grant_vip` is wired to real data
(TASK-EAR-208, live). Three more now have publishers shipped under TASK-EAR-188:

| Scope | Action(s) | Publisher |
|---|---|---|
| E-Voucher | `order.redemption_item.grant` | Games-Labs-Order |
| Grant Pass | `mission.pass.grant` | Games-Labs-Missions |
| Missions | `mission.daily.reset`, `mission.streak.reset`, force-complete | Games-Labs-Missions |

**But the events do not carry enough to fill the designed columns.** Wiring the
FE first would produce tables that are mostly `-`. The operator chose to enrich
the publishers first, then wire the FE as a follow-up run.

**This run is backend only. No FE work.**

## What each scope needs, measured against what is emitted today

Designed columns are in `Games-Labs-backoffice/app/data/mock.ts`
(`getPlayerAuditLogDefinition`), with sample rows showing intended semantics.

### E-Voucher — `order.redemption_item.grant` (Games-Labs-Order)

Columns: `sentAt`, `voucher`, `code`, `available`, `sendVia`, `byAdmin`.
Emitted today: `after{redemption_item_id, user_redemption_item_id}`.

| Column | Status | Source |
|---|---|---|
| `sentAt` | ✅ have | `occurredAt` |
| `byAdmin` | ✅ have | `actorId` |
| `voucher` | ➕ **add** | `models.RedemptionItem.Name` |
| `available` | ➕ **add** | `models.UserRedemptionItem.ValidUntil` |
| `code` | 🔴 **NEVER** | see below |
| `sendVia` | ⛔ **no source** | see below |

🔴 **`code` must never be published.** `UserRedemptionItem.Code` is the
redeemable value. TASK-EAR-188 forbade it explicitly and this package already
has a test scanning every audit field for the code. TASK-EAR-217 is the live
proof of what happens when a secret reaches this store: staff bearer tokens sat
in `admin_actions` for six days and were served over the read API. **Do not add
the code. Do not add a "masked" code either** — masking is a display concern and
the store is the wrong place to decide it.

⛔ **`sendVia` (Email/SMS/APP) has no source.** Grepped `origin/staging` for
`sendvia`/`send_via`/`delivery_channel` in Games-Labs-Order: zero hits. Granting
a redemption item is not a "send" and carries no channel. **Do not invent one and
do not guess a default.** Report it as a product gap; the FE run will render `-`.

### Grant Pass — `mission.pass.grant` (Games-Labs-Missions)

Columns: `updatedAt`, `specialPass`, `previous`, `updated`, `remaining`, `byAdmin`.
Sample row: `specialPass: 'Golden Pass'`, `previous: '-'`, `updated: '7d'`,
`remaining: '2d 10:21'`.
Emitted today: `before{pass_type, had_active_pass, expires_at?}`,
`after{pass_type, days_added}`.

| Column | Status | Notes |
|---|---|---|
| `updatedAt`, `byAdmin` | ✅ have | |
| `updated` | ✅ have | `after.days_added` |
| `previous` | ~ partial | `before.had_active_pass` / `before.expires_at` |
| `specialPass` | ➕ **add** | display name — `pass_type` is a key (`golden_pass`), the design shows `Golden Pass`. `store_repo.go` carries `item_name` on store operations; find the right lookup or say plainly there isn't one |
| `remaining` | ➕ **add** | needs the **post-grant** `expires_at`. `ActiveUserPasses` is read only *before* the grant today |

### Missions — force-complete and the reset actions (Games-Labs-Missions)

Columns: `updatedAt`, `mission`, `previous`, `updated`, `byAdmin`.
Sample row: `mission: 'Play 2 Games'`, `previous: '1'`, `updated: '3'` — a
**numeric progress**, not a boolean.
Emitted today: `before{type, mission_id?, is_complete?, claimed?,
monthly_completed?, reward_claimed?}`, `after{type, mission_id, claim_reward,
completed}`.

| Column | Status | Notes |
|---|---|---|
| `updatedAt`, `byAdmin` | ✅ have | |
| `mission` | ➕ **add** | a title. Only `mission_id` is emitted. Note TASK-EAR-204/211: a mission's display name resolves from the **live plan row**, template is fallback — reuse that resolution, do not re-derive it |
| `previous` / `updated` | ➕ **add** | numeric progress before and after. Only booleans today |

Decide and state how the three actions map onto this one scope — the FE run needs
to know, and the modal title is "Update mission progress".

## Non-negotiables (carried from TASK-EAR-181/188/217)

- Publishing must **never block or fail** the admin write. Any new read added to
  gather these fields must not turn a successful grant into a failure — if the
  enrichment read errors, publish without the field.
- Actor from gateway-validated metadata, never the request body.
- **Never set `ActorAccess`** (TASK-EAR-217). Comments explaining why are already
  in each `audit.go`; leave them.
- No secrets, codes, credentials or tokens in `before`/`after`. Ever.
- Before-state must be the **stored** value, not a display value.
- New env vars stay strings parsed in accessors (`ecs/env.names` empty-string
  trap crashed a deploy on 2026-07-31).
- Do **not** touch `.github/workflows/*` — pushes touching those are rejected for
  lack of `workflow` OAuth scope; it has blocked this epic four times.

## Acceptance criteria

- Each added field appears in the published event, proven by tests.
- Enrichment-read failure degrades to a published event **without** that field,
  never to a failed admin write — with a test.
- `code` and any other secret still cannot reach the event (keep/extend the
  existing scanning test in Order).
- Anything you could not source is **listed with the reason**, not silently
  dropped and not invented. Expect at least `sendVia`.
- `go build` / `go vet` / `go test ./...` green in both repos. PRs base `staging`.
- Verify on staging by performing each action and reading the resulting
  `admin_actions` row — not by unit tests alone. If staging is unreachable, say
  so plainly rather than fabricating.

## Out of scope

- All FE wiring — the follow-up run.
- `manual_wallet` (Wallet) and `reset_password` (Auth): no publisher exists at
  all; Wallet additionally has no staff-identity capture. Separate runs.
- Dropping the now-unused `actor_access` contract field.
