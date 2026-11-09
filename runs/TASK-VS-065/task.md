# TASK-VS-065: UpSlip blog: record who created and last edited posts and categories

Blog posts and categories record when they changed, not who changed them. Add `created_by` and
`updated_by` to both tables for the admin list, and write `activity_logs` rows for every blog
admin write so the history, including deletes and moves, is kept.

- Type: feature in `slip-api` (migration + API). Schema change: two nullable columns on
  `blog_posts` and on `blog_categories`, and a wider `activity_logs_entity_type_check`.
- Created: 2026-11-09 by the Claude conductor lane at operator request ("ผมกำลังมองเรื่องบันทึกว่า
  ใครเป็นคนแก้ไขล่าสุดด้วย", then "เปิด run แบบ C"). Background and the option comparison are in
  TASK-VS-060 `task.md`, section "Open: record who last edited". Claude opens this run only;
  implementation goes to another lane.
- Follows TASK-VS-058 (blog API) and TASK-VS-060 (categories). Ownership as in TASK-VS-060's
  decision 3 unless Earth reassigns: the SPAR-55 squad builds slip-api; viewsupat builds the
  slip-admin side against the contract below. This run's gates cover slip-api only.
- Gates: `production` preset + `knowledge_closeout`. UpSlip prod is live, not cost-gated.
  Promote main → staging → prod through PRs (`verifyslip-promote` skill).

## Operator decisions (Earth, 2026-11-09)

1. **Option C:** columns for "last edited by" in the list, `activity_logs` for history.
2. **Every admin write counts.** Post create, update (including status and featured), cover
   upload and cover removal set `updated_by`. Rule: `updated_by` changes exactly when
   `updated_at` changes, and is set to the admin who made the request.
3. **Delete with move sets the moved posts' `updated_by`** to the admin who deleted the
   category (the move already sets their `updated_at`).
4. **Show the name, else the email.** The admin API returns `{id, name, email}`; the admin shows
   the first and last name, falls back to the email when the name is empty, and shows the email
   on hover. Never in public `/v1/web/...` responses.
5. **slip-admin contract:** "last edited by" in the post list and the category list, plus a
   per-item history panel.

## Facts checked by the conductor (2026-11-09, read-only)

- slip-api `origin/main` = `7de73f8`, `origin/prod` = `8b8ac7d`. The latest migration on every
  remote branch and local slip-api worktree is `078_verification_not_found_slips.sql`; check
  again before numbering.
- `blog_posts` (069) and `blog_categories` (070) have `created_at` and `updated_at` only (plus
  `published_at` and `content_updated_at` on posts). `author` is the byline typed in the form
  (default «ทีม Up-Slip»), not the editor; it stays as is.
- `AdminAuth` (`internal/handler/middleware/admin.go`) resolves the admin and calls
  `requestctx.WithUser(ctx, models.UserIdentity{ID, Email, Role: admin})`. `internal/blog` never
  reads it.
- `activity_logs` (017): `actor_user_id` (FK users, `ON DELETE SET NULL`), `actor_email`,
  `actor_role`, `action` (`created`, `updated`, `deleted`), `entity_type`, `entity_id`,
  `old_value`, `new_value` (JSONB), `ip`, `user_agent`, `created_at`; index
  `activity_logs_entity_idx (entity_type, entity_id, created_at DESC)` already covers a per-item
  history query. The current `activity_logs_entity_type_check` (026) allows `user`, `package`,
  `branch`, `merchant`, `kyc`, `configuration`.
- `service.NewActivityLogger` (`internal/core/service/activity.go`) fills actor, IP and user
  agent from the context and is best effort: a failed insert logs `save activity log` and the
  request still succeeds. `cmd/main.go:131` builds one `activityLogger`; `blog.NewHandler(store,
  uploader)` (`cmd/main.go:112`) does not receive it. `ports.ActivityLogger` is the interface.
- `GET /v1/admin/activity-logs` (behind `AdminAuth`) filters on `entity_type`, `entity_id`,
  `action`, `actor_user_id`, `q`, `from`, `to`, `limit`, `offset` and returns the admin page shape
  (`items`, `total`, `has_more`, `limit`, `offset`). slip-admin has no screen that calls it.
- Every blog write and the rows whose `updated_at` it moves (`internal/blog`):
  - `Create` and `Update` (`repository.go`). Featuring a post un-features the previous one with
    `UPDATE blog_posts SET featured = FALSE, updated_at = NOW() WHERE featured …`
    (`repository.go:136`, `:197`), so that second post's `updated_at` moves too.
  - `Delete` (`repository.go:219`), `SetCover` for upload and removal (`repository.go:232`).
  - `CreateCategory`, `UpdateCategory` (`category_repository.go:76`), `DeleteCategory`
    (`category_repository.go:127`), whose move runs
    `UPDATE blog_posts SET category = $2, updated_at = NOW() WHERE category = $1` in the same
    transaction.
  - A category rename cascades to `blog_posts.category` through the FK and does not move the
    posts' `updated_at`.
- Public and admin post endpoints serialize the same `Post` type (`handler.go:44`, `:54`, `:63`,
  `:72`).
- `users` has `first_name`, `last_name` (`TEXT NOT NULL DEFAULT ''`, 001) and `email`.
- Staging already shows the gap: category `test-1a` «ทดสอบ» exists with one published post, and
  nothing records who created it.

## Data model (migration `079_blog_actor.sql`)

```sql
-- +goose Up
ALTER TABLE blog_posts      ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE blog_posts      ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_entity_type_check
    CHECK (entity_type IN ('user', 'package', 'branch', 'merchant', 'kyc', 'configuration',
                           'blog_post', 'blog_category')) NOT VALID;
```

- No backfill: existing rows stay NULL (there is no source). No new index: the blog tables are
  tiny and `activity_logs_entity_idx` covers the history query.
- `NOT VALID` on purpose. Every existing row satisfies the old, narrower list; new rows are
  checked either way. A `VALIDATE CONSTRAINT` inside goose's transaction would scan all of
  `activity_logs` while still holding the ACCESS EXCLUSIVE lock from the DROP, blocking every
  activity insert during boot. If validation is wanted, do it later outside the boot path.
- Down: drop the four columns. Restoring the old CHECK first needs
  `DELETE FROM activity_logs WHERE entity_type IN ('blog_post', 'blog_category')` (the 026
  pattern), which destroys the history: a data decision, never a rollback step.

## API (slip-api)

Same package and conventions as TASK-VS-058/060 (`internal/blog`, 3 s `queryTimeout`, admin
routes behind `AdminAuth`, field-named validation errors).

- **Actor.** Read `requestctx.User(ctx)` in the handler or repository for every admin write. No
  user in the context (tests, or a future caller outside `AdminAuth`) writes NULL; never fail the
  write for it.
- **Columns** (decision 2, 3):
  - Post create: `created_by = updated_by = actor`. Category create: the same.
  - Every statement that sets a post's or category's `updated_at = NOW()` also sets
    `updated_by = actor`: post update, cover upload and removal, the un-feature of the previously
    featured post, category update, and the posts moved by a category delete.
  - The FK cascade of a category rename changes neither the posts' `updated_at` nor
    `updated_by`.
- **Admin responses only.** Admin post responses (`GET /v1/admin/blog/posts[/{slug}]`, create,
  update, cover) and `GET /v1/admin/blog/categories` (plus category create and update) add
  `created_by` and `updated_by`, each `{"id","name","email"}` or `null`. `name` is
  `btrim(first_name || ' ' || last_name)` (may be empty); join `users` at read time, so a deleted
  user shows `null`. Public `/v1/web/blog/posts[/{slug}]` and `/v1/web/blog/categories` must not
  change: the shared `Post` type needs a separate admin shape or fields that stay absent on the
  public path (assert it in a test).
- **Activity log** through the existing `ports.ActivityLogger` (pass it to `blog.NewHandler`),
  best effort like every other entity (conductor proposal; a reviewer may ask for an in-transaction
  insert instead). `actor_role` is `admin`.
  - Entity ids: `blog_post` uses the post `id` (UUID, stable across slug edits);
    `blog_category` uses the slug (immutable).
  - Post create → `created`; update, cover upload/removal → `updated`; delete → `deleted`.
  - Featuring a post that un-features another → also an `updated` row for the other post.
  - Category create → `created`; update (rename, order, preset) → `updated` with old/new values
    and, on a rename, the number of posts the cascade renamed.
  - Category delete → `deleted` for the category, with `post_count` and `moved_to` (slug or
    null), plus one `updated` row per moved post (`changed: ["category"]`) so each post's history
    shows the move.
  - Values (conductor proposal): a compact snapshot, not the article body. Posts: `slug`,
    `title`, `category`, `status`, `featured`, `thumb_preset`, `cover_set`, `content_revision`,
    plus `changed` (field names that differ; `sections`, `related`, `summary`, `excerpt`, `crumb`,
    `author`, `read_minutes` appear only by name). Categories: `slug`, `name`, `sort_order`,
    `default_thumb_preset`.
- **History endpoint.** The panel uses `GET /v1/admin/activity-logs?entity_type=blog_post&entity_id=<id>`
  (or `blog_category` + slug). Add `actor_name` to each item (same `users` join, empty when the
  user is gone) so the panel can follow decision 4; `actor_email` stays. Backward compatible.

## Contract for viewsupat (not this run's gates)

- Post list: show «แก้ไขล่าสุดโดย {name or email} · {updated_at}», «—» when `updated_by` is null.
  Same on each row of the category modal.
- Per-item history panel for a post (from the edit form) and for a category (from its row):
  newest first from the activity-logs endpoint above, showing action, actor (`actor_name`, else
  `actor_email`), time, and `changed` for updates; page with `limit`/`offset`. Deleted posts and
  categories have no row to open, so their history is out of scope for the panel.
- Order: slip-api first on each environment. The current admin ignores the new fields, so
  nothing breaks before the admin ships.

## Work in deploy order

1. slip-api: migration 079; actor plumbing; column writes in every statement listed above;
   admin-only response fields; activity-log writes; `actor_name` on the activity-logs endpoint;
   README section.
   - Tests: unit + PostgreSQL integration. Seed two admin users and assert `created_by` and
     `updated_by` per write, including cover, the un-featured post, and posts moved by a category
     delete. Assert that a rename leaves the posts' `updated_by` unchanged, that public responses
     are byte-identical in shape to before (no new keys), and that the activity rows (action,
     entity id, `changed`, `moved_to`) exist. Migration replay plus goose Up/Down on a fresh
     database.
2. Review, then staging → prod per `verifyslip-promote`, each with Earth's approval.
3. Hand the contract to viewsupat (Earth relays).

Rollback: point the service back at the previous task definition and keep the schema. The old
image ignores the new nullable columns and never writes the new entity types; writes made by the
old image leave `updated_by` as it was (stale until the next write by the new image).

## Acceptance (staging, then production; slip-api only)

- Boot runs migration 079 once with no fatal, and the listener opens. Public posts and categories
  responses are unchanged (same keys).
- With an admin login: create a post, update it, toggle featured (check the previously featured
  post too), upload and remove a cover; create, rename, reorder and delete-with-move a category.
  After each, the admin response shows the right `updated_by`, and the activity-logs endpoint
  returns the matching row with `actor_name`/`actor_email`. If two admin accounts are available,
  edit with the second and see `updated_by` switch. Clean up test posts and categories afterwards
  (including staging's `test-1a` if Earth agrees).
- Unauthenticated admin and activity-logs requests return 401. `/v1/web/packages` and the verify
  paths are unchanged.
- Logs over the rollout window: no `save activity log` errors.

## Traps

- **Locks during boot.** The DROP/ADD of the CHECK takes ACCESS EXCLUSIVE on `activity_logs`, and
  each `ADD COLUMN … REFERENCES users(id)` takes SHARE ROW EXCLUSIVE on `users` (writes to users,
  such as sign-ins, wait). Both are instant on their own but queue behind any long transaction on
  those tables and then block everyone queued after them. goose runs before the listener
  (task replaced in about 150 s). Consider `SET LOCAL lock_timeout` in the migration and a quiet
  window (01–05 Bangkok), and get a read-only row count of `activity_logs` on prod before the
  production promotion.
- Public responses share the `Post` type: the easiest mistake is leaking admin emails through
  `/v1/web/blog/posts`. Test it.
- `ON DELETE SET NULL` on users: deleting an admin user clears their `created_by`/`updated_by`;
  `activity_logs.actor_email` keeps the email.
- Category names are Thai; compare after `btrim`, never lowercase (as in TASK-VS-060).
- TASK-VS-066 (cover alt, opened 2026-11-09) touches the same `repository.go` statements
  (`Update`, `SetCover`) and adds a `blog_posts` migration too. Whichever PR merges second
  rebases and takes the next migration number (079 is only this spec's proposal).
- slip-api main → staging → prod is sometimes promoted directly by a teammate, and viewsupat has
  pushed slip-api commits straight to `main` (`f82ba69`). Before claiming "on prod", check
  `origin/prod` ancestry and the running ECS image.
- Multica agents run in place in `/Users/earth/Documents/GitHub`. Touch only slip-api in this
  run; `Games-Lab-Android/` is read-only.
