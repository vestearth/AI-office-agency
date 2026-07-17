# TASK-EAR-127 verification evidence

Date: 2026-07-17

## Games-Labs-Missions

- `GOCACHE=/tmp/codex-gocache-ear127 go test ./... -count=1` — pass.
- `GOCACHE=/tmp/codex-gocache-ear127 go vet ./...` — pass.
- `GOCACHE=/tmp/codex-gocache-ear127 go build ./...` — pass.
- Focused coverage includes corrected two-value candidates, legacy-label
  normalization, Daily/Weekly plan pool generation, immutable random selection,
  avatar/pass matching, generic Diamond rejection, exchange rejection, and
  forward/reverse idempotency.

## Games-Labs-Wallet

- `GOCACHE=/tmp/codex-gocache-ear127-wallet go test ./... -count=1` — pass.
- `GOCACHE=/tmp/codex-gocache-ear127-wallet go vet ./...` — pass.
- `GOCACHE=/tmp/codex-gocache-ear127-wallet go build ./...` — pass.
- Focused tests cover trusted Store metadata mapping and the emitted
  `player.activity.v1` provenance for avatar/pass purchases.

## Games-Labs-backoffice

- `node --test --experimental-loader ./tests/nuxtAliasLoader.mjs ./tests/*.test.mjs`
  — pass, 144/144.
- `npm run build` — pass.
- Event Spend Prop regression coverage verifies snake_case and camelCase category
  payloads plus the `Randomly by System` fallback for legacy rows.
- Runtime smoke on `http://localhost:3001/admin/manage/missions?type=weekly`
  confirmed the legacy Spend Prop row with an empty persisted pool renders
  `Special Item/Limited Avatar` and `Special Pass` in the Random Selection Pool
  cell. `Randomly by System` remains only the edit-form selection mode.
- `npx nuxi typecheck` — not clean because of existing repository-wide errors
  (undefined indexed values, missing qrcode declaration, existing schedule and
  admin-page types). The TASK-EAR-127 production build and focused regression
  tests pass; no reported typecheck error is introduced by the new task field or
  category payload mapping.

## AI Dev Office

- `ruby validate-yaml.rb TASK-EAR-127` — pass.
- Pushed `fix/TASK-EAR-127-spend-prop-categories`:
  - Games-Labs-backoffice: `f52b83e`
  - Games-Labs-Wallet: `1dd7a20`
  - Games-Labs-Missions: `d5fab36`
- Opened draft PRs:
  - Games-Labs-Wallet: https://github.com/SparqLab/Games-Labs-Wallet/pull/9
  - Games-Labs-Missions: https://github.com/SparqLab/Games-Labs-Missions/pull/77
  - Games-Labs-backoffice: https://github.com/SparqLab/Games-Labs-backoffice/pull/40
- Backoffice PR #39 had already merged before the legacy-board fallback was
  pushed; PR #40 contains the remaining legacy-board display fixes.
- Wallet PR #9, Missions PR #77, and Backoffice PR #39 are merged; only PR #40
  remains open for the legacy-board display fallback.
- No merge, deployment, staging DB mutation, or runtime smoke was performed.
