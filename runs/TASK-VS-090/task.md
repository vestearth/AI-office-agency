# TASK-VS-090: SPAR-78: fix LINE bank logo startup panic and verify slip-api staging

Multica SPAR-78 (01a1f305-08ac-767f-8923-692994ce0fe5). slip-api only. Confirm CloudWatch startup panic on staging e2c3cf823071549cc6ccb1f416ce375b1d304417, prove regression red/green, merge the fix via main and promote via staging PR, then record healthy ECS revision, commit SHA and image containing PR #164. Production is out of scope. This work is executed by the assigned Multica run.

## Diagnosis and verification

- The application container on staging task `d9f106ce83f9474aa1393d4d082e7edb` used task definition `slip-api-staging:214` and image `staging-sha-e2c3cf8` and exited with code 2. CloudWatch recorded `panic: parsing "GET /v1/line/banks/{code}.png": at offset 19: bad wildcard segment (must end with '}')` at 08:53:25 UTC. The preceding staging task on the same revision successfully applied the PR #164 migration `086_account_suspension.sql`. Evidence `ev-002` and `ev-011`. [Failed deployment](https://github.com/SparqLab/slip-api/actions/runs/44490014760)
- The router captures the full filename and the handler checks the `.png` suffix. `TestLINEBankLogoRoute` reproduced the panic before the fix and passed afterward, covering valid PNGs and headers as well as missing suffixes, other extensions, unknown images, and nested paths. The readonly build, vet and PostgreSQL 16-backed Go suite passed. Evidence `ev-003`, `ev-004`, `ev-005`, `ev-006`, and `ev-009`.
- Implementation targeted `main` and merged at `66effb20253035c804ae53cb8d7cacef670242aa`. Promotion targeted `staging` and merged at `adb89e9d078b1a877a80118703ced3ca938af650`. The staging tree equals the dry-run merge tree and contains both PR #164 and the LINE fix. Evidence `ev-010`. [Implementation PR #165](https://github.com/SparqLab/slip-api/pull/165) · [Staging PR #166](https://github.com/SparqLab/slip-api/pull/166)

## Staging result

- ECS reached `COMPLETED` with one healthy running task on `slip-api-staging:215`. Task `fb87ef8c87e848529b97dba9c4e7d75b` served image `122991883560.dkr.ecr.ap-southeast-1.amazonaws.com/upslip/slip-api:staging-sha-adb89e9` at digest `sha256:ebd64aa72f586f8d84c23acb9c77903f61d29b7d85f30fb87730dd67e8130bde`. Its ALB target was healthy and the startup log contained an HTTP listener message and zero panics. `/health` and `/ready` passed, the SCB logo returned a real PNG with HTTP 200, and the URL without `.png` returned 404. Evidence `ev-015` and `ev-016`.
- GitHub Actions reported `Waiter ServicesStable failed: Max attempts exceeded` at 09:17 UTC while the prior task was draining. ECS finished the same rollout after the prior task stopped at 09:20 UTC. The new task was already serving healthy traffic during that drain. Evidence `ev-012`, `ev-013`, and `ev-016`. [Deployment run](https://github.com/SparqLab/slip-api/actions/runs/44493002207)
- The verified staging revision meets the API dependency for SPAR-75 joint QA.
