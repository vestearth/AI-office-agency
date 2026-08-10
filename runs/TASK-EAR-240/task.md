# TASK-EAR-240 — Manage Leaderboard wire mock → API (queue #6)

## Type

feature

## Workstream

full-stack

## Priority

medium

## Created

2026-08-08

## Parent / Epic

- Parent: TASK-EAR-239
- Epic: Backoffice Manage full-connect queue

| Order | Task | Title |
| --- | --- | --- |
| … | TASK-EAR-235…239 | prior queue |
| 6 | **TASK-EAR-240** (this) | Leaderboard — wire UI to proto |
| 7 | TASK-EAR-241 | Redemption → Tracking |

## Goal

Manage → **Leaderboard** already has Figma (edit rewards frame `3368:52812`), BO pages (Receive Coin / Turnover + edit), and admin Missions proto (`GET/POST/PUT /api/v1/admin/missions/leaderboards`). Replace `mockLeaderboardListDetail` + demo save with real API calls.

## Verified current state (2026-08-08)

- Nav: `/admin/manage/leaderboard` (+ turnover + edit/:id) in `admin.vue`; breadcrumb notes Figma `3368:52812`.
- Data: `mockLeaderboardListDetail.ts`; edit page imports mock finder; save is demo (no API).
- Proto: `shared-lib/proto/admin/adminmissionpb/adminmission.proto` leaderboards RPCs.

## Acceptance criteria

1. List/get for Receive Coin and Turnover use admin leaderboards API (no mock seed when authed).
2. Create/update (edit rewards) persist via API; no “demo saved” toast.
3. UI remains aligned with Figma `3368:52812` for the edit rewards surface (chip/month labeling already referenced in layout).
4. Missing fields vs proto → honest UI or follow-up TASK — do not invent localStorage.
5. Focused tests or staging smoke; gateway already exposes routes if Missions pin current — confirm staging.

## Out of scope

- Tournament player-facing leaderboard (`GetTournamentLeaderboard`).
- Mission Invite mock (separate).

## Sources

- Figma node `3368:52812` (file `cxXNS6dw3I77fPnwl03HR5` unless operator says otherwise)
- `Games-Labs-backoffice/app/data/mockLeaderboardListDetail.ts`
- `Games-Labs-backoffice/app/pages/admin/manage/leaderboard/`
- `shared-lib/proto/admin/adminmissionpb/adminmission.proto` (leaderboards)
