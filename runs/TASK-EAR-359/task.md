# TASK-EAR-359 — Replace XPINEXT redemption banner asset

## Type

asset correction / visual follow-up

## Parent

- Parent: TASK-EAR-358
- Source PR: Games-Labs-Order #71, merged to `staging`

## Goal

Replace the embedded XPINEXT banner in the three Order redemption-email
variants with the newly supplied 2048×294 PNG, whose colour treatment matches
the operator's intended design.

## Scope

- Replace only `xpinext-email-banner.png` and its exact-asset test hash.
- Preserve the existing CID identifier, 640px layout, Google Play badge,
  MIME assembly, transport, and redemption/tracking behaviour.

## Acceptance criteria

- All three redemption-email variants embed the new supplied banner through
  the existing `xpinext-banner@gameslabs.app` CID.
- The rendered header remains full-width at the 640px email canvas.
- Focused renderer tests, full Go tests, readonly build, and diff checks pass.

## Out of scope

- Auth templates, real SMTP sends, mailbox acceptance, configuration,
  deployment, production, and `Games-Lab-Android`.
