# TASK-101: Backoffice admin game asset URLs include `:8080`

## Short name
`backoffice-game-asset-url-8080`

## Type
bugfix + knowledge capture

## Priority
high

## Parent / Epic
- Parent: none
- Epic: Backoffice Game Management

## Status

Done. The production-facing symptom was verified fixed in the in-app browser and
the durable flow note was added to `knowledge-base`.

## Background

On `https://admin-dev.gameslabs.app/admin/games`, IDG game thumbnails rendered
with URLs such as:

```text
http://api-test-gateway.gameslabs.app:8080/assets/idg-img/Abyssal%20Rite.png
```

The browser auto-upgraded the resource to `https://...:8080`, but the public
asset endpoint is:

```text
https://api-test-gateway.gameslabs.app/assets/idg-img/Abyssal%20Rite.png
```

So thumbnails failed even though the same path without `:8080` loaded.

## RCA

Two issues overlapped:

1. `api-gateway` needed a canonical public origin for forwarded metadata. Without
   it, gateway metadata could preserve an internal/public host with port 8080.
2. Some staging `games.image_url` values were already stored as absolute legacy
   URLs with `http://api-test-gateway.gameslabs.app:8080/assets/...`. The Game
   service returned absolute URLs unchanged, so a gateway metadata-only fix could
   not rewrite those rows.

## Changes shipped

- `api-gateway`
  - commit `239e3fa` `ci(gateway): propagate public base url`
  - image pin commit `9e96475`
  - adds ConfigMap propagation for `public-base-url`.
- `Games-Labs-Game`
  - commit `f89599d` `fix(game): normalize admin asset image URLs`
  - image pin commit `c91ef42`
  - rewrites legacy absolute gateway `/assets/...` URLs through forwarded public
    base.
- `Games-Labs-backoffice`
  - commit `929f4e1` `fix(backoffice): normalize admin game asset URLs`
  - image pin commit `a432329`
  - normalizes the known legacy URL shape before rendering the admin game table.
- `knowledge-base`
  - added `Knowledge Base/20 Flows/Backoffice Game Asset URL Flow.md`
  - linked it from `Knowledge Base/00 MOCs/Flows MOC.md`

## Verification

See `verification-evidence.md`.

## Acceptance criteria

- [x] `/admin/games` no longer renders IDG images with `:8080`.
- [x] IDG image URLs render as `https://api-test-gateway.gameslabs.app/assets/...`.
- [x] Images load with non-zero natural dimensions in browser.
- [x] `api-gateway` deploy workflow propagates `public-base-url`.
- [x] `Games-Labs-Game` has a regression test for legacy absolute gateway asset URLs.
- [x] BackOffice production build passes.
- [x] Durable knowledge note exists and is linked from the Flows MOC.

