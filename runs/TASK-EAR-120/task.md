# TASK-EAR-120 — Event mission list ignores uploaded thumbnail_url

## Symptom
Operator: "admin/manage/missions?type=event — ผมลองๆเล่นดูยังอัพโหลดรูปไม่ได้นะครับ"
(image upload still doesn't seem to work on the event missions page)

## Investigation (debugging skill)
Traced the full chain and found every layer already wired on staging:
- FE `ThumbnailUpload.vue` + `useImageUpload.ts` -> POST `/admin/uploads/missions`
- api-gateway proxies `/admin/uploads/missions` -> Order `/uploads/missions` (TASK-EAR-062, deployed on staging)
- Order `UploadHTTP` validates + puts to S3, returns hosted CloudFront URL (confirmed live: other upload kinds resolve on staging)
- Missions proto/DB (`thumbnail_url` on `MissionEventRequest`) persists and returns the URL correctly

## Root cause
`app/components/mission/EventPlanCard.vue` (event list table) hardcodes
`<img src="/collect-event.webp">` for every row — it never reads
`item.thumbnail_url`. So a successful upload is invisible on the list; it
only ever showed on the edit page reload. The operator's "upload doesn't
work" report is a list-rendering gap, not a broken upload pipeline.

## Fix
Render `item.thumbnail_url || '/collect-event.webp'` in the list row image.

## Scope
Single file, frontend-only, no contract/backend change.
