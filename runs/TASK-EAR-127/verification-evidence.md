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
  — pass, 141/141.
- `npm run build` — pass.
- `npx nuxi typecheck` — not clean because of existing repository-wide errors
  (undefined indexed values, missing qrcode declaration, existing schedule and
  admin-page types). The TASK-EAR-127 production build and focused regression
  tests pass; no reported typecheck error is introduced by the new task field or
  category payload mapping.

## AI Dev Office

- `ruby validate-yaml.rb TASK-EAR-127` — pass.
- Pushed `fix/TASK-EAR-127-spend-prop-categories`:
  - Games-Labs-backoffice: `526dcbe`
  - Games-Labs-Wallet: `1dd7a20`
  - Games-Labs-Missions: `d5fab36`
- No merge, deployment, staging DB mutation, or runtime smoke was performed.
