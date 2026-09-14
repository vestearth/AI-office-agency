# TASK-EAR-357 — Order redemption email text/plain literal "\n" fix

## Type

bug

## Parent

- Introduced by: TASK-EAR-353 / Games-Labs-Order PR #69 (merged to `staging`)
- Found in review of: TASK-EAR-354 / Games-Labs-Order PR #70
  (https://github.com/SparqLab/Games-Labs-Order/pull/70#issuecomment-5659715647)

## Problem

`renderRedemptionEmail` in
`Games-Labs-Order/internal/core/services/ordersvc/redemption_email.go` builds
the `text/plain` part with `"\\n"` inside interpreted Go string literals. That
produces a literal backslash + `n`, not a line break, so the whole plain-text
alternative renders as one line with visible `\n` sequences.

Reproduced on PR #70 head `8755769` (same code as `origin/staging` `23e4fc8`):

```
TEXT="Congratulations!\\n\\nYour E-voucher Redemption has been completed successfully\\n\\nDear Customer\\n\\n..."
```

Affects all three variants: link e-voucher success, first gift tracking, and
tracking correction. HTML part is unaffected.

## Scope

- Replace the escaped `\\n` with real line breaks in the text body builder only.
- Add a regression test asserting the text body contains real newlines and no
  literal `\n` sequence for voucher, tracking, and correction variants. The test
  must be seen failing before the fix.
- Keep subject, content, field order, greeting fallback, dates, URL safety, and
  HTML unchanged.

## Sequencing

Touches the same file as open PR #70. Branch from `staging` after PR #70 merges,
or rebase onto it. Do not stack onto the #70 branch.

## Out of scope

- Real email send, staging mutation, deployment, env wiring
  (`REDEMPTION_EMAIL_*`), and Games-Lab-Android.

## Acceptance criteria

1. `TextBody` for all three variants contains `\n` newline characters and no
   literal backslash-n.
2. Regression test fails on current `staging` and passes after the fix.
3. `GOWORK=off go test ./...`, `go vet ./...`, and
   `go build -mod=readonly ./...` pass.
4. Diff is limited to `redemption_email.go` and its test file.
