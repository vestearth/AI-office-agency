# TASK-EAR-118 — Surface `collection` on Missions ListAvatars / AvatarItem

## Context

Operator reviewed the mobile Store screen (Store > "Special" tab: Special Pass
+ Limited Avatar, with "Collection A / Collection B / Collection C" filter
tabs) and asked whether the collection grouping is API-backed for Mobile.

Investigation (Explore agent, 2026-07-15) found:

- `GET /api/v1/store/avatars` (Missions, gateway-proxied) already returns the
  full avatar catalog, but `models.AvatarItem` has no collection field.
- The **collection concept already exists end-to-end** on the Order side:
  `Collection{ID, Name}` entity + `special_items.collection_id` FK
  (`Games-Labs-Order/internal/models/special_item.go:36-48`, migrations 019 +
  025), full admin CRUD (`adminorderhdl.go:1675-1820`), and a working
  Backoffice UI (`Games-Labs-backoffice/app/pages/admin/manage/store/items.vue`,
  `.../avatar/edit/[id].vue`).
- The shared-lib proto already carries it: `weborderpb.CatalogItem.collection`
  (field 22, `CatalogCollection{id, name}`) is already generated in the
  shared-lib version Missions currently pins
  (`v0.0.0-20260713095201-deff7aee266b`) — **no proto/shared-lib bump
  needed**.
- `Order`'s `toWebCatalogItem` (`weborderhdl/grpc.go:129-163`) already sets
  `response.Collection` when `CollectionID != ""` — the data is already on
  the wire, just not read by Missions.

So this is a **pure Missions-side read-path wiring gap**, single repo, no
migration, no proto change, no backoffice change.

## Scope

In `Games-Labs-Missions`:

1. `internal/models/models.go` — add `CollectionID`/`CollectionName` to
   `CanonicalStoreItem` (~line 223-247) and to `AvatarItem` (~line 208-221,
   JSON as nested `collection: {id, name}` to mirror the proto shape and the
   `CatalogCollection` naming Order/Backoffice already use).
2. `internal/clients/order/catalog_client.go` `mapCatalogItem` (~line 117) —
   map `item.GetCollection().GetId()` / `.GetName()`, guarding nil.
3. `internal/services/store_service.go` `canonicalAvatarItem` (~line 1116) —
   pass the new fields through into the response.
4. Passes (`canonicalPassItem`/`PassItem`) are explicitly **out of scope** —
   the mobile screenshot only showed collection tabs under "Limited Avatar",
   and `ListLimitedAvatar`'s `Collection` field in weborderpb is a different
   (count) semantic not relevant here; PassItem gets no change.
5. Add/extend a unit test for `canonicalAvatarItem`/`mapCatalogItem` covering
   collection passthrough (including the nil-collection case, since
   `CollectionID` is nullable in Order's schema).

## Owner / path resolution

Single-repo (Games-Labs-Missions), no migration, no proto/shared-lib bump, no
production-infra, no cross-service contract change (Order already emits the
field) — stays lightweight per AGENTS.md tripwire, no formal-run escalation.
