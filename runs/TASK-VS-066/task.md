# TASK-VS-066: UpSlip blog: editable cover image alt text

Editors cannot describe a post's cover image: slip-landing renders every uploaded cover with
`alt=""` and uses the post title for `og:image:alt`. Add a `cover_alt` field that the editor
writes in slip-admin, stored by slip-api, and used by slip-landing on the article page and in
the share-image tags.

- Type: feature in `slip-api` (migration + API). Schema change: one column on `blog_posts`.
- Created: 2026-11-09 by the Claude conductor lane at operator request ("ขอเพิ่ม custom tag alt
  ให้คนแก้ไข blog edit แยกด้วยได้ไหม ตอนนี้ผมไล่ดู น่าจะไม่มี"). Per-run override the same day
  (decision 5): Claude implements the slip-api part here; slip-admin and slip-landing go to
  viewsupat through the handoff below.
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
5. **Split of work** ("VS-066 ทำได้ แต่ผมขอเว้นส่วน slip-admin กับ slip-landing ให้ viewsupat
   ทำต่อเลย เราเตรียม api และส่วนที่แจ้งต้องบอกให้เขาทำต่อ"): the Claude lane builds slip-api
   and writes the handoff; viewsupat builds slip-admin and slip-landing.

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

## Data model (migration `079_blog_post_cover_alt.sql`)

```sql
-- +goose Up
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS cover_alt TEXT NOT NULL DEFAULT '';
-- inside a DO block guarded by a pg_constraint lookup, so a re-run is a no-op:
ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_cover_alt_check
    CHECK (cover_alt = btrim(cover_alt) AND char_length(cover_alt) <= 250
           AND strpos(cover_alt, E'\n') = 0 AND strpos(cover_alt, E'\r') = 0);
-- +goose Down
ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_cover_alt_check;
ALTER TABLE blog_posts DROP COLUMN IF EXISTS cover_alt;
```

- The number: PR #129 takes 079. TASK-VS-065's spec proposed `079_blog_actor.sql`; whichever
  run merges second renumbers; check `migrations/` on `origin/main` right before merging.
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

## slip-api implementation (Claude lane, 2026-11-09)

- Branch `task/TASK-VS-066` from `origin/main` `7de73f8`, worktree
  `/Users/earth/Documents/GitHub/slip-api-TASK-VS-066`. Commit
  `a763481780f10eaff2d6636d9ddab293288f57e0`. PR https://github.com/SparqLab/slip-api/pull/129
  to `main`: Earth merged it as `2b2d30e8f5c809590655bc89946ef1745b36a0ab` at 2026-11-09 04:23 UTC
  with no GitHub review recorded. The merge sits on top of TASK-VS-064's PR #127 (`e7da8d3`,
  merged a minute earlier); the blog files and migration 079 equal the tested head. Nothing is on
  staging or prod: `origin/staging` `10d0870` and `origin/prod` `2abb1d9` contain neither #127
  nor #129, so promoting `main` now carries both.
- Matches the API section above. One difference from the draft: the check also rejects `\r`.
- Tests seen failing first: a compile error for the missing field and a count of 78 migration
  files, then (fields only) an untrimmed value and the missing migration file. Now green:
  `TestCoverAltValidation`, `TestReadInputCoverAltIsOptional`, `TestCoverAltWithMigration`
  (PostgreSQL: existing posts `""`, create, keep when absent, alt-only edit keeps the content
  date and revision, clear, replace and remove the cover, column check, replay plus goose up and
  down), and `TestGooseSQLFiles` (79). Removing the goose `StatementBegin`/`StatementEnd` markers
  makes the goose step fail (mutation check, file restored and `cmp`-identical).
- Evidence on the clean committed head with a disposable local PostgreSQL 16
  (`SLIP_API_BLOG_TEST_DSN`, `SLIP_API_MIGRATION_TEST_DSN` exported; no blog or migration test
  skipped): `ev-004` `go test ./... -count=1` exit 0, `ev-005` `go vet ./...` exit 0, `ev-006`
  `go build ./...` exit 0. `ev-001`–`ev-003` are invocation errors (exit 127: zsh passed the whole
  command as one word), not test results.
- On the merge commit `2b2d30e` (clean tree, same disposable PostgreSQL): `ev-007` full tests
  exit 0 (15 packages ok), `ev-008` vet, `ev-009` build, `ev-010` the PR merge record.
  `implementation_verification` passed on that basis, its reason stating that no review is
  recorded. Staging and production each need Earth's approval (`verifyslip-promote`).

## Staging promotion (2026-11-09)

- Approval: Earth answered "ขึ้น staging ทั้งคู่" (TASK-VS-064 #127 and this run's #129), then
  approved migration 079 running at boot. Recorded as `authz-001` in both runs. Staging only.
- Scope (`origin/staging..origin/main`, no merges, all by Sichol-Earth): TASK-VS-064 `e19a09c`,
  `038fd73`, `802dc14`, `2826114`; this run `a763481`. Running images matched their branches
  (`staging-sha-10d0870`, `production-sha-2abb1d9`), and no deploy run was active.
- Dry run: T1 = T2 = `fe4dcd3c4325ac78b3b41a4ca740f68ab4786080` (staging and prod had equal
  trees), no conflict, only the files of those commits. Migration in scope: `A 079_blog_post_cover_alt.sql`.
- PR https://github.com/SparqLab/slip-api/pull/130 (`main` → `staging`), merged pinned to head
  `2b2d30e` as `3b33b8e40a3b3269fe9fcc7cf880a9afbe68c717`; the merged tree equals T1.
- Deploy STAGING run 42563785540: success. `slip-api-staging:186`, image `staging-sha-3b33b8e`,
  PRIMARY COMPLETED 1/1 (deployment created 04:50:40.930 UTC, completed 04:59:15.760 UTC).
  Rollback revision: `slip-api-staging:185` (the staging service also has the circuit breaker).
- Boot: the new task logged `goose: OK up 079_blog_post_cover_alt.sql (94ms)` and
  `migrated database to version 79` at 04:51:25 UTC, then `Starting slip-api HTTP`.
  Every event of `/ecs/slip-api-staging` from 04:48:00 to 05:01:20 UTC (11:48–12:01 ICT,
  merge to COMPLETED + 2 min, read after the window closed; `ev-013`): pages=2 events=102 across
  the old and new task (a mixed-rollout window), 95 HTTP requests (200=88, 401=6, 404=1,
  including the smoke), 0 5xx, 0 ERROR/panic/fatal lines, 0 parse failures. `ev-011` is an
  earlier read of the same window taken before it closed (incomplete; superseded by `ev-013`).
- Public smoke (`ev-012`): every public post carries `cover_alt` as a string (9 posts, all `""`),
  the detail too; missing post 404; categories keys unchanged (5 categories); unauthenticated
  admin posts 401; packages 200; unauthenticated verify 401.
- `deploy_staging` passed on this evidence. `staging_acceptance` is pending: the authenticated
  admin writes (set an alt, keep it on a save without the field, alt-only edit keeps the content
  date, 251 characters and a newline 400, cover removal clears it) need an admin login and were
  not exercised. Production is not promoted and needs its own approval.

## Handoff to viewsupat (ready to relay)

ส่วน slip-api (PR https://github.com/SparqLab/slip-api/pull/129) **ขึ้น staging แล้ว** ตั้งแต่
2026-11-09 04:59 UTC (`staging-sha-3b33b8e`) แต่ **ยังไม่ขึ้น prod** เริ่มทำฝั่ง admin และ landing ได้เลย
และ deploy admin ขึ้น staging ได้แล้ว ส่วน admin บน prod ต้องรอให้ slip-api ขึ้น prod ก่อน เพราะ API ตัวเดิม
ปฏิเสธฟิลด์ที่ไม่รู้จัก ถ้าส่ง `cover_alt` ไปก่อนจะได้ 400 `invalid blog post JSON` ส่วน landing ขึ้นก่อนได้
เพราะถ้าไม่มีฟิลด์ก็ทำงานเหมือนเดิม

**API**

- ทุก response ของโพสต์ (public และ admin) มี `cover_alt: string` (`""` แปลว่าไม่มี)
- `POST /v1/admin/blog/posts` และ `PUT /v1/admin/blog/posts/{slug}` รับ `cover_alt` แบบ optional:
  - ไม่ส่งหรือส่ง `null` = คงค่าเดิม, ส่ง `""` = ล้าง
  - server ตัดช่องว่างหัวท้ายให้ ยาวได้ไม่เกิน 250 ตัวอักษร (นับตัวอักษร ภาษาไทยใช้ได้เต็ม 250)
    และต้องเป็นบรรทัดเดียว ไม่งั้นได้ 400 `cover_alt: must be one line of at most 250 characters`
- `DELETE /v1/admin/blog/posts/{slug}/cover` ล้าง `cover_alt` ด้วย ส่วนการอัปโหลดรูปใหม่จะคงค่าเดิม
- แก้ alt อย่างเดียวไม่ขยับ «อัปเดตล่าสุด»

**slip-admin**

1. `app/features/blog/type.ts`: เพิ่ม `coverAlt: string` ใน `BlogPost` (`BlogPostInput` ได้ไปด้วย
   เพราะเป็น `Omit<BlogPost, …>`)
2. `app/features/blog/map.ts`: `mapPost` อ่าน `cover_alt`, `toBody` ส่ง `cover_alt`
3. `BlogManage.vue` ในส่วนรูปปก (ส่วนที่แสดงตอนแก้โพสต์ที่มีอยู่แล้ว):
   - ช่อง «ข้อความ alt ของรูปปก» บรรทัดเดียว `maxlength="250"` พร้อม hint ว่า "อธิบายสิ่งที่อยู่ในรูป
     ไม่ต้องซ้ำชื่อบทความ"
   - เตือนแบบไม่บล็อกเมื่อมีรูปปกแต่ alt ว่าง (บันทึกและ publish ได้ตามปกติ)
   - หลังอัปโหลดรูปใหม่ เตือนให้ตรวจ alt ว่ายังตรงกับรูปไหม
   - **หลังลบรูปปก ให้ล้าง alt ในฟอร์มด้วย** (`applyServerPost` อัพเดทแค่ `editing` ไม่ได้อัพเดท
     ฟอร์ม ถ้าไม่ล้าง พอกดบันทึก alt เก่าจะถูกส่งกลับไปทั้งที่ไม่มีรูปแล้ว)
4. live preview: ใส่ `cover_alt` ใน `previewPost` (object snake_case ที่ส่งให้ landing)
5. ข้อความ i18n ทั้ง th และ en

**slip-landing**

1. `app/composables/useBlog.ts`: เพิ่ม `cover_alt?: string` ใน type `BlogPost` (optional เผื่อเจอ
   API ที่ยังไม่มีฟิลด์)
2. `app/components/blog/Article.vue` (รูปปกหน้าบทความ): `alt=""` → `:alt="article.cover_alt ?? ''"`
3. `app/pages/blog/[slug].vue`: `og:image:alt` ใช้ `cover_alt` เมื่อมีทั้ง `cover_url` และ
   `cover_alt` ไม่งั้นใช้ชื่อบทความเหมือนเดิม และเพิ่ม `twitter:image:alt` ด้วยค่าเดียวกัน
4. `app/components/blog/Cover.vue` (การ์ดในหน้ารวมและ featured): คง `alt=""` ไว้ เพราะมีชื่อบทความ
   อยู่ข้างรูปแล้ว
5. `app/pages/blog/preview.vue` `toPost()`: เพิ่ม `cover_alt: text(raw.cover_alt)`

**ลำดับ deploy:** slip-api staging → admin/landing staging → slip-api prod → admin/landing prod
(Earth แจ้งเมื่อ slip-api ขึ้นแต่ละ environment)

**เช็คหลังขึ้น:** ใส่ alt ให้โพสต์ที่มีรูปปก แล้วเปิด view-source หน้าบทความ ต้องเห็น `<img alt="…">`
ของรูปปก และ `og:image:alt` / `twitter:image:alt` เป็นข้อความนั้น ส่วนโพสต์ที่ใช้ preset artwork
ยังใช้ชื่อบทความ
