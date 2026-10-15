# TASK-VS-027: Admin verification COUNT timeout after production revision 89

Priority: P2. Owner: debugger (Codex conductor). Follow-up to TASK-VS-026.

## Problem and evidence

At 14:20:32 Bangkok on 2026-10-15, production returned HTTP 500 after
10,001 ms for GET /v1/admin/verifications. The paired handler error is
`count verifications: count verifications: timeout: context deadline exceeded`.
This occurred after production revision 89 (d35af57) rolled out and warmed
successfully, outside VS-026's original 14:07–14:16 acceptance window.
VS-026 ev-066/067 retain the bounded runtime output. Two ERROR lines represent
one failed request; they must not be counted as two failures.

The operator supplied page context https://admin.up-slip.com/?view=slips&tab=kbank.
This identifies a page, not the failed API query or its filters. Current frontend
SlipsHub lazy-mounts each visited tab; a fresh KBANK mount calls bank-flow summary
and transfers, not the general verification list. A previously visited history tab
can remain mounted, but no evidence yet ties that lifecycle to this failure.

## Scope and decision point

- Inspect slip-api reports service, repository COUNT and HTTP logging, plus
  slip-admin SlipsHub, SlipsManage, KbankFlowSummary and other list callers.
- First identify the failing request shape and execution path: cached closed days
  plus live tail, direct filtered COUNT, or cold/busy fallback. None is yet proven.
- If logs cannot distinguish those paths, add the smallest bounded diagnostic
  fields: allowlisted filter shape, count path/fallback reason and phase duration,
  correlated by request_id. Do not log raw query strings, search text, names,
  accounts, tokens or customer payloads. Existing shared-store and tenant semantics
  remain authoritative.
- Select a minimal behavior fix only after source/runtime evidence or a focused
  reproducer establishes the defect. Apply decision-grilling to material choices
  discoverable evidence cannot resolve. Do not guess an index or increase timeout.

## Acceptance

1. Identify a reproducible failing COUNT shape, or deploy bounded diagnostics that
   make the next occurrence distinguishable; diagnostics alone are partial and do
   not close this bugfix task.
2. Focused regression reproduces the established defect before the fix and passes
   after it. Preserve exact totals, statuses, inclusive dates, all-history meaning,
   tenant/channel isolation and cache cold/busy behavior.
3. Relevant tests, readonly build and race checks pass on the reviewed commit.
4. Follow slip-* development flow: latest main -> implementation PR to main ->
   staging promotion and authenticated acceptance. Production promotion, if taken,
   must have its own declared gates and recorded authorization.
5. Final runtime verification names the request filters, deployed revision and a
   bounded observation window. Healthy ECS alone or absence of errors in an
   unrelated window does not prove the failing path is fixed.

## Deferred / excluded

No new transfer/daily fix is justified by the current post-deploy sample. No bank
retries, billing/status changes, manual data repairs, load tests, new infrastructure
or unrelated cleanup. Production EXPLAIN ANALYZE, if later necessary, requires an
explicit bounded read-only plan and disclosure of its read load.

## Current status

Task opened for investigation; application code and runtime configuration are
unchanged in this follow-up. Initial findings and locked decisions are in
investigation.md. Unknown filters are a diagnostic gap, not a reason to stop
independent source investigation. Existing deployment gates remain pending.
