# TASK-KAS-001 — AGENTS.md consistency across the Casper repos

## Goal

Make the Casper repos give Claude (and any agent) the same baseline contract the
slipNext-* / VerifySlip repos already have, so behavior is consistent across repos.

## Context

Review compared `casperacc` / `casperacc-api` AGENTS.md against
`slipNext-api` / `slipNext-system` / `VerifySlip`. Findings:

- `casperacc-api` (a real Go payments/accounts backend) had **no AGENTS.md**.
- `casperacc/AGENTS.md` did not declare the `KAS` task prefix (registered in
  `ai-dev-office/office.team.yaml`) and did not opt out of the Games Labs
  platform mandates the way the slipNext repos do — even though Casper is a
  standalone product.

## Changes (docs only)

- **Added** `casperacc-api/AGENTS.md` — standalone-product exclusion of Games
  Labs mandates; `KAS` prefix; hexagonal ports/adapters seam rule; vendor-behind-
  adapter rule; money-as-state + audit; callbacks/webhooks must verify + be
  idempotent; secrets/PII; JWT/CORS/rate-limit; forward-only migrations; GitOps
  deploy; Go verification commands.
- **Patched** `casperacc/AGENTS.md` — added standalone + Games Labs exclusion to
  the intro and a `## Task` section declaring the `KAS` prefix. Existing UI rules
  unchanged.

## Acceptance

- Both Casper repos carry an AGENTS.md whose skeleton matches the slipNext-* /
  VerifySlip pattern (inheritance + explicit exclusions + TASK prefix + domain
  rules).
- Domain rules differ by repo type (frontend vs payments backend) by design.

## Follow-ups

- `TASK-KAS-002` — fix the hexagonal seam violation this review surfaced
  (`internal/core/services/payment.go` importing `internal/adapters/ubit`).
- `casperacc/README.md` is still the default Nuxt starter template, not a Casper
  README (not addressed here).
