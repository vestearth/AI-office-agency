# Knowledge finding closure — implementation spec

Status: decision-complete 2026-10-15 (map: [knowledge-finding-closure-map.md](knowledge-finding-closure-map.md)).
Owner: conductor; `ai-dev-office` is a meta repo, so no TASK run is required.
This spec decides; it does not implement.

## Destination

Open Librarian findings reach closure on a weekly cadence without a dashboard
write path, so the open count (275 on 2026-10-14) stops growing.

## Why (evidence, 2026-10-14)

- 229 of 275 open findings already carry a `proposed_patch`; 161 of those are
  evidence-confirmed. The blocker is applying, not re-checking (I1).
- No apply tool exists. The only machine path is an audit in
  `approved_scope_auto_write`, authorized for Games Labs only
  (`knowledge-base/knowledge-librarian-policy.yaml`); 205 of 275 open findings
  sit inside that scope (I2).
- `knowledge-reviews/` is gitignored: audits live only on this Mac, so the
  runtime must be this Mac (I2, I3).
- The workflow already says "weekly"; no weekly run has ever happened (I3).

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Re-check runs use `approved_scope_auto_write` inside the Games Labs scope: apply the existing `proposed_patch` when evidence is still `confirmed`; record applied + resolved per policy (factual closes, product/architecture stays open). Outside the scope stays proposal-only → human hand-edit via the dashboard brief. Partial/conflicted evidence is never auto-applied. | Uses authority granted 2026-07-15, covers 3/4 of the backlog, no new tool or policy change. |
| D2 | A weekly Claude desktop scheduled task dispatches the `knowledge-librarian` subagent (Claude lane), saved in a permission mode that lets auto-write proceed. | Runs on this Mac, adapter installed, notifies the session, run history in the Runs pane. |
| D3 | Scope comes from `GET /api/knowledge-reviews/findings/brief`, the same rule as the dashboard button; the task never picks its own scope and fails loudly if the server is down. | One rule, unit-tested, shared by humans and the task. |
| D4 | Human-decision findings are excluded from automation and shown as "needs your decision". Never suppressed for being stale. | Policy forbids machine closure; stops wasting the run budget. |
| D5 | One run/week, ≤5 notes / 15 findings, confirmed-only apply. Signals: open count, ">30d not re-checked" count, per-run audit outcome. Review after 4 runs; a flat count means stale patches → revisit D1/scope, not more runs. Kill switch: disable the task; vault reverts via git. | Weekly Review can keep up with ≤15 applied edits. |

## V1 scope (in order)

1. **Server — brief endpoint.** `GET /api/knowledge-reviews/findings/brief?audience=task|human`
   in `dashboard/server`: move `buildRecheckBrief` (currently
   `dashboard/client/src/views/knowledge/openFindings.ts`) server-side with
   tests; the client button calls it. `audience=task` additionally restricts
   to the Games Labs policy scope (reuse the `path_pattern`s from
   `knowledge-librarian-policy.yaml`, never a second copy of the paths),
   `evidence_state: confirmed` first, and excludes human-decision findings.
   Response: text brief plus the structured list (note, fingerprints,
   review ids). Cap 5 notes / 15 findings.
2. **Server + client — human-decision rule.** Classification lives in
   `buildOpenFindings`: `recommendedAction == append_review_queue` AND
   (`fingerprint` contains `human-decision` OR `closure_criteria` starts with
   "A human" / contains "human-approved"). Expose `needsHumanDecision` on
   `KnowledgeOpenFinding` (the raw `closure_criteria` must be carried into
   the finding type for this; it is a contracted field). Open findings tab:
   a "needs your decision N" chip and badge. Document the rule in
   `dashboard/README.md`.
3. **Workflow — re-check run section** in
   `workflows/knowledge-librarian.md`: the weekly re-check run takes its scope
   from the brief endpoint, runs in `approved_scope_auto_write` for the
   Games Labs scope only, applies only confirmed-evidence patches, records
   every outcome per fingerprint (`resolved` with answer + closure evidence +
   `closed_at`, else `recurring` with why), writes the audit as
   `knowledge-reviews/<ts>-weekly-recheck.yaml`, validates it, never commits.
   Note that the Weekly Review checks the audit's applied changes.
4. **Scheduled task** (`create_scheduled_task`): `knowledge-weekly-recheck`,
   cron `0 9 * * 1` local. Self-contained prompt: fetch the brief from
   `http://localhost:4310/api/knowledge-reviews/findings/brief?audience=task`
   (abort and report if unreachable), dispatch the `knowledge-librarian`
   subagent with that scope and the workflow section above, run
   `ruby scripts/validate-knowledge-librarian.rb` on the audit, and report
   applied / resolved / recurring counts. Enable only after steps 1–3 land.
5. **Weekly Review** note in `knowledge-base`: add a line to check the latest
   `weekly-recheck` audit's applied changes (post_write review is already the
   policy; this makes the artifact findable).

## Out of V1

- Dashboard close/suppress buttons (operator chose read-only, 2026-10-14).
- Widening the auto-write policy to other products (C under D1): revisit
  after four runs show a falling open count.
- Changing the Librarian output schema; promoting shared knowledge.
- Committing `knowledge-reviews/` (stays gitignored; local-only is accepted).

## Acceptance

- `GET …/findings/brief?audience=task` returns ≤5 notes / ≤15 findings, all
  inside the Games Labs scope, none `needsHumanDecision`, confirmed evidence
  first; unit tests cover the cap, scope filter, and exclusion.
- Open findings shows the "needs your decision" count (8 on 2026-10-14).
- One manual run of the scheduled task produces a validated
  `weekly-recheck` audit with ≥1 applied change and the dashboard's open
  count drops by that run's resolved count.
- After 4 weekly runs: open count below 275 and ">30d" count below 222,
  or the D5 review is held.

## Risks

- Stale `proposed_patch` text applied verbatim: mitigated by confirmed-only
  apply and the 15/run cap; the Weekly Review is the backstop.
- Scheduled task runs with broad permissions on this Mac: scope is one
  subagent, one audit file, vault edits inside the policy allowlist; disable
  the task to stop.
- The dashboard server must be running at 09:00 Monday; a down server fails
  the run visibly (notification), it does not silently skip.
- `Review Queue.md` (41 open) will dominate the first runs by rule.
