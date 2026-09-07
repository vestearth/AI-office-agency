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

## 🔄 Re-scoped 2026-09-08 — the source of truth moved from User to Auth

The original plan read `user_profiles.source` through User. Staging evidence
killed it:

- A census showed `blank = 0` on staging (register 42, guest 35, social 0), so
  the "what does blank mean" question is settled — but `guest.last_seen` was
  **2026-09-05** while three guests minted on 09-07 and 09-08 were **absent**.
  A targeted lookup of their ids returned `found = 0`.
- The cause is in source: `publishUserRegisteredAsync`
  (`authsvc/service.go:137`) is **fire-and-forget** — `go func()`, a 2s
  timeout, failure only logged, and a silent no-op when the publisher is nil.
  `user_profiles` rows are created **only** by the RabbitMQ `user.registered`
  consumer and **nothing backfills** them.

So `user_profiles.source` is a **best-effort projection**. Gating a money path
on it means a registered, paying customer whose event was dropped months ago is
refused a diamond redemption — and a guest with no row is refused for the wrong
reason with the wrong client message.

**Operator decision 2026-09-08: ask Auth instead.** Auth is the system of record
for account creation and can answer synchronously, with no dependency on a
message having been delivered.

Auth today has **no account-type column** — `users` is
`id/username/email/phone/password_hash/status/user_roles/…`. Guest-ness exists
only as a naming convention. So this becomes a real column, not just a new
read:

- `CreateGuestUser` writes `username = 'guest_<uuid>'`,
  `email = 'guest_<uuid>@guest.local'` and a fixed placeholder
  `password_hash` (`internal/core/repositories/auth.go:244`). All three are
  server-generated and not user-controllable, which makes them a sound
  **backfill** signal — but a fragile thing to gate on forever.
- Social accounts are identified by a row in `user_social_accounts`.

Gate 2's `account_source` on User's stats read is now **off this critical
path**. It is merged, additive and harmless, and still useful to Backoffice and
analytics — but nothing in this epic consumes it. Keep or revert is the
operator's call; it is recorded here so it is not mistaken for the gate's input.

## Gates

| # | Repo | Work | State |
| --- | --- | --- | --- |
| 1 | `shared-lib` | Error codes 5035 / 5036 beside 6014. | ✅ merged, published |
| 2 | `Games-Labs-User` | `account_source` + `account_source_known` on the internal stats read. | ✅ merged — **now off the critical path**, see above |
| 3 | `shared-lib` | Internal `GetAccountType` RPC on `AuthService`, **no `google.api.http` annotation** — the same shape as `VerifyToken`. **Stop for publish.** | ← current |
| 4 | `Games-Labs-Auth` | Migration adding `users.account_source` with an idempotent backfill from the naming convention; write it on all three creation paths; implement the RPC. | |
| 5 | `Games-Labs-Order` | Bump; extend the **existing** `authadt` gRPC adapter (`AUTH_API_URL`); gate `RedeemRedemptionItem` **only when the resolved currency is DIAMOND**, before the attempt row is created. | |
| 6 | handoff | Append the codes and the CTA to the mobile handoff note. | |

Still no api-gateway gate: the new RPC carries no HTTP annotation, so no public
route or public message changes.

No api-gateway gate: no public route or public message changes, and an error
code is a value on the existing envelope rather than a wire change.

## Acceptance criteria

1. A guest redeeming a DIAMOND item is refused with the new code, and **no
   wallet debit and no attempt row** occur.
2. A registered account redeeming a DIAMOND item is unaffected.
3. A POINT redeem — guest or not — makes **no** call to Auth; proven by a test
   that fails the adapter and still expects success.
4. A failed account-type lookup refuses the DIAMOND redeem with a **system**
   error distinct from the guest code, and logs it.
5. Admin grants of a DIAMOND item are unaffected.
6. The account type appears on no public message and no public route.
7. The Auth backfill is idempotent and correctly classifies existing guest,
   social and registered rows.
7. Tests RED first at each gate; Order's integration suite runs against a real
   Postgres.

## Non-goals

- Blocking guest top-up (option 1) or hiding DIAMOND items from the guest
  catalogue (option 3).
- Any other guest restriction — this run does not invent a general guest
  policy, only the one the operator asked for.
- `redemption_items.level_id`, which is stored and settable but enforced
  nowhere. Same code path, separate defect, already raised on its own task.
