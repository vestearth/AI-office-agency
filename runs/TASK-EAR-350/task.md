# TASK-EAR-350: Restore the Gift fulfillment snapshot in Admin Tracking

## Type
bugfix

## Workstream
backend / frontend

## Priority
high — the operator cannot tell which redemption has a shipping address or an
email recipient, and may update a legacy row that cannot send tracking mail.

## Created
2026-09-11

## Parent
TASK-EAR-314 (Gift fulfillment snapshot), TASK-EAR-316 (Gift tracking email).
TASK-EAR-348/349 harden the mail transport but do not repair this response or
display defect.

## Goal
Manage → Redemption → Tracking must show the immutable shipping address and
contact email captured when that exact Gift row was redeemed, matching the
values Order will use when a tracking number is updated.

## Verified finding
- The Order repository selects `uri.shipping_address` and `uri.contact_email`
  into `models.UserRedemptionItem` for the redeemers list and for updated rows.
- `adminUserRedemptionItemToPB` in
  `Games-Labs-Order/internal/core/handlers/adminorderhdl/adminorderhdl.go` omits
  both `ShippingAddress` and `ContactEmail`. The public mapper already includes
  them. Therefore the admin API discards valid DB values before the gateway.
- Backoffice already reads `shippingAddress`, but its Email column comes from
  `identityFor(row.userId).email`, the current account email. It drops
  `contactEmail`, even though tracking mail uses the redeem-time contact email.
- A read-only staging query for `test Gift` found two rows, oldest first: the
  2026-09-04 09:17:59Z row has neither snapshot field; the
  2026-09-07 10:19:14Z row has both. The current modal renders Address as an
  em-dash for both, proving the response/display mismatch without exposing the
  personal values.
- `UpdateRedemptionTracking` commits the tracking number, reloads the same row,
  and `sendGiftTrackingMail` sends only when its stored `ContactEmail` is
  non-empty. A legacy row still updates tracking but logs
  `gift_tracking_mail_skipped reason=no_contact_email`.
- Android `main` at `8bc5cd6` is read-only for AI agents and currently has a
  separate wiring gap: its Gift form validates address/email, but the live
  request DTO contains only `userId` and `idempotencyKey`. The staging row with
  a snapshot does not prove which APK/path created it; capture this as a mobile
  handoff and do not claim provenance without an APK build identifier.
- SocratiCode was attempted against both canonical roots but the index was not
  usable (`Full index in progress`, 0/0); the finding above was reverified from
  current repository source and staging DB evidence.

## Scope

### A. Order admin response — `Games-Labs-Order`
- Extend the existing `adminUserRedemptionItemToPB` mapper to copy
  `ShippingAddress` and `ContactEmail` into `orderpb.UserRedemptionItem`.
- Add focused regression assertions for both
  `ListRedemptionItemRedeemers` and `UpdateRedemptionTracking`, because both use
  this mapper.
- Reuse the existing shared-lib fields. No proto, gateway, migration, model, or
  dependency change.
- Start from current `staging` on a fresh `task/TASK-EAR-350` branch; do not add
  this fix to the unrelated `task/TASK-EAR-348-349` branch.

### B. Accurate Backoffice recipient display — `Games-Labs-backoffice`
- Preserve the existing Tracking modal and column layout.
- Map `contactEmail` into the local redeemer row.
- For a Gift redemption with a captured snapshot, the Email column must show
  that `contactEmail`, because it is the recipient used by Order tracking mail.
- For a legacy row whose `contactEmail` is empty, render an em-dash rather than
  the account email. The account email is not a delivery fallback in
  `sendGiftTrackingMail`, so displaying it would falsely imply mail can send.
- Keep account username and phone resolution unchanged.
- Add focused mapping/rendering coverage for a populated snapshot and a legacy
  empty snapshot.

### C. Read-only mobile handoff
- Record the Android source locations where `giftAddress`/`giftEmail` are lost
  before the request and request the tester's APK version/commit identifier.
- Do not modify, format, commit, push, or open a PR in `Games-Lab-Android`.
- Do not attribute the populated staging row to Android until the APK/build and
  request payload are observed.

## Out of scope
- SMTP envelope/header hardening and Secrets Manager migration
  (TASK-EAR-348/349).
- New or changed protobuf fields, gateway routes, database columns, or
  migrations.
- Changing email templates or the best-effort delivery policy.
- Backfilling missing snapshots on legacy rows.
- Any write to `Games-Lab-Android`.
- Merge, deployment, secret changes, or a real email send without a separate
  operator instruction.

## Acceptance criteria
- Admin redeemers-list JSON returns `shippingAddress` and `contactEmail` for a
  model containing them, using the existing lower-camel JSON contract.
- Admin tracking-update response preserves the same two fields.
- Backoffice shows the captured address and actual tracking recipient for a
  populated Gift row.
- Backoffice shows em-dashes for both fields on a legacy row with no snapshot;
  it does not substitute the profile email.
- Focused Order tests are observed failing before the mapper change and passing
  after it; focused Backoffice tests do the same for mapping/rendering.
- Existing Order admin handler/service tests and the relevant Backoffice suite
  pass; builds are run in both changed repositories before review.
- Authenticated staging acceptance, after separately approved deployment:
  the newer `test Gift` row displays its stored snapshot, the older row remains
  empty, and updating the newer row produces one
  `gift_tracking_mail_sent` event. Mailbox receipt remains a separate external
  delivery check.
- A mobile handoff names the current source mismatch and requests APK/build
  provenance; Android remains unmodified.

## Dependencies and risks
- No shared-lib publication is required: fields 20/21 already exist in
  `orderpb.UserRedemptionItem` and the gateway already emits lower-camel names.
- The two repositories have different PR targets: Order targets `staging`;
  Backoffice targets `main`. Verify each target before opening a PR.
- Deploy the Order response fix before judging the Backoffice display on
  staging; otherwise the UI will correctly receive empty fields from the old
  backend.
- Do not use the visible profile email as proof of tracking-mail eligibility.
  Eligibility is the stored redemption `contact_email`.

## Verification and release plan
1. Implement and verify the minimal Order mapper/test change.
2. Implement and verify the minimal Backoffice mapping/rendering change.
3. Review both diffs and preserve the existing API contract.
4. Open separate PRs to the verified target branches only when authorized.
5. After approved merge/deploy, perform the bounded authenticated staging check
   above; do not broaden it to production.

