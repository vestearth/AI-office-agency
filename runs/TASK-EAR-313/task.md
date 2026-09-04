# TASK-EAR-313: Preserve redemption Link format

User approved both implementation and knowledge update on 2026-09-04.
Item reported: `0076348f-5e3a-4c0d-933f-3161df8c4fcc` (live record not verified).

## Scope and sequence

1. `shared-lib/proto/admin/adminorderpb/adminorder.proto`,
   `shared-lib/proto/orderpb/order.proto`, their generated artifacts, existing
   contract tests, and README: add persisted-format contract `is_link`.
2. Stop for user publication of shared-lib before downstream implementation.
3. After publication: Order redemption models/handlers/repository and a new
   idempotent migration; bump shared-lib in Order/Gateway with tidy; verify
   Backoffice create/edit/save/reload and existing code imports.
4. Update `knowledge-base/Knowledge Base/20 Flows/Backoffice API Gap Inventory.md`
   and its unresolved runtime question in `Knowledge Base/Review Queue.md`.

Publication authorization updated 2026-09-04: user approved commit, push and PR
for the shared-lib contract only. User owns merge/deploy. No deployment,
production changes, Android writes, or email delivery implementation authorized.

## Compatibility and acceptance

- Create omitted/false is_link remains Code; true means Link.
- Update optional is_link: omitted preserves existing format; explicit false
  selects Code; true selects Link. Legacy clients must not clear Link silently.
- RedemptionItem response uses isLink JSON and leaves all existing fields intact.
- Link values remain in the existing code list; format does not send email,
  fetch a URL, or alter redemption/point/claim behavior.
- Existing records default to Code without inferring a historical format from
  code text. Order implementation must document migration and rollback.
- Contract tests cover JSON aliases, presence, wire roundtrips and defaults;
  generated artifacts are regenerated, not hand edited.
- Final acceptance requires authenticated create/save/reload for Link and Code,
  legacy update preservation, import behavior, and deployed-version evidence.
  Contract-only checks are not runtime acceptance.

## Diagnosis evidence

Backoffice create sends is_link; edit sends it then hydrates from the response.
resolveFormatLabel defaults to Code when isLink/format is absent. The inspected
pre-change shared-lib Create/Update/RedemptionItem contracts and Order models
and repository do not carry this field. This explains the source-level gap,
not the exact deployed state of the reported item.

## Shared-lib PR handoff — 2026-09-04

- Commit: `3a8e372` on `task/TASK-EAR-313-redemption-link-contract`.
- PR: https://github.com/SparqLab/shared-lib/pull/62 — verified target `main`.
- No workflow/deployment files found in the inspected current main tree.
- Fresh uncached full Go tests, readonly build, vet, buf breaking against
  origin/main, proto formatting and diff checks passed (`ev-008`, `ev-009`).
- Remote PR identity/state recorded in `ev-010`; no merge/deploy performed.
- Resume Order migration/persistence and Gateway adoption after user merges
  the contract and the mainline module version is verified as resolvable.

## Downstream implementation — 2026-09-04

PR62 is MERGED as `28664d5b21bae0d3eee9ed294ba386f3abc04eb6`.
Order/Gateway now pin published `v0.0.0-20260904035802-28664d5b21ba`
locally; `go mod tidy` run, no replace. Initial module download needed a
command-local `GOPRIVATE=github.com/SparqLab/*` (no global config change).

All three downstream repos use `task/TASK-EAR-313-redemption-link`; Order and
Gateway branched from current origin/staging, Backoffice from origin/main.
Downstream edits are uncommitted; previous publication approval applied only to
shared-lib. User owns merge/deploy; no downstream live state changed.

- Order persists/maps is_link with nil-preserving SQL updates. Gift rejects
  explicit Link and clears the format when converting to Gift.
- Migration: `Games-Labs-Order/migrations/038_add_redemption_item_is_link.sql`,
  embedded by `migrations/run.go`; idempotent ADD COLUMN, NOT NULL default false.
  Legacy values are not inferred from code text. Real PostgreSQL tests cover
  a legacy row and a rerun preserving stored true.
- Backoffice edit now sends parsed spreadsheet codes with Update like Create;
  removes the redundant post-update multipart import. The prior conditional
  omitted required codes for spreadsheet uploads. No layout redesign.
- Backend import skips the Link template heading only for Link-format items;
  Code-format literal Link remains valid. CSV/XLSX tested against PostgreSQL.
- New Gateway generated-route tests verify isLink/is_link inputs, explicit
  false and omitted/null update presence, and response serialization. These
  isolate the edge contract with a stub, not live authorization/runtime proof.

### Release and rollback

Deploy Order with migration 038 before Gateway, then Backoffice. Startup runs
migrations before serving; the new Order requires the column. Old Order can run
against the expanded schema, but cannot support Link. Keep the column/data on
rollback and suspend Link editing/testing until the compatible Order/Gateway
pair is restored. Never backfill historical format by guessing from values.

Local verification: ev-015 Backoffice 501 tests; ev-016/017 default Order/Gateway
tests; ev-018/020 readonly builds and vet; ev-019 full Order integration suite
against isolated local PostgreSQL16; ev-021 Backoffice build. ev-011/013/014 are
pre-fix failures for format persistence, spreadsheet update, and Link header.
Not verified: deployed authenticated UI save/reload, the reported live item,
email delivery, production, or live money effects. Email stays separate scope.

## Downstream PR handoff — 2026-09-04

User subsequently approved commit/push/open PR for all three repositories,
superseding the local-only publication boundary above. No merge or deployment
performed by Codex; user owns these actions.

| Repository | Commit | PR | Verified target |
| --- | --- | --- | --- |
| Games-Labs-Order | bd00d93 | https://github.com/SparqLab/Games-Labs-Order/pull/49 | staging |
| api-gateway | de78ecf | https://github.com/SparqLab/api-gateway/pull/60 | staging |
| Games-Labs-backoffice | 3636edd | https://github.com/SparqLab/Games-Labs-backoffice/pull/110 | main |

All OPEN at verification; clean worktrees. Deployment workflow triggers and
remote PR bases checked. Release Order/migration038 first, Gateway second,
Backoffice last. Fresh checks: ev-024 Backoffice 501 tests; ev-025 Gateway full
default tests/build/vet; ev-026 Order full default tests/build/vet. Prior full
PostgreSQL integration and Backoffice build remain implementation evidence,
not deployed acceptance. Remote PR evidence: ev-027 Gateway, ev-028 Order,
ev-029 Backoffice.
