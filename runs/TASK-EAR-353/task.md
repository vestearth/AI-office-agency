# TASK-EAR-353 — Responsive redemption emails and tracking correction

## Type

feature

## Workstream

backend

## Priority

high

## Created

2026-09-14

## Parent / related work

- Parent: TASK-EAR-316 (Link voucher and Gift tracking email delivery)
- Related: TASK-EAR-350 (Gift fulfillment snapshot restored in Admin Tracking)
- TASK-EAR-349 is independent SMTP secret hardening and is not a dependency.

## Goal

Replace the current plain-text redemption notifications with responsive,
email-client-safe XPINEXT templates for:

1. successful Link e-voucher redemption;
2. the first successfully emailed Gift tracking number; and
3. a corrected Gift tracking number after a different number was previously
   emailed successfully.

The templates must match the operator-provided Figma desktop/mobile direction
while preserving the existing post-commit, best-effort and send-once behavior.

Design reference:
<https://www.figma.com/design/cxXNS6dw3I77fPnwl03HR5/BackOffice--GAMESLAB?node-id=8416-103901>

## Current source evidence

- `Games-Labs-Order/infrastructures/mail_smtp.go` sends one
  `text/plain; charset=UTF-8` body through `net/smtp`.
- `internal/core/services/ordersvc/service.go::sendLinkVoucherMail` sends a
  plain voucher link after the redeem transaction commits.
- `service.go::sendGiftTrackingMail` sends a plain tracking number after the
  tracking write commits and uses a per-number claim.
- `internal/models/redemption.go::UserRedemptionItem` already carries the
  redemption id, user id, link/code, item/brand names, thumbnail/logo URLs,
  redeemed/valid/shipped timestamps, tracking number and contact email.
- Order does not carry a username on the redemption row. Its existing
  `UserAdapter` is backed by `USER_API_URL`; the User service's current
  `GET /users/{id}` response contains `username`.
- `tracking_email_sent_for` is the only current record of the tracking number
  claimed/sent. `ReleaseTrackingEmailClaim` currently resets it to empty, so
  correction rendering requires the claim to return and restore the prior
  successful state atomically on SMTP failure.
- Backoffice copy and the approved design currently name Thailand Post; no
  carrier field exists on the redemption contract.

## Locked product decisions (operator, 2026-09-14)

- Greeting is `Dear {{username}}`.
- Username lookup is read-only and best-effort. On lookup failure or blank
  username, render `Dear Customer`; never fail redeem/tracking for identity.
- Do not trust a username supplied by Backoffice/mobile for email rendering.
- Carrier is configurable with default `Thailand Post`; no carrier schema or
  Backoffice field is added in this task.
- A correction email is sent only for a distinct non-empty tracking number
  when another tracking number was previously emailed successfully. Clearing
  tracking sends no email.
- E-voucher details use Redeemed Date and Expiry Date, not Shipped Date.
- Copy is English. Dates use `DD MMM YYYY` in `Asia/Bangkok`.
- Footer links without configured real URLs are omitted; placeholders are
  never sent.
- Static branding assets must use stable public HTTPS locations (or another
  email-safe stable mechanism), never expiring Figma URLs.

## Committed scope

### Mail transport and rendering

- Extend the existing Order-owned Mailer message shape to carry subject,
  plain-text body and HTML body.
- Build standards-compliant `multipart/alternative` UTF-8 MIME while retaining
  the current envelope/from parsing and CR/LF header-injection protection.
- Use Go `html/template`; all dynamic text is escaped and CTA/image URLs are
  restricted to safe public HTTP(S) values.
- Use email-safe tables and inline CSS, approximately 600 px desktop with a
  375 px mobile layout. Critical link/tracking information must remain visible
  when remote images are disabled.

### Templates

- Link e-voucher success: username greeting, voucher CTA, item/brand imagery,
  redemption id, gift name, redeemed date and expiry date.
- Gift tracking: username greeting, current tracking number, configured
  carrier, item image, redemption id, gift name, redeemed date and shipped
  date.
- Tracking correction: apology copy, new tracking number, previously emailed
  tracking number marked as replaced, carrier and the same redemption details.
- Share one XPINEXT header/footer and responsive foundation across all three
  templates without creating a general-purpose templating framework.

### Username and tracking state

- Extend the existing User adapter boundary with a bounded username lookup
  against the current User read endpoint; errors log a reason and fall back to
  `Customer`.
- Make the tracking-email claim return the prior sent number/timestamp
  atomically. Template selection is based on that prior successfully emailed
  number, not merely the previous value typed in Backoffice.
- If SMTP delivery fails, restore the prior claim state so a retry still knows
  whether it is an initial or correction email.

### Configuration

- Add non-secret configuration for carrier, timezone, branding assets,
  support details, Play Store URL and social URLs only where required.
- Empty optional support/social URLs hide their UI. Do not add placeholder
  phone numbers, contact addresses or URLs.

## Out of scope

- Games-Lab-Android changes; it remains read-only.
- Carrier database/API fields or a carrier picker in Backoffice.
- New User/shared-lib contracts unless source verification proves the existing
  supported read path cannot supply username; stop and split that dependency
  rather than widening this task silently.
- Marketing campaign tooling, unsubscribe management, SMS or push messages.
- TASK-EAR-349 Secrets Manager migration.
- Production deployment, production ECS scale-up or production RDS activity.

## Acceptance criteria

- Every notification contains both a text/plain and text/html alternative and
  has valid MIME boundaries and UTF-8 headers.
- Gmail desktop and mobile previews match the supplied design structure:
  XPINEXT header, headline/greeting, highlighted link or tracking number,
  item/details section and responsive footer.
- A Link redeem sends the e-voucher template once and an idempotent replay does
  not resend it.
- The first non-empty Gift tracking number sends the normal tracking template
  once; the same number does not resend.
- A later distinct number sends the correction template once and shows the
  exact prior successfully emailed number as the replaced number.
- Clearing tracking sends no email.
- Forced SMTP failure restores the previous claim number/timestamp; retry uses
  the correct initial/correction template.
- A successful username lookup renders `Dear <escaped username>`; timeout,
  error or empty username renders `Dear Customer` and does not fail the
  business operation.
- Missing optional footer URLs omit their elements; no placeholder content or
  expiring Figma URL appears in generated mail.
- Dynamic HTML is escaped, unsafe link schemes are rejected/omitted, and the
  tracking/voucher value remains available in plain text.
- Existing focused and integration mail tests are updated rather than removed;
  `GOWORK=off go test ./...`, `GOWORK=off go build -mod=readonly ./...`,
  `git diff --check`, and the AI Dev Office YAML validator pass.

## Verification and release plan

1. Add renderer golden/fragment tests for all three templates at desktop and
   mobile widths, including escaping, missing assets and footer omission.
2. Extend the fake SMTP test to parse and assert multipart/alternative MIME,
   plain/HTML parity and sanitized headers.
3. Add service tests for username success/fallback and initial/correction/
   duplicate/clear/failure-retry behavior.
4. Add PostgreSQL integration coverage for atomic previous-claim capture and
   restoration.
5. Render local `.eml` fixtures and inspect in Gmail-compatible desktop/mobile
   previews against the Figma reference.
6. After review, deploy only to staging and perform controlled mailbox
   acceptance using dedicated QA data. Mail submission logs and mailbox receipt
   are recorded as separate evidence.

## Risks and mitigations

- **Email client CSS differences:** use table layout, inline CSS, real fallback
  fonts and visual preview evidence.
- **Remote images blocked or unavailable:** keep every critical value as text,
  supply alt text and omit invalid URLs.
- **Username service latency/failure:** bounded lookup plus non-blocking
  `Customer` fallback.
- **Correction history lost during retry:** atomically capture and restore the
  previous claim state, with repository integration tests.
- **Duplicate mail:** retain and strengthen the existing conditional claim
  semantics; never move mail before the business transaction commits.

## Assignment

- Next agent: `dev-2`
- Parallel: false; transport, renderer and tracking claim share the same Order
  service paths and must land coherently.
- Estimated complexity: medium-high.
