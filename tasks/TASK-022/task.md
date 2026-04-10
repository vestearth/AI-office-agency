# Request: Refactor Level Terminology (Rename Points to EXP)

The term `points` is currently overloaded across domains. In `Games-Labs-Wallet`, it represents a spendable currency, while in `Games-Labs-Missions`, it incorrectly represents level progression. This causes severe API and domain logic confusion (e.g., `GET /levels` returning progression points vs `POST /levels/redeem` spending wallet points).

To establish clear domain boundaries:
1. Refactor the `Games-Labs-Missions` service to use the term `exp` (Experience) instead of `points`.
2. Rename Database columns in the `user_levels` table: 
   - `points` -> `exp`
   - `total_points` -> `total_exp`
   - `next_level_points` -> `next_level_exp`
3. Update all related Go structs, JSON payload responses, gRPC protobufs (if applicable), and internal logic variable names to reflect the `exp` terminology.
4. Ensure `Games-Labs-Wallet` remains the sole owner of the term `points` (as spendable currency).
