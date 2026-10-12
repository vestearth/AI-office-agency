# TASK-EAR-400: Staging data: canonical special item category on event spend-withdfghfg-e4cca498

Found during TASK-EAR-398 admin-dev acceptance. Staging only; no code change.

Staging event spend-withdfghfg-e4cca498 ("Spend withdfghfg", SPEND_PROP, min_spending_value 1000, expired, active true) stores special_item_category "Limited Avatar". The Backoffice event options are "Randomly by System", "Special Item/Limited Avatar" and "Special Pass" (EVENT_SPECIAL_ITEM_RANDOM + eventMissionSpecialItemOptions, app/data/mock.ts), so its edit page loads the select blank (selectedIndex -1).

Missions is unaffected by the spelling. NormalizeSpecialItemType (Games-Labs-Missions origin/staging internal/models/event.go:84) maps "Limited Avatar" and "Special Item/Limited Avatar" to the same avatar type, SpecialItemCandidates passes a non-sentinel category through as is, and per-user selections already locked in the special-item selection ledger are immutable. Rewriting the stored value to the canonical "Special Item/Limited Avatar" (SpecialItemAvatarLabel, event.go:57) therefore only fixes the admin display.

Outcome: the event stores "Special Item/Limited Avatar"; every other field (title, description, thumbnail, window, reward, min_spending_value, active, sort_order) is unchanged; the edit page shows that option selected.

How: read the event first (GET /api/v1/admin/missions/events/spend-withdfghfg-e4cca498) and record it, then PUT the same payload with only the category changed (admin update replaces conditions, so send every field back exactly). Read it again and diff. Before writing, confirm that this event's selection-ledger rows (special item selections for surface event, scope spend-withdfghfg-e4cca498) are unaffected by an update. Do not touch prod. Check that no other staging event stores a non-canonical special item category.
