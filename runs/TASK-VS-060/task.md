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
- Migration 070 creates `blog_posts_category_idx` on a live table. The `verifyslip-promote`
  playbook requires prebuilding indexes concurrently in a 01:00–05:00 Bangkok window and
  verifying the index before rollout. Plan and schedule this before merging the production PR.
- Production `slip-api-production:133`, image `production-sha-ccf727d`, was PRIMARY COMPLETED
  3/3 during preflight and is the rollback target. Keep migration 070's schema on image rollback;
  an old binary rejects renamed or new category names. Production has no automatic deployment
  circuit-breaker rollback. No production deploy or schema operation was performed in preflight.
