# TASK-EAR-157 — Lock Restore Streak currency to Diamond (FE) + backfill existing configs

## Operator decision

1. **FE-only lock.** The backend keeps accepting `COIN` / `DIAMOND` / `POINT`
   (validated by TASK-EAR-116) so the other currencies can be re-enabled later
   without a backend change. Only the Backoffice UI stops offering a choice.
2. **Backfill everything to `DIAMOND`** — existing check-in campaign restore
   configs and the default check-in template.
3. Close out TASK-EAR-115 (POINT restore fee routed to RedeemPoints).

## UX contract

The Currency field stays **visible** (operators need the unit next to
`Pricing`), but is no longer a `<select>`:

- Rendered as a locked read-only value: `Diamond` + lock affordance.
- No dropdown, no chevron, no disabled `<option>` list. A disabled `<select>`
  that still lists Coin/Point implies those are available-but-blocked, which is
  wrong and is also a focus/tooltip dead end for a11y.
- Reason surfaced on the existing (i) affordance in the Restore Streak card
  header.

Affected surfaces (both consume `RestoreStreakEditor`):
- `app/pages/admin/manage/missions/monthly/settings.vue` (default template)
- `app/pages/admin/manage/missions/monthly/edit/[id].vue` (per-month campaign)

## Data backfill

Restore currency is persisted in two places in the Missions DB:

| Location | Backfill |
| --- | --- |
| `check_in_restore_configs.currency` | → `DIAMOND` |
| `mission_config.check_in_template` → `restore.currency` | → `DIAMOND` |

`check_in_restore_ledgers.currency` is **NOT** migrated — it is the audit record
of what was actually charged at the time.

### Trap: migrations replay on every boot

`migrations/run.go` embeds and executes every `*.sql` on every process start —
there is no `schema_migrations` version table. A bare
`UPDATE ... SET currency='DIAMOND'` would therefore re-clobber the column on
every restart, permanently defeating decision (1). The backfill must be
**one-shot**, guarded by an applied-marker row.

## Out of scope

- Backend currency enforcement (deliberately not done — see decision 1).
- Daily / Weekly / Bonus reward currency dropdowns — unchanged, still full list.
