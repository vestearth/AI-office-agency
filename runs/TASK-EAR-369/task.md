# TASK-EAR-369 — Move plaintext secrets out of ECS task-definition environment

## Type

devops / security hardening

## Priority

high — production credentials are readable by any principal with
`ecs:DescribeTaskDefinition`, which is a much wider audience than the people
who should hold them.

## How this surfaced

While auditing TASK-EAR-200 on 2026-09-21, `games-labs-logs-prod:12` was seen
carrying `CLICKHOUSE_PASSWORD` as a plaintext `environment` value. A census of
all 29 active task definitions in `ap-southeast-1` / account `122991883560`
showed that is the norm, not an exception.

## Census (2026-09-21, names only — no values recorded anywhere in this run)

62 secret-shaped environment names carry a non-empty plaintext value, spread
across **20 of 29** task definitions. Only **10** task definitions use the
`secrets` / `valueFrom` mechanism at all, and every one of those uses it
solely for the RDS credential.

| Task definition | rev | plaintext | secrets refs |
|---|---|---|---|
| `games-labs-provider-staging` | 32 | 18 | 0 |
| `games-labs-wallet-staging` | 78 | 7 | 0 |
| `games-labs-order-staging` | 91 | 5 | 0 |
| `games-labs-order-prod` | 22 | 4 | 2 |
| `games-labs-provider-prod` | 18 | 3 | 2 |
| `games-labs-user-staging` | 70 | 3 | 0 |
| `games-labs-auth-staging` | 31 | 2 | 0 |
| `games-labs-game-staging` | 74 | 2 | 0 |
| `games-labs-user-prod` | 17 | 2 | 2 |
| `games-labs-wallet-prod` | 18 | 2 | 2 |
| `slip-api-production` | 14 | 2 | 1 |
| `slip-api-staging` | 44 | 2 | 1 |
| `slip-system-production` | 5 | 2 | 0 |
| `slip-system-staging` | 12 | 2 | 0 |
| `games-labs-auth-prod` | 25 | 1 | 2 |
| `games-labs-game-prod` | 22 | 1 | 2 |
| `games-labs-logs-prod` | 12 | 1 | 2 |
| `games-labs-logs-staging` | 42 | 1 | 0 |
| `games-labs-missions-prod` | 20 | 1 | 2 |
| `games-labs-missions-staging` | 147 | 1 | 0 |

`api-gateway-*`, `slip-admin-*`, `slip-front-end-*`, `slip-landing-*` and
`upslip-redis-ping-diag` are clean.

### Known false positives in that 62 — do not "fix" these

- `WALLET_INTERNAL_TOKEN_ENFORCE` (Wallet staging + prod) — a `"true"` /
  `"false"` flag, matched only on the word TOKEN.
- `API_KEY_HEADER` (Provider staging + prod) — the *name* of a header, not a key.
- `STRIPE_PUBLISHABLE_KEY` (Wallet staging) — publishable by design.

That leaves roughly **57 real secrets**.

### Highest-value targets, in the order worth doing them

1. **Provider signing and API keys** — `VP_SECRET_KEY`, `VP_API_KEY`,
   `GGSOFT_SIGNING_KEY`, `GGSOFT_KEY`, `GGSOFT_SEAMLESS_JWT_SECRET`,
   `GGSOFT_SEAMLESS_PASSWORD`, `AFB_SECRET_KEY`, `AFB_SIGNATURE_KEY`,
   `ONEUP_API_KEY`, `ONEUP_SECRET_KEY`, `IDG_API_KEY`,
   `IDG_INBOUND_API_KEY`, `API_KEYS`, `ADMIN_API_KEY`. These authenticate
   money-moving provider callbacks; a leak is not just a data-read problem.
2. **Payment keys** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `UBIT_AES_KEY` (Wallet).
3. **Object storage and mail** — `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
   `SMTP_PASSWORD` (Order, Auth, Game).
4. **Everything else** — `POSTGRES_PASSWORD` where it is still inline,
   `REDIS_PASSWORD`, `CLICKHOUSE_PASSWORD`, `GEMINI_API_KEY`, `JWT_SECRET`,
   `CONSUMER_KEY` / `CONSUMER_SECRET`, `WALLET_INTERNAL_TOKEN`.

## The mechanism already in use

`games-labs-order-prod` and `games-labs-logs-prod` already reference the
RDS-managed secret in **AWS Secrets Manager** with a JSON key selector:

```
valueFrom: arn:aws:secretsmanager:ap-southeast-1:122991883560:secret:rds!db-<id>:password::
name:      POSTGRES_PASSWORD
```

Standardise on that. The execution role is `ecsTaskExecutionRole`, which must
be granted `secretsmanager:GetSecretValue` (and `kms:Decrypt` if a CMK is
used) for each new secret ARN, or the task fails to start with a pull-secret
error rather than a running-but-broken container.

## Where the values come from today

Each service renders its task definition from `ecs/env.names` via
`ecs/build-env-json.sh`, fed by the deploy workflow's exported variables,
which come from GitHub environment **secrets** and **variables**. So the
value already lives in a secret store — it is the *rendering* into
`environment` that flattens it into the task definition. The change is
therefore per-repo workflow work plus a Secrets Manager entry, not a hunt for
the values.

## Plan

1. Pick one service end to end first — **Wallet staging** is a good pilot: a
   manageable 6 real secrets, and the flip is already well understood from
   TASK-EAR-266.
2. Create the Secrets Manager entries. One JSON secret per service per
   environment is easier to manage than one entry per key.
3. Grant `ecsTaskExecutionRole` read access on the new ARNs **before** the
   first deploy that references them.
4. Change the deploy workflow so those names render into `secrets` with a
   `valueFrom`, and drop them from the rendered `environment`. They stay
   listed in `ecs/env.names` only if that file still needs to know about
   them; if it does not, remove them there too, keeping every remaining entry
   a string (the `ecs/env.names` boot-crash lesson).
5. Deploy, confirm the task reaches RUNNING and healthy, and confirm
   `describe-task-definition` no longer shows the value.
6. Repeat per service, prod last for each service.

## Explicitly out of scope

- **Rotation.** Moving a secret and rotating it in one step makes a failed
  deploy ambiguous. Rotate afterwards, per service, as its own change.
- Application code. No service reads these differently; ECS injects
  `secrets` into the environment exactly as it injects `environment`.
- The k3s/EKS lane in the older `prod.yml` workflows.
- GitHub secret hygiene — these are already GitHub secrets; the leak is on
  the AWS side.

## Acceptance criteria

- [ ] For each converted service: `describe-task-definition` shows the name
      under `secrets` with a `valueFrom`, and **not** under `environment`
- [ ] The task reaches RUNNING and healthy on the new revision, and one real
      request through the service succeeds
- [ ] `ecsTaskExecutionRole` grants read only on the ARNs it needs, not `*`
- [ ] A final re-run of the census script shows the count dropping to the
      documented false positives only
- [ ] No secret value appears in any tracked file, run artifact, PR body or
      commit message produced by this work

## Risks

- A missing execution-role grant fails the task at **startup**, not at build
  time. Check `stoppedReason` on the first deploy of each service.
- Prod ECS is scaled to 0 outside 09:00–20:00 Mon–Fri; deploy inside the
  window.
- Doing several services in one change makes a startup failure hard to
  attribute. One service per change.

## References

- TASK-EAR-200 — where `CLICKHOUSE_PASSWORD` in `games-labs-logs-prod` was
  noticed
- `ai-skills/rules/no-secrets-in-repo/RULE.md` — the repo-side rule this is
  the infrastructure counterpart of
- TASK-EAR-266 / TASK-EAR-368 — `WALLET_INTERNAL_TOKEN` is one of the values
  in scope here; coordinate so the two runs do not re-render the same task
  definition at cross purposes
