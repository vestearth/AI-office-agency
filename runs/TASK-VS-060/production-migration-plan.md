# PR #121: production rollout plan for migration 070

Earth’s decision in Multica comment `01a1a70f-e09c-766a-acd9-04fe8a5f8e41` on 2026-11-04 supersedes the previously proposed DB preflight, index prebuild and migration-pool/timeout prerequisites for this rollout. Earth explicitly accepts the remaining lock/startup risk. Keep migration 070 unchanged and run it on startup. `authz-002` remains the production deployment grant. The PR remains draft until Earth completes `staging_acceptance` through the category admin UI after viewsupat deploys it to staging.

## Decision and limitations

- Skip production DB preflight and do not prebuild `blog_posts_category_idx`. The migration builds it as written. Earth reports one published post on production and expects only a few rows because the table was created by migration 069 on 2026-11-02. The published count is not an exact total row count: the production catalog, draft count, table size, index state and current locks remain unverified.
- Staging’s 070 ran in 99 ms; this does not prove production time or lock availability. `blog_posts` takes ACCESS EXCLUSIVE for the DROP CHECK until the Goose transaction commits, including FK validation and the index build. If another transaction holds a conflicting lock, the new task’s listener can be delayed. The blog repository’s 3-second query timeout starts after migration and does not limit boot-time migration or Goose advisory-lock wait.
- Do not add a dedicated migration pool or timeout change as a prerequisite for this rollout. The earlier SQL preflight file and proposed approaches are historical tools, not steps required by this decision. No production database or runtime changes were made to investigate them.

## Rollout when staging acceptance passes

1. Keep PR #121 draft and the larger issue blocked while staging acceptance is pending. Record Earth’s UI test results and the gate through the run workflow; do not claim acceptance from public smoke alone.
2. Choose a low-traffic production window and **post the planned date and time to the issue before pressing ready/merge**. No window has yet been scheduled. Recheck approval `authz-002`, PR head/base/tree, release scope, running workflow, current ECS service/task/image and rollback target before deploying. If the scope or live state changed, stop and reassess.
3. The previously observed rollback target is `slip-api-production:133`, PRIMARY COMPLETED 3/3 with image `production-sha-ccf727d`; confirm it is still the appropriate target immediately before deploy. Production has no automatic circuit-breaker rollback. If startup fails or rollout stalls, stop and inform Earth before taking a manual rollback decision. Preserve schema 070 on image rollback; old code cannot save posts in renamed/new categories.
4. After the authorized merge, immediately inspect each new task’s boot logs: migration 070 success, listener ready and no ERROR/fatal/panic; monitor ECS rollout, 5xx and existing verify traffic. Verify new image PRIMARY COMPLETED with running equal to desired, then perform the public blog/categories/no-store/CORS, admin unauthenticated 401, packages and verify smoke checks, and record the actual evidence and gate status.
5. **Do not rename or delete categories on production until production admin reads categories from the API instead of its hardcoded list.** Otherwise stale names can cause `category: unknown` when saving posts. Do not make category changes during a mixed-version rollout.

The PR is draft at head `ea9893ad` and tree `f18b52ae`; no production SQL, DDL, runtime change, merge or deploy was performed as part of this plan update. Michael owns the review disposition of the exception.
