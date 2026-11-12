# TASK-VS-069: Partner sub-branch API with pay-per-use credit - planning only

Opened 2026-11-10 by the Claude conductor at Earth's request.

**This run is brainstorming and planning only.** No code, branch, PR, migration or deploy
happens here. Earth is still collecting information from the partner. Implementation
gets its own task(s) once the `design_decision` gate passes.

The partner's raw request, its name and the agreed price stay in
`partner-request.local.md` in this folder. That file is local only, because this
repository is public. For the same reason, exact security weaknesses found in code
(slip-api and agent-slip-api) stay in `security-findings.local.md`; this file cites
them as S1–S8. Below, "the partner" means that customer, and `P` means its
price per billable unit (operator confirmed 2026-11-11).

## Request (paraphrased)

The partner resells slip verification to its own agents.

1. An API that lets the partner create branches under its account.
2. No packages. Charge `P` per billable unit; a request can incur more than one
   unit under the applicable charging rules (operator confirmed 2026-11-11).
3. Read the balance of each branch.
4. The balance never expires.
5. Send the partner a callback with each branch's balance.
6. Agents never see an API key, but the partner must be able to tell agents apart.
7. Record which product a request came from. One agent can use several of the
   partner's products, and all of them stay under the same agent.

## Team feature list (second input, 2026-11-11)

Earth posted a feature list written by the team to SPAR-69 on 2026-11-11. It is a
second input next to the partner request. Where the two conflict, nothing is decided
yet; Jason's three questions at the end of this section are pending with Earth.

**User side**

- Account: sign up, log in, email verification, password reset, log out; view and
  edit profile, change password, upload a photo.
- Merchants and branches: create, view, edit and delete merchants; create ("Gen
  Branch"), view, edit and delete branches; issue, rotate and revoke a branch API
  key; manage a branch's bank accounts and turn the receiver check on or off.
- Verify: through the API only; view results and fetch a slip by reference.
- Wallets and reports: branch wallet = verifications × that branch's price per slip;
  user wallet = sum over all branches; usage history; branch report; merchant
  dashboard (today, daily, total, per branch).

**Admin side**

- Admin login and own profile; view, summarize and edit users; view and edit
  merchants and branches; login, activity and action logs.
- Price per slip for each branch; usage per branch and per user; whether each user's
  bill is paid.
- Reports: verification list, daily summary, status summary, money flow by bank,
  usage history.

**System emails** (plain text, no templates): OTP on sign-up and resend; OTP for a
password reset; a notice to the account owner when a branch key is rotated.

**Not included:** KYC, credit top-up, packages, LINE, coupons, articles, credit
transfer between users, branch webhook, verify from a QR image, slip decode, welcome
email, email templates.

**How it differs from the partner request and the earlier assumptions** (from the
three evaluations in SPAR-69):

| Topic | Partner request / earlier assumption | Team list |
|---|---|---|
| Money | Prepaid wallet candidate (billing model 1) | Wallet = usage × price, bill status, no top-up: billing model 2, or 3 with a limit |
| Price | One `P` for the partner | A price per branch, set by an admin |
| Count | Charged units (principle 3) | "Verifications × price": must mean charged units, not requests |
| Callback | A balance callback per branch (request 5) | "No branch webhook": unclear whether the balance callback goes too |
| Who logs in | The partner's backend holds keys; agents never see them (request 6) | Self sign-up with key management: unclear whether a user is the partner or an agent |
| Onboarding | KYC once, at partner level | No KYC; self sign-up |
| Async | Queue and batch exist today | API only, no QR or decode; queue/batch scope is open |
| Not in the list | `source_system` (request 7), server-to-server Gen Branch API, `external_ref`, IP allowlist | All three agents: do not treat these as dropped |

**Evaluation highlights** (agent claims; "verified" marks a claim Claude checked at
`d567be9`):

- **Michael (risk):**
  - Self sign-up, no KYC and postpaid together let anyone create branches and spend
    our KBank cost. Options: reject verify until an admin sets the branch price
    (default deny), admin approval before keys are issued, or no self sign-up.
  - Without an IP allowlist a leaked key builds unpaid usage. Needs a rate limit per
    key and anomaly alerts. New keys should be stored hashed. Claude's verified note
    on today's key storage is S1 in `security-findings.local.md`.
  - Soft-delete merchants and branches that have usage or bills. A price change needs
    an effective date and an audit record.
  - Under option B, lift the existing OTP and auth code with its tests instead of
    rewriting it, and rate-limit OTP requests per email and per IP.
  - B's main failure mode is verify-rule drift. Proposal: a shared golden test of
    outcome → charged units that both backends must pass.
  - Reports carry PII (sender names, account numbers) and need tenant isolation on
    every query.
- **Trevor (repo evidence):**
  - No existing table fits "bill paid or not". `payment_transactions` is top-up
    intake with statuses `pending|credited|rejected`.
  - Receiver mismatch is charged today; a duplicate stopped before the bank is not.
  - `verification_usage_hourly` (`migrations/065_verification_usage_hourly.sql`,
    verified) spares dashboards a scan of `verifications`. It has no bank column, so
    "money flow by bank" needs a new rollup.
  - The existing key-rotation email renders a template; plain text means building
    the text body directly.
  - Options listed: money W1 usage ledger with a closed monthly bill, W2 prepaid,
    W3 postpaid with a cap; callback C1 none, C2 bill status only, C3 periodic usage;
    multiplier U1 charged units or U2 every request.
- **Tommy (implementation):**
  - Leans to a usage ledger plus a postpaid statement. UI labels: current-period
    charges, unpaid bills, and remaining limit when a limit exists.
  - Formula: `sum(charged units × applied unit price)` per billing period. A price
    change takes effect next period (simpler) or at an effective time (needs price
    versions).
  - Postpaid does not remove the case where the bank call succeeds and the database
    commit fails; it still needs recovery and reconciliation.
  - Phase order under postpaid: (1) identity, branches and keys, synchronous verify,
    auditable usage facts; (2) branch price, period close, bills, manually recorded
    payments, basic history and reports; (3) more dashboards and automation. If the
    callback stays, durable delivery belongs to the acceptance scope.
  - Bills in phase 1: an operator records each payment with a reference and the
    actor; statuses unpaid, paid, void.

**Jason's questions for Earth (pending):**

1. Is the "wallet" postpaid charges, or still prepaid? If postpaid, is there a
   credit limit or a suspension rule for unpaid bills?
2. Is the user who signs up the partner's administrator or a downstream agent, and
   who pays the bill and sees the API keys?
3. Does "no branch webhook" also drop the partner balance callback? Are
   `source_system` and the Gen Branch API still required?

## Current system (slip-api `origin/prod` `d567be9`, read 2026-11-10)

- **Hierarchy.** `users` (THB wallet `credit_balance`) → `merchants` → `branches` →
  `branch_packages` (migrations 001, 002, 006, 012).
  - Every branch already has its own `api_key`, an `ip_address` allowlist,
    `webhook_url` and `webhook_secret`.
  - `branch_packages` holds `quota_limit`, `quota_used` and a non-null `expires_at`
    for each (branch, channel).
- **Charging.**
  - `SaveWithQuota` charges in the same transaction as the verification insert
    (`internal/repositories/verification.go:43`).
  - The fast path updates `branch_packages` only while `expires_at > NOW()` and quota
    remains (`internal/repositories/branch_package.go:820`).
  - A pre-check runs before the bank call (`internal/core/service/verification.go:243`).
  - Units come from `models.QuotaCost` (always 1 today). The not-found, duplicate and
    8404 rules (TASK-VS-063), and the planned retry +1 (TASK-VS-068), are all
    expressed in these units.
- **Branch creation.** JWT only: `POST /v1/merchants/{merchantId}/branches`
  (`internal/core/service/branch.go:1168`).
  - It requires approved KYC and `package_id_api` or `package_id_line`, and it debits
    the package price.
  - It starts with an empty IP allowlist, and an empty list rejects verify with 403
    (`internal/handler/middleware/api_key.go:76`).
- **Webhook.** Per branch, and only for queue (async verify) results.
  - Signed HMAC `X-Slip-Signature`.
  - Retried in memory, 3 attempts, with no outbox
    (`internal/core/service/webhook_deliver.go:96`). A restart or deploy loses pending
    callbacks.
- **Balance reads.**
  - `GET /v1/slips/quota` returns package quota.
  - `GET /v1/account` returns the user wallet.
- **Source tag precedent.** `verifications.line_source` (migration 011).
- **Not involved.** slip-system and slip-contracts have no billing. All charging is
  in slip-api.

## Requirement → gap

| # | Today | Gap | Candidate |
|---|---|---|---|
| 1 | JWT-only create, package and KYC required | No server-to-server create | New `/v1/partner/branches` behind a partner key |
| 2 | Every verify needs an active package | No pay-per-use | `branches.billing_mode = credit` plus a branch wallet |
| 3 | `/v1/slips/quota` is package-only | No per-branch THB balance | `GET /v1/partner/branches/{id}/balance` plus a list |
| 4 | Package `expires_at NOT NULL` | n/a | A wallet has no expiry |
| 5 | Webhook covers queue results only | No balance event | Partner-level callback with an outbox |
| 6 | One key per branch already exists | Partner-side mapping | Return the key to the partner only; add `external_ref` |
| 7 | No field | No origin tag | `source_system` per request |

Rows 2–5 assume billing model 1 (prepaid). Models 2 and 3 are in
[Billing model options](#billing-model-options-operator-idea-2026-11-11).

## Principles (draft, for the design_decision gate)

1. **Additive and opt-in.**
   - `branches.billing_mode` defaults to `package`, so existing branches do not
     change.
   - `/v1/partner/*` routes and their middleware are new; no existing route
     changes.
2. **Preserve existing package-mode verify behavior.** Reuse the verify body and
   bank integration. Credit-mode pre-checks and settlement select the billing
   policy; new errors or headers are documented additive contract changes. The mode
   can be loaded with the branch row that APIKeyAuth already reads.
3. **Unit-based monetary pricing (operator confirmed 2026-11-11).** The operator
   selected `charged_billable_units × P`, including billable retry units under the
   applicable policy, rather than a per-request price cap. Zero charged units cost
   zero; two charged units cost `2 × P`. Count units actually charged, not raw bank
   attempts: free outcomes, replay and any skipped surcharge must follow the
   applicable policy. TASK-VS-068 remains a planned dependency, not proof of shipped
   behavior. Funding/insufficient-balance handling and customer notice remain to be
   specified; this pricing decision does not pass the overall design gate.

## Candidate design (options, not decisions)

- **Partner account.** One user plus one merchant, as today. A new `partner_accounts`
  table holds:
  - the partner key (store a hash)
  - callback URL and secret
  - allowed IPs
  - `unit_price`

  KYC happens once, at partner level.
- **Candidate mapping: downstream agent = branch (unconfirmed).** The partner is
  itself an Agent in our platform; do not confuse that identity with the partner's
  downstream customer/agent terminology. `POST /v1/partner/branches {name, external_ref}` creates an
  `api` branch with `billing_mode=credit` and the partner's IPs, and returns
  `api_key` to the partner only. `external_ref` is unique per merchant. For idempotent
  creation, the implementation must also return the existing resource for an
  equivalent repeat and reject conflicting attributes, including concurrent creates.
- **Wallet (billing model 1 only).** A `branch_wallets` row per branch plus a
  `branch_wallet_transactions` ledger, using `NUMERIC(14,4)`.
  - A charge is one statement: `UPDATE ... SET balance = balance - $amt WHERE
    branch_id = $1 AND balance >= $amt`.
  - Insufficient funds return a new `insufficient_balance` error, separate from
    quota exceeded.
  - Funding: the partner tops up its user wallet through the existing invoiced
    top-up, then calls `allocate` / `reclaim` to move money to a branch. An admin can
    also top up a branch directly.
- **Balance push.** One partner-level URL using the existing HMAC scheme.
  - Events: `balance.topped_up`, `balance.low`, `balance.depleted`, and optionally
    `balance.snapshot` every N minutes.
  - Per-change callbacks versus thresholds or coalesced snapshots remain a partner
    decision. Measure event volume and delivery capacity before choosing a trigger;
    high volume alone does not authorize dropping required balance notifications.
  - Needs a durable outbox.
  - Optional: an `X-Balance-Remaining` response header on verify. This is an additive
    API contract change; define whether it is the committed post-transaction balance
    and document it. It does not replace the requested callback.
- **Source.** Request header `X-Source-System`, limited to a per-partner allowlist,
  stored in `verifications.source_system` (`ADD COLUMN ... DEFAULT ''`, a
  metadata-only change).
  - Request-hash treatment is undecided: define what happens when the same branch
    and idempotency key are reused with a different source. Preserve the original
    attribution on replay, and decide whether conflicting sources are rejected or
    share the original result. Do not silently reattribute or charge twice.
  - No index on `verifications` (TASK-VS-049 rule). Report by source from the wallet
    ledger.

## Billing model options (operator idea, 2026-11-11)

Earth is considering metering usage and invoicing the partner once a month, instead
of packages or a prepaid wallet. It changes how "balance" in the request is read, so
the partner must confirm (Q9–Q11). **Update 2026-11-11:** Earth decided monthly
postpaid with a credit limit per user for the agent product (DEC-05, under Operator
decisions). The partner's confirmation is still pending.

| Model | "Balance" means | State in the verify path | Main cost |
|---|---|---|---|
| 1. Prepaid wallet (candidate design above) | Money the partner deposited with us, left per branch | A money balance per branch, debited per charge | Wallet, top-up, allocate/reclaim, D6 |
| 2. Postpaid, metered | Units used so far this month | Only the usage fact | Credit exposure; no automatic stop |
| 3. Postpaid with a limit per agent | The limit the partner sets for an agent, minus units used | A unit counter per branch, not money | Limit API; a small overshoot is acceptable |

Claude's first guess was model 3, for a reseller whose agents prepay it. The team
feature list (above) points to model 2, or model 3 if a limit is added, and it sets
a price per branch rather than one `P`. The request's "no expiry" holds in models 2
and 3 without extra work.

**Removed by models 2 and 3:**

- Branch wallets and the wallet ledger.
- Top-up and allocate/reclaim, including moving money from the user wallet to a
  branch.
- The `insufficient_balance` error.
- Money precision in stored balances. Precision matters only when the invoice is
  computed.
- D6 as a money question. In model 3 it becomes how many units of overshoot are
  acceptable.

**Still needed:**

- Verify skips the package check for partner branches and records the charged units
  in the same transaction as the verification. The change to the verify path is
  small.
- Usage facts record charged units and the applied unit price (Codex issue 5), not
  raw bank attempts.
- Partner key and branch API, `source_system`, and callbacks. The callback carries
  usage or the remaining limit instead of money.

**Existing precedents (slip-api `origin/prod` `d567be9`):**

- `quota_history` already writes one row per charge with branch, channel, action,
  `quota_delta` and a reference to the verification, and its `branch_package_id` is
  nullable (`migrations/021_quota_history.sql:3`). Check that its readers accept rows
  without a package before reusing it.
- `quota_history` has an index on `(branch_id, created_at DESC, id DESC)`
  (`migrations/021_quota_history.sql:22`), so a per-branch monthly sum is indexed.
  Corrected 2026-11-11: an earlier version of this list said it had no index; the
  grep missed a two-line `CREATE INDEX`.
- `quota_history` records units only. It has no price column and
  `CHECK (quota_delta <> 0)`, so an invoice that snapshots the applied price needs a
  price column or its own usage ledger.
- `verification_usage_hourly` (`migrations/065_verification_usage_hourly.sql`) is a
  precedent for a rollup written alongside verify without foreign keys. It counts
  verifications, not charged units, and has no price.
- `MonthlyUsage` (`internal/core/service/reports.go:889`) counts verification rows by
  month and channel. It cannot be the invoice source: it counts free outcomes and
  misses retry units.
- Tax invoice mail exists only for prepaid flows. `NotifyTopUp` sends the tax invoice
  after a credit top-up (`internal/core/service/invoice_mail.go:41`). A monthly
  invoice needs a new document flow, and accounting confirms when the tax invoice is
  issued.

**New work and risks for models 2 and 3:**

- A monthly invoice job and document, plus a per-request export the partner can
  check when it disputes an invoice.
- Credit exposure: the partner uses a month of service before paying. Needs a credit
  limit or monthly cap, and a suspension flow for unpaid invoices.
- Cash flow: KBank bills us monthly for 0000 results, before the partner pays us.
- Month cut-off in Asia/Bangkok time, counted by commit time, so queued work that
  spans the month end is counted once.
- An issued invoice never changes; corrections are credit notes.

**Effect on D7 (repo topology).** Under models 2 and 3 the new code inside verify
shrinks to skipping the package check and recording units. The code a new repo would
copy does not shrink: the verify and charging files on `origin/prod` had 26 non-merge
commits in the 30 days to 2026-11-11 and 56 in 60 days. Monthly invoicing is a batch
outside the verify path, so invoicing, the partner portal and the partner admin are
the parts that separate cleanly.

## Open questions for the partner (`partner_requirements` gate)

The block below is meant to be sent as is. Internal notes go after it, never inside.

```text
1. Agents and branches: should each of your agents be one branch in our system?
   Each branch has its own verify quota, which you set through our API. Your
   account is invoiced once a month for all of its branches.
2. Quota callback: we plan to call you when a branch's remaining quota falls
   below a threshold and when it runs out. What threshold do you want? Do you also
   need a callback after each charge, or a periodic snapshot?
3. Verify calls: are you fine holding one API key per agent (no change to our
   verify API), or do you need one partner key plus an agent ID header?
4. Source system: what is the fixed list of values? Is it set per request or per
   agent?
5. Pricing: we charge P per billable unit, and one request can incur more than one
   unit (for example, when the bank call is retried). Is P VAT-inclusive? We will
   send you the list of outcomes that are free and those that are charged (slip not
   found, receiver mismatch, duplicate slip); please confirm it works for you.
6. Is this a new account, or will existing branches move off their packages?
7. API channel only, or LINE as well?
8. Duplicate slips across agents: duplicate detection works per branch. If the
   same slip is submitted at two of your agents, both are verified and both are
   charged. Do you need a flag when a slip was already verified at another of
   your agents?
9. Quota: a branch's quota counts billable units, so free outcomes such as "slip
   not found" do not use it, and it never expires. You set a branch's total quota
   through our API, and the remaining quota is the total minus what it has used.
   Is this what you meant by "balance"?
10. When a branch's quota runs out, we reject its verify calls before contacting
    the bank and charge nothing. Is that what you expect?
11. Billing: we invoice your account monthly, in Thai time, for all usage. What
    payment terms do you expect (days to pay)?
13. Network: are your outgoing IP addresses fixed, and how often do they change?
    Do you want us to accept your calls only from listed IP addresses?
14. Keys: do you need to rotate and revoke an agent's API key through our API?
15. Billing callbacks: we can notify your account when an invoice is issued, when
    a payment is recorded, and when the account is suspended for an overdue invoice
    or reactivated. If you want them, send us the callback URL and we will turn
    them on.
```

Internal notes for this block (do not send):

- **Reworded 2026-11-11** after DEC-08 (per-branch quota) and the DEC-05 change:
  Q1, Q2 and Q9–Q13 now describe the decided model, and Q15 is new. Q9 and Q10 ask
  the partner to confirm what Earth decided. The partner's account gets an explicit
  "unlimited" credit setting; do not mention it in the block. Q12 was removed on
  2026-11-12: the partner left batch to us, and Earth decided on no batch in the
  first release. Renumber the block when sending. Q15 offers the billing callbacks
  Earth decided to build in advance (2026-11-12).

- Q2: do not exclude per-charge callbacks until the partner agrees the triggers
  and any coalescing (Codex review).
- Q5: per-billable-unit pricing, including billable retry units, is settled
  (operator, 2026-11-11). Q5 asks only about VAT and the outcome list; do not
  reopen per-unit versus per-request. Build the outcome list from what is shipped
  when it is sent: the 8404 rule (TASK-VS-063) and the retry rule (TASK-VS-068,
  still planned). "Duplicates are free" is not precise enough, because pre-bank
  and post-bank duplicates differ under TASK-VS-068.
- Q8: added by the Claude review below (per-branch duplicate scope).
- Q9–Q11: they offer the partner monthly billing (models 2 and 3). Send Q11 only if
  Earth decides to offer it; it is an operator idea from 2026-11-11, not a decision.
  Q9 is worth sending in any case, because it settles which billing model the
  request means.
- Q12–Q14: from the SPAR-69 Round 1 replies. Q12 (Trevor): a queued job cannot read
  the original header, so `source_system` must be stored at intake; batches also
  hit the 1-unit batch admission check (D6). Q13 (Michael, Trevor): a per-branch
  allowlist must be updated in bulk when the partner's egress changes. Q14
  (Trevor): rotate and revoke exist today only on JWT merchant routes.
- Round 1 questions not copied into the block, because they assume prepaid: reject
  or partly process a batch when the balance runs out, accept a small negative
  balance, accept a coalesced callback, and where an agent's money goes when it is
  closed (Michael). Revisit them if model 1 is chosen.

## Operator decisions needed (`design_decision` gate)

**Recorded 2026-11-11 — Earth confirmed DEC-01..07 in SPAR-69** (Earth's own comment,
08:22 UTC, accepting the seven recommendations from the agent-slip-api review round).
The DEC numbers are the ones used in agent-slip-api `PRD.md`.

| DEC | Decision | Settles here |
|---|---|---|
| DEC-01 | Charge by slip-api's charged/free policy, including receiver mismatch and the full 8404 timing and free windows | D10.1 |
| DEC-02 | Block duplicate bank work for the same key and for the same slip within a branch, even with a different key or none, while keeping the not-found retry windows | D10.2 |
| DEC-03 | Separate sandbox and live credentials, data and replay state | S5 |
| DEC-04 | A branch without a set price cannot start live bank work; the price is snapshotted at admission and a replay keeps it; an explicit zero differs from unset | D10.3 (first part), D9 (default deny) |
| DEC-05 | Monthly postpaid in Asia/Bangkok time; issued invoice amounts never change; payments carry references; a credit limit per user; automatic suspension over the limit or when overdue; overrides expire and are audited | D1, D10.4, D10.5 |
| DEC-06 | One shared overall bank budget, with rate and concurrency caps per product and per user | D10.6, the per-branch cap in D6 |
| DEC-07 | Build the partner product in agent-slip-api as a standalone postpaid product; reuse slip-api's policy and control drift with golden tests | D7 → B |

Also confirmed in the same comment: `x-merchant-id` carries the merchant of the branch
that auth resolved, not a constant, and billable units, applied unit price and charge
amount are stored as separate values (principle 3).

**Answered later on 2026-11-11 (Earth, in the Claude session):**

- Jason's three questions (08:51 UTC), as Jason recommended:
  1. R1 = A: a request waiting on the same slip while the first runs shares the
     first result.
  2. The 404/4040 cooldown starts at slip-api's 30 s. Whether 0 (off) is allowed was
     not decided.
  3. Admitted work that provably never reached the bank is cancelled when the user is
     suspended, and its commitment is released once.
- DEC-02 wording: "block duplicate bank work" replaces "coordinate". Earth
  confirmed the case list below. Within one branch, in live mode:

  | # | Case | Bank call? |
  |---|---|---|
  | 1–3 | Same key: completed replay, sent while in flight, or different payload (conflict) | No |
  | 4 | Slip already verified in the branch, any key | No (duplicate, free) |
  | 5 | 404/4040 within the cooldown | No (stored free result) |
  | 6 | Same slip, different or missing key, sent while the first is in flight | No: shares the first result (R1 = A); new vs slip-api |
  | 7 | First attempt ended unknown (timeout) | No until recovery resolves it; new vs slip-api |
  | 8 | 404/4040 after the cooldown | Yes, free |
  | 9 | Resubmitted after a finished 8404 | Yes, under the 8404 clocks; same as slip-api |
  | 10 | Resubmitted after another rejected result | Yes, charged; same as slip-api |
  | 11 | Bank returned 0000 but the receiver lookup failed | No: keep the bank result and recheck; new vs slip-api, which calls the bank again |
  | 12 | Same slip in another branch | Yes |
  | 13 | Sandbox | Mock bank only |

  KBank bills only 0000, so rows 6 and 11 are where duplicate calls cost money.
- Recorded in agent-slip-api: commit `29eeac4` on the PR branch updates `PRD.md`
  (DEC-02 wording, the case list, R1 = A, cooldown, cancellation, case 11) and
  aligns `ARCHITECTURE.md`, `DESIGN_SYSTEM.md` and `AGENTS.md`. Pushed to
  SparqLab/agent-slip-api#1, and the PR description updated.

**Decided later on 2026-11-11: per-branch quota and the main agent's limit (Earth,
in the Claude session).** The partner calls an API to set each branch's verify
quota, while billing stays monthly at the main agent (the user).

- **DEC-08, per-branch quota:**
  1. The quota counts billable units; free outcomes do not use it.
  2. It never expires.
  3. The partner sets a branch's total quota (`PUT`, with an idempotency key).
     Remaining = quota − used − reserved. A total set below what was used blocks the
     branch; it never goes negative.
  4. One unit is reserved before the bank call and released if the outcome is free.
     An exhausted quota rejects verify before the bank call, with no charge. A
     branch with no quota set is blocked the same way until the account sets one
     (Earth, decided after the first record; agent-slip-api commit `41aabe4`).
  5. The API uses an account-level management key, stored hashed and separate from
     the branch verify keys. Every quota change is audited with its actor and
     source.
  6. A callback is sent when remaining quota falls below a threshold and when it
     runs out (part of D3). Earth asked about other callbacks; two were discussed
     earlier: a result webhook for async or batch verify (slip-api has one, for
     queue results only), and a billing callback (invoice issued or paid, or a
     periodic usage report; Michael's C2/C3). Earth: ask the partner first (Q15).
     The partner then left the batch webhook to us; see the next bullet.
- **Batch verify and result webhook (Earth, 2026-11-12):** not in the first
  release; verify stays synchronous. The partner left the choice to us.
  - Why: the sync response carries the result, and `GET /v1/slips/{ref_id}`
    re-reads it.
  - Batch would add per-item quota and credit admission, cancellation of queued
    items on suspension, and a durable queue and webhook. slip-api's webhook loses
    pending callbacks on restart, so it cannot be copied.
  - Revisit when the partner needs bulk submission, or when production throttling
    shows it is needed. A later version reuses the quota callback outbox.
- **Billing callbacks, built in advance (Earth, 2026-11-12):** ready for the partner
  to use as soon as it asks.
  1. Enabled per account; off by default. The partner sends a URL and we turn them
     on.
  2. Events: invoice issued, payment recorded, suspended for an overdue invoice,
     reactivated. No periodic usage report; usage is read through the API.
  3. Same outbox, signing and retries as the quota callback. A callback is a hint;
     the read API is the source of truth, so a lost or repeated callback cannot
     change amounts.
  4. Minimal payload: ids, billing period, amounts, status, due date. No slip or
     personal data.
  5. Not a gate for real money; built after invoicing and payments.
- **DEC-05 changed:** the credit limit per user is optional. An admin can set an
  explicit "unlimited" for an approved account, such as the partner's main agent;
  usage is still tracked. An account with no setting still cannot start live bank
  work, so self sign-up stays fail-closed. Overdue invoices still suspend
  automatically.
- Recorded in agent-slip-api commit `dbc291c` on PR #1: `PRD.md` (DEC-05 row,
  DEC-08, FR-11, open parameters, a release-criteria row) and aligned
  ARCHITECTURE, DESIGN_SYSTEM, AGENTS, SECURITY and TESTING.

Still open, so the `design_decision` gate stays pending and `decision-memo.md` is not
written yet:

- Whether the 404/4040 cooldown may be set to 0 (off).
- The quota callback threshold (partner Q2).
- The items agent-slip-api `PRD.md` lists as open: read and replay rights while
  suspended, invoice attribution and cut-off, D8 and unknown-outcome exposure, the
  security profile, and the operating values.
- D2, D3 and D4 below, and the partner's answers (`partner_requirements` gate).

- **D1. Billing and balance model:**
  **Decided for the agent product (DEC-05, changed later the same day, and
  DEC-08):** monthly postpaid at the user (main agent) level. The credit limit is
  optional, and an admin can set it to an explicit "unlimited" for an approved
  account such as the partner's. Overdue invoices still suspend automatically. The
  partner sets a verify quota per branch through our API (DEC-08), which brings
  back the per-agent limit of model 3, counted in units and never expiring. The
  partner must still confirm (Q9–Q11). Original text: model 1, 2 or 3 in
  [Billing model options](#billing-model-options-operator-idea-2026-11-11); Q9
  decides which one the request means. For model 1 only: per-branch wallet or a
  partner pool. The request text asks for a balance per branch and a balance
  callback per branch, which reads as per-branch wallets; the partner still has to
  confirm it (Q1). Row-lock contention is a sizing input to measure, not the reason
  to choose (Codex and Claude reviews).
- **D2. Key model:** (A) one key per agent, held by the partner, with no auth change
  (recommended for phase 1); or (B) one partner key plus an agent header, which
  touches auth on the hot path.
- **D3. Callback trigger set and threshold.**
- **D4. Phase 1 scope** (draft below).
- **D5. Surfaces.** Do credit branches appear in slip-front-end and slip-admin, and
  how do package-only jobs skip them? Affected jobs: daily digest, quota alert,
  package expiry mail, revenue reports.
- **D6. Concurrent spending policy:** reserve funds before the bank call, or allow a
  bounded overdraft. See addition 1 in the Claude review below. This applies to
  model 1. In model 3 it is only how many units of overshoot are acceptable, and
  model 2 has no limit to protect.
  - Michael's correction (SPAR-69): an overdraft is bounded by the number of
    requests in flight at once, not by one request, unless there is a concurrency
    cap per branch. An enforced floor brings back the lost-race case.
  - Whatever the policy, batch admission must check per item first. Today
    `EnqueueBatch` checks 1 unit for a whole batch
    (`internal/core/service/queue.go:197`, verified at `d567be9`).
- **D7. Repo and deployment topology.** Earth raised it on 2026-11-11; the discussion
  is in the SPAR-69 thread. **Decided 2026-11-11 (DEC-07): B, in the existing
  `SparqLab/agent-slip-api` repo**, as a standalone postpaid product. slip-system is
  not forked. Follow-ups this creates: update ADR-VS-0001; add the repo to
  `docs/VERIFYSLIP_PROJECT_CONTEXT.md`, the knowledge-base VerifySlip Project Map and
  the branch flow in `AGENTS.md`; open TASK-VS runs for its implementation. The
  options as they were discussed:
  - A: inside slip-api (Trevor's recommendation).
  - B: a new partner backend repo with its own service and database. It owns
    verification, idempotency, usage and billing, and the outbox. slip-system stays
    one repo with a separate partner deployment (recommended by Codex in Earth's
    chat, posted to SPAR-69 by Earth). Tommy (Codex runtime in Multica) also leans
    to B when the goal is separate release and data ownership, but notes that
    postpaid weakens the wallet-in-the-hot-path reason, that A and D keep reuse and
    operations advantages, and that D7 should be decided apart from the billing
    model. Michael (Claude runtime in Multica) picked no option, but says the team
    feature list is a separate product that fits B, and that B's main failure mode
    is verify-rule drift, which needs a shared golden test.
  - C: a new facade repo that calls slip-api.
  - D: the slip-api repo with a second binary `cmd/partner-api`, its own ECS service,
    and its own Postgres schema and goose table. The partner binary runs only the
    partner schema's migrations and none of the main binary's background jobs
    (Claude's middle option; ADR-VS-0001 allows more binaries on a concrete trigger
    such as distinct auth).
  - All three agree: do not fork slip-system. A separate deployment adds no KBank
    capacity, because the attempt budget is one Redis key per KBank host, at most
    1,200 per minute (slip-system `internal/repositories/bank_attempt_limiter.go:42`,
    identical at prod `171baeb` and local `2256c62`). A budget per tenant in
    slip-system would protect existing customers in every option. It does not exist
    today: the tenant from metadata keys only the result cache (Tommy, SPAR-69).
  - Earth's direction: the partner portal and admin front ends are separate. Claude
    suggested a partner section in slip-admin instead of a second admin; still open.
  - Deciding questions:
    1. Does the partner product keep Slip's verify rules (same bank, 8404, duplicate
       and receiver rules, only billing differs), or diverge into its own product?
    2. Is this one partner or a reseller program?
    3. Does the contract require separate data or an SLA?
  - Claude's updated view (2026-11-11): the team feature list answers question 2
    toward a separate product (own auth, merchants, pricing, bills, reports, admin,
    self sign-up), so B has more support than before. Its verify rules still match
    Slip's, receiver check included, so B needs Michael's golden test, a bank budget
    per tenant and an ADR update. D remains the cheaper option.
  - B departs from ADR-VS-0001 and needs an ADR update.
  - **Status 2026-11-11:** a teammate created the private repo
    `SparqLab/agent-slip-api` (GitHub `createdAt` 03:52 UTC; `main` only, 2 commits,
    head `14b4280`), and Earth cloned it to `agent-slip-api/`. It is a new codebase
    in the shape of option B, not a copy of slip-api. First look: "agent-slip-api
    first look" under Operator research notes. The SPAR-69 review round (same day)
    concluded it is not ready for real money; see "agent-slip-api review round".
    Earth then confirmed DEC-01..07 and authorized product documents in that repo;
    see "agent-slip-api documentation round".
- **D8. Timeout cost** (Michael, SPAR-69 Round 1): KBank bills results that we cut
  on timeout. Under per-use pricing that cost shows per call. Choose: we absorb it,
  the partner pays it, or a monthly reconciliation settles it.
- **D9. Onboarding gate for self sign-up** (from the team feature list): default
  deny until an admin sets the branch price, admin approval before keys are issued,
  or no self sign-up. Tied to Jason's question 2 (who signs up). **Partly decided
  (DEC-04):** default deny until a price is set. Admin approval before keys, and
  whether self sign-up stays, are still open.
- **D10. agent-slip-api outcome and protection policy** (from the SPAR-69 review
  round). **Decided 2026-11-11** by DEC-01, 02, 04, 05 and 06 (table above), except
  whether a price change applies at once or from an effective date. The questions as
  raised:
  1. Charging: keep slip-api's full charged/free rules, or change some on purpose
     (receiver mismatch, 8404, other rejected codes)?
  2. Duplicate bank calls: block only the same idempotency key, or also the same slip
     sent with a different key or with none?
  3. Unpriced branches: reject verify, or use an approved default price? Does a price
     change apply immediately or from the next period?
  4. Unpaid users: suspend automatically, by an admin, or by a credit limit?
  5. Billing period: monthly in Bangkok time, or another cycle?
  6. Bank capacity: give the agent product its own share of the bank budget, and at
     what level (product, user, merchant)?

## Risks

- **Hot path.** The fork lives in the verify path every customer uses. It needs tests
  for both modes and a load test before prod.
- **Package-only surfaces.** Branch overview, digests, alerts and revenue reports may
  break or mislead for credit branches.
- **Migrations.** They must be idempotent (replay on boot). Never build an index on a
  large table at boot.
- **IP allowlist.** A per-branch list must be updated in bulk when the partner
  changes its egress IPs.

## Draft phasing (`implementation_split` gate)

1. **Phase 1:**
   - partner key
   - create, list and get branch
   - `billing_mode=credit`
   - wallet charge
   - balance read
   - `source_system`
   - admin branch top-up
2. **Phase 2:** `allocate` / `reclaim`, callback outbox and events.
3. **Phase 3:** FE and admin views, reports by source.

This outline assumes billing model 1. Under models 2 and 3, usage recording and the
monthly invoice job replace the wallet charge, top-up and allocate/reclaim.

**Superseded 2026-11-11 by DEC-05 and DEC-07.** The phases above put prepaid credit
inside slip-api. The work now goes to agent-slip-api: its `PRD.md` (FR-01..10, release
criteria) and Michael's "before real money" list under Operator research notes are
the input for the implementation split. Tommy's postpaid phase order (team feature
list section) is the closest draft. The migration and rollback rules in the next
paragraph still apply.

Each phase is one TASK-VS run with migration, deploy order and rollback stated
(rule: schema change needs a migration). The default `billing_mode=package` preserves
the mode of existing branches; it does not make a code rollback safe for new credit
branches. Old code still requires a package. Rollback must stop new partner work,
handle in-flight work, preserve balances/ledgers/outbox, and state the interruption
to credit branches. Do not remove financial history as part of rollback.

## Operator research notes

### Planning review — Codex, 2026-11-10

This is a review of options, not an operator design decision. No design gate is
passed and no implementation is authorized by these notes. Customer identity and
negotiated price remain outside this public document.

**Operator confirmations from this chat:**

- "Branch" means an actual branch. Pricing was clarified on 2026-11-11 as per
  billable unit, with no per-request price cap; see principle 3 above.
- The partner is itself an Agent in our platform. Whether a downstream agent maps
  to a merchant, branch, or another external identifier is not yet confirmed.
- A real balance per branch versus a shared partner balance is still a customer
  question. Neither wallet model is approved. Lock contention is a sizing input,
  not a reason to choose the commercial ownership of money.
- Follow-up answered 2026-11-11: charge by total billable units, including a billed
  retry unit. This supersedes the 2026-11-10 open question about a flat per-request
  cap. Wallet ownership, insufficient-funds behavior and remaining gates stay open.

**Issues to resolve before the design decision:**

1. **Request identity and credentials.** Branch keys held only by the partner's
   backend satisfy "no keys for end customers" and reuse the current verify auth.
   A master partner key for management endpoints is a separate credential with
   explicit scopes. The one-key-plus-branch verify option remains open. A partner
   credential plus an arbitrary agent/branch ID must never authorize another
   partner's resources. One branch used by several products must retain one
   business identity, with product attribution per request.
2. **Funding and money conservation.** If branch wallets are chosen, user-wallet
   allocation/reclaim must debit one side and credit the other atomically, with
   paired ledger references and idempotency. Direct admin branch funding needs an
   explicit accounting/invoice rule; it must not create a second path for crediting
   the same payment. Confirm currency, precision and rounding before choosing
   NUMERIC(14,4); the current user wallet uses NUMERIC(12,2).
3. **Concurrent spending before bank calls.** A conditional final debit prevents a
   negative balance but does not reserve funds. Several requests can pass the
   pre-check, incur bank work, then lose the race to debit. Specify admission or
   reservation, settlement, release, and recovery of interrupted work before
   accepting the wallet design. Do not hold a database transaction open over the
   bank call. Verification persistence, final debit/ledger and a required balance
   outbox event must commit atomically; free outcomes must not consume funds.
4. **Reliable balance callbacks are part of customer acceptance.** Phase 1 as drafted
   is a pilot only; it does not deliver the complete request if callbacks wait for
   phase 2. Agree triggers first. Events need stable IDs, branch identity, committed
   balance and a monotonic per-wallet version so duplicates/out-of-order deliveries
   cannot overwrite a newer balance. Reuse HMAC mechanics, with durable delivery,
   retry/replay and reconciliation through the balance API. Callback failure must
   not undo a committed charge.
5. **Product attribution.** An allowlisted header validates a value but does not
   prove which product called. Choose between partner-asserted attribution and
   product-scoped credentials. Persist source into queue/batch jobs at intake,
   verification records, and monetary facts where applicable; a worker cannot
   recover the original HTTP header later. Wallet-ledger reports cover charged
   activity, not all free or failed attempts. Snapshot applied unit price and
   billable quantity on financial facts rather than reconstructing old charges
   from the partner's current price.
6. **Compatibility and phasing.** New insufficient-balance errors and optional
   balance headers are contract additions even when routes/request bodies stay the
   same. Verify both package and credit modes at every enabled entry point, plus
   queued work and account/branch disablement. Rich UI/reporting may be deferred,
   but correct handling or explicit filtering of credit branches in existing
   overview, expiry, alert, digest and revenue paths is needed before customer
   rollout. Do not present wallet money as package quota.

**Suggested next discussion order:** (1) partner/agent/merchant/branch mapping and
wallet owner; (2) pricing outcomes including VS-068; (3) keys and callback triggers;
(4) complete pilot versus customer-release acceptance, funding and rollback. Keep
the balance question open until the partner answers; do not create implementation
tasks merely to fill the current phase outline.

**Source checks for this review:** current clean slip-api `staging` checkout
`fc67804`; locally stored `origin/prod` points to `d567be9` (not fetched or runtime
verified in this review). Inspected `Verification.VerifyBank`, `bankRequestHash`
and `saveBankRecord` in `internal/core/service/verification.go`;
`SaveWithQuota`/`SaveBankNotFound` in `internal/repositories/verification.go`;
`AssertQuotaAvailable` in `internal/repositories/branch_package.go`; API-key
middleware; queue processing and webhook delivery; migrations 001/009; and the
pending TASK-VS-068 scope/decisions. TASK-VS-068 is planning evidence, not proof
that its behavior is implemented. No tests, load tests, migration or runtime
acceptance were run for this planning-only review.

### Planning review — Claude, 2026-11-11 (response to the Codex review)

This reviews options; it is not an operator decision, and no gate passes because of
it. Source: slip-api after `git fetch` on 2026-11-11. `origin/prod` is `d567be9` and
`origin/staging` is `fc67804`, and the files cited below are identical on both refs.
No tests or runtime checks were run.

**Codex issues confirmed in source:**

- **Issue 3 already happens in package mode.**
  - The order is: pre-check (`internal/core/service/verification.go:243`), then the
    bank call (`:267`), then the quota consume inside `SaveWithQuota`
    (`internal/repositories/verification.go:43`).
  - If quota runs out in between, `SaveWithQuota` returns `ErrQuotaExceeded` or
    `ErrInsufficientBalance`. The verification is not saved and the caller gets an
    error, although KBank may already have billed a 0000 result.
  - This is rare with large package quotas. It would be frequent with small
    per-branch balances that hover near zero.
- **Issue 2.** `users.credit_balance` is `NUMERIC(12,2)` with `CHECK (credit_balance
  >= 0)` (`migrations/001_users.sql:10,19`).
- **Issue 5.** Queued work is persisted in `verification_queue`
  (`migrations/029_verification_batches.sql:7`). `source_system` therefore needs a
  column there, written at intake.
- **Replay attribution.**
  - `bankRequestHash` covers sending bank, trans ref, test flag, quota action and
    channel, but not the source (`internal/core/service/verification.go:482`).
  - So a replay with the same idempotency key returns the original record and its
    original attribution by default.
  - Rejecting a conflicting source would need the source in the hash, or a
    separate check.
- **A user-wallet debit already runs inside verify.**
  - When a package's quota is exhausted, the verify transaction can auto-renew it:
    `consumeQuotaInTx` (`internal/repositories/branch_package.go:895`) calls
    `resetFromCatalog` (`:1341`).
  - `resetFromCatalog` calls `debitUserBalanceWithLedger` (`:1762`), a conditional
    `UPDATE users ... WHERE credit_balance >= $2` plus a credit-transaction ledger
    row.
  - This is a precedent for both D1 options. It is also an existing pattern a
    branch-wallet ledger can mirror.

**Conceded.** The D1 recommendation in the first draft rested on lock contention.
Codex is right that contention is a sizing input, not a commercial reason. D1 above
now points to the request text and to Q1 instead.

**Additions:**

1. **Bounded overdraft as an alternative to reservation (D6).**
   - Reservation needs hold rows, a release when the outcome is free, and a
     sweeper for holds left by crashed requests.
   - A bounded overdraft is simpler. Admit a request only while the balance is
     above zero, and let the final debit go below zero. The worst-case shortfall
     is requests in flight × max units × `P`, so it needs a concurrency cap per
     branch (corrected after Michael's SPAR-69 review; the first draft bounded it
     by one request).
   - It needs the operator to accept that a prepaid wallet can go slightly
     negative, and the partner to be told how a negative balance settles at the
     next top-up.
   - Either way, keep Codex's rules: no transaction held open over the bank call,
     and free outcomes consume nothing.
2. **Duplicate detection is per branch.**
   - Detection works per branch and channel: `rejectIfDuplicate`
     (`internal/core/service/verification.go:675`) calls `ExistsVerified(branchID,
     channel, sendingBank, transRef)`.
   - Keeping every product of one agent on one branch means a slip sent through
     one product and then another is a free duplicate. That is what "under the
     same agent" needs.
   - A mapping of one branch per product would charge the same slip twice and
     miss the duplicate, so reject that mapping.
   - The same slip at two different agents is verified and charged at both. That
     case is now Q8 for the partner.
3. **No agent or reseller entity exists in slip-api.**
   - A grep of `internal/` and `migrations/` on 2026-11-11 finds only the KYC
     juristic type `partnership`.
   - "The partner is an Agent" is business vocabulary. In code, the partner is
     one user plus one merchant.
   - Name new tables `partner_*`, never `agents`. Use "agent" in documents only
     for the partner's downstream customers.
4. **Precision depends on Q5 (VAT).**
   - If `P` includes VAT, the price before VAT needs more than two decimals, and
     `NUMERIC(12,2)` cannot store it exactly.
   - Choose the column precision and where rounding happens (per charge or per
     invoice) after Q5 is answered.
5. **The partner question block is paste-ready again.** The internal notes in Q2
   and Q5 moved below the block (this edit).

### Multica brainstorm — SPAR-69, opened 2026-11-11

- Earth opened Multica issue SPAR-69 for the squad AI Dev Team. Jason leads it.
- It collects ideas from three runtimes. Earth chose one agent per runtime on that
  day: Michael (Claude), Tommy (Codex) and Trevor (Cursor).
- It is brainstorm only. No gate passes because of it, and its participants must not
  edit this file.
- The conductor merges the results here after Earth reviews Jason's synthesis.

**Status, merged on Earth's request 2026-11-11:**

- Round 1 replies came from Michael (2026-11-10 18:08 UTC) and Trevor (18:12 UTC).
  Tommy never posted Round 1: Tommy's runtime lacked `MULTICA_TOKEN` and
  `MULTICA_CLI_PATH` until Earth fixed it around 05:09 UTC on 2026-11-11. So Jason
  never wrote the Round 1 summary, and Round 2 was not opened.
- Earth then raised the repo question (Trevor compared A, B, C; Codex's B was posted
  by Earth) and the team feature list (all three evaluated it; Jason summarized at
  05:13 UTC). Both are merged above: D7, and the team feature list section.
- Later that day: the agent-slip-api review round (06:32–06:45 UTC), Earth's
  DEC-01..07 (08:22 UTC) and a documentation round (to 08:51 UTC). All are merged
  below and under Operator decisions.

**Round 1 points not already covered elsewhere in this file** (agent claims at
`d567be9`; Claude verified only those marked "verified"):

- Michael (risk):
  - Batch admission checks 1 unit for the whole batch (`queue.go:197`, verified).
    A batch of 100 passes with 1 unit available, and the worker calls the bank for
    every item. Moved to D6.
  - Timeout cost: moved to D8.
  - A kill switch per partner that stops partner billing mode without a deploy;
    the rollback in the draft phasing needs a deploy of old code.
  - Daily reconciliation: ledger charges against charged units × price, and against
    the KBank bill.
  - A refund or dispute path: a credit-back row that references the verification
    id; never edit a balance directly.
  - Define what happens to queued jobs of a branch disabled while they wait;
    `FindByAPIKey` checks `status = 'active'` only at auth.
  - A rate limit or concurrency cap per branch, needed by D6 and to stop one agent
    from raising KBank latency for other customers.
  - Callback design: a monotonic version per wallet, callbacks as hints with the
    balance API as the source of truth, a dead letter for a long partner outage,
    `FOR UPDATE SKIP LOCKED` dispatch, and a coalesced latest-value row per branch
    if every charge triggers a callback.
  - `source_system`: keep the original attribution on replay and log a conflict,
    rather than return 409; store unknown values as `unknown` with an alert rather
    than reject them; never tie price or permission to a partner-asserted value.
  - IP allowlist inherited from the partner when a branch has none, so a partner
    egress change does not give every branch 403.
- Trevor (repo evidence):
  - `credit_transactions` cannot hold branch wallets: `user_id NOT NULL`,
    `NUMERIC(12,2)`, `CHECK (balance_after >= 0)`. The daily digest sums its debits,
    so pay-per-use rows there would distort the digest. A separate ledger keeps the
    digest unchanged.
  - Branch names are unique per user (`lower(name)`) and can be renamed, so they
    cannot be the idempotency key for creation; `external_ref` needs its own unique
    constraint and replay rule.
  - Duplicate detection is per branch and channel, so one slip sent through `api`
    and `line` on the same branch is charged twice.
  - One note on callback signing: S2 in `security-findings.local.md`.
  - `quota_low` mail starts from `branch_packages`, so branches without a package
    never trigger it; do not create fake packages for partner branches, and check
    the overview pages that assume every branch has one.
  - Key model C: a separate, hashed management key leaves the verify-key lookup
    (`FindByAPIKey`) unchanged.

### agent-slip-api first look — Claude, 2026-11-11

Read-only look at `SparqLab/agent-slip-api` `main` `14b4280` (fetched 2026-11-11;
51 files, one migration `001_init.sql`). This is planning input, not a code review
verdict. No tests were run. Code work in that repo needs its own TASK run.

**What it is.** A new Go service: own module `github.com/SparqLab/slip/agent-slip-api`,
own database (`POSTGRES_DB=agent_slip` in `.env.example`), goose migrations on boot
(`cmd/main.go:40`), and a direct gRPC call to slip-system
(`internal/adapters/slipsystemadt/client.go`). It follows the team feature list:
self sign-up with OTP, merchants, branches, API key rotate and revoke, branch bank
accounts with a receiver-check switch, verify by payload through the API, usage and
dashboard reports, admin price per branch, and a bill status per user. There is no
Dockerfile, workflow or task definition yet, so nothing can deploy over slip-api's
ECS services.

**Where it matches the plan:**

- Billing model 2 (postpaid). `branches.slip_price NUMERIC(12,4)`, and each
  verification row stores `unit_price` and `charged` in the same insert, so the usage
  fact is atomic with the result and the applied price is snapshotted (Codex
  issue 5). Usage sums `unit_price` over charged rows.
- Duplicate scope is per branch, bank and trans ref (unique index
  `verifications_branch_slip`); idempotency is a unique index per branch and key.
- Merchants and branches are soft-deleted; OTPs are hashed with an attempt count;
  admin price changes write an action log.

**Blocker:**

- **Verify fails against the real slip-system.** `VerifyBankSlip` in slip-system
  rejects a call without `x-merchant-id` or `idempotency-key` gRPC metadata with
  `InvalidArgument` (`internal/handler/grpc/bank.go`, same rule on slip-system
  `main` `d5a8a5f`, `staging` `35c5942` and `prod` `171baeb`). agent-slip-api sends
  no metadata at all (`client.go` `Verify`). Corrected after the SPAR-69 review: no
  per-tenant bank budget exists today. The attempt limiter keys on the bank
  hostname, and slip-system uses the tenant only for its result cache. Send the
  merchant ID resolved by auth, as slip-api does; splitting bank capacity by product
  is a separate slip-system design.

**Differences from slip-api that need a decision, not a silent port:**

- Receiver mismatch is free (`charged = false`); slip-api charges it, and KBank still
  bills us for that 0000 result.
- Bank code 8404 falls into `rejected` and is free. slip-api also classifies 8404 as
  rejected, but charges it under the TASK-VS-063 per-slip rule: the first 8404 is
  charged; within 24 h of that charge a repeat is free, unless it comes less than
  30 s after the previous 8404; and a verified result inside the 24 h window is free
  (`internal/models/bank_not_found.go:32 @ d567be9`; corrected 2026-11-11, this line
  earlier said a repeat inside 30 s was free). Only `0000`/`0` count as verified in both repos.
- Other rejected codes (expired, invalid data) are free here; slip-api charges them,
  because `saveBankRecord` falls through to `SaveWithQuota`
  (slip-api `internal/core/service/verification.go:376 @ d567be9`).
- Cost side: KBank bills only `statusCode=0000` (KBank, 2026-11-04;
  `runs/TASK-VS-059/task.md:101`). Not charging 8404 or rejected codes means less
  revenue than slip-api, not a loss. Receiver mismatch is the only outcome where we
  pay KBank and collect nothing.
- `charged` is a boolean, so a request can never cost more than one unit. Principle 3
  (charged billable units, including retry units under TASK-VS-068) cannot be
  expressed yet.
- No idempotency lock around the bank call. Two concurrent requests with the same key,
  or the same slip, both reach the bank; the unique indexes stop the double charge
  but not the double bank cost. slip-api takes `AcquireIdempotencyLock` first.

**Risks already named in this file, now visible in code:**

- New branches start at `slip_price = 0`, so they verify for free until an admin sets
  a price (D9, Michael's default-deny point).
- Key storage and the missing IP allowlist: S3 in `security-findings.local.md`.
- `users.bill_status` is one `unpaid|paid` flag per user, not a bill per period, so it
  cannot say which month is paid (Tommy, Trevor).
- Not present, consistent with the team list but still open against the partner
  request (Jason's question 3): `source_system`, `external_ref`, server-to-server
  branch creation (create is a JWT user route), and any balance callback.
- Tests: only `internal/handler/router/router_test.go`. Nothing covers charging,
  bank-code classification or receiver matching, which is where Michael's shared
  golden test would sit.

**Housekeeping if this repo is the chosen path:** add it to
`docs/VERIFYSLIP_PROJECT_CONTEXT.md`, the knowledge-base VerifySlip Project Map and
the `main` → `staging` → `prod` branch flow in `AGENTS.md`; update ADR-VS-0001; open
a TASK-VS run for its implementation under the `implementation_split` gate.

### agent-slip-api review round — SPAR-69, 2026-11-11

Earth asked Michael, Tommy and Trevor (06:32 UTC) to re-check the first look above
against `agent-slip-api` `14b4280`, slip-api `d567be9` and slip-system `171baeb`.
All three replied, and Jason summarized at 06:45 UTC. Michael and Trevor posted
before reading the others; Tommy saw part of the other replies first. Source review
only: no tests, no `EXPLAIN`, no runtime evidence.

**Jason's conclusion:** not ready for real money. Making verify reach the connector
is only part of the work; it does not make charging or billing ready.

**Confirmed by all three:** the metadata blocker, the check-then-insert race before
the bank call, `charged` as a boolean, new branches priced at 0, key storage and the
missing IP allowlist (S3), one `bill_status` flag per user, and tests limited to
`router_test.go`. The corrections to Claude's first look (bank budget, 8404, other
rejected codes, KBank cost) are already applied in the section above.

**New findings** ("verified" marks a claim Claude checked in code):

- **Deleting a branch removes its unpaid usage from the user wallet** (Michael;
  verified). `BranchUsage` filters `b.deleted_at IS NULL`
  (`internal/repositories/verification.go:198 @ 14b4280`). Deleting a merchant
  cascades to its branches. Billing must sum charge facts per user, whatever happens
  to the branch.
- **Three access-control and configuration findings** (Michael, Tommy; verified):
  S4 suspension enforcement, S5 test and live separation, S6 secret configuration, in
  `security-findings.local.md`. DEC-03 and "before real money" items 3 and 7 below
  cover them.
- **Slip identity differs between the duplicate check and the insert** (Trevor;
  verified). The pre-check uses the bank codes from the payload; the record stores
  the codes from the bank response when present; both compare exactly, without
  `lower()` (`internal/repositories/verification.go:93 @ 14b4280`). A mismatch sends
  the duplicate to the bank again before the unique index rejects it.
- **Branch lookup aggregates `verifications` on every API call** (Michael; SQL
  verified, plan not). `branchSelect` joins a `GROUP BY branch_id` subquery over the
  whole table (`internal/repositories/branch.go:18-31 @ 14b4280`), and
  `FindByAPIKey` uses it. Run `EXPLAIN` before concluding it scans the table.

**Further findings, not verified by Claude:**

- Receiver matching is looser than slip-api's (Michael): S7 in
  `security-findings.local.md`.
- The adapter creates a new `RqUid`/`RqDt` per call while slip-system includes them
  in its request digest, so a retry with the same idempotency key can hit a conflict
  instead of a replay. Separate the logical request, the bank attempt and the
  transport retry (Tommy).
- slip-api sends `idempotency-key` as the client key plus `:` plus the request ID
  (`attemptIdempotencyKey`); the connector scopes keys per merchant, so two branches
  of one merchant must not send the same raw key (Trevor, Tommy).
- All slip-system errors become one 502, losing rate-limit, conflict and deadline
  distinctions (Tommy).
- A not-found result stays replayable under its key forever; slip-api releases a
  not-found key and limits 8404 replay (Tommy).
- A failed readback after a successful insert returns an error although the charge
  fact was saved (Tommy). A failed insert after the bank answered returns 500, and
  the client's retry pays KBank again (Michael).
- The price is read after the bank call; "no price set" and "approved price 0" need
  different states (Tommy).
- Minor: merchant delete runs two statements outside a transaction; rate limits (S8 in
  `security-findings.local.md`); no retention policy for stored slip data; `statusCodeOr`
  always returns its fallback (Michael, Trevor).
- Not a problem: `test=true` reaches slip-system's mock bank, not KBank (Michael).

**Before real money** (Michael's minimum list, which Jason's summary follows):

1. Send the gRPC metadata and take an idempotency lock before the bank call.
2. Bill totals that survive branch deletion, and immutable bill periods.
3. API key auth that checks user and merchant, and a way to suspend unpaid users.
4. Reject verify for branches without a set price.
5. Take usage out of the branch lookup on the hot path.
6. Reuse slip-api's receiver-check rules with their tests.
7. A startup guard for secrets.
8. Tests for charging (free and charged outcomes, replay, price changes, branch
   deletion) and a golden test shared with slip-api.
9. Deploy order against slip-system's shared bank budget.

Tommy's sizing, relative only: the metadata, identity and error-mapping fix is small
and needs no proto or migration change; local idempotency, test isolation and retry
semantics are medium; charging parity with billable units is medium to large;
collectable postpaid billing is its own scope. Decisions raised: D10 under Operator
decisions.

### agent-slip-api documentation round — SPAR-69, 2026-11-11

After confirming DEC-01..07 (08:22 UTC), Earth authorized product documents in
agent-slip-api, and nothing else: no runtime, migration or deploy change.

- **Files.** Written in the working tree of `agent-slip-api` on top of `14b4280`;
  committed later (see the end of this section).
  - `PRD.md`: DEC-01..07, FR-01..10 with acceptance evidence, the charging matrix,
    open operating parameters and release criteria.
  - `ARCHITECTURE.md`: today's source baseline against the target flow, bank metadata
    and attempt identity, bounded credit exposure, the invoice model, recovery and
    known gaps.
  - `DESIGN_SYSTEM.md`: proposed tokens and Thai terms; no frontend or brand approval.
  - `AGENTS.md`: product invariants, write boundaries, migration and test rules.
  - `README.md`: links to the four files (+11 lines).
- **Review.** Trevor, Tommy and Michael each reviewed the first snapshot. Tommy merged
  the findings (+85/−23 lines). Michael checked that and raised R1 and r1–r3. Tommy
  added them (+37/−3), and Michael closed all four at document level. DEC-01..07 did
  not change. No tests ran; the agents checked the counts by tracing source.
- **Final snapshot** (SHA-256 matches Tommy's last report; Claude checked the files on
  2026-11-11): PRD `e7711515…`, ARCHITECTURE `3f86516c…`, DESIGN_SYSTEM `be941ad8…`,
  AGENTS `da4bb655…`.

**Main additions from the reviews:**

- Charging matrix per slip-api (Trevor):
  - Other rejected codes that reach the save fallback are charged one unit.
  - A failed receiver lookup creates no result and no charge, so the caller can retry.
  - 8404 has two clocks: 24 h from `charged_at`, and 30 s from `last_seen_at`, which a
    free observation also moves.
- Source correction (Tommy, confirmed by Michael; Claude verified at slip-api
  `d567be9`): 404/4040 do not use the 8404 bound-key replay.
  - `not_found` clears its idempotency key when saved
    (`internal/core/service/verification.go:288`).
  - The bound-key replay under 30 s applies to 8404 only (`:411`).
  - 404/4040 reuse a recent free result through a separate cooldown: `recentNotFound`
    (`:766`), default 30 s (`configs/config.go:54`), off when the value is ≤ 0.
- Replay of a completed result is separate from admission of new spending (Tommy, P1).
  A caller that lost the response can recover it after its credit fills up; revoked
  credentials stay denied.
- Credit admission is tied to a durable admission identity from the first transaction
  (Tommy). Proposed states: reserved and not sent, sent with an unknown outcome,
  settled or released. Unknown work is never released only because time passed.
- Exposure is outstanding invoice debt plus charged but unbilled usage plus
  unresolved commitments, and no fact sits in two of these (Tommy). Issuing an
  invoice moves usage between them without changing the total.
- The migration must not turn a legacy zero price into an approved zero, or invent
  price snapshots for old rows (Tommy).
- Security and money-UI items (Michael) are listed as open decisions, not chosen:
  - admin provisioning, and MFA or dual approval for money actions
  - IP allowlist and key storage
  - limits on sending OTPs
  - a "receiver not checked" state
  - the formula for remaining credit
  - payload retention, separate from financial records

**Decisions Jason asked Earth for (08:51 UTC):** fixture totals are bank calls and
charges, not baht.

1. **R1: a request waiting on the same slip when the first one ends with 8404.**
   - A: the waiter shares the first result (1 call, 1 charge). Jason recommends A.
   - B: it runs as a new attempt under slip-api's rule (2 calls, 2 charges).
   - Either way, a new request that arrives after the first has finished is charged
     again (Michael's note 1).
2. **404/4040 cooldown.** Jason recommends starting at slip-api's 30 s. Still to
   decide: whether 0 (off) is allowed.
3. **Admitted work that provably never reached the bank, when the user is suspended.**
   - Cancel and release the commitment once (0 calls, 0 charges). Jason recommends
     this.
   - Or let it finish (grandfather), which can create a charge after suspension.
   - In both cases, work that may have been sent goes through recovery.

Claude's view (2026-11-11): agree with all three. On R1, DEC-02 already says to block
duplicate bank work for the same slip whatever the key. B would queue the second
request but still call the bank and charge for it, which defeats DEC-02. A is the
reading consistent with it.

**Still open after this round.** These come from `PRD.md`; the agents chose none of
them:

- read and replay rights while suspended
- invoice attribution (admission or settlement time) and cut-off
- D8, and how long unknown work holds credit
- the security profile
- operating values: price, credit limit, due date, grace, override length, caps,
  rounding and tax, retention
- the original request's scope: callback, `source_system`, management API and partner
  operator roles

**Committed 2026-11-11** on Earth's go-ahead: commit `1ec4013` on local branch
`docs/product-docs-dec-01-07` of agent-slip-api, parent `14b4280`, five files (+445
lines). The committed files hash to the final snapshot above. No code, migration or
dependency change.

- Second commit `495be6f` changes `AGENTS.md` only (+2/−2). The team mainly runs
  Cursor and Codex (Earth, 2026-11-11), so it now works in a plain clone: tool and
  workspace references apply only where they exist, with no fixed AWS profile name.
  It also states that Earth owns the product decisions.
- Pushed and opened as
  [SparqLab/agent-slip-api#1](https://github.com/SparqLab/agent-slip-api/pull/1)
  into `main`. The repository has no CI and no branch protection. Prefer a merge
  commit, which keeps the SHAs cited here.
- Earth decides the merge. At 14:59 UTC Earth removed the review request to the
  repository creator and assigned the PR to Earth. Earth also edited the opening
  line of the decision-review comment posted at 14:56 UTC.
- Third commit `29eeac4` records the DEC-02 case list and the answers to Jason's
  three questions (see Operator decisions).
- Fourth commit `9f5f4df` adds SECURITY.md, TESTING.md and a draft CODE-STYLE.md
  (+202/−2, with links from README and AGENTS).
  - SPAR-69, 15:12–15:16 UTC: Earth asked whether these three files fit. Tommy
    recommended SECURITY.md first and TESTING.md second, and CODE-STYLE.md short
    and only once the team has real conventions. Jason agreed. They gave advice
    only and wrote no files.
  - Earth then asked Claude to write SECURITY.md and TESTING.md, and to draft
    CODE-STYLE.md for the team to complete.
  - Every current-source line cited in the new files was checked at `29eeac4`.
  - `go test ./...`, `go test -race ./...`, `GOWORK=off go build -mod=readonly ./...`
    and `go vet ./...` pass, and `gofmt -l .` lists nothing. The build used the
    sibling `slip-contracts` at `f3d9eb3`.
  - The vulnerability reporting channel in SECURITY.md is pending Earth.
- Fifth commit `996c087` applies the SPAR-69 review (15:34–15:37 UTC) of the new
  files; Claude checked every finding against the source.
  - SECURITY.md (Michael): the startup guard must not treat an unset `APP_ENV` as
    development (`APP_ENV` defaults to `development`). Failed password logins are
    not limited for users or admins.
  - New Audit row: audit writes are best-effort and key revocation and branch
    deletion write none. Michael also listed key rotation as unaudited; it is
    audited, best-effort, at `merchant.go:154`.
  - The branch key can also read results through `GET /v1/slips/{ref_id}`. The
    admin seed does not rotate an existing password. Receiver matching is now
    described from source, UI masking is marked pending, and incident steps cover a
    compromised admin.
  - TESTING.md (Trevor): case 11 moves out of the parity suite; boundary sides,
    units of 0 or 1, parity cases with channel `api`, the router test and the
    security suites are corrected.
  - PRD case 1 now notes that 404/4040 clear the key and 8404 keeps it for 30 s.
  - Earth's answers to Jason's two questions (2026-11-11): the startup-guard method
    is left to engineering, as long as an unset `APP_ENV` does not count as
    development. Restricting the admin API to a private network is not decided and
    stays pending in SECURITY.md.
- Sixth commit `dbc291c` records DEC-08 (per-branch quota) and the DEC-05 change
  (optional credit limit) across all six documents; see Operator decisions.
- Seventh commit `41aabe4`: a branch with no quota set is blocked until the
  account sets one. Claude posted the sixth and seventh commits to SPAR-69 on Earth's
  request (2026-11-11 17:02 UTC), as information only, with no new review round.
- Eighth commit `e4cc079` (2026-11-12): no batch verify and no result webhook in
  the first release (see Operator decisions).
- Ninth commit `a7c98cb` (2026-11-12): billing callbacks built in advance as FR-12,
  off by default and enabled per account, with the outbox in ARCHITECTURE,
  callback controls in SECURITY and a callback suite in TESTING. Claude posted the
  eighth and ninth commits to SPAR-69 on Earth's request (17:34 UTC), as
  information only.
- Tenth commit `9eee8e7` applies the SPAR-69 review (17:37–17:45 UTC) of the
  sixth to ninth commits. Claude checked the findings against the docs and
  slip-api `d567be9`. One error was Claude's own: the sixth commit left the payment
  sentence under the Branch quota bullet instead of Credit exposure.
  - Quota: available = max(0, total − used − reserved), with the shortfall shown.
    Reservation is per logical operation; zero-price billable outcomes consume,
    free outcomes release, unknown outcomes keep their unit. An older PUT replayed
    after a newer one is not applied. The management key is scoped to one account.
    Quota used is reconciled with charged units.
  - Docs: the ARCHITECTURE footer that called the outbox optional is fixed, and
    FR-12 is separated from unresolved scope and from the first-release test gate.
    Migration keeps unset, zero and unlimited apart and never backfills a quota to
    avoid the block. SECURITY gains management-key and unlimited-credit rows, plus
    callback destination checks on every send and signatures over timestamp and
    event ID.
  - Earth's answers (2026-11-12, all as recommended):
    1. The owner (portal) and admins can set quotas too.
    2. The owner issues, rotates and revokes the management key, and an admin can
       revoke it.
    3. Unlimited credit needs a per-user cap first.
    4. Lowering a quota cancels provably unsent work it no longer covers.
  - Still open: callback threshold and re-arming, callback URL authority and
    signing secret, FR-12 enable/disable handling, the unusual-usage alert, and IP
    limits for the management key.
  - Posted to SPAR-69 on Earth's request (18:31 UTC), as information only.
- **Merged 2026-11-11 19:23 UTC** on Earth's go-ahead: PR #1 merged into `main` with
  a merge commit, `462dc18` (parents `14b4280` and `9eee8e7`), so every SHA cited
  above stays valid. No CI exists, and no reviewer approved; Earth decided. The
  branch `docs/product-docs-dec-01-07` is kept. The local checkout is back on `main`
  at `462dc18`. The open items above remain pending in the documents.
- **PR #2 (2026-11-12), `MIGRATIONS.md`:** Earth asked whether to add
  DATA-MODEL, SCHEMA, MIGRATIONS and RLS-POLICIES documents. Claude recommended
  MIGRATIONS.md only:
  - DATA-MODEL: ARCHITECTURE's conceptual records cover it until the target model
    is designed.
  - SCHEMA: the SQL files are the source of truth.
  - RLS: the service enforces ownership in queries (for example
    `internal/repositories/branch.go:95`) and has no row-level security.
  - Commit `56719ff` on branch `docs/migrations-guide`, opened as
    [SparqLab/agent-slip-api#2](https://github.com/SparqLab/agent-slip-api/pull/2).
    It adds MIGRATIONS.md (+45) with links from README and AGENTS.
  - Facts it relies on, checked in source: goose runs at boot before the listener
    (`cmd/main.go:40`, `:108`), with a session lock (`migrations/run.go:28`), and
    `001_init.sql`'s Down section drops every table (`:187`).
  - **Merged 2026-11-12 02:31 UTC** by Earth: merge commit `640eac0`, which
    includes the `cca5aff` fix below. No review on GitHub.
  - A teammate then pushed `5304565` straight to `main` (no PR). It marks
    `CODE-STYLE.md` "structure locked" (package layout and call direction; the
    other conventions stay open) and updates `AGENTS.md` and `README.md` to match.
  - Claude posted the PR #1 merge and PR #2 to SPAR-69 on Earth's request
    (20:15 UTC), as information only. The post corrected Jason's 18:36 UTC reply,
    which still described PR #1 as unmerged.
  - Review finding P2 (2026-11-12; Earth pasted it into the session; it is not on
    GitHub or SPAR-69): rule 3 offered `CREATE INDEX CONCURRENTLY` in a
    `NO TRANSACTION` file as a way to keep boot fast. That is wrong:
    `provider.Up()` (`migrations/run.go:36`) returns only after every statement
    has finished, and it runs before the listener. Fixed in `cca5aff`:
    - Rule 3: build a large index by hand before the deploy, check `indisvalid`,
      and keep `CONCURRENTLY IF NOT EXISTS` in the migration file.
    - Rule 4: `IF NOT EXISTS` skips an invalid index.
    - Other instances wait on the goose lock (5 s x 60, goose v3.24.3 defaults)
      and then exit (`cmd/main.go:41`).
    - The slip-api example was also wrong. The 12 verify timeouts came from the
      hand pre-build in busy hours, not from a boot build (TASK-VS-055
      decision-memo section 8). The example now cites that memo.
    - PR body updated.
    - Claude posted a correction to SPAR-69 on Earth's request (21:42 UTC,
      same thread as the 20:15 UTC post), as information only. It covers why
      the old rule 3 was wrong, what `cca5aff` changed, and the corrected
      slip-api example.
- **Knowledge capture (2026-11-12, Earth's request):** knowledge-base notes
  `10 Projects/VerifySlip/Agent Slip API — Postpaid Partner Product (TASK-VS-069).md`
  and the lesson `40 Lessons/CREATE INDEX CONCURRENTLY Does Not Keep A Boot
  Migration Fast — Pre-Build By Hand And Check indisvalid.md`. The VerifySlip
  Project Map now lists agent-slip-api, which is the knowledge-base part of the
  D7 follow-ups. The `knowledge_closeout` gate stays pending until the run closes.

## Sources

- slip-api `origin/prod` `d567be9`: the files and lines cited above, plus migrations
  001, 002, 006, 008, 009, 011, 012, 021 and 045.
- knowledge-base `10 Projects/VerifySlip/Branch Quota History Cursor Page — 2026-10-26.md`
  (the no-index rule on hot tables).
- knowledge-base `10 Projects/VerifySlip/Credit Top-Up Flow And Admin Top-Up Tracing.md`.
- TASK-VS-063 (8404 rule) and TASK-VS-068 (retry +1, open).
- agent-slip-api `main` `14b4280`, and its documents commit `1ec4013` on branch
  `docs/product-docs-dec-01-07` (snapshot hashes in "agent-slip-api documentation
  round").
- Multica SPAR-69 comments of 2026-11-11, including Earth's DEC-01..07 (08:22 UTC)
  and Jason's questions (08:51 UTC).
