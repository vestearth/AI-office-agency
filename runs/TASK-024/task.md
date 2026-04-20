# TASK-024: Dynamic Missions Redemption Rewards and Phase 1 Pass Fulfillment

Epic: Points Redemption Reliability and Semantics

Type: feature

Priority: high

Depends On:
- TASK-022 (wallet-authoritative redemption/idempotency baseline in Missions)
- TASK-023 (redemption ownership/auth hardening for secure caller identity)

Target Services:
- Games-Labs-Missions
- Games-Labs-Wallet (catalog lookup contract consumption only; no ownership shift)

Target Files:
- Games-Labs-Missions/internal/services/level_service.go (modify) -- remove hardcoded `voucher_thb`, accept dynamic reward key/type, and route pass rewards to fulfillment flow.
- Games-Labs-Missions/internal/handlers/level_handler.go (modify) -- accept reward selection input in redeem endpoint and pass normalized fields to service.
- Games-Labs-Missions/internal/models/* (modify) -- extend redeem request/response models for dynamic reward identifiers while preserving backward compatibility.
- Games-Labs-Missions/internal/services/store_service.go (modify) -- integrate `GrantPass` fulfillment when redeeming temporary privilege rewards.
- Games-Labs-Missions/internal/services/*_test.go (modify/create) -- add tests for catalog validation, voucher flow, and pass grant flow.
- Games-Labs-Missions/internal/clients/wallet/* (modify if required) -- support reward-catalog validation lookup (`GetActiveRateByKey` or equivalent).

Overview:
Missions redemption currently returns a fixed reward type (`voucher_thb`) regardless of requested item. This task introduces dynamic reward handling for Phase 1 items. The service must validate reward keys via wallet/store reward catalog and apply reward-specific fulfillment: externally configured vouchers (custom campaign vouchers managed outside Missions) must be assignable to a user as redemption rewards, and temporary privileges must be granted via `GrantPass` after successful wallet redemption.

External Voucher Data Contract (Phase 1):
- `voucher_code` (string, required): external voucher identifier/code to be granted to user.
- `campaign_id` (string, required): campaign or reward batch identifier for audit and reconciliation.
- `expires_at` (string RFC3339, optional): voucher expiration timestamp from provider/source.
- `provider` (string, required): source/provider namespace (example: `marketing-cms`, `partner-x`).
- `condition` (object/string, optional): eligibility/rule payload (minimum level, region, usage constraints, etc.).
- `voucher_price` (number, required): monetary face value of voucher for display/reporting.

Objectives:
1) Replace hardcoded reward type in redemption flow with dynamic, validated reward item selection.
2) Validate redemption item against active wallet/store reward catalog mapping before attempting deduction.
3) Implement Phase 1 voucher redemption using externally configurable voucher rewards (e.g. your own voucher definitions/campaigns), with proper logging, user reward assignment, and idempotent deduction.
4) Implement Phase 1 temporary privilege redemption by invoking `StoreService.GrantPass` after successful deduction.
5) Enforce validation rules for external voucher payload (`voucher_code`, `campaign_id`, `provider`, `voucher_price`) before redemption execution.
6) Preserve backward compatibility and stable error semantics where feasible.

Acceptance Criteria:
- `RedeemPoints` no longer hardcodes `voucher_thb`; reward type/key are dynamic per request.
- Reward validation uses centralized catalog source (`GetActiveRateByKey` or equivalent mapping) and rejects inactive/unknown rewards.
- Voucher rewards can be configured from outside Missions (catalog/config source) and redeemed dynamically without code changes for each new voucher key.
- Voucher redemption returns the selected voucher reward metadata and records user reward assignment outcome.
- Voucher assignment metadata persists/returns at least: `voucher_code`, `campaign_id`, `provider`, `voucher_price`, and normalized `expires_at` when present.
- Invalid external voucher payload (missing required fields or invalid `expires_at`) is rejected with a clear 4xx response before wallet deduction.
- Temporary privilege reward redemption triggers `GrantPass` with correct `user_id`, `pass_type`, and duration once wallet deduction succeeds.
- Duplicate requests with the same idempotency key remain idempotent and do not grant pass or deduct points twice.
- Existing error mapping behavior for wallet insufficient points and service unavailability remains intact.

Test Plan:
1. Voucher Happy Path: redeem an externally configured voucher key succeeds with expected assignment metadata (`voucher_code`, `campaign_id`, `provider`, `voucher_price`, `expires_at`) and single deduction.
2. Temporary Privilege Happy Path: redeem pass reward succeeds and invokes `GrantPass` exactly once.
3. Unknown/Inactive Reward: catalog validation fails with clear 4xx and no wallet deduction.
4. Invalid External Voucher Payload: missing `voucher_code`/`campaign_id`/`provider`/`voucher_price` or invalid `expires_at` is rejected with clear validation error and no wallet deduction.
5. Idempotency Replay: same idempotency key does not double-deduct and does not duplicate voucher assignment or pass grant.
6. Wallet Failure Mapping: insufficient points and wallet unavailable still map to current API error statuses.
7. Backward Compatibility: legacy request shape (if still allowed) follows documented fallback behavior.

Risks and Mitigations:
- Reward-key mapping drift between Missions and Wallet catalog can reject valid items.
  - Mitigation: define explicit key convention and centralize mapping helper in Missions.
- Partial success risk (wallet deducted but pass grant fails).
  - Mitigation: make fulfillment sequencing explicit, log correlation IDs, and define compensating/error strategy.
- External voucher provisioning source may be unavailable or inconsistent.
  - Mitigation: enforce validation with clear rejection response and add observability for catalog lookup/assignment failures.
- Field contract drift between external systems and Missions can cause malformed payload ingestion.
  - Mitigation: define strict schema/versioning and add payload validation tests at handler/service boundary.

Assigned Agent: dev-2

Reviewer Focus:
- Validate no hardcoded reward remains in redemption success path.
- Confirm catalog validation gates redemption before wallet deduction.
- Confirm pass fulfillment is triggered exactly once with idempotent replay behavior.
