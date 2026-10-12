# TASK-EAR-394: Event detail item must not say done at 0/0

Found during TASK-EAR-391 staging acceptance (runs/TASK-EAR-391/evidence/ev-007-staging-acceptance.log): the player event detail for a target-0 event returns items[0].state "done" with progress 0/0 while claimable is false, so the app can show an event as completed that nobody can claim.

Cause (Games-Labs-Missions origin/staging, internal/services/event_service.go, missionEventDetailItemState): `case card.Target == 0: return "done"` and `case card.Progress >= card.Target: return "done"` (0 >= 0). buildMissionEventDetailItem uses it for every event that is not config-driven, which covers two cases:
- legacy events with target_value 0 (no conditions, no games), which TASK-EAR-391 made never claimable at zero progress;
- the TASK-EAR-391 branch for events whose conditions have no progress source (CATEGORY_TURNOVER / ANY_GAME_TURNOVER / unknown with no games), whose card carries Target 0 and Progress 0.

Outcome: a detail item reads "done" only when the event is actually completed (claimed, or progress > 0 and progress >= target). A zero-progress or never-claimable event must not read "done". Keep missionEventAchievementStatus consistent with the item state.

Scope: Games-Labs-Missions only. The items[].state values are mobile-facing. Check how the Android client repo (read-only reference) reads them before choosing the replacement state. Add a regression test that fails on the current code first. PR to staging.
