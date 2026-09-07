# TASK-EAR-333 — Guests may top up, but may not redeem in Diamonds

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-09-07

## Parent / Epic

- Parent: TASK-EAR-329 (Diamond redemption, live on staging 2026-09-07)
- Epic: Diamond redemption
- Sequence: follows 329. Nothing in 329 blocks this; this closes a policy gap
  329 revealed.

## Goal

A guest account can redeem a DIAMOND-priced redemption item today. Operator
decision 2026-09-07: **guests may top up, but may not redeem with Diamonds.**
Enforce it in Order's redeem path.

## Evidence — there is no guest rule anywhere

Verified across every service on 2026-09-07:

- A guest is only a **naming convention**. `Games-Labs-Auth` writes
  `guest_<uuid>` / `guest_<uuid>@guest.local` with a never-matching password
  hash (`internal/core/repositories/auth.go:246-249`) and publishes
  `source="guest"` on the user-registered event
  (`internal/core/services/authsvc/service.go:417`).
- That value **is persisted**: `user_profiles.source` (User migration 002,
  commented `register, social, guest`), written by `profileRepo.CreateFromEvent`
  and **already read back** into `models.UserProfile.Source`
  (`internal/core/repositories/profile.go:50`). No new column and no migration
  is needed.
- It appears on **no proto**, and **no service reads it as a gate** — Order,
  Wallet and Missions each have zero occurrences.
- `RedeemRedemptionItem` has **no user-level gating of any kind** — no level,
  no VIP, no source. (`CreateRewardOrder`, in the same file, does check
  `level < 5` through `s.ua.GetUserLevel`, so the User adapter is already wired
  into this service.)
- The deposit path has no gate either, so a guest can already obtain diamonds
  through the normal top-up flow — which the operator's decision explicitly
  allows.

## The lane this rides — no proto, no gateway

Order reaches User over **User's internal HTTP mux**, not gRPC:
`useradt.Adapter.GetUserLevel` calls `GET {USER_API_URL}/users/{id}/stats` and
decodes `models.LevelStatsResponse`.

That means the account type can be surfaced by **adding a field to that
existing internal response** — the same shape as the Missions→Wallet HTTP lane.
**No shared-lib bump for the lookup, no proto change, no gateway gate.**

`source` must **not** be exposed on any public message. It is an internal
account attribute; publishing it would leak guest status to clients for no
product reason (compare the VIP-inactive leak on `GetProfile`).

The one cross-repo piece is the **error code** — see below.

## Locked decisions (operator 2026-09-07)

- **Option 2 of three.** Not "guests cannot top up" (too broad, hits every
  purchase path) and not "hide DIAMOND items from guests" — hiding alone is
  **not** a control, since a client can still call the redeem endpoint
  directly. Whether the catalogue should *also* hide them is a separate
  product decision; the refusal is the security primitive either way.
- The gate fires **only for DIAMOND items**. A POINT redeem must take no new
  dependency, no new RPC and no added latency. This is a hard non-regression
  requirement, not an optimisation.
- **Admin grants stay unaffected.** A grant is free in any currency and is the
  admin's deliberate act.

## 🔴 Fail-closed, but distinguishably

If the account-type lookup fails — User down, a 500, or `USER_API_URL` unset —
Order must **refuse the DIAMOND redeem**: this is a money path and failing open
would let exactly the accounts this task blocks through.

But it must **not** report that failure as "you are a guest". `Games-Labs-Game`
already lived this: an unset `USER_API_URL` made `s.ua` nil and every
level-gated launch returned `4009`, the **same code as a real denial**, so a
misconfiguration was indistinguishable from a policy refusal and cost real
debugging time.

So there are three outcomes, not two:

| Outcome | Result |
| --- | --- |
| Registered account, DIAMOND item | Proceed |
| Guest account, DIAMOND item | The new business code below |
| Account type could not be determined | A **system** error, logged loudly, distinct from the guest code |

Deploy must verify `USER_API_URL` is set on the Order task before this ships,
or every diamond redeem fails closed on day one.

## Error code

Clients need to show "register to use Diamonds", which is a different CTA from
"insufficient diamonds". `errormsg.Forbidden` (1001) is too generic to key a UI
on, and the mobile handoff convention is explicitly *"render
`status.description`; do not key UI on the text"* — so the code has to carry
the meaning.

Add one code to `shared-lib/errors/errormsg.go` beside
`InsufficientDiamondBalance` (6014). That is the only reason this run touches
shared-lib, and it needs the usual publish-then-bump.

**If the operator would rather not pay a publish cycle for one constant**, the
fallback is `Forbidden` (1001) with a specific description, which collapses the
run to two repos. State the choice before Gate 1 rather than after.

## Gates

| # | Repo | Work |
| --- | --- | --- |
| 1 | `shared-lib` | One new error code beside 6014. Regenerate if needed, **stop for publish.** |
| 2 | `Games-Labs-User` | Add the account type to `LevelStatsResponse` (`GET /users/{id}/stats`) from the already-read `user_profiles.source`. Internal mux only; nothing public. |
| 3 | `Games-Labs-Order` | Bump; extend `ports.UserAdapter` and `useradt`; gate `RedeemRedemptionItem` on it **only when the resolved currency is DIAMOND**, before the attempt row is created. |
| 4 | handoff | Append to the mobile handoff note: the new code, its CTA, and that POINT redemption is unaffected. |

No api-gateway gate: no public route or public message changes, and an error
code is a value on the existing envelope rather than a wire change.

## Acceptance criteria

1. A guest redeeming a DIAMOND item is refused with the new code, and **no
   wallet debit and no attempt row** occur.
2. A registered account redeeming a DIAMOND item is unaffected.
3. A POINT redeem — guest or not — makes **no** call to User; proven by a test
   that fails the adapter and still expects success.
4. A failed account-type lookup refuses the DIAMOND redeem with a **system**
   error distinct from the guest code, and logs it.
5. Admin grants of a DIAMOND item are unaffected.
6. `source` appears on no public message.
7. Tests RED first at each gate; Order's integration suite runs against a real
   Postgres.

## Non-goals

- Blocking guest top-up (option 1) or hiding DIAMOND items from the guest
  catalogue (option 3).
- Any other guest restriction — this run does not invent a general guest
  policy, only the one the operator asked for.
- `redemption_items.level_id`, which is stored and settable but enforced
  nowhere. Same code path, separate defect, already raised on its own task.
