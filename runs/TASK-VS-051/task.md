# TASK-VS-051: VerifySlip documentation authority

Operator decision, 2026-10-26: accepted ADR-VS-0001 retains historical
rationale; the versioned VerifySlip Project Map owns current-design guidance;
slip-doc becomes a pointer. No new docs repository, ADR rewrite, runtime change
or deployment.

Scope: knowledge-base Project Map and Review Queue; slip-doc/STRUCTURE.md;
slip-api/AGENTS.md and slip-system/AGENTS.md on isolated docs task branches.
Acceptance: one current-design authority, historical material qualified,
source pointers updated, vault links and git diff checks pass. Backend AGENTS
publication is via docs PRs to main, respecting unrelated operator branches.

## Publication and validation — 2026-10-26

slip-api#101 merged main at 101c77f8fab63c5402aa3028b7f95d2203910b29;
slip-system#17 merged main at 8c5f29a83c21e5e33401005b61f630f75d959722.
Both PR targets/files/merge states verified with gh pr view. Each changed only
AGENTS.md. Docs review passed (knowledge-reviews/20261026T075716Z-verifyslip-documentation-authority.yaml).
Vault link/stale-date check and git diff --check passed; three unrelated
source warnings remain. Local KB and slip-doc edits are uncommitted; no
backend source or deployment changed.
