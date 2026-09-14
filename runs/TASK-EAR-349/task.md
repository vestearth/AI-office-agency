# TASK-EAR-349: Move Order's SMTP_PASSWORD out of the plaintext ECS task-definition environment into Secrets Manager

## Type
security hardening (devops)

## Workstream
devops / backend

## Priority
medium — no incident, but a live Gmail app password is readable today by
anyone with `ecs:DescribeTaskDefinition` on the account, and it sits in every
task-definition revision ever registered (revisions are immutable and are not
purged on deregister).

## Created
2026-09-11

## Parent
TASK-EAR-315 (Order-owned SMTP mailer added the variable), TASK-EAR-348 (fixes
the `SMTP_FROM` value). Sibling to Provider's RDS-secret injection, which is the
pattern to copy.

## Finding (verified 2026-09-11, read-only)
- `Games-Labs-Order/.github/workflows/staging.yml` (and `prod.yml`) read
  `secrets.SMTP_PASSWORD` from the GitHub environment and hand it to
  `ecs/build-env-json.sh`, which renders every name in `ecs/env.names` as a
  plaintext `{name, value}` entry in `containerDefinitions[0].environment`.
- Staging task definition `games-labs-order-staging:84` therefore carries the
  Gmail app password for `xpinext@sparqlab.co` in clear text. It is NOT alone:
  the same revision also renders `POSTGRES_PASSWORD`, `RABBITMQ_URL` (embeds
  credentials), `S3_SECRET_KEY`, and `WALLET_INTERNAL_TOKEN` as plaintext
  environment, and `secrets` is `null`.
- The account already has a working precedent: `games-labs-provider-prod:16`
  injects `POSTGRES_USER` / `POSTGRES_PASSWORD` through
  `containerDefinitions[0].secrets[].valueFrom` pointing at a Secrets Manager
  ARN, using the SAME execution role (`ecsTaskExecutionRole`). Its `prod.yml`
  builds that block with `jq` after `render-task-definition` — copy that
  step shape.
- The `vestearth` CLI profile cannot `secretsmanager:ListSecrets` or
  `iam:ListRolePolicies`, so the execution role's exact Secrets Manager
  resource scope is unverified. It can read the RDS-managed secret; whether it
  can read a NEW custom secret must be proven by a task actually booting.

## Goal
`SMTP_PASSWORD` reaches the Order container only via ECS `secrets`
(`valueFrom`), never via `environment`, on staging first and then prod, with
no change to how the Go code reads it (`envconfig:"SMTP_PASSWORD"` stays).

## Scope
**A. Secrets Manager (operator/devops, console or CLI with a role that may
create secrets):** create one secret per environment, e.g.
`games-labs/order/smtp` with JSON keys `user` and `password` (SMTP_USER can
ride along; HOST/PORT/FROM are not secret and stay as environment). Record
the full ARN including the random suffix in the GitHub environment as
`SMTP_SECRET_ARN` (Variables or Secrets — mirror Provider's
`RDS_POSTGRES_SECRET_ARN` handling, which accepts either).

**B. IAM:** ensure `ecsTaskExecutionRole` may `secretsmanager:GetSecretValue`
on the new ARN(s) (and `kms:Decrypt` if a customer key is used). Scope the
grant to the ARN prefix, not `*`. Do not touch `ecsTaskRole` — the container
never calls Secrets Manager itself.

**C. Workflows (`Games-Labs-Order`):** in `staging.yml` and `prod.yml`
- remove `SMTP_PASSWORD` (and `SMTP_USER` if moved) from the render-step
  `env:` and from `ecs/env.names`;
- add a step after `render-task-definition` that `jq`-injects
  `containerDefinitions[0].secrets = [{name:"SMTP_PASSWORD",
  valueFrom: $arn + ":password::"}, ...]`, failing the job with a clear
  `::error::` when the ARN is unset — copy Provider `prod.yml` lines 179-191;
- keep `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` in `env.names` as strings
  (`ecs/env.names` non-string crash trap).

**D. Rollout:** merge to `staging`; confirm the new revision shows
`SMTP_PASSWORD` under `secrets` and absent from `environment`; confirm the
boot log still says "Redemption mailer configured"; run one Gift tracking
Update (TASK-EAR-348 scope C) and observe `gift_tracking_mail_sent`. Prod
follows on the next prod train only.

**E. Hygiene after cutover:** rotate the Gmail app password (the old value is
in immutable revisions 1..N and in GitHub secret history) and delete the
GitHub environment secret `SMTP_PASSWORD` so the plaintext path cannot be
re-enabled by accident. Deregister old task-definition revisions is optional
and does not remove their stored env — rotation is the real fix.

## Out of scope
- The other four plaintext secrets in the same revision
  (`POSTGRES_PASSWORD`, `RABBITMQ_URL`, `S3_SECRET_KEY`,
  `WALLET_INTERNAL_TOKEN`) and the same pattern in the other Games-Labs
  services. Once this run proves the mechanism on Order, open one sweep run
  per service rather than widening this one.
- Go code changes. The mailer keeps reading `SMTP_PASSWORD` from the process
  environment; ECS `secrets` populate it identically.

## Acceptance criteria
- `aws ecs describe-task-definition games-labs-order-staging:<new>` shows
  `SMTP_PASSWORD` only in `containerDefinitions[0].secrets` with a
  `valueFrom` ARN, and `environment[?name=='SMTP_PASSWORD']` is empty.
- The task boots (no `ResourceInitializationError` on secret fetch) and the
  boot log names the mailer configured.
- One observed `gift_tracking_mail_sent` on staging after cutover.
- Workflow fails loudly with `::error::` when `SMTP_SECRET_ARN` is missing;
  it never silently falls back to plaintext.
- Gmail app password rotated; old GitHub secret removed.

## Traps
- A `valueFrom` on a secret the execution role cannot read fails at task
  start with `ResourceInitializationError`, and ECS rolls the deployment back
  to the previous revision — the plaintext one. A green deploy badge is not
  proof; read the revision's `secrets` block and a fresh boot log.
- `ecs/env.names` non-string crash: removing a name is fine, but never leave
  a name in the list with no exported value if envconfig parses it non-string.
- Secret ARN must include the random suffix (Provider's error text says why).
- Do not print the secret value in workflow logs while debugging the jq step.
