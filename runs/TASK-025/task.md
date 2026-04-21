# TASK-025: Update Postman API Documentation

## Objective
Update the existing Postman API collections to accurately reflect the latest API contracts and security enhancements introduced in TASK-022, TASK-023, and TASK-024.

## Scope
### Target Services
- `Games-Labs-Missions`: The primary service whose endpoints (especially `#RedeemPoints`) have changed.
- `api-gateway`: Relevant if there are gateway-level headers.

### Affected Files
- `docs/Games-Labs-APIs.postman_collection.json`
- `Games-Labs-Missions/Games-Labs-Missions.postman_collection.json` (if applicable)

## Description
During the recent phase 1 iterations, several critical changes were made to the Missions API (specifically around point redemption):
1. **Security (IDOR Fix):** The `user_id` field has been entirely removed from request bodies. APIs now rely on the `X-User-ID` header for user identification.
2. **Idempotency Fix:** The `idempotency_key` is no longer sourced from the JSON body. It must be provided via the `Idempotency-Key` header.
3. **Dynamic Rewards:** The point redemption request payload now uses dynamic catalog keys rather than hardcoded point amounts (e.g., `reward_type: "voucher"`, `reward_key: "missions.tier1_voucher"`).
4. **Terminology Update:** All references to `points` in responses for the Missions service have been renamed to `EXP`.

The current Postman collections are outdated (last modified around April 10) and will cause testing/frontend errors if used as-is.

## Acceptance Criteria
- [ ] Postman collections no longer send `user_id` or `idempotency_key` in the payload body for `#RedeemPoints` or related endpoints.
- [ ] `X-User-ID` and `Idempotency-Key` are properly configured as Headers in the Postman requests.
- [ ] The Point Redemption request payload uses the new `reward_type` and `reward_key` format.
- [ ] Example responses in the Postman collection use `EXP` instead of `points`.
- [ ] The JSON format remains valid after modifications.

## Plan
### Approach
1. Read the current Postman JSON files and identify the relevant endpoints (e.g., `/v1/missions/redeem` or similar).
2. Modify the `request.body.raw` strings for these endpoints to match the new struct shapes.
3. Add the required headers (`X-User-ID`, `Idempotency-Key`) to the `request.header` arrays.
4. Locate any saved example responses and update `points` to `EXP`.
5. Validate that the files are still valid JSON.

### Blockers / Risks
- **JSON Formatting:** Manually editing stringified JSON inside a JSON file can be tricky. Use tools like `jq` or write a small Go/Python script to do the replacement if it becomes too complex.

### Assignment
- **Agent:** `dev` (since it's a straightforward documentation update task).
