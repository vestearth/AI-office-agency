# TASK-EAR-217 — 🔴 SECURITY: admin audit log stores and now serves raw staff bearer tokens

## Type

security / incident

## Priority

critical

## Discovered

2026-08-06, during TASK-EAR-215's live re-verification of the audit-events route.
The verifying agent noticed `actorAccess` in the API response looked exactly like
the bearer token it had just logged in with. Coordinator traced the full chain
through source and confirmed it.

## Severity — why this is critical

`GET /api/v1/admin/audit-events` returns, for every audit row, the **raw opaque
bearer token of the admin who performed the action**. Any staff user who can read
the audit log can lift another admin's session token verbatim and impersonate them.

That is privilege escalation: the audit log is typically readable by a broader
staff set than the high-privilege actions it records. A read-only auditor can
harvest a superadmin's token.

**The exposure is new as of today.** The tokens have been stored in plaintext
since TASK-EAR-181 (2026-07-31), but nothing served them over an API until
TASK-EAR-207's read route went live on staging on 2026-08-06. This epic's own
work is what converted a storage problem into an exposure.

## The chain (verified in source, not inferred)

1. `api-gateway/interceptor/metadata.go:38` — the grpc-gateway annotator puts the
   **raw** token straight into gRPC metadata:
   ```go
   if token := extractAccessToken(authHeader); token != "" {
       data["access"] = token
       data["authorization"] = "Bearer " + token
   }
   ```
   It is not hashed anywhere on this path — the very next line reuses the same
   value to rebuild the `Bearer ` header.
2. `shared-lib/pkg/auth/auth.go` — `ConvertMetaDataToUserData` reads
   `md["access"]` into `TokenData.Access`.
3. `Games-Labs-User/internal/core/handlers/adminuserhdl/audit.go:47` —
   `ActorAccess: td.Access` goes onto the published `AdminActionEvent`.
4. `Games-Labs-Logs/migrations/003_admin_actions.sql:24` — persisted as
   `actor_access VARCHAR(64)`, plaintext, in an append-only, long-retention store.
5. `Games-Labs-Logs/internal/core/handlers/adminloghdl/grpc.go:73` —
   `ActorAccess: row.ActorAccess` is mapped into the response.
6. `shared-lib/proto/admin/adminlogpb/adminlog.proto:98` —
   `string actor_access = 5;` ships it to any caller.

⚠️ `VARCHAR(64)` is the same width as a sha256 hex digest, so **column width alone
does not prove the value is raw** — step 1 is what proves it. Do not let a future
reader talk themselves out of this finding on the length argument.

Observed live: 3 `user.vip_level.set` rows on staging, two sharing one
`actorAccess` value (consistent with one admin session reused).

## NOT yet confirmed

Nobody has replayed a stored `actorAccess` as a bearer to prove it is *live and
accepted*. The verifying agent's attempt was blocked by the permission classifier
and it correctly did not work around it. **This is the one open question**, and it
only changes urgency, not direction — a raw token in a long-lived, broadly-readable
store is wrong even if it happens to be expired.

## Fix — staged, fastest mitigation first

1. **Stop serving it** (minutes, no contract break): drop the `ActorAccess`
   mapping in `adminloghdl/grpc.go` so the field is never populated in responses.
   Closes the exposure immediately while the rest is decided. Keep the proto field
   reserved rather than renumbering.
2. **Stop storing it**: remove `ActorAccess` from the publisher
   (`adminuserhdl/audit.go`, plus the Order and Missions publishers just added in
   TASK-EAR-188 — check all three) and from the event contract. Decide what, if
   anything, replaces it: a sha256 of the token would let sessions be correlated
   without being replayable, and `actor_id` + `occurred_at` may already be enough
   for every real audit question.
3. **Purge existing rows**: `UPDATE admin_actions SET actor_access = NULL` on
   staging and prod. Cheap and there is no reason to keep the values.
4. **Rotate** any staff token that appears in the table, operator's call.

## Scope note

Steps 1–3 are Claude-lane code work. Step 4 and the replay confirmation are
operator/devops decisions.

## Blast radius to check before closing

- Does anything actually *consume* `actor_access`? Grep the backoffice — if
  nothing reads it, step 1 is zero-risk.
- The same `td.Access` pattern may exist in other publishers or handlers beyond
  the audit path; sweep for `ActorAccess` and `td.Access` across all services.

## Related

- TASK-EAR-181 (introduced the field and the store)
- TASK-EAR-188 (Order + Missions publishers, merged today — likely carry the same
  field)
- TASK-EAR-207 (the read API that turned storage into exposure)
