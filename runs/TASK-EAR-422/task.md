# TASK-EAR-422: Missions gRPC bridge owner-scope IDOR sweep

Sibling sweep of TASK-EAR-420 (StoreHistory IDOR, Games-Labs-Missions#146).
Every annotated MissionsService RPC is public through api-gateway
(`gateway/grpc.go:148`); `/api` requires a token and the gateway re-sets
`userid` from it (`middleware/identity_headers.go`), so `X-User-ID` /
`resolveOwner(ctx)` is the trusted caller.

## Audit (base origin/staging 6d5500c)

| RPC | Dispatches to | Verdict | Evidence |
|---|---|---|---|
| GetMissionProgress | mission.go:644 GetProgress | IDOR (read) → fixed | query user_id, no header check |
| GetWeeklyMissions | weekly.go:51 | IDOR (read) → fixed | query user_id |
| ListMissionEvents | event.go:43 | IDOR (read) → fixed | query user_id |
| GetMissionEvent | event.go:64 | IDOR (read) → fixed | query user_id |
| GetQuestOverview | quest.go:38 | IDOR (read) → fixed | query user_id |
| GetInviteOverview | invite.go:34 | IDOR (read) → fixed | query user_id |
| GetMissionBoostStatus | mission.go:386 | IDOR (read) → fixed | query user_id |
| GetStreak | mission.go:480 | IDOR (read) → fixed | query user_id |
| GetUserBadges | mission.go:613 | IDOR (read) → fixed | query user_id |
| GetLevel | level.go:36 | IDOR (read) → fixed | path user_id; Android only calls with own id |
| GetInventory | store.go:376 | IDOR (read) → fixed | query user_id |
| GetCheckInCalendar (typed) | server.go:129 → MissionSvc | IDOR (read) → fixed | q.GetUserId() straight to service |
| GetRestoreStreakQuote (typed) | server.go:248 → MissionSvc | IDOR (read) → fixed | q.GetUserId() straight to service |
| ClaimWeeklyCompletionBonus | weekly.go:117 | IDOR (write) → fixed | body user_id, no header check (missed by EAR-263) |
| StoreHistory | store.go:312 | IDOR → fixed in #146 | out of this PR |
| ClaimMissionEvent / JoinMissionEvent | event.go:103/147 | safe via gateway | X-User-ID wins; body only if header empty |
| ClaimWeeklyMission | weekly.go:83 | safe via gateway | X-User-ID wins |
| ClaimGenericReward, GetAvatars, RedeemLevelPoints | mission.go:658, store.go:346, level.go:99 | safe | header required / compared |
| Body money paths (ClaimDaily … StoreExchangeCustom) | owner.go resolveOwner | safe | TASK-EAR-263 table |
| ClaimCheckInMilestone/Day | server.go resolveOwner | safe | |
| AddTurnover | level.go:67 | **NOT FIXED — follow-up** | public POST trusts body user_id AND amount: any player forges EXP for anyone incl. self; resolveOwner alone would not close it (needs internal-only route) |
| RestoreStreakTyped, RecordPurchaseHistory, HasActivePass, ListActiveLevelAccessGrants, ApplyGameplayTurnover | — | internal (no google.api.http) | not gateway-routable; trust service callers |

## Fix
gRPC wrapper: `resolveOwner(ctx, requested)` before building the URL / calling the
service (no id = caller, own id ok, other = PermissionDenied, none = Unauthenticated).
weekly.go ClaimWeeklyCompletionBonus: HTTP `resolveOwner(w, r, body)`.

## Evidence
RED/GREEN in PR; tests `owner_scope_test.go`, `trusted_identity_test.go` (+ClaimWeeklyCompletionBonus).

## Merged, deployed, accepted (2026-11-03, Claude conductor)

- **Approval:** the operator approved merging ("PR จาก session อื่น merge ได้เลยครับ").
- **Pre-merge check:** I merged #147 and #148 together onto staging and ran `go vet` and `go test`; both passed with no conflicts. I also confirmed that no service and no Backoffice code calls `AddTurnover`.
- **Merged:** #147 as `6c7669e`, #148 as `4139416`.
- **Deployed:** Deploy STAGING run 41617388756 succeeded. DEV runs Missions td161 `staging-sha-4139416`, HEALTHY (ev-001).
- **Accepted on DEV:** the operator ran these through Postman. Both calls returned `code: 7` (PermissionDenied):

  | Call | Message |
  | --- | --- |
  | cross-user `missions/progress` | "user_id does not match authenticated user" |
  | `levels/turnover` | "turnover is applied from settled gameplay only" |

- **Review:** no separate reviewer-lane pass was run for #147 or #148. This is disclosed in the gates.
