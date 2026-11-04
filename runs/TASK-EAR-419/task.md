# TASK-EAR-419: Games Labs payment and redemption durable event delivery and DEV recovery

Approved chat plan: Order transactional outbox, recoverable confirmed AMQP publisher, atomic settlement/redemption/refund event persistence, bounded worker retries, Wallet safe Stripe reconciliation CLI, DEV validation and allowlisted recovery. No production or Android changes. Multica receives the implementation handoff from the operator.

## Approved scope and ownership

- Codex is the sole implementer; Multica independently reviews. Operator subsequently authorized Codex to post updates in the existing Multica SPAR-54 session; this does not authorize other recipients or agent implementation.
- Write scope: Games-Labs-Order (activity publisher, atomic activity outbox and worker, related settlement/redemption/refund paths, migration, recovery CLI and tests); Games-Labs-Wallet (verified Stripe reconciliation CLI, reward serialization, redemption HTTP compatibility and tests); related recovery configuration/runbooks/deploy guards and this task's evidence/handoff artifacts.

## Operator-approved review remediation — 2026-10-30

Operator accepted Codex's two recommendations after Multica SPAR-54 requested changes:
1. Wallet owns duplicate-credit prevention. Serialize RewardPackage before inspecting the original key within the same transaction, reusing the existing wallet row lock; prove concurrent duplicate requests fail before the fix and preserve one original operation after it. No schema/index/dependency change is needed for this strategy. Inspect the webhook claim path as a caller; do not rely on it for ledger idempotency.
2. Fix POINT/DIAMOND redemption field mapping for new records with HTTP-to-PostgreSQL regression coverage. Preserve already supported callers and the strict recovery predicate. Do not accept blank historical reasons, rewrite original ledgers or apply the unidentified Oct29 redemption. Historical support remains deferred until exact-record selection and raw owned evidence.

Also address required M1 final-clean-HEAD PostgreSQL/RabbitMQ evidence and M2 environment/allowlist restrictions, plus directly related CLI/runbook/deploy-guard corrections. Do not introduce retention or retry policy changes, migrate service transports, merge PRs, touch production or create financial App QA. Codex implements; Multica reviews the new commits.
- Read-only references: shared-lib, api-gateway, Games-Labs-Missions and Games-Labs-Logs. Games-Lab-Android remains read-only, including no builds.
- Branches: task/TASK-EAR-419 in both services, based on origin/staging; PR target staging. Worktrees: _workspace/worktrees/TASK-EAR-419/{Games-Labs-Order,Games-Labs-Wallet}.
- No public API, protobuf, event-schema or dependency changes; keep original reward quotes, event IDs, event times and idempotency keys.
- DEV recovery allowlist: payment bed3dd8c-6f6b-41cb-82d6-ad4bcd9eb59e, order 31449eb6-3346-4664-9257-ea6c858e82dd, expected user f737e6f3-466b-4db5-b86e-70ac4772b660. Inspect this user's redemption attempts on 2026-10-29 Bangkok time before selecting a matching attempt. No bulk recovery.

## Requirements and acceptance

1. Reproduce closed-channel recovery and post-commit publish failures before fixing, with evidence of failing/passing regression tests.
2. Confirmed, mandatory, persistent AMQP publishing with reconnect and bounded network/confirm deadlines; no successful delivery claim before broker ACK and no basic.return.
3. Add idempotent migration 048 and outbox persistence in the SAME PostgreSQL transaction as each Order fulfillment, redemption/admin grant, and refund outcome. Snapshot complete original event payload; retry must not rebuild mutable catalog data.
4. Worker: 1s poll, batch up to 10, 120s lease, 5s publish deadline, capped 60s jittered retry, aggregate ordering and durable poison-event isolation. Retry ambiguous ACK outcomes with the same event ID. Retain pending/dead rows; no automatic destructive retention.
5. After business state plus outbox commit, broker outage must not fail the request; DB/outbox errors still fail and are recoverable with original Wallet idempotency, including a stranded fulfilling order. Preserve existing HTTP/proto fields and statuses; delivery can lag.
6. Default-dry-run internal reconciliation CLIs. Fetch Stripe truth and compare session, order, user, amount, currency and immutable reward quote with owned ledgers before allowlisted apply. No blind credit, no new checkout, no fake webhook signature, no cross-service database access.
7. PostgreSQL/RabbitMQ integration, concurrent and crash-window tests; fresh schema and repeat migration tests; builds, vet and targeted race checks. Real DEV Card/PromptPay and POINT/DIAMOND acceptance remains a separate runtime gate.
8. Staged Order rollout: foundation migration/publisher/worker first (rollback-capable reader), then atomic producers. Keep additive schema and worker when rolling back the producer. Do not deploy prod or start prod compute.

## Known evidence and limitations

- Parent-collected DEV Wallet logs: transaction bed3dd8c-6f6b-41cb-82d6-ad4bcd9eb59e failed ConfirmCheckoutOrder at 2026-10-29T05:16:53.834Z and 06:17:44.636Z with AMQP 504 channel/connection is not open.
- Initial disconnect trigger remains unconfirmed. The original payment's credits were later verified and its status repaired without changing the ledger (ev-072/076/077/123); original historical-redemption selection/raw evidence remain open.
- Earlier direct database read timed out; SSM port-forward StartSession denied. ECS Exec read-only probe worked; runtime image has wget, no psql/curl/grpcurl. Runtime CLI may provide a supported in-container recovery path after review/deployment.
- SocratiCode MCP remote/local and CLI fallback were unavailable (Qdrant unavailable); source inspection used instead.

## Implementation checkpoints

- [x] Foundation regression, migration, confirmed reconnecting publisher and outbox worker.
- [x] Atomic producers, replay/crash recovery and immutable shared event builders.
- [x] Wallet/Order dry-run and apply tooling, with validation and redaction tests.
- [x] Local verification, migration replay and review-ready commits/handoff.
- [x] Verified staged DEV deployment: Order foundation104, atomic105, Wallet80; health and config hashes verified.
- [x] Allowlisted payment recovered to paid/fulfilled with original ledger unchanged; both events published, Missions handled spend, Logs has one original-time row each.
- [x] Operator-approved B1/R1(new records)/M1/M2 fixes independently approved by Multica; final clean-HEAD real PG/RabbitMQ suites pass with zero skips.
- [x] Corrected Wallet81/ec69292 deployed and verified BEFORE corrected Order106/5d6d897; digest/health/config and read-only original-ledger/event smoke pass (ev-117–127). No additional recovery apply.
- [x] Scoped App acceptance: November3 PromptPay, Card and POINT cases independently matched to backend records (ev-134–140). Operator explicitly excluded DIAMOND redemption as N/A because an Admin-configured case is believed unavailable; no DIAMOND test pass is claimed. See app-acceptance-20261103.md.
- [ ] Identify and recover only the App-confirmed original redemption after exact Wallet debit/refund inspection; operator explicitly chose to wait for App.

## Operator continuation

Operator explicitly requested `continue` after the review handoff and selected
the App team to run real DEV Card/PromptPay/POINT/DIAMOND acceptance and return
IDs. Continue the originally approved DEV rollout and scoped recovery from task
refs without merging either draft PR. Multica independent review remains the
operator's follow-up; the earlier checkpoint's assumption that it blocks all
DEV validation is superseded by this continuation. Production stays excluded.

`authz-001` records the DEV deployment authorization. Use image-only task
definition updates preserving every existing runtime value, compare hashes
before/after, and deploy Order foundation before atomic producers. Build only
tracked source from the approved commits; do not copy .env or credentials into
build contexts. The App team supplies new acceptance IDs; do not invent new
payments/redemptions on the affected account while waiting.

## New App evidence — 2026-11-03

See [app-acceptance-20261103.md](app-acceptance-20261103.md). New PromptPay, Card and POINT cases have matching read-only backend evidence (TASK-EAR-419 ev-134–139). DIAMOND and original historical-redemption selection remain missing; both remaining gates stay pending. No replay/deploy/merge performed. Old config-hash baseline is unavailable (ev-132/133); current image digests were verified separately.

## Operator acceptance scope update — 2026-11-03

The operator explicitly directed skipping the DIAMOND redemption App case because such an item is believed no longer configured in Admin. Treat that scenario as N/A for this acceptance scope, not as a tested pass or proof that no DIAMOND catalog items exist. Do not create/reconfigure an item or make a synthetic redemption to satisfy it.

The scoped App acceptance set is now PromptPay, Card and POINT redemption. All three have the fresh App report plus matching read-only backend evidence (ev-134–140). staging_acceptance can pass for this scope. The original historical redemption recovery remains a separate pending gate; it is not waived by this instruction. Config continuity was not reverified because the old baseline file is missing. Refresh/reopen persistence was not separately reported, and no such verification is claimed.

This update supersedes earlier statements that DIAMOND is required to finish staging_acceptance. It does not claim DIAMOND runtime acceptance, full task completion, new source changes or a deployment.

## Product rule (2026-11-03)

The App team confirmed with Christy (product) that item redemption is POINT-only, with no other currency. This is the product basis for the DIAMOND redemption App case being N/A above. It is still not a tested pass. The code still accepts DIAMOND, and no data census was run. Shared text: `docs/GAMES_LABS_PROJECT_CONTEXT.md` → Product rules.

## Latest staging integration — 2026-11-03

Wallet PR60 merged into staging688fd85 and deployed as82 BEFORE Order PR87 merged into staginga5367df and deployed as107. Both workflows succeeded, runtime digests/health/config hashes verified (ev-141–153). See merge-staging-20261103.md. Earlier candidate/draft/unmerged statements below are historical. Scoped App acceptance passed with DIAMOND N/A; historical original-redemption recovery remains pending. No production or financial replay.


## Product rule propagation follow-up — 2026-11-03

DIAMOND item-redemption acceptance is excluded by the confirmed POINT-only product rule, not merely a missing test fixture. Earlier acceptance descriptions are historical and are superseded by this rule. Scoped PromptPay/Card/POINT acceptance and completed staging integration remain valid; historical recovery remains pending. No legacy code/contract removal or runtime enforcement is claimed. Current handoff and acceptance artifacts now carry the same rule.
