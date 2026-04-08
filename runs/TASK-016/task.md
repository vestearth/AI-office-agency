# TASK-016: Validate Games Labs API Postman Collection (Manual + Newman)

## Type
investigation

## Priority
high

## Description
Run and validate the API scenarios in `docs/Games-Labs-APIs.postman_collection.json`
against the current environment via Postman/Newman.

Goal:
- prove which endpoints are passing/failing right now,
- identify data/setup prerequisites for each flow,
- and produce a test evidence report with actionable blockers for Dev.

This task is test-focused (no feature implementation requested), but if
collection issues are found (wrong path/header/body/variable usage), update the
collection as part of the same task.

## Scope
- `docs/Games-Labs-APIs.postman_collection.json`
- optional mirror copy: `api-gateway/docs/Games-Labs-APIs.postman_collection.json` (if repo keeps both in sync)
- run artifacts/logs under `ai-dev-office/runs/TASK-016/`

## Acceptance Criteria
- Postman collection is executed end-to-end (manually or via Newman) with a real environment file.
- A pass/fail matrix is produced for every request in the collection:
  - User — Order Packages
  - Admin — Order Packages
  - Orders — Payment
  - Health
- Required environment variables are documented and validated:
  `base_url`, `user_token`, `admin_token`, `webhook_api_key`, `package_id`, `order_id`.
- For each failing request, root cause is classified as one of:
  - data/setup issue,
  - auth/permission issue,
  - API contract mismatch,
  - backend defect.
- If contract mismatch is in collection (request path/header/body), collection is corrected and re-run.
- Deliverable report includes: executed commands, response evidence, final blocker list.

## Next Action
Run `dev` to execute the collection, patch collection definitions if needed,
and produce a structured QA report for reviewer confirmation.
