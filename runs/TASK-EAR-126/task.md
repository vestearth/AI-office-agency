# TASK-EAR-126: Daily Completion Bonus — close the double-pay vector (prod bug)

## Short name

`daily-completion-bonus-double-pay`

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-12

## Goal

Close a confirmed double-pay vector in the **live** daily completion bonus: a
client-supplied `Idempotency-Key` is forwarded to the Wallet, so a retry after a
wallet timeout + compensating delete can credit the same user twice for the same
Bangkok day. Fix it the way TASK-EAR-123 already fixed the weekly twin: always
derive the wallet key server-side from `(userID, bangkokDay)`.

## Description

Found during the TASK-EAR-123 review (weekly completion bonus claim flow), which
was modelled on this daily flow and inherited the same bug before it was caught
and fixed there. This run tracks the daily side, which is **live on production**.

`internal/services/mission_service_daily_completion.go` (~L181-184):

```go
	key := idempotencyKey
	if key == "" {
		key = fmt.Sprintf("daily_completion_bonus:%s:%s", userID, bangkokDay)
	}
```

and ~L234 runs a compensating `DeleteDailyCompletionBonusClaim` when the wallet
credit returns an error.

`internal/handlers/mission/http/mission.go` (~L90-95) reads an `Idempotency-Key`
header / `idempotency_key` body field and forwards it verbatim into that
parameter, so a client fully controls the wallet dedupe key.

**The failure sequence (all four steps independently verified):**

1. Wallet **commits** the credit but returns an error to Missions (context
   deadline / connection reset). Plausible: a timeout is exactly when the write
   has often already landed.
2. Missions runs the compensating delete, removing the `daily_completion_bonus_claims`
   row — the ledger gate that would otherwise stop a second payment.
3. The client retries with a **new** per-request `Idempotency-Key`.
4. `TryInsertDailyCompletionBonusClaim` succeeds (row is gone), and Wallet's
   `ApplyTransaction` dedupe — `SELECT ... FROM wallet_transactions WHERE user_id = $1
   AND idempotency_key = $2`, **no TTL** (`Games-Labs-Wallet`
   `internal/repositories/wallet.go` ~L147) — sees an unseen key and **credits a
   second time**.

The claim ledger cannot protect step 4 because step 2 deleted the row itself. The
deterministic key is the only thing standing between a retry and a double credit,
and the client can currently override it.

Note this is NOT hypothetical-only: the compensating delete on wallet error is
exactly the path that runs on any wallet blip, and mobile clients commonly
generate a fresh idempotency key per HTTP attempt.

## Scope

### Target services

| Service | Reason |
| --- | --- |
| `Games-Labs-Missions` | Owns `ClaimDailyCompletionBonus` and the HTTP handler that forwards the client key. |
| `ai-dev-office` | Records scope, assignment, and verification handoff. |

### Affected files

| Path | Action | Description |
| --- | --- | --- |
| `internal/services/mission_service_daily_completion.go` | modify | Always derive the wallet key from `(userID, bangkokDay)`; never accept the caller's. |
| `internal/handlers/mission/http/mission.go` | modify | Decide whether to keep reading `Idempotency-Key` at all for this route (see "Open decisions"). |
| `internal/services/daily_completion_bonus_resolve_test.go` (or a new focused test file) | modify/create | Pin: a caller-supplied key must not reach the wallet. |
| `ai-dev-office/runs/TASK-EAR-126/status.yaml` | create | Track assignment and next action. |

### Explicitly excluded

- No change to the weekly completion bonus — already fixed under TASK-EAR-123
  (branch `feat/TASK-EAR-123-weekly-completion-bonus-claim`, PR
  https://github.com/SparqLab/Games-Labs-Missions/pull/76).
- No new migration; no proto/`shared-lib`/api-gateway change expected.
- Do not change the Wallet service's dedupe semantics — they are correct; the bug
  is Missions handing Wallet a key the client controls.

## Open decisions (settle before implementing)

1. **Does the daily route keep accepting `Idempotency-Key` on the wire?**
   TASK-EAR-123 chose NOT to accept it for weekly (a field that silently does
   nothing is a trap). Daily differs: it is **live**, and clients may already be
   sending the header. Dropping it is wire-visible; accepting-and-ignoring is
   honest only if clearly documented. Recommend: keep accepting it (avoid
   breaking existing callers), ignore it for the wallet key, and document that
   plainly at both the handler and the service — then unify with weekly later.
2. **Unify the two signatures?** Once daily is also deterministic, both
   `ClaimDailyCompletionBonus` and `ClaimWeeklyCompletionBonus` carry a
   permanently-ignored `idempotencyKey` parameter. The EAR-123 final review
   recommended dropping both **together, in this task**, rather than leaving one
   inconsistent. Decide whether that is in scope here.
3. **Is remediation needed for already-double-paid users?** Unknown whether this
   has actually fired in production. Consider an audit query before/alongside the
   fix: `daily_completion_bonus_claims` rows vs. `wallet_transactions` entries
   with `reason = 'daily_completion_bonus'` for the same (user, day) — more than
   one credit per (user, bangkok_day) indicates a real occurrence.

## Acceptance criteria

- [ ] A caller-supplied `Idempotency-Key` / `idempotency_key` can no longer
      influence the wallet idempotency key for `ClaimDailyCompletionBonus`; the
      key is always `daily_completion_bonus:<userID>:<bangkokDay>`.
- [ ] A test pins this: passing a caller key still results in the deterministic
      key reaching the wallet (mirrors
      `TestClaimWeeklyCompletionBonus_CallerSuppliedIdempotencyKeyIgnoredForWallet`).
- [ ] The wire decision from "Open decisions" #1 is implemented and documented in
      code comments that accurately describe what happens.
- [ ] `go build ./...`, `go vet ./...` clean; `go test ./... -race` green.
- [ ] `ruby ai-dev-office/validate-yaml.rb TASK-EAR-126` passes.
- [ ] An answer recorded for "Open decisions" #3 (audit run, or an explicit
      decision not to).

## Plan

1. Settle the three open decisions with the operator.
2. Write the failing test (caller key must not reach the wallet).
3. Make the key unconditional in `ClaimDailyCompletionBonus`; apply the handler
   decision.
4. Consider porting the other two EAR-123 hardenings if they apply to daily:
   propagate the plan-read error rather than silently falling back to the
   singleton, and log compensating-delete failures instead of discarding them.
   (`ResolveDailyCompletionBonusForDate` swallows similarly.)
5. Full suite + PR to `staging`; promote toward prod per the normal flow, since
   unlike EAR-123 this one is a live-prod bug.

## Dependencies and blockers

- Reference implementation: TASK-EAR-123's `WeeklyService.ClaimWeeklyCompletionBonus`
  (deterministic key + propagated plan-read error + logged compensating delete).
- Blockers: none. Independent of EAR-123 merging.

## Risks and mitigations

- **Dropping the wire field could break existing clients** that send the header
  and expect a 2xx. Mitigation: prefer accepting-and-ignoring (decision #1);
  either way the field never affects payment.
- **`mission_service_daily_completion.go` / `mission_service.go` may be under
  concurrent edit** by another session (they were during EAR-123, 2026-07-12).
  Mitigation: check `git status` before starting; stage only this task's paths;
  never `git add -A`.
- **Fixing daily without auditing** leaves any historical double-credits
  unaddressed. Mitigation: decision #3.

## Assignment

- Primary: `dev`
- Parallel: `false`
- Reason: small, focused, money-path change in one repo; needs the open decisions
  settled first.

## Verification and review plan

- Reviewer confirms the client cannot influence the wallet key by any path, and
  that comments describe actual behavior.
- Reviewer confirms Wallet's dedupe semantics were not touched.
- Run `ruby ai-dev-office/validate-yaml.rb TASK-EAR-126` before handoff.
