# TASK-VS-060: UpSlip blog categories: managed through slip-api instead of hardcoded

The four blog categories are fixed in four places, so a new or renamed category needs a
migration plus three deploys. Move them into a slip-api table with a public list and admin
CRUD; admin and landing then read the list from the API.

- Type: feature in `slip-api` (migration + API). Schema change: new table `blog_categories`,
  drop `blog_posts_category_check`, add a foreign key from `blog_posts.category`.
- Created: 2026-11-04 by the Claude conductor lane at operator request ("ขอทำ API เพิ่มเรื่อง
  เส้นหมวด ตอนนี้เหมือนล็อคค่าถาวรไว้"). Claude opens this run only; implementation goes to
  another lane.
- Follows TASK-VS-058 (blog API). Same ownership as its decision 11: the SPAR-55 squad builds
  slip-api; viewsupat owns slip-admin and slip-landing and uses the contract below.
- Gates: `production` preset + `knowledge_closeout`, slip-api only. UpSlip prod is live, not
  cost-gated. Promote main → staging → prod through PRs (`verifyslip-promote` skill).

## Operator decisions (Earth, 2026-11-04)

1. **Linking: keep the category name on the post, add a foreign key.** `blog_posts.category`
   stays the display name, so the post API shape does not change. It references
   `blog_categories(name)` `ON UPDATE CASCADE`: renaming a category renames it on every post.
   The admin and landing builds on prod keep working until they move to the category API.
2. **Deleting a category that posts use moves them.** `DELETE` takes a target category and moves
   every post (draft and published) to it in the same transaction, then deletes. Rules are under
   API below.
3. **Ownership:** the squad builds slip-api; viewsupat builds the admin category screen and the
   landing tabs from the API. This run's gates cover slip-api only.
4. **Separate run.** TASK-VS-058 closes on its own after its production cover-upload check.

## Facts checked by the conductor (2026-11-04, read-only)

- slip-api `origin/main` = `origin/prod` = `ccf727d` (payment commits by others since VS-058's
  `e0ddd56`; nothing under `internal/blog` or `migrations`). Latest migration is
  `069_blog_posts.sql`; check again before numbering.
- Where the categories are fixed today:
  - `migrations/069_blog_posts.sql:26`: `CONSTRAINT blog_posts_category_check CHECK (category IN
    ('วิธีดูสลิปปลอม', 'เทคนิคสำหรับร้านค้า', 'คู่มือนักพัฒนา', 'ข่าวธนาคารและระบบ'))`.
  - `internal/blog/post.go:24`: `presetByCategory` maps each name to its default
    `thumb_preset` and is also the validity check (`presetByCategory[in.Category] == ""` →
    400 at `post.go:105`; default preset at `post.go:111`). `validPresets` (7 SVG presets that
    exist in slip-landing) stays fixed.
  - slip-admin `app/features/blog/type.ts:2` `BLOG_CATEGORIES` (form and filter dropdowns in
    `BlogManage.vue`).
  - slip-landing `app/data/blogPresets.ts:13` `categories` (tabs in `pages/blog/index.vue`).
- Category is a content field: `post.go:171` counts a category change as a content revision.

## Data model (migration `070_blog_categories.sql`, idempotent)

```sql
CREATE TABLE IF NOT EXISTS blog_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
    name TEXT NOT NULL UNIQUE CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
    sort_order INTEGER NOT NULL DEFAULT 0,
    default_thumb_preset TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- Seed the four current categories `ON CONFLICT DO NOTHING`, keeping today's default presets:

  | sort | slug | name | default_thumb_preset |
  | --- | --- | --- | --- |
  | 1 | `fake-slips` | วิธีดูสลิปปลอม | `fake-slip-signs` |
  | 2 | `merchant-tips` | เทคนิคสำหรับร้านค้า | `close-chat-orders-faster` |
  | 3 | `developer-guides` | คู่มือนักพัฒนา | `api-quickstart` |
  | 4 | `bank-news` | ข่าวธนาคารและระบบ | `bank-slip-redesign` |

  The slugs are the conductor's proposal; change them before the migration first ships, never
  after (slugs are immutable).
- `ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_category_check`.
- Add `blog_posts_category_fkey FOREIGN KEY (category) REFERENCES blog_categories(name)
  ON UPDATE CASCADE ON DELETE RESTRICT`, guarded by a `pg_constraint` check so a re-run is a
  no-op. Every existing row satisfies it because the old CHECK allowed only the four seeded
  names. Add `CREATE INDEX IF NOT EXISTS blog_posts_category_idx ON blog_posts (category)`.
- Both tables are tiny (7 posts on prod), so the goose-before-listener boot window is not a
  concern.
- Down: drop the FK and index, re-add the CHECK, drop `blog_categories`. The Down is valid only
  while every post still uses one of the four original names; after a rename or a new category
  it fails, and that is a data decision, not a rollback step.

## API (slip-api)

Same package and conventions as the blog posts (`internal/blog`, 3 s `queryTimeout`, `no-store`
on public responses, admin routes behind `AdminAuth` and 401 when it is nil). Validation errors
name the field (the VS-058 follow-up), for example `{"message":"name: must be 1 to 80 characters"}`.

- `GET /v1/web/blog/categories` (public): all categories ordered by `sort_order`, then `name`:
  `[{"slug","name","sort_order","published_count"}]`. Landing decides whether to hide empty tabs.
- `GET /v1/admin/blog/categories`: as above plus `default_thumb_preset`, `post_count` (all
  statuses), `created_at`, `updated_at`.
- `POST /v1/admin/blog/categories` `{slug, name, sort_order?, default_thumb_preset?}` → 201.
  `default_thumb_preset` defaults to `fake-slip-signs` and must be one of `validPresets`. At most
  50 categories (409 over the cap).
- `PUT /v1/admin/blog/categories/{slug}` `{name?, sort_order?, default_thumb_preset?}` → 200.
  The slug cannot change. A rename cascades to `blog_posts.category` through the FK and does not
  move any post's `content_revision` or `content_updated_at` (housekeeping, not a content edit).
- `DELETE /v1/admin/blog/categories/{slug}?move_to=<slug>` → 204.
  - No post uses it: deleted; `move_to` is ignored.
  - Posts use it and `move_to` is missing: 409 `{"message":"…","post_count":N}`.
  - `move_to` equals the deleted slug or does not exist: 400.
  - The last remaining category: 409, so a post can always be created.
  - Otherwise, in one transaction: move every post (draft and published) to the target, set
    those rows' `updated_at`, leave `content_revision`, `content_updated_at` and `featured`
    unchanged, then delete.
- Duplicate slug or name: 409. Unknown slug: 404.
- Posts: drop `presetByCategory`. `category` must name an existing category; an unknown name is
  400 `category: unknown` (check it, or map the FK violation `23503` to that 400). When a post
  omits `thumb_preset`, use the category's `default_thumb_preset`. `validPresets` is unchanged.

## Contract for viewsupat (not this run's gates)

- Admin: a category screen on the endpoints above (list with counts, create, rename, reorder,
  delete with a "move posts to" picker), and the post form's category dropdown and filter read
  `GET /v1/admin/blog/categories` instead of `BLOG_CATEGORIES`.
- Landing: tabs from `GET /v1/web/blog/categories` (it needs the same CORS as the posts list,
  already in place), instead of `categories` in `blogPresets.ts`; posts still carry the name.
- Order: slip-api first on each environment. The current admin and landing keep working
  against the new slip-api because posts still carry the same names.

## Work in deploy order

1. slip-api: migration 070, repository + handlers + router, post validation change, tests
   (unit + PostgreSQL integration for the cascade, the move-on-delete transaction, 409/400/404
   rules, and that a rename does not move `content_updated_at`), README section.
2. Review, then staging → prod per `verifyslip-promote`, each with Earth's approval.
3. Hand the contract to viewsupat (Earth relays).

Rollback: point the service back at the previous task definition. The old image still reads
posts, and posts in an original category keep saving. A post moved to a new category cannot be
saved by the old image (its fixed map rejects the name) until it is moved back. Keep the table.

## Acceptance (staging, then production; slip-api only)

- Boot runs migration 070 once, with no fatal; the four categories exist; `/v1/web/blog/posts`
  responses are unchanged.
- `GET /v1/web/blog/categories` returns the four in order with correct `published_count`, with
  `no-store` and the landing CORS origins.
- With an admin login: create a category, rename it (a post in it shows the new name in the
  public post response, and its «อัปเดตล่าสุด» does not move), reorder, delete with `move_to`
  (posts land in the target), delete without `move_to` while in use (409), delete the last
  category (409), and an unknown category on a post save (400). Clean up test categories after.
- Admin routes reject an unauthenticated request (401). `/v1/web/packages` and the verify paths
  are unchanged.
- The admin build on prod (fixed list) still saves a post in an original category.

## Traps

- `ON UPDATE CASCADE` needs the referenced `name` to be `UNIQUE` (it is) and makes a rename
  touch every post row in that category in one statement; fine at this size.
- Category names are Thai; compare after `btrim`, never lowercase.
- slip-api main → staging → prod is sometimes promoted directly by a teammate. Before claiming
  "on prod", check `origin/prod` ancestry and the running ECS image.
- Multica agents run in place in `/Users/earth/Documents/GitHub`. Touch only slip-api in this
  run; `Games-Lab-Android/` is read-only.

## Production preflight (2026-11-04)

- Earth requested production promotion in Multica comment `01a1a640-a7a9-7622-9923-3e953cfaf7b4`;
  recorded as `authz-002`. This does not claim that staging acceptance has passed.
- Draft PR https://github.com/SparqLab/slip-api/pull/121 targets `prod` `ccf727d` from
  `release/TASK-VS-060-production` `ea9893ad`; its tree `f18b52ae20e6b29a8bd9f8936dc90afb09c12be1`
  equals staging `7598907`. The only non-merge commit in scope is `e90641b8` (VS-060).
- Staging deploy passed; authenticated category CRUD and a live hidden-draft check remain
  outstanding for `staging_acceptance`. Do not mark the gate passed without evidence.
- Earth explicitly approved an exception in Multica comment
  `01a1a70f-e09c-766a-acd9-04fe8a5f8e41`: skip production DB preflight and index prebuild;
  run migration 070 unchanged at boot. No migration pool/timeout work is required before
  this rollout. Earth accepts the remaining lock/startup risk; published count does not prove
  total rows and DB catalog/locks/size remain unobserved. See `production-migration-plan.md`.
- In later comment `01a1a714-68e8-72d2-8db0-6f423af93fde`, Earth directed production
  promotion now and expects frontend checks tomorrow. `staging_acceptance` remains pending
  until authenticated CRUD/draft checks are observed; do not claim it passed. Announce the
  planned time in the issue before ready/merge, revalidate release and rollback target, and
  immediately inspect migration/listener boot logs. Do not rename/delete categories in
  production until production admin reads the API.
- Production `slip-api-production:133`, image `production-sha-ccf727d`, was PRIMARY COMPLETED
  3/3 during preflight and is the rollback target. Keep migration 070's schema on image rollback;
  an old binary rejects renamed or new category names. Production has no automatic deployment
  circuit-breaker rollback. No production deploy or schema operation was performed in preflight.

## Status (checked 2026-11-09, read-only)

- The slip-api production rollout completed on 2026-11-04: `slip-api-production:134`, image
  `production-sha-b9f8cda`, PRIMARY COMPLETED at 15:18:33 UTC. Details and evidence
  (`ev-012`–`ev-021`) are in `production-migration-plan.md`. slip-api `origin/prod` has since
  moved to `8b8ac7d` (other tasks); `internal/blog` changed once after VS-060 (`f82ba69`, below).
- This update changes no gate. `implementation_verification` and `deploy_staging` pass.
  `staging_acceptance` is pending (authenticated CRUD and draft visibility still unobserved).
  `deploy_production` is pending only because it depends on `staging_acceptance`; the deploy
  itself ran. `production_acceptance` and `knowledge_closeout` are pending.
- The condition on "do not rename or delete production categories until production admin reads
  the API" is now met: slip-admin prod has read the API since 2026-11-05 01:27 UTC and
  slip-landing prod since 2026-11-06 09:27 UTC (below). Public
  `GET https://api.up-slip.com/v1/web/blog/categories` at 2026-11-09 02:45 UTC still returned
  the four seeded categories, counts `[1,0,0,0]`, `no-store`: nobody has changed a production
  category yet.
- Staging at the same time had five categories. The fifth is `test-1a` «ทดสอบ», sort 5, with one
  published post, so someone created it through the admin and put a published post in it. That
  suggests create works end to end, but it is not acceptance evidence (no observed rename,
  delete with move, 409 or 400), and nothing records who created it or when (see the last
  section). Acceptance includes cleaning up test categories.
- What the admin UI can cover for `staging_acceptance`: create, rename, reorder (sort number)
  and delete with move. It cannot reach the error paths: it never sends an in-use delete without
  `move_to`, it disables delete on the last category, and the post form offers only existing
  categories. The 409 in-use, 409 last-category and 400 `category: unknown` checks need direct
  authenticated API calls.

## Frontend integration (viewsupat; checked 2026-11-09 from git and deploy runs, read-only)

Both halves of the contract shipped. viewsupat's commits went main → staging → prod by direct
merges, without PRs.

### slip-admin `9e8f4e1` (2026-11-04 21:28 +07)

Deployed to staging by `82c77c3` (Deploy STAGING 2026-11-04 14:29 UTC, success) and to prod by
`11e63de` (Deploy PRODUCTION 2026-11-05 01:27 UTC, success).

- `BLOG_CATEGORIES` is gone. The post-list filter and the post form's category dropdown load
  `GET /v1/admin/blog/categories` (option value = name, key = slug). A filter left on a renamed
  or deleted category resets.
- A new «จัดการหมวด» button (with the count) opens `BlogCategoriesModal.vue`:
  - List: sort order, name, `slug · default preset`, and a post-count badge (all statuses; the
    tooltip shows published).
  - Inline edit: name, sort order, default preset. Renaming a category in use shows how many
    posts it affects. The slug is read-only.
  - Delete: a category in use needs a "move posts to" pick and then calls
    `DELETE …?move_to=`; an empty one deletes directly; the delete button is disabled on the last
    category. A failed delete reloads the counts.
  - Add: name, slug (format and uniqueness checked in the browser, max 60), sort order (defaults
    to the highest + 1), default preset.
  - After any change, both the categories and the post list reload (renames cascade, deletes
    move posts).
- A new post starts in the first category, and picking a category sets `thumb_preset` to that
  category's `default_thumb_preset`. Existing posts keep their preset.
- `BlogPresetPicker.vue` shows the 7 presets as thumbnails in the post form and the category
  form. The images load from `https://up-slip.com/og/blog/<preset>.png` (the production landing,
  on the staging admin too).
- Reordering is the sort-order number field; there is no drag.

### slip-landing `3b8b801` (2026-11-06 16:26 +07)

Deployed to staging by `c2e616d` and to prod by `63578b0` (Deploy PRODUCTION 2026-11-06 09:27
UTC, success).

- `useBlogCategories()` reads `GET /v1/web/blog/categories` with the short optional timeout. If
  it fails, the page uses `fallbackCategories` (the four original names).
- Tabs follow `sort_order` but show only categories with at least one card in the list below
  (the featured post is excluded), so no tab opens empty. A category name a post uses but the
  API list lacks is appended at the end. `published_count` is not used. The section
  description's "แบ่งเป็น N หมวด" is now computed and shown only when N > 1.

### Other blog work in the same period (outside this run)

- slip-api `f82ba69` (viewsupat, 2026-11-05 21:18 +07): sections accept `list_style` = `check`,
  `bullet` or `number` (empty → `check`, anything else 400), with tests and a README note. No
  migration (it lives in the `sections` JSONB). It was pushed straight to `main` without its own
  PR and reached production inside TASK-VS-062's promotion PRs
  https://github.com/SparqLab/slip-api/pull/123 and
  https://github.com/SparqLab/slip-api/pull/124 (2026-11-05 19:31 UTC). TASK-VS-062 names it only
  as its baseline commit; no run reviewed it as a change.
- slip-admin, in prod since `017bb90` (2026-11-06 09:00 UTC): a list-style picker (`c9a3097`),
  card previews (`c2b80ab`), opening the unsaved article on the real landing page (`06a018d`:
  `window.open` plus `postMessage`, with admin and landing origins paired per environment), and
  body formatting: `**bold**`, links `[label](https://…)` or `[label](/path)` and bare URLs, with
  only http(s) or relative targets (`ef41e09`), `| table |` rows (`ffa6d88`), and `#`–`###`
  headings rendered as h3/h4 (`03cd454`).
- slip-landing renders the same rules (`131396e`, `2046437`, `f8d040f`), adds `/blog/preview`
  for the admin's live preview (`56be359`), and renders list styles (`f390a7d`). slip-landing
  `app/` has no `v-html`.
- The formatting lives inside `body` strings; slip-api stores it as text and needs no change for
  it.

## Open: record who last edited (operator interest 2026-11-09; not started, no code)

Facts (slip-api `origin/main` `7de73f8`):

- Neither `blog_posts` (069) nor `blog_categories` (070) has an actor column: only `created_at`
  and `updated_at`, plus `published_at` and `content_updated_at` on posts. `author` is the byline
  typed in the form (default «ทีม Up-Slip»), not the editor.
- `AdminAuth` (`internal/handler/middleware/admin.go`) already puts the admin's user ID and
  email in the request context (`requestctx.WithUser`). `internal/blog` never reads it.
- A generic audit table exists: `activity_logs` (017) with `actor_user_id`, `actor_email`,
  `actor_role`, `action` (created, updated, deleted), `entity_type`, `entity_id`, `old_value` and
  `new_value` JSONB, IP and user agent. `activityLogger.Log` fills the actor from the context, and
  `GET /v1/admin/activity-logs` lists the rows. Its `entity_type` CHECK (026) allows only user,
  package, branch, merchant, kyc and configuration, so blog entities need a migration. slip-admin
  has no screen that calls that endpoint.
- The admin writes that would count: post create, update, delete, cover upload and cover removal;
  category create, update, and delete (with move).
- Users have `first_name`, `last_name` and `email`.

Options:

- A. Columns `created_by` and `updated_by` (`UUID REFERENCES users(id) ON DELETE SET NULL`) on
  both tables, set from the context on every admin write and returned only by admin endpoints
  (with a display name or email). This answers "who edited last" in the list. It does not cover
  deletes (the row is gone) and keeps no history.
- B. `activity_logs` rows for `blog_post` and `blog_category` (extend the CHECK; keep old and new
  values). Full history, including deletes and who moved posts. Showing "last edited by" in the
  list needs a lookup per row, and the admin needs a viewer.
- C. A for the list display, B for history and deletes.

Decisions to make before opening a run:

1. A, B or C.
2. What counts as an edit: every admin write (status, featured, cover) or only content changes
   (the `content_revision` rule)?
3. Category housekeeping: a rename cascades to posts through the FK, so the posts' `updated_by`
   would not change. Should a delete with move set the moved posts' `updated_by` to the admin who
   deleted the category?
4. Show a name or an email. Either way, keep it out of public `/v1/web/...` responses (personal
   data).
5. Existing rows stay NULL (shown as «—»); there is nothing to backfill from.

This is a schema change, so it belongs in its own run (migration 079 or later, idempotent for
boot replay, slip-api before slip-admin), not in this one.

Opened as TASK-VS-065 on 2026-11-09: Earth chose C, every admin write counts, a delete with move
sets the moved posts' `updated_by`, show the name else the email, and the admin gets the list
column plus a per-item history panel.
