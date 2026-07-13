# TASK-EAR-096: Approve Store Items canonical catalog and product contract

## PM Contract

- Short name: `store-items-contract-decision`
- Epic: Store Items canonical catalog rollout
- Type / workstream / priority: investigation / general / high
- Parent: none
- Status: decision complete on 2026-07-13. Implementation is delegated to child
  tasks; this card authorizes no product-code changes itself.

## Outcome

Approve one source-of-truth and field/ID contract for Backoffice, Website,
Mobile, Missions and Coupon before any implementation child starts. The PM
recommendation is Order `special_items` as the canonical catalog, Missions as
purchase/grant and user-inventory owner, and API/gRPC access instead of cross-DB
reads or dual writes.

## Scope and evidence

- `Games-Labs-Order`: `special_items`, collections, AdminOrder CRUD and Website list APIs.
- `Games-Labs-Missions`: `store_passes`, in-memory Avatar catalog and Mobile buy/list behavior.
- `shared-lib`: AdminOrder/WebOrder/Missions contracts.
- `Games-Labs-backoffice`: current Store Items/Avatar/Pass UI fields.
- Reference plan: `knowledge-base/Knowledge Base/10 Projects/Games Labs Backoffice/Store Items API Checklist and Plan.md` (read only).

## Locked decisions — operator 2026-07-13

1. Order `special_items` is the canonical catalog.
2. Missions owns purchase, grant and user inventory, and reads the canonical
   catalog from Order through API/gRPC; no cross-database reads.
3. Pass subtype, Detail From/To and Game Support are real persisted behavior,
   not display-only UI.
4. Collection is optional for `item_type=pass`; Avatar may keep its Collection
   requirement.
5. Description is localized and must round-trip all supported locales.

## Locked legacy-ID decision — operator 2026-07-13

Use an additive alias table rather than changing primary IDs or dual-writing
catalogs:

```text
special_item_aliases
  source_system   // e.g. missions
  legacy_id       // e.g. pass_golden
  special_item_id // canonical Order UUID
  item_type
```

- unique `(source_system, legacy_id)` and index `special_item_id`
- backfill canonical Order rows for existing Missions Pass/Avatar entries
- Missions accepts legacy IDs during migration, resolves through Order, and
  performs purchase/grant with the canonical UUID
- public responses return canonical UUID; `legacy_id` is temporary compatibility
- after cutover, catalog writes occur only in Order; aliases remain read-only

The operator approved this alias-table and cutover approach. It preserves old
client links and gives rollback a reversible mapping without a second mutable
catalog.

## Acceptance criteria

- One approved matrix names catalog, purchase, grant and inventory owners.
- Pass, Avatar, Collection, VIP UUID, localization and stable-ID semantics are explicit.
- Existing Missions IDs have a no-dual-write migration/compatibility rule.
- Child tasks TASK-EAR-097 through TASK-EAR-100 can implement without inventing product choices.
- Decision evidence and approver/date are recorded in this run before the task advances.

## Plan and verification

1. Reconfirm current contracts and data sources from repository source.
2. Present the recommendation and alternatives to the operator.
3. Record approval of the alias-table compatibility approach.
4. Close this decision gate and unblock TASK-EAR-097.
5. Child implementers verify every assumption against this approved matrix.

Risks: choosing Missions as catalog owner conflicts with existing AdminOrder,
Website and Coupon references; dual writes create drift; ID remapping can break
owned items. Mitigate with one owner, stable IDs and explicit compatibility.
