# TASK-EAR-192 — Win capture T2: VP / 1UP / AFB adapters + per-provider kill-switch

## Type

feature

## Priority

high

## Context

T1a/T1b are live on staging (TASK-EAR-184/187): `gamepb.SettleRoundRequest`
carries `optional double win_amount = 8`, Game stores it monotonically
(NULL-preserving GREATEST) and serves `max_coin_win` / `total_wins` /
`captured_rounds` on the admin player-activity endpoint — field-proven by
live curl. Every row's win is still NULL because no provider sends it yet.

This run is **T2 of the TASK-EAR-183 spec v1.3 split**: the three providers
whose round win total is already in hand at settle time. No accumulation
state, no Lua — that is T3 (GGSoft/Sigma/IDG), NOT this run.

**READ `runs/TASK-EAR-183/win-definition-spec.md` (v1.3) FIRST** — §2
(per-provider mapping), §5 (presence: send 0, never gate with `> 0`), §6
(per-provider rollback kill-switch, env plumbing rule).

## Scope — Games-Labs-Provider only

1. **shared-lib bump** to `v0.0.0-20260731150247-0e4294344367` (the #34 merge
   commit — same version Game and gateway now use). AGENTS.md:282 rules: no
   `replace`, `go mod tidy`, go.mod+go.sum committed together,
   `GOWORK=off go build -mod=readonly ./...`.
2. **gameadt**: `SettleRoundInput` gains `WinAmount *float64`
   (`internal/adapters/gameadt/settle_round.go:15-23`); the wire mapping sets
   `req.WinAmount` whenever the pointer is non-nil — **including 0**. Do NOT
   replicate the `SettledAmount > 0` gate (:106-108) for the new field; that
   gate stays for settled_amount only. Log line gains `win=` when present.
3. **Kill-switch (spec §6, operator requirement)**: boot-time env
   `WIN_CAPTURE_PROVIDERS` — comma-separated provider codes, default EMPTY =
   capture off. Config-layer parse + a helper the services consult (e.g.
   `config.WinCaptureEnabled("vp")`). An adapter sets `WinAmount` ONLY when
   its code is listed. **The env name must be added to `ecs/env.names` (and
   any staging env manifest the repo uses) — not just documented** (the
   EAR-079 lesson: console-only env vanishes on next deploy).
4. **VP** (`internal/core/services/vp/seamless.go:109-115`): win total =
   `req.WinAmt` from the same betNSettle callback. Send it (incl. 0 on a
   losing round). `JackpotWin` stays untouched/ignored per spec.
5. **1UP** (`internal/core/services/oneup/callback.go:91-97`): win total =
   `utils.MinorToMajor(req.Win)` (incl. 0).
6. **AFB** (`internal/core/services/afb/service.go:498-505`): win total =
   Σ positive `tx.Amount` over `AllTransactions()` (a sibling helper next to
   `afbPayoutTurnover`, e.g. `afbPayoutWin(req)`); 0 when no positive legs.
   Turnover formula untouched.

## Non-goals

- GGSoft / Sigma / IDG (T3 — gated on correlation/units/prereq run).
- Any Game, shared-lib, gateway, or FE change.
- The 1UP refund path (TASK-EAR-186, already shipped) — do not touch it
  beyond keeping its tests green.

## Acceptance criteria

- Per adapter, tests (RED-first for new behavior, following each package's
  existing hook-seam pattern of capturing `SettleRoundInput`):
  a. win mapped correctly per spec §2 (VP WinAmt; 1UP MinorToMajor(Win); AFB
     Σ positive legs — include a multi-leg case);
  b. a zero-win round sends `WinAmount` pointing at 0 (NOT nil);
  c. kill-switch: provider not listed in `WIN_CAPTURE_PROVIDERS` →
     `WinAmount` nil; listed → set;
  d. existing `SettledAmount` values unchanged in every case (pin with the
     existing turnover tests staying green).
- `ecs/env.names` (+ staging manifest if applicable) carries
  `WIN_CAPTURE_PROVIDERS`.
- Full repo build/vet/test green; PR base `main` (repo convention), body
  states: rollback = remove provider code from env + restart; deploy path =
  merge main, then bring to `staging` branch for ECS (same trail as
  TASK-EAR-186); suggested initial staging value
  `WIN_CAPTURE_PROVIDERS=vp,1up,afb`.
- Post-deploy live proof (after operator merges + staging deploy, using the
  proven harness from TASK-EAR-186 / memory `staging-live-provider-test-harness`):
  a signed 1UP BetResult with `win > 0` for the devtest player → admin
  player-activity shows `maxCoinWin` = that amount, `totalWins` "1"+,
  `capturedRounds` ≥ 1 for that game. This closes the epic's first real
  captured win end to end.

## Out of scope

- Prod anything (migration 032 must reach prod first — consolidated prod
  patch constraint).
