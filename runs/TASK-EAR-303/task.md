# TASK-EAR-303 — Wire Website Blog and Package pages to existing admin APIs

## Origin

Multica issue SPAR-26 — Website: wire Blog and Package pages to existing admin APIs.

## Type / workstream / priority

Feature / frontend / medium

## Goal

Replace local Website page seed data with the existing Backoffice admin APIs without
adding backend contracts or changing the Banner page.

## Scope

- `Games-Labs-backoffice` only.
- Blog list: `/api/v1/admin/blog`.
- Package list and edit route: `/api/v1/admin/order-packages`.
- Preserve loading, error, empty, pagination, and CRUD feedback behavior.

## Acceptance criteria

1. Blog list reads and mutates through the existing blog admin API; no local seed
   data drives production behavior.
2. Package list and edit views use the existing order-package API and preserve
   pagination and CRUD feedback states.
3. Loading, error, and empty states are visible and the Banner page is untouched.
4. Focused frontend tests and the project build pass before merge.

## Current evidence

Implementation is on Backoffice branch `feat/SPAR-26-website-blog-package-apis` in
PR #106 targeting `main`. This run records it for review; it does not claim merge,
deployment, or authenticated runtime verification.

## Out of scope

- Banner page work.
- New backend endpoints or contract changes.
- Any Monitoring page changes.
