# TASK-EAR-426: Order package code_name: VARCHAR(50) rejects the 64-char slugs Backoffice sends

Opened 2026-11-28 by the Claude conductor, from a source finding made while
re-verifying the knowledge-base note "Field Lineage — Store Packages &
Redemption". **Open-only:** no service code was changed and no request was sent
to staging or prod. The operator chose **option A** on 2026-11-28 (see
"Decision"); implementation has not started.

## Verdict: CONFIRMED (source and local reproduction)

A store package or exchange rate whose derived slug is 51–64 characters cannot
be saved. Postgres refuses the insert with SQLSTATE 22001.

Refs checked (fetched 2026-11-28):

| Repo | Ref | Fact |
|---|---|---|
| Backoffice | `origin/main` `2637315`, `origin/prod` `241bb6e` | slug capped at 64 |
| Games-Labs-Order | `origin/staging` `c244578`, `origin/prod` `aedf982` | column is `VARCHAR(50)`, no length check |
| Games-Labs-Wallet | `origin/staging` `b6eb662` | `rate_key TEXT` |
| api-gateway | `origin/staging` `f0f5baa` | no length rule |
| shared-lib | `d816962` (Order's pin) | `string code_name`, no field rule |

## Save path

1. Backoffice derives `codeName` from the name with `.slice(0, 64)`:
   `app/pages/admin/manage/store/packages/index.vue:370` (sent at `:400`) and
   `app/pages/admin/manage/store/exchange.vue:188` (used at `:276`, sent by
   `app/composables/useAdminStoreExchangeApi.ts` `saveOrderPackage`). Neither
   name input has a `maxlength`.
2. `POST` / `PUT /api/v1/admin/order-packages[/{id}]` goes through api-gateway's
   grpc-gateway (`body: "*"`) to `CreatePackage` / `UpdatePackage`. No limit in
   the proto or the gateway.
3. Order: `adminorderhdl.go:844` / `:893` only trims the value;
   `ordersvc/service.go:970` (`normalizeAndValidatePackageRequest`) requires it
   and, for exchange packages, checks the character set, not the length;
   `repositories/order.go:580` (`UpsertPackage`) writes it. This is the only
   writer of the column.
4. Column: `migrations/008_uuid_id_and_code_name.sql:38`, `VARCHAR(50)`. No
   later migration widens it.

**It is not a 500.** The handler turns any non-`MetaError` into status 1002 with
the raw error text (`adminorderhdl.go:869` / `:918`). The caller gets HTTP 200
with `status.code=1002`, `description="ERROR: value too long for type character
varying(50) (SQLSTATE 22001)"`, and Backoffice shows that string in an error
toast.

**Reach:** the create flows of both screens. The two edit screens send the
stored `codeName` back (`packages/edit/[id].vue:323` spreads the loaded
package; `exchange.vue:440`), so a UI edit does not build a new slug. A direct
API update with a longer code is refused the same way.

**Names that hit it** (the real slug function, `ev-003`): 46 characters for
"Songkran Festival Mega Bonus Diamond Pack 2027" (fine), 55 for "Songkran
Festival Mega Bonus Diamond and Coin Pack 2027" (refused), 64 for a 69-character
name (refused). A Thai-only name falls back to `pkg_<ms>` / `ex_<ms>` and is
unaffected.

**Side effects of a refused save:** the exchange flow is Order-first, so no
Wallet rate is written. The thumbnail is uploaded before the create call, so an
unused upload is left behind (read from source).

## Other places the value goes (no limit that blocks 64)

- Wallet `rate_catalog.rate_key` is `TEXT`
  (`migrations/014_create_rate_catalog.sql`); Wallet has no bounded string
  column at all. The key is `exchange.<code_name>`, 73 characters at most.
- Missions reads exchange packages from Order and keys the exchange by package
  UUID. Its legacy `exchange_rates.code VARCHAR(50)` is not written: its only
  writer, `StoreRepository.UpsertRate`, has no caller.
- Order `redemption_items.code_name` (migration 037) is `TEXT`; the redemption
  item screens are not affected.

## Reproduction (local, throwaway Postgres 16.13)

Gateway-style JSON decode → admin handler → service → repository → Postgres, on
an export of Order `c244578`. api-gateway itself was not run.

- `ev-001` (current schema, exit 1): 50 accepted; 51 and 64 refused for
  purchase and exchange create and for update.
- `ev-002` (candidate migration applied, then the **current** runner replayed
  twice, exit 0): 51 and 64 accepted, 65 refused, column stays `VARCHAR(64)`.
  - Widening did not rewrite the table (`relfilenode` unchanged) and added no
    dropped attribute. The partial unique index
    `idx_order_packages_type_code_name_active` was rebuilt once.
  - On an already-64 column the guarded block takes no table lock. An unguarded
    `ALTER … TYPE VARCHAR(64)` takes `ACCESS EXCLUSIVE` and rebuilds that index,
    which would happen on every boot.
  - Narrowing back to 50 fails while any longer row exists.

The kit (`repro.sh before|after`, test, SQL) is in
`runs/TASK-EAR-426/evidence/repro/`. The `evidence/` folder is gitignored, so it
exists only on the machine that opened this run.

**Not verified:** the live column type on staging or prod (the guard is safe
either way), whether anyone has hit this on a live environment (logs not
searched), and client apps.

## Options

**A. Widen Order to 64 and validate (chosen).** One repo, no proto,
shared-lib, gateway or Backoffice change, and it fixes the Backoffice builds
already on `main` and `prod`. Cost: a migration, one index rebuild, and a column
that cannot be narrowed again while longer rows exist.

**B. Cap the slug at 50 in Backoffice, and validate 50 in Order.** No migration.
Cost: two repos and a Backoffice deploy for each environment, and long names
that share their first 50 characters collide (`DuplicatePackageCode` among
active packages of the same type).

**C. Cap in Backoffice only.** Smallest, not recommended: other API callers
still get the raw database error.

## Scope for implementation (option A, Games-Labs-Order only, PR into `staging`)

1. New `migrations/049_widen_order_package_code_name.sql` (049 was unused on
   every Order branch on 2026-11-28; recheck), embedded and run last in
   `migrations/run.go`. Do not edit 008. Tested SQL:

   ```sql
   DO $$
   BEGIN
       IF EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'order_packages'
             AND column_name = 'code_name'
             AND data_type = 'character varying'
             AND character_maximum_length < 64
       ) THEN
           ALTER TABLE order_packages ALTER COLUMN code_name TYPE VARCHAR(64);
       END IF;
   END $$;
   ```

2. In `normalizeAndValidatePackageRequest`, after the trim: refuse
   `utf8.RuneCountInString(req.CodeName) > 64` with
   `errormsg.ErrorInvalidRequest("code_name must be at most 64 characters")`.
   `VARCHAR(n)` counts characters, and purchase codes have no character-set rule,
   so do not count bytes.
3. Tests, each seen failing on the base commit first:
   - service: a 65-character code returns that error and nothing is written;
   - real Postgres (env-gated like the existing integration tests): after
     `migrations.Run` twice, a 64-character code saves. A mock cannot show 22001.

## Acceptance criteria

- [ ] 64 saves and 65 returns the validation message (no SQLSTATE text), for
      purchase and exchange, create and update.
- [ ] Running the migrations twice on an empty database succeeds and leaves
      `VARCHAR(64)`; the drift test passes with
      `ORDER_MIGRATIONS_TEST_DATABASE_URL` set to an empty database.
- [ ] `GOWORK=off go build -mod=readonly ./...`, `go vet ./...` and
      `go test ./...` pass.
- [ ] Staging, on the new image: a package with a 51–64 character slug saves;
      for exchange, Wallet has `exchange.<code_name>`. This writes test data on
      staging, so get the operator's OK first and remove the package afterwards.

## Deploy order

1. Order only. Merging into `staging` is the staging deploy; 049 runs at boot,
   before the service serves, and a failed migration stops that boot.
2. Nothing else has to ship first or after. Old and new tasks can overlap: the
   old code has no length check and its runner does not narrow the column.
3. The `ALTER` needs a brief `ACCESS EXCLUSIVE` lock on `order_packages` once.

## Rollback

- Revert the commit or redeploy the previous image and **leave the column at
  64**. 008 uses `ADD COLUMN IF NOT EXISTS`, so the old runner does not touch it
  (`ev-002`). Packages with long codes stay readable and editable.
- Narrowing is not a normal rollback step. It needs 049 out of the runner first,
  and no row with `char_length(code_name) > 50`. Renaming an exchange code also
  means moving its Wallet rate key `exchange.<code_name>`.

## Production

The same mismatch is on Order `prod` and Backoffice `prod`; Order's `prod`
branch has no length check either. Games Labs prod is cost-gated and this task
does not start or deploy anything there. After staging acceptance, adding the
commit to the release train (TASK-EAR-402; its Order branch
`release/TASK-EAR-402-prod` `438d7ee` already has migrations through 048) is the
operator's call.

## Follow-ups (not in this task)

- Order package handlers return raw database error text for any non-`MetaError`.
- Backoffice leaves an unused thumbnail upload when a create is refused.
- Knowledge closeout: the Field Lineage note says "slug ≤64 → `code_name`"
  without saying the column is 50; correct it once the fix is known.

## Decision

**Option A**, chosen by the operator in chat on 2026-11-28 ("A: ขยายเป็น 64"),
recorded by the Claude conductor. B and C are not to be implemented.

The choice settles the fix only. It does not authorize a staging deploy, the
staging test data in the last acceptance criterion, or any production step.
