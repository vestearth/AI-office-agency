# TASK-EAR-421: Auth/Logs/Provider Dockerfile: GH_PAT via short-lived .netrc (git 2.54 insteadOf break)

## Why

On 2026-11-03 the api-gateway staging deploy failed at `go mod download` with
`could not read Username for 'https://github.com'`. `golang:1.25-alpine` now
ships git 2.54.0, which drops a token-only userinfo URL
(`url."https://TOKEN@github.com/".insteadOf`) on GitHub's redirect, so no
credential is sent whatever the token is. api-gateway was fixed in
SparqLab/api-gateway#99 and User in SparqLab/Games-Labs-User#45 (TASK-EAR-420).
Auth, Logs and Provider still had the broken pattern and would fail on their
next deploy.

## Scope

- `Games-Labs-Auth`, `Games-Labs-Logs`: both `RUN --mount=type=secret,id=GH_PAT`
  steps write `/root/.netrc` (`login x-access-token`), `chmod 600`, run, then
  `rm -f /root/.netrc` — the api-gateway block on `staging`.
- `Games-Labs-Provider`: used `ARG GH_PAT` (token kept in image history), not a
  secret mount. Switched to the same secret-mount `.netrc` steps; staging/prod
  workflows already pass `GH_PAT` under `secrets:`. `docker-compose.dev.yml`
  (legacy manual VPS deploy) passes it as a build secret instead of a build arg.
- Out of scope: merging/deploying (merge to `staging` deploys DEV — operator).

## Acceptance

- RED: old Dockerfile, clean `git archive origin/staging`, fails with
  `could not read Username`.
- GREEN: new Dockerfile, full image from clean `git archive HEAD` (no local
  `go.work`), exit 0; image has no `/root/.netrc` and no token in history/env.
- One PR per repo to `staging`, not merged.

## Result

- SparqLab/Games-Labs-Auth#18 — https://github.com/SparqLab/Games-Labs-Auth/pull/18
- SparqLab/Games-Labs-Logs#59 — https://github.com/SparqLab/Games-Labs-Logs/pull/59
- SparqLab/Games-Labs-Provider#44 — https://github.com/SparqLab/Games-Labs-Provider/pull/44

Branch `task/TASK-EAR-421-netrc-gh-pat` in each repo. Evidence in
`evidence.yaml` (RED/GREEN per repo). Waiting on the operator to merge.

## Evidence notes

- ev-001/003/005 RED (exit 1, `could not read Username`), ev-002/004/006 GREEN
  (exit 0), each from a clean `git archive` of the recorded sha.
- ev-005.log was redacted after capture: BuildKit printed the old Provider
  `RUN git config ... ${GH_PAT}` with the ARG expanded, so the real token was in
  the log. `artifact_sha256` was recomputed for the redacted file.
- Finding: because old Provider builds took `GH_PAT` as a build ARG, every
  Provider image built that way carries the token in its layer history
  (`docker history --no-trunc`). Rotate `GH_PAT` once SparqLab/Games-Labs-Provider#44
  is merged and deployed.

## Merged and deployed (2026-11-03, Claude conductor)

The operator approved "PR จาก session อื่น merge ได้เลยครับ". Merged to `staging`:

| Repo | PR | Merge commit |
| --- | --- | --- |
| Auth | #18 | `11c38a9` |
| Logs | #59 | `3ef8fd0` |
| Provider | #44 | `c3f00d2` |

Evidence ev-007:
- **CI builds:** each Deploy STAGING run (Auth 41617336251, Logs 41617348949, Provider 41617365271) passed `build-push` and `deploy-ecs`. This is the real CI proof that the `.netrc` Dockerfile builds with GitHub's git 2.54 image.
- **DEV:** every service runs the new image, 1/1, rollout COMPLETED.

| Service | Task definition | Image |
| --- | --- | --- |
| Auth | td 32 | `staging-sha-11c38a9` |
| Logs | td 64 | `staging-sha-3ef8fd0` |
| Provider | td 38 | `staging-sha-c3f00d2` |

- **Boot:** no panic or fatal on any of them.

Follow-ups:
- **Rotate GH_PAT.** Old Provider images received it as a build-arg, so it may sit in their image history. I have not inspected those images.
- **Clean up Provider's workflows.** `staging.yml` and `prod.yml` still pass `build-args: GH_PAT`, which the Dockerfile no longer uses. Remove it.
