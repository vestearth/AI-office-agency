# TASK-EAR-250 — ECS prod env-contract audit, and the two gaps already fixed

**Production is not broken.** Confirmed by the operator on 2026-08-13. This is a
pre-flight inventory for the consolidated prod patch, not an incident report.

Audited 2026-08-13 against each repo's `prod` branch. HEADs match the operator's
project snapshot exactly (`GamelabsProject.mdc`, synced 2026-08-13).

## What was measured

For each service, **what the code on `prod` reads** versus **what the prod deploy
actually ships**:

- reads: `envconfig:"NAME"` tags in `config/config.go` (or `configs/config.go`)
- ships: `ecs/env.names`, which is the gate — `build-env-json.sh` emits only the
  names listed there, so a variable exported in the workflow but absent from
  `env.names` never reaches the container, and vice versa

A missing name only matters if it resolves to empty at runtime, so each one is
classified by its struct tag: **no `default:`** or **`default:""`** means empty;
a usable default means the omission is harmless.

## Results

| Service | prod HEAD | missing | empty at runtime |
|---|---|---|---|
| Games-Labs-Wallet | `d1b1592` | 22 | **17** |
| Games-Labs-Provider | `2e99474` | 9 | **9** |
| Games-Labs-User | `5cea3e1` | 3 | **3** |
| Games-Labs-Game | `03b72be` | 3 | **2** |
| Games-Labs-Order | `f069bfc` | 3 | **2** |
| Games-Labs-Logs | `b8cfae9` | 1 | **1** |
| Games-Labs-Missions | `1b88dce` | 8 | 0 |
| Games-Labs-Auth | `86fd860` | 1 | 0 |

Missions and Auth are clean: everything they omit has a working default.
api-gateway has no `ecs/env.names` on `prod` and was skipped.

### Per service, the names that resolve to empty

**Wallet** — `ORDER_API_URL`, `MISSIONS_API_URL`, and 15 payment-provider
credentials: `API_KEY_BC/PP`, `USERNAME_BC/PP`, `PASSWORD_BC/PP`,
`DEPOSIT_KEY_BC/PP`, `DEPOSIT_SECRET_KEY_BC/PP`, `WITHDRAW_KEY_BC/PP`,
`WITHDRAW_SECRET_KEY_BC/PP`, `ONEDAY_SECRET_KEY`.

**Provider** — `AFB_API_KEY`, `AFB_REQUEST_BASE_URL`, `GGSOFT_APP_ID`,
`GGSOFT_GAME_URL`, `GGSOFT_REPORT_URL`, `SIGMA_AGENT_ID`, `SIGMA_BASE_URL`,
`SIGMA_SECRET`, `RABBITMQ_QUEUE_PROVIDER_LOGS`. VP, 1UP and IDG are **not**
affected.

**User** — `GAME_API_URL`, `WALLET_GRPC_ADDR`, `WALLET_HTTP_ADDR`.

**Game** — `USER_API_URL`, `MISSIONS_API_URL`. *(fix prepared, see below)*

**Order** — `AUTH_API_URL`, `RABBITMQ_URL`.

**Logs** — `USER_API_URL`.

## Why an empty value is worth listing at all

Both shapes appear in this codebase, and they fail very differently:

- **Loud** — Wallet's order adapter: `if s.oa == nil { return errors.New("order
  adapter not configured") }`. Package fulfilment refuses outright.
- **Silent** — Wallet's missions adapter: `recordPackagePurchaseHistory` returns
  early and the call site discards the error, so purchase history is simply
  never written. Game's user adapter is the same shape and worse to diagnose: it
  returns `ErrLevelRequired`, which renders as an ordinary "User level too low"
  and is indistinguishable from a real denial.

The silent ones are the reason this audit exists — they cannot be found by
watching for errors after a cutover.

## Fixes already prepared

Both are committed on prod-based branches and **await a push by the operator**;
this lane's token cannot write `.github/workflows/**`.

| Repo | Branch | Commit | Adds |
|---|---|---|---|
| Games-Labs-Game | `fix/TASK-EAR-250-prod-user-api-url` | `8f29553` | `USER_API_URL`, `MISSIONS_API_URL` |
| Games-Labs-Wallet | `fix/TASK-EAR-250-wallet-prod-service-urls` | `78bc902` | `ORDER_API_URL`, `MISSIONS_API_URL` |

Both follow the prod conventions verified in this audit: the
`games-labs-prod.local` namespace, and **scheme-less** addresses for Wallet
because its adapter dials the raw string, while Game's `GrpcTarget` strips a
scheme. Getting that backwards fails at dial time, not at deploy time.

## Not done deliberately

The remaining names are mostly provider and payment secrets. They need real
values from the GitHub environment or Secrets Manager, and someone has to decide
which providers and payment channels production actually uses — AFB, GGSOFT and
SIGMA may be intentionally unused. Guessing values or inventing URLs would put
plausible-looking wrong config into a deploy path.

## Re-run before the consolidated patch

The gap changes every time either side moves, so re-run rather than trusting
this table:

```bash
for r in Games-Labs-Auth Games-Labs-Game Games-Labs-Logs Games-Labs-Missions \
         Games-Labs-Order Games-Labs-Provider Games-Labs-User Games-Labs-Wallet; do
  cd ~/Documents/GitHub/$r || continue
  git fetch origin prod -q
  code=$(git show origin/prod:config/config.go 2>/dev/null || git show origin/prod:configs/config.go)
  env=$(git show origin/prod:ecs/env.names)
  echo "=== $r [$(git rev-parse --short origin/prod)] ==="
  comm -23 <(echo "$code" | grep -oE 'envconfig:"[A-Z_0-9]+"' | sed 's/envconfig:"//;s/"//' | sort -u) \
           <(echo "$env" | sort -u) | while read v; do
    line=$(echo "$code" | grep -m1 "envconfig:\"$v\"")
    if ! echo "$line" | grep -q 'default:' || echo "$line" | grep -q 'default:""'; then
      echo "   $v  (empty at runtime)"
    fi
  done
done
```

Two things this check cannot see, both needing AWS access:

- whether the ECS service really registers under the name the URL points at, in
  the `games-labs-prod` Cloud Map namespace
- whether a shipped name has a **wrong** value rather than a missing one

## Related

- `runs/TASK-EAR-247/prod-release-checklist.md` — the rollout this feeds
- `runs/TASK-EAR-247/status.yaml` — where the Game gap was first found, on staging
- knowledge-base `40 Lessons/A Nil Optional Adapter Becomes A Silent Business Denial`
