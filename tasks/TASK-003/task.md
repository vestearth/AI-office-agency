# TASK-003: Extend Orders Package Catalog Schema and Migration

## Overview
Extend the existing `order_packages` table and `OrderPackage` model in Games-Labs-Order
to support the full catalog lifecycle needed for both purchase and exchange packages,
including time-bounded availability, metadata, and alignment with Missions seed data.

## Type
feature

## Priority
high

## Target Service
Games-Labs-Order

## Target Files
- `Games-Labs-Order/internal/models/order.go`
- `Games-Labs-Order/migrations/003_extend_order_packages.sql`
- `Games-Labs-Order/migrations/run.go`
- `Games-Labs-Order/internal/core/repositories/order.go`
- `Games-Labs-Order/internal/core/services/ordersvc/service.go`

## Description
The `order_packages` table (migration `002`) already has core fields: `id`, `type`,
`name`, `category`, `price_amount`, `price_currency`, `price_diamonds`,
`reward_diamonds`, `reward_coins`, `bonus_percent`, `active`, `sort_order`,
`created_at`, `updated_at`.

Extend it with:

1. **Schema additions** (new migration `003_extend_order_packages.sql`):
   - `effective_at TIMESTAMPTZ` — package becomes available (NULL = immediately)
   - `expires_at TIMESTAMPTZ` — package expires (NULL = never)
   - `metadata JSONB DEFAULT '{}'` — extensible properties (promo tags, display hints)
   - `code VARCHAR(50)` — business key for exchange rates (maps to `ExchangeRate.Code`)
   - Index on `(type, active)` for filtered listing
   - Index on `(effective_at, expires_at)` for time-window queries

2. **Model updates** (`OrderPackage` struct):
   - Add `EffectiveAt`, `ExpiresAt *time.Time`
   - Add `Metadata json.RawMessage`
   - Add `Code string`

3. **Seed data migration** — align with Missions' baseline:
   - Purchase packages: `first_timer`, `pkg_i` through `pkg_vi` (verify coin/diamond
     amounts match; Missions code has `first_timer` coin=2450 while SQL has 2400)
   - Exchange packages: map `ex_5`, `ex_25`, `ex_100` from `ExchangeRate` to
     `order_packages` with `type=exchange`, `price_diamonds`, `reward_coins`,
     `bonus_percent`, and `code` = original rate code
   - Verify existing seed in migration `002` and add/update as needed

4. **Repository updates**:
   - `ListPackages` filter should respect `effective_at <= NOW()` and
     `(expires_at IS NULL OR expires_at > NOW())` for user-facing queries
   - Admin listing should show all packages regardless of time window
   - Add `GetPackageByCode(code string)` for exchange rate lookups by business key

5. **Service validation updates** in `UpsertPackage`:
   - `effective_at` must be before `expires_at` when both are set
   - `code` must be unique among active packages of the same type

## Acceptance Criteria
- [ ] Migration `003` adds `effective_at`, `expires_at`, `metadata`, `code` columns
- [ ] `OrderPackage` Go struct includes new fields with proper JSON tags
- [ ] Seed data for purchase packages matches Missions' canonical values
- [ ] Exchange rate seed data is represented as `order_packages` rows with `type=exchange`
- [ ] `ListPackages` for users filters by time window (only shows currently available)
- [ ] `ListPackages` for admin returns all packages regardless of time window
- [ ] `UpsertPackage` validates `effective_at < expires_at` when both provided
- [ ] `code` field has a uniqueness check within active packages of the same type
