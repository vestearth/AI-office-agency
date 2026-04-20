# Request: Missions Redemption Security & API Hardening

Two critical/high issues regarding security and idempotency were discovered during the auditing of the points redemption flow in the Missions service.
These must be addressed to prevent IDOR and double-spend exploits.

1. **[Critical] Fix Redemption Ownership/Auth (IDOR Vulnerability)**
   - `Games-Labs-Missions/internal/handlers/level_handler.go` accepts `user_id` blindly from the request body.
   - Stop trusting client input for `user_id`. Ensure the system uses the `user_id` extracted from the gateway or authenticated Metadata Headers (`X-User-ID`), and reject any mismatch or missing header.
2. **[High] Fix Idempotency Key Ingestion Mapping**
   - The handler currently only reads the key from the body, despite standard usage dictating an `Idempotency-Key` HTTP header.
   - Refactor `level_handler.go` to support falling back between the HTTP Header and the request body consistently.
