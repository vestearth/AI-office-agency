# TASK-VS-092: SPAR-79: stop API package auto-renewal after channel cancellation

Multica SPAR-79 (01a1f305-babf-7883-b474-2fe9afa25248). Reproduce TestCancelAPIChannelStopsPackageAutoRenew on 78e7ca8 in an isolated slip-api worktree, rebase onto current origin/staging, and open a PR targeting staging. Cancelling API must prevent renewal debits and a new active term. LINE packages, refunds, incident ledger, merge and production deployment are out of scope.

## 2026-11-20 staging and production rollout

Earth authorized the staging merge in SPAR-79 comment `01a1f887-3869-7f13-ac96-76e3c0a842a5`. Michael independently approved head `e3b04b241c9d2507b0830ac0fc6fe3cb30a851f1` in comment `01a1f828-f659-75e7-8820-c82b8d971634` (`ev-013`). Earth authorized the subsequent production promotion conditional on staging verification and the commit scope in comment `01a1f88f-1510-7d23-89cc-c82fa9b0d48e` (`ev-017`).

| Environment | Git range and PR | Workflow | Live ECS image and rollout | Previous task definition and image |
| --- | --- | --- | --- | --- |
| staging | `63d3d7e62acf7aa6f8f7d51bbffd90e525deb19b..124ddba68f29b9d6823e6d9f9bece1ce4b3b0dde`, [#173](https://github.com/SparqLab/slip-api/pull/173) | [Deploy STAGING 44721766152](https://github.com/SparqLab/slip-api/actions/runs/44721766152) succeeded | `slip-api-staging:219`, `staging-sha-124ddba`, COMPLETED 1/1 HEALTHY, ECR digest `sha256:cad6106ace83716ead3ab8730ab611d2018bec587d43c33bf249a076b101d690` | `slip-api-staging:218`, `staging-sha-63d3d7e` |
| production | `f2f62159391761d73831139be108165087a17107..26486e531f304bade2875bca01fbe2bdc995e7ba`, [#174](https://github.com/SparqLab/slip-api/pull/174) | [Deploy PRODUCTION 44723540065](https://github.com/SparqLab/slip-api/actions/runs/44723540065) succeeded | `slip-api-production:167`, `production-sha-26486e5`, COMPLETED 3/3 HEALTHY, ECR digest `sha256:d8a52e7eedee05cf036673f9155d8432f6ad129712786cad022b9326c6633d98` | `slip-api-production:166`, `production-sha-f2f6215` |

Before opening #174, `prod..staging` contained `ee433aa`, `e3b04b2`, and #173's merge commit `124ddba`. The production dry run showed changes to the two approved repository files. Both merge trees matched the dry run tree `75fb9a2c7609a80247df228f8cf368fa16e5b610` (`ev-014`–`ev-018`, `ev-026`–`ev-028`).

The CloudWatch scan covered every returned page from task definition registration through verification. Staging had its startup marker and zero panic or runtime fatal messages from 10:46:53.421 to 10:56:28 UTC (`ev-025`). Production had startup markers for all three running tasks and zero panic or runtime fatal messages from 10:59:49.053 to 11:09:29 UTC (`ev-032`). The workflow, rollout, running task image and ECR digest checks are in `ev-022`–`ev-024` and `ev-029`–`ev-031`.

For an authorized rollback, update the affected ECS service to the previous task definition in the table, then confirm the rollout and image. ECS rollback was not invoked. SPAR-79 is handed back for operator review.
