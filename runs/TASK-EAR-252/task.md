# TASK-EAR-252 — Remove the committed public fallback bearer (Backoffice)

## Origin

knowledge-base Review Queue critical item, opened 2026-07-25, never closed.
Audit: `ai-dev-office/knowledge-reviews/20260725T024746Z-games-labs-backoffice-missions-auth-warning-triage.yaml`.

## Problem

`Games-Labs-backoffice/nuxt.config.ts` committed a literal bearer token under
`runtimeConfig.public.apiBearer`. `useApiBearerHeaders` sent it as
`Authorization: Bearer …` whenever no login token was present.

Everything under `runtimeConfig.public` is compiled into the client bundle.
The credential was therefore **served to every visitor** and granted API Gateway
access **without logging in**. The git exposure the audit reported is the second
leak; the delivered bundle is the first.

Facts established 2026-08-12 (value never reproduced in any artifact):

| | |
|---|---|
| Shape | opaque, 64 chars (not a JWT — scope/expiry not self-describing) |
| Introduced | `62b7950`, 2026-04-10, single commit |
| Reach | `main` + 4 task branches + `origin` |
| `NUXT_PUBLIC_API_BEARER` override | **never wired** in any workflow/Dockerfile → the committed literal shipped in every build |
| Second copy | `docs/superpowers/plans/2026-07-16-event-game-selector-unification.md` — plaintext, missed by the original audit |

## Decision

**Remove the fallback; do not rotate it into place.**

Rotation produces a new equally-public credential. Moving it to
`NUXT_PUBLIC_API_BEARER` does not help either — `public` reaches the browser
regardless of where the value originates. The only correct shape is: no
credential under `public` at all, and the header path fails closed.

Safety check before removing: `login.vue` imports only `readBackofficeAuth` and
never calls `useApiBearerHeaders`, so the pre-login flow did not depend on the
fallback. The other 43 call sites are post-login and read `backoffice-auth`.

## Changes

Branch `task/TASK-EAR-252-remove-public-bearer-fallback`, commit `65c7e1b`.
**Not pushed** — operator instruction.

- `nuxt.config.ts` — drop `apiBearer`; add a comment stating that nothing under
  `public` may hold a credential, env-sourced or not.
- `app/composables/useApiBearerHeaders.ts` — remove the runtime-config branch;
  no token → `{}` → no `Authorization` header.
- `docs/superpowers/plans/2026-07-16-event-game-selector-unification.md` —
  redact the second plaintext copy.
- `tests/publicRuntimeConfigNoCredentials.test.mjs` — new regression guard.

## Verification

- Regression test **seen failing on the pre-fix tree** (all three assertions,
  via `git stash` of the two source files), passing after.
- `npm test` — 433/433 pass.
- `npm run build` — succeeds; `.output/` contains neither the token nor the
  `apiBearer` key, while `apiBaseUrl` **is** still inlined, proving the absence
  is a real removal rather than a grep miss.
- Anonymous runtime smoke against the production build on `:3010` —
  `/login` and `/admin/manage/player` return zero copies of the value, and
  `window.__NUXT__` exposes no `apiBearer`.
- Fail-closed: with no token, `/admin/manage/player` redirects to `/login`.
  With a token in `backoffice-auth`, it stays on the admin route.

Not verified here, and deliberately: a credentialed end-to-end call through the
gateway. `API_BASE_URL` is unset in the local build so no API request is issued,
and entering real credentials is out of scope for this lane. QA should run the
normal authenticated smoke before merge.

## Still open — this task does not close the exposure

1. **Revoke the token at its issuer.** Owner action. Removing the code stops
   future delivery; it does not invalidate the value already present in
   deployed client bundles and in git history.
2. **Determine what it authorized.** It is opaque, so scope must come from the
   issuer, not from inspection. That answer decides the incident's blast radius.
3. **History rewrite — recommended against.** One commit, but it is on `main`,
   four branches, and `origin`; a rewrite breaks every clone and open PR, while
   revocation makes the historical value inert. Spend the effort on (1).
4. **Merge timing.** Backoffice `main` merges deploy to k3s. Confirm no QA
   script or automation depends on the pre-login fallback before merging.
