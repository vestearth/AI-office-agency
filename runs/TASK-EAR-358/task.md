# TASK-EAR-358 — Embed approved XPINEXT email assets

## Type

feature / visual follow-up

## Parent

- Parent: TASK-EAR-354
- Source PR: Games-Labs-Order #70, merged to `staging`

## Goal

Use the two operator-supplied PNGs as the exact XPINEXT redemption-email banner
and Google Play badge. Deliver them as CID inline images so recipients do not
depend on a new public CDN URL.

## Scope

- `Games-Labs-Order` redemption-email renderer, Order-owned mail message/MIME
  transport, the two supplied assets, and focused tests.
- Preserve the existing plain-text fallback, redemption/tracking semantics,
  configured Play Store destination URL, URL safety, and responsive layout.

## Acceptance criteria

- The 2048×294 supplied XPINEXT banner renders edge-to-edge at the 640px email
  canvas width with meaningful alt text.
- When a safe Play Store URL is configured, the supplied 304×82 badge renders
  at 152×41 CSS pixels and remains the link target.
- Both images are emitted as standards-compliant CID MIME parts; no new CDN,
  dependency, or production URL is invented.
- Missing/blocked image display leaves useful alt text and the plain-text email
  remains usable.
- Focused renderer/MIME tests, full Go tests, readonly build, formatting, and
  diff checks pass.

## Out of scope

- Auth emails, social icons, SMTP delivery/mailbox acceptance, deployment,
  runtime configuration changes, production, and `Games-Lab-Android`.
