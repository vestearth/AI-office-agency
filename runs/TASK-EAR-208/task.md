# TASK-EAR-208 — Audit read A2: wire the VIP Level audit scope (proof), other scopes stay mock

## Type

feature

## Priority

medium

## Context

A2 of the audit-read split. **Gated on TASK-EAR-207** (Logs query RPC +
gateway route live on staging).

The player audit modal has 6 scopes sharing one component
(`Games-Labs-backoffice/app/components/PlayerAuditLogModal.vue`, opened via
`app/composables/usePlayerAuditLogModal.ts`, rows from
`app/data/mock.ts:300-382`). Exactly **one** scope has a live publisher
today: `grant_vip` — Games-Labs-User emits `user.vip_level.set` with
before/after `{level, exp}` and full outcome coverage
(`internal/core/handlers/adminuserhdl/grpc.go:249-296`). The other five
(Wallet, Security, E-Voucher, Grant Pass, Missions) emit nothing yet
(TASK-EAR-188 covers Order+Missions; Wallet and Auth have no run at all).

So this run wires **one scope** — proving publisher → sink → API → UI end
to end — and deliberately leaves the rest on mock until their publishers
exist.

## Scope

1. **Composable** (new, following `useAdminPlayerGameActivity.ts` /
   `useAdminPlayerPointHistory.ts` shape — the newer `adminFetch` service
   layer in `app/services/apiClient.ts` is also acceptable; pick one and
   say why): `GET /api/v1/admin/audit-events` with
   `target_user_id`, `actions=user.vip_level.set`, `outcome=succeeded`,
   `limit`, `offset`.
2. **Normalize at the composable boundary** and map to the *existing*
   `grant_vip` column contract (`mock.ts` keys: `id`, `updatedAt`,
   `previousVip`, `updatedVip`, `byAdmin`):
   - `updatedAt` ← `occurredAt` (gateway emits camelCase for typed proto
     fields — the check-in trap; **but `before`/`after` are Struct, so the
     keys inside them stay exactly as the publisher wrote: `level`, `exp`**)
   - `previousVip` ← `before.level`, `updatedVip` ← `after.level`
   - `byAdmin` ← `actorId` — **honest limitation: the event stores only the
     actor's id, no name/email** (no snapshot exists anywhere yet). Render
     the id; do NOT invent a lookup or fabricate a display name. If the
     designed column is too narrow, truncate visually — do not change the
     design.
   - Missing/absent `before` (e.g. a profile read failed at publish time)
     → render "-", never "0" or "null".
3. **Server-side pagination** for this scope: the modal currently slices a
   mock array client-side at 10/page (`PlayerAuditLogModal.vue:39-42`);
   drive it from `limit`/`offset` + the response `total` so the "Showing
   1 to N of M" footer is honest.
4. **Thread the player id into the modal** — it currently receives only a
   display-oriented `player` object; the panels already have
   `:user-id="playerId"`.
5. **Only `grant_vip` changes.** The other five scopes keep their mock
   rows and their current behavior untouched. Loader failure → the
   fallback/empty state the sibling tables already use, never mock data.
6. **Preserve the designed UX** (standing operator rule): columns, order,
   modal chrome, pagination component all stay as designed — data source
   only.

## Acceptance criteria

- Tests in the repo's existing style (`tests/*.test.mjs`): the normalizer
  (before/after key extraction, missing-before → "-", actorId passthrough),
  scope isolation (the other five still return mock), and the failure
  fallback.
- Build/lint scripts green.
- Authenticated staging smoke (pattern in memory
  `backoffice-authenticated-smoke`: playwright-core + system Chrome +
  devtest login, app pointed at the staging gateway): open the devtest
  player's edit page → VIP panel → Audit Log, and show the real VIP change
  rows created by TASK-EAR-181's publisher. Screenshot as evidence. If the
  harness cannot run here, say exactly why and deliver unit tests plus a
  manual checklist — do not fabricate the screenshot.
- ⚠️ PR only, **no merge**: this repo's main merge is a REAL k3s/ArgoCD
  deploy. State that in the PR body.

## Out of scope

- The other five scopes (blocked on their publishers).
- The Export button (still `alert('Export: demo only')` in 5 places) —
  server-side export is its own run once more scopes are live.
- Any actor name/email resolution (needs a gateway metadata + publisher
  decision first).
