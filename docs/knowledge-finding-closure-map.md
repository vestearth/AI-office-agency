# Knowledge finding closure — decision map

Wayfinding map (ai-skills `decision-wayfinding`). Problem state, not a ledger:
verified, reusable outcomes go to their owning docs when this map is complete.

Context (2026-10-14, from `GET /api/knowledge-reviews/findings` and every audit
detail): 623 distinct finding fingerprints, 275 still open (latest audit says
`new`/`recurring`). Open count by date: 73 (07-31) → 144 → 187 → 233 → 269 →
275 (10-14). Of 348 closed, 292 closed inside the audit that found them; only
56 were closed by a later audit. 203 open findings were reported once and
never re-checked; 132 not looked at for 60+ days. The workflow already says
"run weekly, or on demand" (`workflows/knowledge-librarian.md:13`), but no
scheduled run exists. Of the 275 open: evidence `confirmed` 187, `partial` 79;
recommended action `update_note` 184, `no_change` 46, `append_review_queue` 35.

```yaml
destination:
  outcome: >-
    Decide how open Librarian findings reach closure on a regular cadence —
    who applies proposed vault edits, what re-checks them, and on what
    trigger — so the open count stops growing, ending in an
    implementation-ready spec.
  done_when:
    - "Every decision on the V1 path is resolved or explicitly deferred"
    - "No fog item blocks a V1 decision"
    - "The spec names the trigger, the runtime, the scope rule, and the apply path"
  v1_boundary: >-
    In: closure path for proposal-only findings, a recurring re-check run, and
    its scope rule. Out: dashboard write actions (kept read-only), changing the
    Librarian output schema, promoting shared knowledge.
  status: confirmed
  confirmed_by: "operator (chat), 2026-10-14"

nodes:
  - id: I1
    type: investigation
    title: "What blocks closure for each open finding: an unapplied vault edit, a missing re-check, or a human product/architecture decision?"
    status: resolved
    depends_on: []
    resolved_at: 2026-10-14
    outcome: >-
      Of 275 open: 229 need a vault edit and already carry a proposed_patch
      (prose edit instructions, median ~500 chars; 161 evidence-confirmed, 60
      partial, 7 conflicted); 46 are no_change watch items whose closure
      usually reads "human applies or rejects the existing proposal"; 8 are
      human product/architecture decisions (append_review_queue). 205 of 275
      sit inside the Games Labs auto-write scope. 11 already have an applied
      change but were never re-checked. Review Queue.md holds 41 (32 with a
      patch). So the dominant blocker is an unapplied edit, not a missing
      re-check.
    evidence: ["knowledge-reviews/*.yaml (323 files, contracted fields only: status, recommended_action, proposed_patch, closure_criteria, evidence_state)", "knowledge-base/knowledge-librarian-policy.yaml scope paths"]
  - id: I2
    type: investigation
    title: "What apply path exists today for proposal-only patches, and which products does knowledge-base/AGENTS.md already authorize for auto-write?"
    status: resolved
    depends_on: []
    resolved_at: 2026-10-14
    outcome: >-
      No apply tool or script exists; a proposal is applied only when a human
      edits the vault by hand. The only machine path is an audit run in
      approved_scope_auto_write (87 applied changes, all from the 40 games_labs
      audits; 281 of 321 audits ran proposal_only). Authorized scope:
      games_labs only (knowledge-librarian-policy.yaml: Games Labs project
      notes, 20 Flows, Review Queue, new ADR-GL-* Proposed), post_write review
      in Weekly Review; factual questions may auto-close on confirmed evidence,
      product/architecture questions stay open. knowledge-reviews/ is
      gitignored (0 tracked): audits exist only on this Mac. knowledge-base
      commits go straight to main and the vault is clean.
    evidence: ["knowledge-base/AGENTS.md (Approved Automated Write Exception)", "knowledge-base/knowledge-librarian-policy.yaml", "ai-dev-office/.gitignore:42", "scripts/ has no apply tool"]
  - id: I3
    type: investigation
    title: "Which runtimes can run the Librarian unattended with the local repos and write access to ai-dev-office/knowledge-reviews, given the Librarian never commits or pushes?"
    status: resolved
    depends_on: []
    resolved_at: 2026-10-14
    outcome: >-
      Because audits are local-only, the runtime must be this Mac. Three
      options have local repo access: (a) a Claude desktop scheduled task
      (cron in local time, runs while the app is open or on next launch, can
      dispatch the knowledge-librarian subagent, notifies the creating
      session); (b) `claude -p` headless under launchd/cron (the operator
      already runs launchd agents); (c) `codex exec` headless (policy: Codex
      librarian = GPT-6 Luna High). No scheduled task exists today; every
      audit so far was session-closeout driven (82/109/111 per month
      Jul-Sep, 20 in Oct), never a weekly run.
    evidence: ["mcp scheduled-tasks: list empty; create_scheduled_task contract", "claude 2.1.285 -p, codex-cli 0.157.1 exec", "~/Library/LaunchAgents", "knowledge-reviews/ file dates", "workflows/knowledge-librarian.md model profile"]
  - id: D1
    type: decision
    title: "How do findings that need a vault edit get it applied?"
    status: resolved
    depends_on: [I1, I2]
    resolved_at: 2026-10-14
    outcome: >-
      Re-check runs operate in approved_scope_auto_write inside the already
      authorized Games Labs scope: apply the existing proposed_patch when
      evidence is still confirmed, record applied + resolved per policy
      (factual closes; product/architecture stays open), post_write review in
      Weekly Review. Findings outside the scope (70 of 275) stay proposal-only
      and go to the human hand-edit queue via the dashboard brief. No new
      apply tool; no policy change yet. Partial/conflicted evidence (67) is
      never auto-applied. Per-run cap decided in D5. Option C (widen the
      policy to other products) deferred until A shows a trend.
    evidence: ["I1", "I2", "knowledge-base/knowledge-librarian-policy.yaml", "operator choice A (chat), 2026-10-14"]

  - id: D2
    type: decision
    title: "What triggers re-check runs, and on which runtime?"
    status: resolved
    depends_on: [I3]
    resolved_at: 2026-10-14
    outcome: >-
      A weekly Claude desktop scheduled task (local-time cron; runs while the
      app is open, else on next launch) dispatches the knowledge-librarian
      subagent in the Claude lane. Saved in the creating session's permission
      mode so auto-write does not wait on approval; the prompt must be
      self-contained. launchd + claude -p and codex exec remain fallbacks.
    evidence: ["I3", "operator choice A (chat), 2026-10-14"]

  - id: D3
    type: decision
    title: "How does an unattended run choose its scope (reuse the dashboard brief rule server-side, or let the Librarian select)?"
    status: resolved
    depends_on: [D2]
    resolved_at: 2026-10-15
    outcome: >-
      The brief rule moves server-side as GET /api/knowledge-reviews/findings/brief
      (worst priority, then longest since an audit; cap 5 notes / 15 findings;
      Games Labs scope and confirmed evidence first) and the scheduled task
      fetches it as its scope. One rule for humans and the task, unit-tested.
      If the dashboard server is down the run fails loudly and reports;
      the Librarian never guesses a scope.
    evidence: ["dashboard/client/src/views/knowledge/openFindings.ts buildRecheckBrief", "operator choice A (chat), 2026-10-15"]

  - id: D4
    type: decision
    title: "What happens to findings only a human can close (product or architecture choices)?"
    status: resolved
    depends_on: [I1]
    resolved_at: 2026-10-15
    outcome: >-
      Excluded from the automated re-check scope and shown separately in the
      dashboard as "needs your decision". The classification rule must be
      explicit in the spec (recommended_action = append_review_queue together
      with a fingerprint/closure_criteria that names a human decision), never
      a general text guess. The human brief may include them on request. Once
      a human records the decision (ADR or Review Queue), the next run sees
      new evidence and can close normally. Never suppressed for being stale.
    evidence: ["I1 (8 such findings)", "knowledge-base/AGENTS.md: product/architecture questions stay open for a human", "operator choice A (chat), 2026-10-15"]

  - id: D5
    type: decision
    title: "What signal says the loop works (open-count trend, re-check age), and what per-week budget caps it?"
    status: resolved
    depends_on: [D1, D2]
    resolved_at: 2026-10-15
    outcome: >-
      One run per week, at most 5 notes / 15 findings per run, auto-apply only
      confirmed evidence; leftovers wait for the next week. Signals on the
      Open findings tab: open count falls from 275; "not re-checked >30d"
      falls from 222; each run's audit shows applied/resolved/recurring.
      Review after 4 runs: no drop means the existing patches are not
      applicable (stale evidence) → revisit D1/scope, never add runs. Kill
      switch: disable the scheduled task; the vault reverts via git.
    evidence: ["I1 counts", "workflows/knowledge-librarian.md limits", "operator choice A (chat), 2026-10-15"]

fog:
  - item: "Review Queue.md as a hub note (41 open: 32 patches, 9 watch) — same blockers as elsewhere, so no separate treatment yet"
    why_not_a_node: "I1 shows it shares the unapplied-edit blocker; revisit only if D3 scope selection starves other notes"
  - item: "Model and cost per unattended run"
    why_not_a_node: "Depends on the runtime chosen in D2"

deferred:
  - id: X1
    title: "Dashboard close/suppress buttons"
    reason: "Operator chose the read-only re-check route over a dashboard write path (2026-10-14)"
```

## Checkpoint

```yaml
checkpoint:
  written_at: 2026-10-15
  map: "ai-dev-office/docs/knowledge-finding-closure-map.md"
  destination: "Decide how open Librarian findings reach closure on a regular cadence — DECISION-COMPLETE 2026-10-15"
  resolved:
    - "I1, I2, I3 (see nodes)"
    - "D1: auto-write re-check inside the approved Games Labs scope; outside stays proposal-only (operator, 2026-10-14)"
    - "D2: weekly Claude desktop scheduled task → knowledge-librarian subagent, Claude lane (operator, 2026-10-14)"
    - "D3: scope = server-side brief endpoint, same rule as the dashboard button (operator, 2026-10-15)"
    - "D4: human-decision findings excluded from automation, surfaced as needs-your-decision (operator, 2026-10-15)"
    - "D5: weekly, ≤5 notes / 15 findings, confirmed-only apply; signals = open count, >30d count, per-run audit; review after 4 runs (operator, 2026-10-15)"
  findings_to_keep:
    - "I1: 229 of 275 open findings already carry a proposed patch; the blocker is applying, not re-checking"
    - "I2: only machine apply path = approved_scope_auto_write, games_labs only; audits are gitignored (local-only)"
    - "I3: runtime must be this Mac; desktop scheduled task / claude -p launchd / codex exec all viable; no weekly run has ever happened"
  frontier: []
  blocked: []
  fog: ["Review Queue hub note", "model/cost per run"]
  next_action: "Decision-complete. Implement from docs/knowledge-finding-closure-spec.md (ai-dev-office is a meta repo: no TASK run needed)"
```
