# TASK-EAR-225 — Retire `actor_access` entirely: column, contract field, and its misleading doc

## Type

fix / security-cleanup

## Priority

medium

## Context

TASK-EAR-217 stopped the audit trail storing and serving the acting admin's raw
bearer token. That fix was deliberately minimal — publishers stopped setting the
field and the read handler stopped mapping it — but three things were left behind
on purpose so the urgent mitigation would not be blocked behind a multi-repo
contract dance:

1. `admin_actions.actor_access VARCHAR(64)` still exists (values purged to NULL).
2. `events.AdminActionEvent.ActorAccess` still exists in shared-lib.
3. `adminlogpb`'s `string actor_access = 5;` is still in the proto.

And the reason this ever looked benign is still in the codebase:
`shared-lib/events/admin_action.go:54` documents the field as *"ActorRole/
ActorAccess capture the privilege actually used"* — which reads as an access
**tier**, not a token. That comment will keep misleading readers until it is gone.

**Why now:** prod does not have this epic at all (Games-Labs-Logs `origin/prod`
is at 2026-07-01 with only migrations 001–002; no `admin_actions` table, no
publisher on any prod service). Retiring the field **before** the prod rollout
means prod is never given the column that held tokens, rather than inheriting it
and needing a cleanup pass later.

## The trap that dictates the whole plan

`internal/core/repositories/admin_actions.go:46` — the consumer's INSERT **names
the column explicitly**:

```sql
INSERT INTO admin_actions (
  event_id, schema_version,
  actor_id, actor_role, actor_access,
  ...
```

`admin_actions_list.go:131` selects it too.

ECS deploys are rolling. **If the column is dropped while old containers are
still running that INSERT, their inserts fail and audit rows are silently lost
for the length of the rollout.** An audit trail with a hole in it is worse than
the cosmetic problem this run exists to fix.

So the drop must not share a deploy with the code that still references the
column.

## Plan — three stages, in this order

### Stage 1 — stop referencing the column (Games-Labs-Logs, PR → `staging`)

- Remove `actor_access` from the INSERT (`admin_actions.go`) and from the SELECT
  (`admin_actions_list.go`), and from the model.
- The column still exists and simply goes unwritten. **Deploy this and let it
  settle before stage 3.**
- Keep the `ActorAccess` field on the Go struct for now — that is stage 2's job,
  and coupling them would drag the shared-lib gate into this stage.

### Stage 2 — remove it from the contract (shared-lib, standalone PR)

- Delete `ActorAccess` from `events/admin_action.go` **and fix the doc comment at
  line 54** — that false description is half the reason this run exists.
- In `proto/admin/adminlogpb/adminlog.proto`, replace `string actor_access = 5;`
  with `reserved 5;` and `reserved "actor_access";`. **Never renumber the other
  fields.** Regenerate with `make buf`; never hand-edit generated files.
- **This is a publish-gate run (AGENTS.md:275): stop after opening the PR.**
  Downstream repos cannot bump until the operator merges it.
- Then bump and clean up the four consumers of the field: Games-Labs-Logs,
  Games-Labs-Order, Games-Labs-User, Games-Labs-Missions. Each currently has a
  SECURITY comment explaining why the field is not set — **rewrite those comments
  rather than deleting them outright**; the reasoning (td.Access is a raw token on
  the staff path, not a tier) is what stops someone reintroducing it, and it stays
  true even once the field is gone.

### Stage 3 — drop the column (Games-Labs-Logs migration, PR → `staging`)

- New migration `004_drop_admin_actions_actor_access.sql`:
  `ALTER TABLE admin_actions DROP COLUMN IF EXISTS actor_access;`
- ⚠️ **Logs replays every embedded `.sql` on every boot** — `migrations/run.go`
  uses `//go:embed *.sql` and iterates, with no version table. Every statement
  must be idempotent; `IF EXISTS` is required, not optional.
- Must deploy **after** stage 1 is live. State the deploy order and the rollback
  (re-add the column as nullable; no data to restore, the values were purged and
  nothing reads them) in the PR body.

## Non-negotiables

- **No hole in the audit trail.** If at any point you are unsure whether a stage
  is safe to deploy alongside another, split it further rather than combining.
- Do not renumber proto fields; reserve.
- Do not hand-edit generated protobuf code.
- Do not touch `.github/workflows/*` — pushes there are rejected for lack of
  `workflow` OAuth scope; this has blocked the epic five times.
- Publishers must still never set the field while it exists.
- PRs base `staging` for the services; shared-lib follows its own gate.

## Acceptance criteria

- Stage 1 merged and deployed before stage 3 is merged. Say explicitly in each PR
  which stage it is and what must already be live.
- `go build` / `go vet` / `go test ./...` green in every touched repo.
- A test proving audit rows still insert and read correctly with the column
  unreferenced (stage 1) and then absent (stage 3).
- Live check on staging after stage 3: perform an admin action that publishes
  (e.g. a VIP level set or a pass grant) and confirm the row still lands and is
  readable through `GET /api/v1/admin/audit-events`. ⚠️ `actions` must be sent as
  **repeated** query params — comma-joined returns `total: 0` silently.
- The misleading doc comment is gone.

## Out of scope

- Rolling the audit epic to prod — its own effort, belongs with the planned
  consolidated prod patch.
- Rotating any staff token that appeared in the table (operator's call).
- The `manual_wallet` / `reset_password` scopes, which have no publisher.
