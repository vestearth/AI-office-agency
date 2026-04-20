# TASK-023: Missions Redemption Security and Idempotency Hardening

Epic: Points Redemption Reliability and Semantics

Type: bugfix

Priority: critical

Depends On:
- TASK-022 (wallet-authoritative redemption and idempotency baseline)

Target Services:
- Games-Labs-Missions
- api-gateway (header propagation verification only if missing)

Target Files:
- Games-Labs-Missions/internal/handlers/level_handler.go (modify) -- enforce authenticated user identity over body user_id and normalize idempotency key ingestion.
- Games-Labs-Missions/internal/services/level_service.go (verify/modify if needed) -- ensure handler-authenticated user_id is authoritative in redemption flow.
- Games-Labs-Missions/internal/models/* (verify only) -- ensure request model behavior remains backward compatible where required.
- api-gateway/* (verify only if needed) -- confirm `X-User-ID` is propagated to Missions redemption endpoint.

Overview:
Missions redemption currently trusts `user_id` from request body and only consumes `idempotency_key` from JSON payload. This introduces a critical IDOR risk and weak idempotency behavior. The flow must use authenticated identity from headers/metadata as source of truth and consistently support header-first idempotency key ingestion.

Objectives:
1) Remove trust in body-provided `user_id` for redemption and require authenticated `X-User-ID`.
2) Reject redemption requests when authenticated identity is missing or mismatched with provided body user_id.
3) Read idempotency key from `Idempotency-Key` header first, with deterministic fallback to request body for compatibility.
4) Preserve stable API semantics and error mapping for insufficient points and wallet unavailability.

Acceptance Criteria:
- `POST /levels/redeem` uses `X-User-ID` (or equivalent authenticated metadata) as the only authoritative user identity.
- Requests without authenticated user identity are rejected with a clear 4xx response.
- If body `user_id` is provided and differs from authenticated identity, request is rejected.
- Idempotency key ingestion supports `Idempotency-Key` header and falls back to body `idempotency_key` when header is absent.
- Replayed requests with the same effective idempotency key do not trigger double-spend behavior.
- Existing wallet error mapping (`402` insufficient points, `503` wallet unavailable) remains intact.

Test Plan:
1. Auth Ownership: valid `X-User-ID` with matching/no body user_id succeeds and redeems once.
2. IDOR Block: `X-User-ID` different from body `user_id` returns 4xx and does not call redeem for body identity.
3. Missing Identity: absent `X-User-ID` returns 4xx and no redemption occurs.
4. Header Priority: when both header and body idempotency keys are present, header value is used.
5. Body Fallback: when header is absent, body idempotency key is used and idempotency remains effective.
6. Error Mapping Regression: wallet insufficient points and service unavailable still map to existing HTTP statuses.

Risks and Mitigations:
- Gateway/header inconsistency across environments may break valid requests.
  - Mitigation: verify gateway propagation and document required headers in endpoint contract.
- Existing clients may rely on body-only user identity.
  - Mitigation: keep body field optional for compatibility checks but enforce authenticated identity and publish migration note.
- Header canonicalization edge cases (`Idempotency-Key` casing/spacing).
  - Mitigation: rely on standard Go HTTP header handling and trim whitespace before use.

Assigned Agent: dev

Reviewer Focus:
- Confirm no IDOR path remains in redemption handler.
- Confirm idempotency key precedence is header-first with explicit fallback.
- Verify tests cover mismatch/missing-auth and no double-spend regression.
