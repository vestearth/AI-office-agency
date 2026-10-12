# TASK-EAR-399: Backoffice: share one constant for the Randomly by System special item option

Follow-up of TASK-EAR-398 (reviewer nit). Owner: Games-Labs-backoffice (PR to main; deploys to admin-dev, no staging branch). Refactor only; no behaviour change.

The special item sentinel "Randomly by System" is spelled out twice in app code on origin/main (2026-10-10):
- app/data/mock.ts:1282 eventMissionSpecialItemOptions = ['Randomly by System', 'Special Item/Limited Avatar', 'Special Pass'] (the event create/edit select options)
- app/utils/eventMissionMap.ts:145 specialItemCategoryOrRandom returns category || 'Randomly by System' (TASK-EAR-398)
If one is renamed without the other, the edit page loads an empty category as a value that is not an option. The select goes blank again and Update stays disabled (TASK-EAR-397 rule).

Outcome: one exported constant, used by both. The value must stay exactly "Randomly by System", because Missions matches it as SpecialItemRandomSentinel (Games-Labs-Missions internal/models/event.go:44). Place it where both callers can import it without a cycle (check the existing imports between data/mock.ts and utils/eventMissionMap.ts first). Tests that assert the literal wire value stay as they are. Comments mentioning the name need no change. Add a test that ties the helper's fallback to the option list (e.g. the fallback is a member of eventMissionSpecialItemOptions), and show it failing first if the shape allows; otherwise record why a red run is not possible for a pure refactor.

Gates: the staging preset still applies because a merge to main deploys admin-dev. For staging_acceptance, confirm the served build switched and a SPEND_PROP edit page still shows its category (read-only).
