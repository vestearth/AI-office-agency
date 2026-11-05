# TASK-VS-062: receiver matching and compatibility check (SPAR-62)

Multica issue: 01a1acc4-2ac0-768c-bae0-37a3a71b3dbf.
Current trigger: 01a1acf6-fcf9-73b3-8509-c57c60599da9.
Conductor: Codex / Tommy Vercetti. Repository: SparqLab/slip-api.
Worktree: /Users/earth/Documents/GitHub/slip-api-spar62-audit;
branch task/TASK-VS-062; baseline f82ba69307c982eaa1ee619f23be2bf3b6f23b94.

## Current human requirements

Earth's 01a1acf6-b534-7dc9-9056-c91ff8f0dc0b supersedes v1 policy:
full-length masked bank account numbers use positional matching only, with at
least four visible digits; valid shortened masks and unmasked numbers retain
legacy behavior. Preserve AND/type separation/PromptPay/priority/bank fallback.
Collision/first-match policy is explicitly undecided and remains unchanged.

Jason's trigger assigns prod history impact/readiness and independent v2 review
in parallel. Peer followup requests the reviewer finding be fixed locally.
Earth's 01a1ad00-8e2a-77a4-9db7-8a9d6f4b6ef8 supplies history aggregates and says
not to query receiver_account patterns again; no additional DB query follows it.

## Work in scope

- Fix reviewer finding in payment.go: malformed masked inputs must fail closed,
  and only valid shortened masks may reach suffix matching. Overlong masks do
  not qualify as shortened. No change to legacy unmasked behavior.
- Reuse reviewer reproducer for failing-before/passing-after unit and Confirm
  tests. Preserve Submit/Confirm valid full/short/unmasked success and expiry;
  verify fake Credit amount, user, destination and call count.
- Assess stored credited history without exporting customer identifiers or raw
  account values. Read-only aggregate snapshot ev-038 was already completed
  before Earth's supplied result/no-repeat instruction; use both existing results.
- Run feasible local readiness checks and prepare portable v3 patch for re-review.

## Boundaries

No Git commit, push, PR, merge, deploy or actual credit operation is authorized.
No production application/config/database write or extra provider replay.
No changes to original slip-api/slip-system/slip-contracts checkouts, contracts,
models, schemas, dependencies or deployment files. API worktree changes are
limited to payment.go and payment_receiver_match_test.go; task evidence/report
artifacts may be updated. Future VerifySlip implementation PR targets main,
subject to policy/workflow checks only after publication is separately authorized.

## Evidence and limitations

Actual verifier replays ev-018/019/026 show BANKAC XXXXX####X, receivingBank004,
null bankCode and empty proxy reference. Historic422 logs are generic; replay is
not the original response. Earlier substring/v1/v2 patches are historical and
superseded by receiver-positional-mask-v3.patch. Detailed history: audit.md.
Current local fix requires independent re-review. No runtime recovery claim.
