# TASK-VS-066: UpSlip blog: editable cover image alt text

Editors cannot describe a post's cover image: slip-landing renders every uploaded cover with
`alt=""` and uses the post title for `og:image:alt`. Add a `cover_alt` field that the editor
writes in slip-admin, stored by slip-api, and used by slip-landing on the article page and in
the share-image tags.

- Type: feature in `slip-api` (migration + API). Schema change: one column on `blog_posts`.
- Created: 2026-11-09 by the Claude conductor lane at operator request ("ขอเพิ่ม custom tag alt
  ให้คนแก้ไข blog edit แยกด้วยได้ไหม ตอนนี้ผมไล่ดู น่าจะไม่มี"). Claude opens this run only;
  implementation goes to another lane.
- Follows TASK-VS-058 (blog API). Ownership as in TASK-VS-060's decision 3 unless Earth
  reassigns: the SPAR-55 squad builds slip-api; viewsupat builds the slip-admin field and the
  slip-landing changes against the contract below. This run's gates cover slip-api only.
- Gates: `production` preset + `knowledge_closeout`. UpSlip prod is live, not cost-gated.
  Promote main → staging → prod through PRs (`verifyslip-promote` skill).

## Operator decisions (Earth, 2026-11-09)

1. **Separate run** from TASK-VS-065 (who edited): alt is small and low risk and can ship in any
   window; VS-065 needs a quiet window for its boot-time locks.
2. **Where the alt is used:** the cover on the article page and `og:image:alt` (plus
   `twitter:image:alt`). Cards on the list page and the featured card keep `alt=""`, because the
   post title sits next to the image and a screen reader would read it twice.
3. **Optional, with a warning:** the admin warns when a post has an uploaded cover and an empty
   alt; saving and publishing still work. Empty means the cover is decorative (`alt=""`), so the
   existing posts need no edit.
4. **An alt-only edit does not move «อัปเดตล่าสุด»:** `cover_alt` is not a content field
   (`content_revision` and `content_updated_at` stay), like the cover itself. `updated_at` moves
   as for any save (and `updated_by`, once TASK-VS-065 ships).

## Facts checked by the conductor (2026-11-09, read-only)

- slip-api `origin/main` = `7de73f8`: no alt field anywhere in `internal/blog`, `069_blog_posts.sql`
  or `070_blog_categories.sql`. The cover is `cover_key` (upload via
  `POST /v1/admin/blog/posts/{slug}/cover`, removal via `DELETE …/cover`, both `SetCover`,
  `repository.go:232`), exposed as `cover_url`. `contentChanged` (`post.go:192`) counts title,
  crumb, category, summary, excerpt, author, read_minutes, sections and related only. Public and
  admin endpoints serialize the same `Post` type.
- slip-landing `origin/main`:
  - `app/components/blog/Article.vue:161`: the article-page cover `<img … alt="">`; without a
    cover it shows the preset artwork (`BlogThumb`, `aria-hidden="true"`).
  - `app/components/blog/Cover.vue:12`: list and featured cards, `<img … alt="" loading="lazy">`.
  - `app/pages/blog/[slug].vue:46-52`: `og:image` is the cover or the preset share PNG;
    `og:image:alt` is `article.title.join(' ')`; `twitter:image` is set, `twitter:image:alt` is not.
  - `app/pages/blog/preview.vue` `toPost()` maps the admin's live-preview message field by field,
    so a new field has to be added there too.
- slip-admin `origin/main`: the cover block in `BlogManage.vue` is shown only when editing an
  existing post (`:alt="t('blog.fields.cover')"` at `:758` is the admin's own preview image).
  `toBody`/`mapPost` in `app/features/blog/map.ts` list the fields explicitly.
- The article body has no images (the rich-text rules cover bold, links, tables and headings), so
  the cover is the only content image.

## Data model (migration, next free number)

```sql
-- +goose Up
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS cover_alt TEXT NOT NULL DEFAULT '';
-- guarded by a pg_constraint lookup so a re-run is a no-op:
ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_cover_alt_check
    CHECK (cover_alt = btrim(cover_alt) AND char_length(cover_alt) <= 250
           AND position(E'\n' IN cover_alt) = 0);
-- +goose Down
ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_cover_alt_check;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS cover_alt;
```

- The number: TASK-VS-065's spec names `079_blog_actor.sql`. Whichever run merges second takes
  the next number; check `migrations/` on `origin/main` right before the PR.
- A constant default is metadata-only, and `blog_posts` is tiny; no lock or boot-window concern.
- Down loses the alt texts; it is valid at any time.

## API (slip-api)

Same package and conventions as TASK-VS-058/060 (`internal/blog`, field-named validation errors).

- `Input` gains `cover_alt`, decoded as an optional pointer: **absent keeps the stored value**,
  `""` clears it. An admin build that predates the field (prod until viewsupat ships, or after an
  admin rollback) then never wipes an alt on save.
- Validation after `btrim`: at most 250 characters (runes; the text is usually Thai) and a single
  line, else 400 `cover_alt: must be one line of at most 250 characters`. Allowed with or without a
  cover.
- Removing the cover (`DELETE …/cover`) also clears `cover_alt` in the same `UPDATE`
  (conductor proposal: the text described that image). Uploading a replacement keeps it; the
  admin asks the editor to check it.
- Public and admin post responses add `cover_alt` (string, `""` when unset). The landing needs it
  on the public detail; the list may carry it too (same type).
- `contentChanged` does not include `cover_alt` (decision 4).
- When TASK-VS-065 has shipped: an alt change is an admin write (`updated_by`) and appears by name
  in the activity row's `changed`.

## Contract for viewsupat (not this run's gates)

- slip-admin, in the cover block of the edit form:
  - A text field «ข้อความ alt ของรูปปก» (`maxlength` 250, single line), with a hint to describe
    what the image shows rather than repeat the title.
  - A warning when the post has a cover and the field is empty (decision 3). After uploading a
    replacement cover, prompt to check the alt.
  - `toBody` sends `cover_alt`, `mapPost` reads it, and the live-preview message includes it.
- slip-landing:
  - `Article.vue` cover: `:alt="article.cover_alt"` (empty stays decorative).
  - `[slug].vue`: `og:image:alt` and a new `twitter:image:alt` use `cover_alt` when the post has
    a cover and a non-empty alt, otherwise the title as today.
  - `Cover.vue` cards keep `alt=""` (decision 2).
  - `preview.vue` `toPost()` maps `cover_alt`; type it optional (`cover_alt?: string`) so the page
    still works against an API without the field.
- Order: slip-api first on each environment. Admin and landing then ship in either order: the
  landing falls back to today's behaviour while the field is empty.

## Work in deploy order

1. slip-api: migration, `Input`/`Post` field, validation, cover-removal clear, README.
   - Tests: unit + PostgreSQL integration. Save with an alt; save again without the field (alt
     kept); save `""` (cleared); 251 characters and a newline → 400; an alt-only change leaves
     `content_revision` and `content_updated_at`; cover removal clears the alt; public responses
     carry `cover_alt`; migration replay plus goose Up/Down on a fresh database.
2. Review, then staging → prod per `verifyslip-promote`, each with Earth's approval.
3. Hand the contract to viewsupat (Earth relays).

Rollback: point the service back at the previous task definition and keep the column. The old
image ignores it; alts entered meanwhile come back when the new image returns.

## Acceptance (staging, then production; slip-api only)

- Boot runs the migration once with no fatal, and the listener opens. Existing posts return
  `cover_alt: ""`; every other public field is unchanged.
- With an admin login on a test post that has a cover: set an alt and read it back from the admin
  and public detail; save the post again without the field (alt kept); change only the alt
  («อัปเดตล่าสุด» / `content_updated_at` unchanged); send 251 characters and a newline (400 each);
  remove the cover (alt cleared). Clean up the test post afterwards.
- `/v1/web/packages`, the verify paths and unauthenticated admin 401 are unchanged.
- Once viewsupat's landing change is out (not a gate): the article page's cover `alt` and
  `og:image:alt` show the text; a preset-artwork post keeps the title.

## Traps

- PUT replaces the whole post. Decoding `cover_alt` as a plain string would let an old admin
  build wipe every alt on its next save; keep the absent-means-keep pointer.
- Count characters as runes, not bytes: a 250-character Thai alt is about 750 bytes.
- TASK-VS-065 touches the same `repository.go` statements (`Update`, `SetCover`) and also adds a
  migration; the second PR rebases and renumbers.
- slip-api main → staging → prod is sometimes promoted directly by a teammate, and viewsupat has
  pushed slip-api commits straight to `main` (`f82ba69`). Before claiming "on prod", check
  `origin/prod` ancestry and the running ECS image.
- Multica agents run in place in `/Users/earth/Documents/GitHub`. Touch only slip-api in this
  run; `Games-Lab-Android/` is read-only.
