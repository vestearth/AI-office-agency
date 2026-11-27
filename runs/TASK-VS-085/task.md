# TASK-VS-085: Portal webhook test calls verify

Multica SPAR-72 follow-up, separate from the api article batch (TASK-VS-084).

Repository: slip-front-end only. The Portal button "ทดสอบส่ง" in app/features/branches/ui/BranchDetailApi.vue (testWebhook, around lines 134-135) shows the toast "ส่งคำขอทดสอบแล้ว" and does not call an API.

slip-api already exposes POST /v1/merchants/{merchantId}/branches/{id}/webhook/verify (internal/handler/router/router.go:439). Earth checked slip-api b6ac678 and Portal f8dd417. Re-read current source before editing.

The button must call that endpoint and show the real result both when verification succeeds and when the API returns webhook verification failed.

Do not edit manual articles. The applied branch-detail-tabs article already tells the user to press this button.

Acceptance:
- A regression fails before the fix because the button does not call webhook/verify.
- After the fix, both success and webhook verification failed show the real API result.
- No new API, schema, or dependency.
- Independent review before staging deploy. No production deploy and no production data change.
- Do not edit Games-Lab-Android.

Claude Speed owns the implementation through the linked Multica issue. This Office task stays pending until that issue starts.
