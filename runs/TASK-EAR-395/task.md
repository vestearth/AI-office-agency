# TASK-EAR-395: Reject SPEND_PROP events with no spend target

Follow-up from TASK-EAR-394 (reviewer finding on Games-Labs-Missions origin/staging 6ab88b6). Pre-existing.

buildCard's SPEND_PROP branch (internal/services/event_service.go) claims only when target > 0, where target = cfg.MinSpendingValue() (params.min_spending_value). missionEventDetailItemState says done when Progress > 0 && Progress >= Target. A SPEND_PROP event with min_spending_value 0 and progress above zero therefore shows items[0].state done while claimable is false, and missionEventAchievementStatus says in_progress: a finished event nobody can collect. internal/services/event_admin.go validateEventRequest does not check min_spending_value, so admin create/update accepts it.

Outcome: such an event cannot be saved or activated. Admin create/update rejects a SPEND_PROP condition whose min_spending_value is missing or <= 0 (ErrInvalidInput, HTTP 400 validation_failed). SetEventActiveAdmin refuses to activate a stored one, following the TASK-EAR-391 untrackedEventCondition pattern. Before deciding about existing rows, check staging events for SPEND_PROP with min_spending_value <= 0. Regression test fails first. PR to staging.
