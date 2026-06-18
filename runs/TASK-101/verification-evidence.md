# TASK-101 Verification Evidence

## Source Evidence

- `api-gateway/interceptor/metadata.go:57-90`
  - `PUBLIC_BASE_URL` overrides forwarded host/proto.
- `api-gateway/.github/workflows/deploy.yml:93-109`
  - deploy workflow now writes `public-base-url` into `api-gateway-config`.
- `Games-Labs-Game/internal/core/handlers/admingamehdl/grpc.go:133-151`
  - admin `responseImageURL` rewrites absolute gateway `/assets/...` URLs.
- `Games-Labs-Game/internal/core/handlers/admingamehdl/image_url_test.go:10-21`
  - regression test for `http://api-test-gateway.gameslabs.app:8080/assets/...`.
- `Games-Labs-backoffice/app/pages/admin/games/index.vue:112-148`
  - admin game rows normalize legacy `:8080` asset URLs before rendering.

## Commands Run

```bash
go test ./interceptor
go test ./...
```

Result: passed in `api-gateway`.

```bash
go test ./internal/core/handlers/admingamehdl
go test ./...
```

Result: passed in `Games-Labs-Game`.

```bash
npm run build
```

Result: passed in `Games-Labs-backoffice`.

Build warnings observed:

- Existing Nuxt duplicate route-name warning for promotion coupon edit routes.
- Existing chunk-size warning after minification.

Neither warning failed the build.

## Deploy Evidence

- `api-gateway`
  - fix commit: `239e3fa`
  - pin commit: `9e96475`
  - GitHub Actions run: `27747063088`, success.
- `Games-Labs-Game`
  - fix commit: `f89599d`
  - pin commit: `c91ef42`
  - GitHub Actions run: `27748302346`, success.
- `Games-Labs-backoffice`
  - fix commit: `929f4e1`
  - pin commit: `a432329`
  - GitHub Actions run: `27748596782`, success.

## Browser Evidence

Before final BackOffice deploy, in-app browser on
`https://admin-dev.gameslabs.app/admin/games` showed:

```json
{
  "attrSrc": "http://api-test-gateway.gameslabs.app:8080/assets/idg-img/Abyssal%20Rite.png",
  "src": "https://api-test-gateway.gameslabs.app:8080/assets/idg-img/Abyssal%20Rite.png",
  "naturalWidth": 0,
  "naturalHeight": 0
}
```

After deploy and reload:

```json
{
  "badCount": 0,
  "attrSrc": "https://api-test-gateway.gameslabs.app/assets/idg-img/Abyssal%20Rite.png",
  "src": "https://api-test-gateway.gameslabs.app/assets/idg-img/Abyssal%20Rite.png",
  "naturalWidth": 540,
  "naturalHeight": 540
}
```

## Knowledge Capture

- `knowledge-base/Knowledge Base/20 Flows/Backoffice Game Asset URL Flow.md`
- `knowledge-base/Knowledge Base/00 MOCs/Flows MOC.md`

