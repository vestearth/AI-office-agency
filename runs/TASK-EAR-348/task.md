# TASK-EAR-348: Harden SMTP_FROM handling in the Order mailer — a display name works on Gmail only by accident

## Type
bugfix (config + hardening)

## Workstream
backend / devops

## Status
CLOSED done 2026-09-12. Shipped as Order PR #66 (b5f603c), live in staging
task definition :86. SMTP_FROM is now the bare address xpinext@sparqlab.co —
NOT the name-plus-address form scope A proposed, so recipients see no display
name. Two gift_tracking_mail_sent events observed (09:15:39Z QA, 09:27:43Z
operator). Mailbox receipt is operator-attested. Scope C is satisfied.

## Priority
low — NOT blocking. CORRECTION 2026-09-11: the operator pointed out that mail is
already going out, and CloudWatch confirms it: `link_voucher_mail_sent` on
2026-09-09 08:08Z and 2026-09-10 02:59Z through this exact mailer and this
exact `SMTP_FROM`. Gmail accepts the malformed `MAIL FROM` and rewrites the
sender to the authenticated account (`xpinext@sparqlab.co`). The earlier
"Gmail answers 5.5.2, nothing sends" claim in this run was wrong — it was
read from `net/smtp` source, never observed. This run is now optional
hardening; the operator may close it as won't-fix.

## Created
2026-09-11

## Parent
TASK-EAR-315 (Order-owned SMTP mailer), TASK-EAR-316 (Gift tracking + Link
e-voucher emails), TASK-EAR-314 (redeem-time contact_email snapshot).

## Finding (verified 2026-09-11, read-only)
- Order staging runs task definition `games-labs-order-staging:84`
  (image `staging-sha-50911f6`). Its environment carries
  `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=xpinext@sparqlab.co`,
  and `SMTP_FROM="Xpinext Notification System"` — a display name with spaces and
  no `@`.
- The mailer (`Games-Labs-Order/infrastructures/mail_smtp.go`, `Send`) passes
  `cfg.From` verbatim as the envelope sender to `smtp.SendMail` AND as the
  `From:` header. `net/smtp` only rejects CR/LF in that value, so the client
  emits `MAIL FROM:<Xpinext Notification System>`. Gmail tolerates this for
  an authenticated session and substitutes the account address; two
  `link_voucher_mail_sent` events prove delivery works TODAY. Any other SMTP
  relay (SES, Postmark, a company MTA) would reject it, so the value is
  provider-coupled, not broken.
- `Configured()` only checks Host and From are non-empty, so the boot log says
  "Redemption mailer configured (addr=smtp.gmail.com:587); Gift tracking emails
  enabled" (seen every boot since 2026-09-08 04:23Z) — the misconfiguration is
  invisible until a send is attempted.
- CloudWatch `/ecs/games-labs-order-staging`, 14 days, paginated: zero
  `gift_tracking_mail_*` events (Gift path never exercised) but two
  `link_voucher_mail_sent` events (Link path works). Same mailer, same
  config, so the Gift path is expected to send too once a row with a
  `contact_email` gets a tracking number.
- The values come from the GitHub **environment** secrets `staging` /
  `production` on `SparqLab/Games-Labs-Order` (both environments list all five
  `SMTP_*`); `.github/workflows/staging.yml` renders them into `ecs/env.names`.
  Repo-level `gh secret list` does not show them.
- Prod task definition currently renders `SMTP_FROM=""` and `SMTP_HOST=""`
  (mailer unconfigured, sends skipped with `email_not_configured`). Fix the
  production secret too so the next prod train does not repeat the defect.

## Goal
Make `SMTP_FROM` provider-independent: the envelope sender is always a bare
address, the display name lives only in the `From:` header, and a value that
does not parse fails loudly at boot. Delivery already works on Gmail; this
removes the dependency on Gmail's leniency and makes the recipient see
"Xpinext Notification System <xpinext@sparqlab.co>" instead of whatever Gmail
substitutes.

## Scope
**A. Config (operator or devops, no code, AFTER scope B):** set environment
secret `SMTP_FROM` on `staging` and `production` to RFC 5322 form
`Xpinext Notification System <xpinext@sparqlab.co>`. Do this only after B
lands — today that whole string would go into `MAIL FROM` too, and it is
unproven whether Gmail tolerates angle brackets inside angle brackets.
Changing the value before B is a risk with no benefit.

**B. Hardening (`Games-Labs-Order`, `infrastructures/mail_smtp.go`):**
- Parse `cfg.From` with `net/mail.ParseAddress` once. Use `addr.Address` as the
  envelope sender in `smtp.SendMail`, and `addr.String()` for the `From:`
  header, so a display name is allowed in the header but never in the envelope.
- `Configured()` must return false (and `cmd/main.go`'s boot log must say why)
  when `SMTP_FROM` does not parse as an address. Fail loud at boot, not at send.
- Keep backward compatibility: a bare address must still work unchanged.
- Redeploy staging (merge to `staging` triggers the ECS deploy) so the new
  secret value is rendered into a fresh task definition — editing the secret
  alone does not touch the running task.

**C. Runtime acceptance (staging):** redeem one Gift item with a test
`contact_email`, enter a tracking number in Manage → Redemption → Tracking,
press Update, and read `/ecs/games-labs-order-staging` for
`gift_tracking_mail_sent user_redemption_item_id=<id>`. The mailbox receiving
"Your gift is on its way" with the display name intact is the final proof.
This Gift-path check is worth doing even if the operator closes the rest of
the run, since it has never been observed. Note the two rows on the
tracking page today have no address snapshot (redeemed before TASK-EAR-314)
and will always log `skipped reason=no_contact_email`; do not use them.

## Out of scope
- Prod deploy. Fix the production secret value now; the mailer goes live on
  prod only with the next prod train (cost-gated, operator approval).
- Moving `SMTP_PASSWORD` out of plaintext task-definition environment into
  Secrets Manager. Split out as TASK-EAR-349 — the Gmail app password is readable by
  anyone with `ecs:DescribeTaskDefinition` today.
- Email content/templates (product copy is TASK-EAR-316's).

## Acceptance criteria
- `SMTP_FROM` on both GitHub environments is in name-plus-address form once B
  ships; the rendered staging task definition shows it.
- Unit test seen RED then GREEN: `Send` with `From: "Some Name"` (no address)
  is refused before dialing; `From: "Name <a@b.test>"` dials with envelope
  sender `a@b.test` and header `From: "Name" <a@b.test>`. Existing tests in
  `infrastructures/mail_smtp_test.go` keep passing.
- Boot log on staging reads "Redemption mailer configured" only when the
  address parses; otherwise it names the bad `SMTP_FROM`.
- One real `gift_tracking_mail_sent` event observed on staging with the
  message received in the test mailbox.

## Traps
- Test integrity rule: do not weaken `mail_smtp_test.go` fixtures to pass.
- `ecs/env.names` non-string crash trap: keep the variable a string; never
  remove it from `env.names` or the workflow.
- Secret edits do not redeploy. A green "secret updated" is not evidence; the
  task-definition revision number and its rendered env are.
