# TASK-EAR-397: Backoffice event edit: block saving a SPEND_PROP with no spend target

Follow-up from TASK-EAR-395 (reviewer nit). Owner: Games-Labs-backoffice (PR to main; that repo deploys from main to admin-dev and has no staging branch).

Since TASK-EAR-395 (Missions 0d898d1 on staging), admin create/update of a SPEND_PROP condition with min_spending_value <= 0 returns 400 'SPEND_PROP requires min_spending_value > 0'. The create page already blocks that client side: app/pages/admin/manage/missions/event/create.vue typeRequiredValid (around line 134) requires specialItemCategory and minSpendingValue > 0, plus per-type minimums for the other types. The edit page app/pages/admin/manage/missions/event/edit/[id].vue canUpdate (around line 199) checks only dates, game selection and subReward. An operator who sets Min Spending Value to 0 on edit can press Update and gets a server 400 instead of a disabled button.

Outcome: the edit page refuses to submit the same type-required fields the create page refuses, at minimum SPEND_PROP minSpendingValue > 0 with a special item category. Reuse the create-page rule rather than duplicating it (e.g. move typeRequiredValid into a shared helper). Preserve the design-approved UI; do not restyle. Add a node test under tests/ that fails first.

Coordination: TASK-EAR-396 (in_review, another lane) also changes the event mission create/edit pages to stop offering CATEGORY_TURNOVER / ANY_GAME_TURNOVER. Rebase on it or merge after it, and check its PR before editing the same files.
