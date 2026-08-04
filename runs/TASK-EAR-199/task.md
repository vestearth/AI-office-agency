# TASK-EAR-199 — Keep non-active games out of the player VIP level games list

## Request

Stop serving games that are not `active` to players through the VIP level games
list, and stop offering them in the Backoffice **Add Game** picker — without
hiding stale membership from Backoffice.

**Approach is decided, not open: Option 1 — carry the member's game status in the
contract and let each caller filter.** An `active_only` RPC flag was rejected: it
satisfies the player side but leaves Backoffice with no signal that a stale
member exists, which is an explicit goal of this run.

## Observed behavior

- Backoffice Game List shows `Drop The Ceo` (GGSoft, ARCADE, VIP5) with status
  **Inactive** and no image.
- That same game is a member of the VIP5 level group and is returned to an
  authenticated player: `GET /api/v1/vip-levels/5` answers `200` with 20 games,
  including `Drop The Ceo` at `sort_order` 6 with `gameImageUrl: ""`.
- The mobile VIP 5 screen fails with "Unable to load category games". The
  operator traced the client-side failure to that empty image URL.
- This became visible only after TASK-EAR-197 restored configured games to the
  public read; before that the player-facing list was always empty, so neither
  the inactive member nor the empty image could ever be reached.

## Source evidence

- `Games-Labs-Game/internal/core/repositories/level_group.go:452` —
  `listLevelGroupGamesInGroup` LEFT JOINs `games` with **no status condition**, so
  a game deactivated *after* being added to a level group keeps being returned.
- `Games-Labs-Game/internal/core/repositories/game.go:315` — `List` applies a
  status condition only when the caller supplies one, and both Backoffice picker
  call sites pass `excludeInLevelGroup` only, so `pending` / `inactive` /
  `maintain` games are all offered.
- `Games-Labs-Game/migrations/001_games_table.sql:19` — `games.status` is
  `pending|active|inactive|maintain` defaulting to `pending`, so freshly
  imported games are offered by the picker too. **No migration is needed for
  this run**; the column already exists.
- `shared-lib` — neither `LevelGroupGame` message carries status:
  `proto/admin/admingamepb/admingame.proto:730` and `proto/gamepb/game.proto:311`.
  `Games-Labs-User` therefore cannot filter today; it never receives the value.

### The duplicated route, and which service actually serves it

`GET /api/v1/admin/group/level-games/{group_id}` — the route the Group Edit page
uses — is declared **twice**, in two different services' protos:

- `shared-lib/proto/gamepb/game.proto:82` (legacy `GameService`)
- `shared-lib/proto/admin/admingamepb/admingame.proto:94` (`AdminGameService`)

**`AdminGameService` wins, so both Backoffice surfaces travel the `admingamepb`
lane.** The gateway registers `GameService` at `api-gateway/gateway/grpc.go:83`
and `AdminGameService` at `:91`, and grpc-gateway v2.27.7 **prepends** each new
handler — `s.handlers[meth] = append([]handler{{pat, h}}, s.handlers[meth]...)`
at `runtime/mux.go:362` — so the **last** registration is matched first. The
`gamepb` HTTP binding for this path is therefore shadowed and unreachable
through the gateway.

Two earlier drafts of this task got this wrong in opposite directions: first by
claiming the two Backoffice surfaces "share one RPC", then by claiming
first-registration-wins routing sent Group Edit to the legacy service. Both
corrected here against the vendored mux source.

Consequence for scope: `gamepb.LevelGroupGame` still gets the field and mapper,
but **only as parity for legacy direct-gRPC consumers** — it must not be
described or tested as the Backoffice HTTP route. If that parity is kept, it
needs its own direct-gRPC test; otherwise it is dead weight that will drift.

## Goal

Players see only active games in a VIP level. Backoffice keeps seeing every group
member together with its status on **both** of its surfaces, so stale membership
stays visible and can be cleaned up. Non-active games cannot be added to a level
group in the first place.

## Mandatory requirements

1. **Contract — both messages, both mappers.** Add `string game_status = 8` to
   `admingamepb.LevelGroupGame` (`admingame.proto:730`) *and*
   `gamepb.LevelGroupGame` (`game.proto:311`), and populate it in both proto
   mappers (`admingamehdl/grpc.go:268`, `gamehdl/grpc.go:402`). Field number 8 is
   free in both messages. The `gamepb` copy is legacy direct-gRPC parity only —
   see the routing note above — and carries its own direct-gRPC test.
   **Over HTTP the field is `gameStatus`**, camelCase, exactly like the existing
   `gameImageUrl`; `game_status` is the proto name and never appears in a JSON
   payload.
2. **Game service — every result path, not just the shared list query.** Status
   must be present in the list path (`level_group.go:452`), the get-by-id path,
   and the result returned after create. A member fetched one way and the same
   member fetched another way must not disagree.
3. **Assignment guard — inside the transaction, with the right status code.**
   On `CreateLevelGameGroup`, lock/read the game's status and reject anything
   that is not `active` *before* any membership delete or insert, so a rejected
   request **creates no new membership and moves no existing one**. Note the
   distinction: a non-active game may already hold stale membership from before
   this rule existed, so the assertion is that the rejected request leaves the
   prior mapping byte-for-byte as it was — not that the game has no membership
   at all. The handler at `admingamehdl/grpc.go:1261` must map the new error
   explicitly to the invalid-request envelope; its current fallthrough is
   `statusCodeInternal`, so an unmapped error turns a validation failure into a
   500.
   **Envelope code, reviewed and settled:** this is `status.code = 1002`, not a
   literal `400`. `statusCodeInvalidRequest = 400` is only an internal class
   constant; `statusErr()` translates it to `errormsg.ErrorInvalidRequest`, whose
   envelope code is 1002, and every other validation error in this handler
   answers that way. Forcing a literal 400 would drop this one endpoint out of
   the contract its siblings share.
4. **Backoffice — two picker call sites and real four-state rendering.** The
   picker exists twice: `useVipLevelGames.ts:163` and an independent URL builder
   on the Group Edit page (`app/pages/admin/games/group/edit/[id].vue:176`).
   Both must request active games only. Rendering must handle all four states —
   today `useVipLevelGames.ts:10` types status as `'Active' | 'Inactive'` and
   lines 259 and 280 **default unknown values to `'Active'`**, so a `pending` or
   `maintain` game would display as Active. Reuse the four-state pattern from
   `useAdminProviderApi.ts` rather than extending the two-state collapse.
5. **User service — filter only, do not widen the response.** Filter to
   `active` after receiving status from Game (`usersvc/service.go:647`), and do
   **not** map the received status into the public payload, where it would
   surface as `gameStatus`. The only intended change to
   a successful public response is that non-active entries are absent.

## Rollout order (strict)

`shared-lib` publish → `Games-Labs-Game` → `api-gateway` → `Games-Labs-User`
strict filter → `Games-Labs-backoffice`.

**Never deploy the User filter before Game.** An older Game build returns an
empty `game_status`, and a strict `active`-only filter would then drop every
game — turning this fix into a total blackout of VIP games, which is a worse
version of the bug TASK-EAR-197 just closed.

The three consumers are currently pinned to **three different shared-lib
pseudo-versions**, verified in `go.mod`:

| repo | shared-lib |
|---|---|
| Games-Labs-Game | `v0.0.0-20260731150247-0e4294344367` |
| Games-Labs-User | `v0.0.0-20260731102805-b3198f8f0a1e` |
| api-gateway | `v0.0.0-20260730050034-4b9d68056699` |

All three must be locked to one new version and built with `-mod=readonly` in
every repository. Behavior is proven by endpoint response, never by a green
build — this workspace has been bitten by gateway/shared-lib lane mismatches
four times.

## Scope

- Included: `shared-lib` (both messages + regeneration), `Games-Labs-Game`,
  `Games-Labs-User`, `Games-Labs-backoffice`, and focused tests in each.
- Excluded:
  - Data edits. Whether `Drop The Ceo` is removed from the VIP5 group or
    activated is an ops decision.
  - The mobile client's empty-image guard — dev/mobile lane. Held out
    deliberately: the payload/contract defect is confirmed from source, but no
    mobile stack trace has been seen, so it is not established as the single
    root cause of that dialog. An active game may also legitimately have no
    image, so the client needs the guard regardless of this run.
  - Database migrations — `games.status` already exists.
  - Production deployment.

## Constraints

- Do not hide stale membership from Backoffice; filtering is decided per caller.
- Preserve `sort_order` and the existing public response shape.
- Do not weaken or reinterpret TASK-EAR-197's scope; that run stays closed.

## Acceptance criteria

1. All three non-active states are covered: a `pending`, an `inactive`, and a
   `maintain` member are each absent from `GET /api/v1/vip-levels/{level}`.
2. A direct `POST /api/v1/admin/group/level-games` with a non-active game
   answers the invalid-request envelope — `status.code = 1002` — **and** creates
   no new membership and moves no existing one — asserted on the data, by comparing the game's membership rows
   before and after. A stale pre-existing membership must still be there,
   unchanged; its presence is not a failure of this criterion.
3. Staff still sees the stale member through **both** Backoffice surfaces,
   `GET /api/v1/admin/group/level-games/{groupId}` and
   `GET /api/v1/admin/group/level-games/by-level/{level}` — both served by
   `AdminGameService` — each carrying `gameStatus` in the JSON. The `gamepb`
   parity mapper is proven separately by a direct-gRPC test, not through HTTP.
4. The public payload never contains `gameStatus`; its shape is otherwise
   unchanged from the current response.
5. Backoffice renders all four states distinctly and offers only active games in
   both pickers.
6. Focused tests pass and `-mod=readonly` builds pass in every touched
   repository.
7. Staging: the VIP5 public payload no longer contains `Drop The Ceo`, while
   Backoffice still shows it in the group with a non-active badge. Recorded per
   environment with the API host stated.

## Suggested ownership

Assign `dev-2` sequentially. Small code, but it crosses a shared-lib contract,
two protos serving one duplicated route, two services, the Backoffice, and a
strict deploy order where the wrong sequence blanks VIP games for every player.

## Origin

Found while verifying TASK-EAR-197 on staging. EAR-197 stopped the public VIP
read from silently swallowing failures; these gaps were underneath it and had
been unreachable while the list was always empty. Related audit:
`ai-dev-office/knowledge-reviews/20260803T042041Z-games-labs-vip-level-public-games.yaml`.
