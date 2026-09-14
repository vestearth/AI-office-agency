# TASK-EAR-354 — Redemption email visual polish follow-up

## Type

feature / visual follow-up

## Parent

- Parent: TASK-EAR-353
- Source PR: Games-Labs-Order #69, merged to `staging`

## Goal

Polish the three Order redemption email templates so the committed HTML follows
the operator-provided XPINEXT desktop/mobile Figma screenshots more closely:

1. Link e-voucher redemption success;
2. first physical-gift tracking notification; and
3. corrected tracking notification.

## Locked decisions

- Keep the existing multipart text/HTML transport, username greeting with
  `Customer` fallback, Thailand Post default, Asia/Bangkok dates, URL safety,
  and tracking correction/claim semantics unchanged.
- Reuse the existing renderer; do not introduce a general email framework or a
  dependency.
- Use table/inline CSS compatible with common email clients and a responsive
  desktop-to-mobile details layout.
- Reuse only exact approved assets already present in the workspace or supplied
  by Figma. Do not redraw the XPINEXT logo or social icons. Optional assets and
  footer/contact values remain hidden when no safe public source is configured.
- Preview with sample data only. Do not send real email, mutate staging, deploy,
  or edit Games-Lab-Android.
- After this task is reviewed, open a separate task for the Auth/account-status
  email designs; those are not part of this Order PR.

## Source evidence

- `Games-Labs-Order/internal/core/services/ordersvc/redemption_email.go` owns
  the shared template and all three variants.
- The current template is one compact HTML string with stacked image/details,
  oversized mobile headings, a text-only header fallback, and optional footer
  blocks.
- The supplied Figma screenshots show a narrower centered desktop canvas,
  image/details columns on desktop, stacked content on mobile, compact type and
  spacing, a branded gradient header, and a structured footer.
- Figma live context currently requires connector reauthentication. The
  operator-supplied screenshots and rendered source preview are the active
  design evidence for this follow-up.

## Acceptance criteria

- Desktop preview uses a centered email canvas and places item imagery beside
  redemption details when imagery exists.
- Mobile preview stacks the image/details content without horizontal overflow;
  headings, pills, padding, and body copy remain readable at 375-390 px.
- Voucher, initial tracking, and correction retain their distinct subject/copy
  and data fields; voucher does not render carrier fields.
- Remote images are optional: XPINEXT text fallback and critical voucher or
  tracking values remain visible when images are unavailable.
- Optional brand, Play Store, contact and social elements render only from safe
  configured values; no placeholder production values are invented.
- Focused renderer tests, full `go test ./...`, readonly build, diff check, and
  browser-rendered desktop/mobile previews pass.

## Out of scope

- SMTP delivery/mailbox acceptance; tester owns the real-send pass.
- Auth reset/password-changed email templates.
- User suspended/deactivated/deleted notification behavior.
- CI/CD, ECS configuration, deployment, production, or Android changes.

