# Request: Missions Redemption - Dynamic Rewards & Phase 1 Setup

Currently, the points redemption flow in the Missions service has hardcoded rewards.
The `RedeemPoints` function in `level_service.go` currently hardcore passes `"voucher_thb"` to the Wallet service.

We need to make this dynamic and support Phase 1 redemption items.

1. **[Medium] Deprecate Hardcoded Rewards**
   - Support dynamic redemption items instead of hardcoding one string.
   - Use the Wallet/Store Reward Catalog (via `GetActiveRateByKey` or similar mapping) to validate the specific dynamic rewards.
2. **Phase 1 Implementation**
   - **Cash Vouchers:** Generic discounts (e.g. `voucher_5`, `voucher_20`). For these, log and deduct points properly.
   - **Temporary Privileges:** (e.g., granting a 7-day Pass). When a user redeems points for a pass, the service should call `GrantPass` on the `StoreService` to automatically add the pass logic upon successful deduction.
