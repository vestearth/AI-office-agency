# TASK-EAR-110: Integrate Missions with canonical Store Items providers

Parent `TASK-EAR-100`; blocked by deployed `TASK-EAR-108` and `TASK-EAR-109`. Epic: Store Items canonical catalog rollout. Feature/backend/high; owner `dev-2`.

## Outcome

Make Mobile Store Pass/Avatar list and buy flows consume Order's canonical catalog over the published service contract while Missions keeps purchase debit, grant and inventory ownership. Resolve price, currency, item type, status, sale window, canonical identity and VIP eligibility server-side; never trust client `price_diamonds`. Make retries safe with a durable operation ledger and deterministic Wallet idempotency keys.

Remove Missions' Pass/Avatar seed/database/admin catalog authority. Existing owned items and legacy IDs must continue to resolve through Order aliases without a direct Order DB read.

## Scope

- Missions Order/User client wiring, store service/handlers/models/repository/migrations/tests and dependency files.
- Existing Missions ownership tables for user passes/avatars remain; catalog tables and write endpoints do not.
- No shared-lib, Order, User or gateway contract edits in this final integration task.

## Acceptance criteria

- List and buy use the same canonical Order catalog and no Pass/Avatar seed/local catalog fallback remains.
- Client `price_diamonds` is ignored/removed; debit uses Order price/currency and rejects unsupported currency, inactive, not-yet-on-sale, expired, wrong type or VIP-ineligible items.
- Canonical UUID is stored for new ownership/history; approved legacy IDs and existing inventory resolve to the same stable item through Order aliases.
- A required idempotency key is scoped to user+operation; replay returns the original success, concurrent duplicates debit/grant once, and retry after ambiguous Wallet/service failure is deterministic.
- Missions retains grant/inventory ownership and never accesses Order/User databases directly.
- Focused list-buy-inventory/error/retry tests and `GOWORK=off go build -mod=readonly ./...` pass with published shared-lib and no replace.

## Dependencies and rollout

Start only after TASK-EAR-108 and TASK-EAR-109 are deployed and smoke-verified. Roll out with provider health checks and rollback that disables buying rather than restoring a second catalog authority.

Published contract baseline: `github.com/SparqLab/shared-lib@v0.0.0-20260713083006-64c2276be266` (TASK-EAR-107 / PR 16 merge commit `64c2276be26640d20f0ab94532bb88031cd98099`). Provider deployment gates from TASK-EAR-108 and TASK-EAR-109 remain mandatory.
