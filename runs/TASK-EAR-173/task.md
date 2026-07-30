# TASK-EAR-173 — Bump api-gateway staging lane for ListStorePurchases

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-30

## Epic

Player Detail page backend epic (TASK-EAR-137/159/163/164/172). Direct
follow-up to **TASK-EAR-172**, which stays **done** — every artifact it
promised landed. This task closes a deployment-lane gap that task left open.

## Context

TASK-EAR-172 shipped `AdminMissionsService.ListStorePurchases`
(`GET /api/v1/admin/store/purchases`) across four repos, all merged
2026-07-30:

| repo | PR | base | deployed? |
| --- | --- | --- | --- |
| shared-lib | #32 | main | n/a (library) |
| Games-Labs-Missions | #89 | staging | ✅ Deploy STAGING green |
| api-gateway | #28 | **main** | ❌ **main does not deploy** |
| Games-Labs-backoffice | #60 | main | ✅ live (k3s) |

**The gateway bump went to the wrong lane.** `api-gateway` `main` has not run
a workflow since 2026-06-19 — the lane that actually deploys is `staging`
(`Deploy STAGING`, last run 2026-07-27). `origin/staging`'s `go.mod` still
pins `shared-lib v0.0.0-20260727115312-cd08206ddf5d`, which predates the
`ListStorePurchases` proto, so **the route does not exist on the staging
gateway** while the Backoffice UI that calls it is already deployed.

This is an established, repeated pattern in this repo, not a novel case — the
gateway needs a *separate* staging-lane bump each time:

- TASK-EAR-147 → PR #23
- TASK-EAR-159 + TASK-EAR-164 → PR #26 (one bump covering both)

TASK-EAR-172 mirrored the earlier tasks' `main` bump and missed the staging
counterpart. The caveat was noted at the time but never turned into work.

## Objective

Make `ListStorePurchases` reachable through the gateway lane that actually
serves traffic, so the already-live Purchase → Special Pass / Limited Avatar
sub-tabs stop 404ing.

## Scope

`api-gateway` only. **`go.mod` + `go.sum` only — no Go code changes.**

Verified: `gateway/grpc.go:97` registers the whole service via
`adminmissionpb.RegisterAdminMissionsServiceHandlerFromEndpoint`, so every
route generated into the shared-lib gw file is picked up automatically. PR #28
on `main` was exactly a 3-line `go.mod`/`go.sum` change and nothing else; this
is the same change on a branch cut from `staging`.

## Required work

1. Branch **from `origin/staging`**, not `main` — this workspace has broken
   the branch-freshness rule twice already (`main` is the stale DEV lane for
   every Games-Labs service repo).
2. Bump the pin to `v0.0.0-20260730050034-4b9d68056699` — byte-identical to
   what `main` carries after PR #28.
   `GOPRIVATE=github.com/SparqLab/*` is required (no global GOPRIVATE is set
   in this workspace).
3. `go build ./...` clean.
4. Open a PR **against `staging`**. Do not merge — the operator merges.
5. After the operator merges, verify via the API (not `gh run watch`'s exit
   code, which this workspace has been burned by): the `Deploy STAGING` run
   for the merge commit must show every job `conclusion=success`.

## Risk

**Low, and bounded by measurement rather than assumption.** The shared-lib
delta between the two pins is exactly two commits:

```
4b9d680 feat(adminmission): add ListStorePurchases RPC     <- the only new content
cfe3419 Merge pull request #31 (TASK-EAR-164 proto)        <- merge of the commit staging is ALREADY pinned to
```

`cd08206` — staging's current pin — *is* the TASK-EAR-164 feature commit, so
`cfe3419` adds no content. The bump therefore introduces `ListStorePurchases`
and nothing else. No migration, no proto change owned here, no route reordering
(the new binding is additive, and TASK-EAR-172 already checked it against the
three existing `/admin/store/*` paths for collisions — see the
`grpc-gateway route order trap`).

## Out of scope

- The `prod` lane. `api-gateway` `prod` last deployed 2026-06-23 and is 72
  commits / a June-23 shared-lib behind, so **every** admin route from
  TASK-EAR-130 onward is missing there. That is a much larger consolidated
  prod-patch problem the operator has deliberately scheduled separately —
  do not try to fix it here.
- Any other pending shared-lib RPC. Bump to the exact pin above; do not
  fast-forward to shared-lib `HEAD` and quietly widen the change.
- Backoffice or Missions changes. Both are already correct and deployed.

## Done when

1. `origin/staging` of `api-gateway` pins
   `shared-lib v0.0.0-20260730050034-4b9d68056699`.
2. The `Deploy STAGING` run for that merge commit is green on all jobs.
3. `GET /api/v1/admin/store/purchases` resolves through the staging gateway
   instead of 404ing.

## Notes

Claude advisory lane.

Worth naming as a process observation rather than burying it: the same
lane-mismatch has now happened across enough tasks (147, 159, 164, 172) that
"did the gateway bump reach `staging`, not just `main`?" belongs on the
checklist for any future task that adds a proto binding — the `main` PR looks
complete and green in isolation, which is exactly what makes it easy to miss.
