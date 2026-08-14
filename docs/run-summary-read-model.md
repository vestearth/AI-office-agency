# Review And Action Read Model

Read-only projection that powers the dashboard Command and Action layers.

## Principle

The dashboard **renders** signals; it does **not** infer them. Every field is a
projection of a field that a producer emits under a schema contract. Anything
that could only be derived from free-form prose (summaries, error reasons,
review text) is intentionally **excluded** — if a signal isn't emitted under a
contract, it doesn't appear here. Derived fields (`needsReview`,
`requiresAction`, `actionKind`, `riskLevel`)
combine contracted enums via explicit, server-owned rules — never via text.

## Source of truth

| Read-model field | Provenance | Contract |
|---|---|---|
| `title` | `status.yaml` → `task_label`, falling back to task id | — |
| `phase` | `runs/<id>/status.yaml` → `phase` | [status.schema.yaml](../schemas/status.schema.yaml) enum |
| `verdict` | `runs/<id>/reviewer-output.yaml` → `review_verdict` | [reviewer-output.schema.yaml](../schemas/reviewer-output.schema.yaml) enum |
| `lastReviewedAt` | `status.yaml` → `updated_at` (only when a reviewer-output exists) | — |
| `confidence` | `runs/<id>/debugger-output.yaml` → `diagnosis.confidence` | validate-yaml.rb enum (high/medium/low) |
| `issueCounts` | counts of `reviewer-output.yaml` → `artifacts[].issues[].severity` | base enum (error/warning/suggestion) |
| `riskLevel` (producer half) | `runs/<id>/reviewer-output.yaml` → `risk_level` | [reviewer-output.schema.yaml](../schemas/reviewer-output.schema.yaml) enum (high/medium/low) |
| `latestDecision` | latest entry in `runs/<id>/decision.yaml` → `decisions[]` (human input) | [decision.schema.yaml](../schemas/decision.schema.yaml) |
| `statusUpdatedAt` | `status.yaml` → `updated_at` | — |

Values that don't match the enum **exactly** are dropped to `null` — no
substring/fuzzy matching, no guessing. A typo or a future enum value never
leaks through as a real signal.

## Derived fields (projections, not inference)

- `inReviewQueue` = `phase ∈ {review, in_review}`
- `verdictNeedsAttention` = `verdict ∈ {changes_requested, escalate, infra_failure}`
- `decisionPending` = latest decision `decidedAt` differs from `status.yaml decision_applied_at`
- `needsReview` = `actionKind == awaiting_review`
- `requiresAction` = `actionKind != null`
- `actionKind` uses this precedence:
  1. unapplied human decision → `decision_pending`
  2. `review | in_review` → `awaiting_review`
  3. terminal phase plus adverse historical verdict → `artifact_drift`
  4. blocked/escalated/validation/devops or off-contract phase → `workflow_exception`
  5. any other adverse verdict/phase mismatch → `artifact_drift`
- `riskLevel` = the **higher** of two contracted signals, never from prose:
  - change risk — `reviewer-output.yaml` `risk_level` (issue #12; the reviewer's
    deterministic classification of the paths it reviewed), and
  - finding risk — `error>0 → high; warning>0 → medium; reviewed & clean → low`.

  Not reviewed → `none`. An absent or off-enum `risk_level` (every run written
  before issue #12) falls back to finding risk alone, so the old behaviour is
  unchanged.

The queue and risk rules are **server-owned**, so the client never re-derives
them. Output shape: [run-summary.schema.yaml](../schemas/run-summary.schema.yaml).

## Field semantics

What each value means, and what `null` / `none` mean — so the UI and any
consumer read them the same way.

### `riskLevel` — how much review attention the work needs

Derived from two contracted enums — the reviewer's emitted `risk_level` and
`issueCounts` — plus whether a review happened. The higher of the two wins.

| value | meaning | rule |
|---|---|---|
| `high` | a blocking issue was flagged, or the change touches a high-risk path | `issueCounts.error > 0` or `risk_level == high` |
| `medium` | non-blocking concerns only, or a medium-risk path | `warning > 0` or `risk_level == medium` |
| `low` | reviewed and clean, on a low-risk change | reviewer-output exists, no error/warning, `risk_level` absent or `low` |
| `none` | **not review-assessed yet** (absence of signal, not "safe") | no reviewer-output |

The two halves answer different questions — "how risky is this change?"
(`risk_level`, from path rules; see [reviewer-policy.md](reviewer-policy.md)) and
"what did the review find?" (`issueCounts`). Taking the max means a clean review
of an auth change still reads `high`, and an error on a docs change is never
hidden.

`none` ≠ `low`. `none` means "we have no review evidence"; `low` means "a review
happened and found nothing material." Don't render `none` as a green/safe state.

### `confidence` — the debugger's self-rated certainty

Provenance: `debugger-output.yaml` → `diagnosis.confidence`. Only present for
tasks that went through debugging.

| value | meaning |
|---|---|
| `high` / `medium` / `low` | the debugger's stated confidence in its root-cause/fix |
| `null` | the task was never debugged (no signal) — not "low confidence" |

Confidence describes the **debugger's** view, not the reviewer's and not an
overall task health score. Treat `null` as "n/a", never as a low score.

### `verdict` — the reviewer's last decision

`approved | changes_requested | escalate | infra_failure`, or `null` if never
reviewed. `verdictNeedsAttention` is the non-`approved` subset
(`changes_requested | escalate | infra_failure`). A task can be `phase: done`
with a non-`approved` last verdict; the Action Center classifies that mismatch
as `artifact_drift`, not as work awaiting a new review decision.

### `latestDecision` — the human supervisor's call (Slice 4)

Provenance: the last entry of `decision.yaml` → `decisions[]`. Human input under
a contract, not a producer signal.

| `decision` | meaning |
|---|---|
| `approve` | supervisor accepts the work |
| `request_changes` | send back for rework |
| `escalate` | needs more/senior attention |
| `reject` | abandon / will not proceed |

`null` means no human has decided yet. `againstVerdict` / `againstPhase` record
the contracted signals the decision was made against (captured server-side for
an audit trail; `againstVerdict` is normalized to a valid enum or `null`).

`latestDecision` reflects what the human chose; the **driver** turns it into a
`phase` transition at the next dispatch (see the decision → phase table above).
The read model itself stays read-only — it never writes `status.yaml`.

## Per-execution signals (run records)

This read model is **per task**: one row, current state. Questions about
individual agent *executions* — success rate by role/client/model, how often a
role was re-dispatched, which reviewer pass caught what — are answered from the
run-record store instead, which is per execution and keeps history across
retries. Same principle: contracted fields only, never prose. See
[run-records.md](run-records.md) for the id grammar, storage layout, and the
aggregation recipes.

## Listing invariant

The Action/runs scanners list a task only if its directory name matches the same
strict id pattern the detail/decision endpoints enforce
(`^TASK(-<NS>)?-…` — covers TASK-PKG and per-user prefixes). So every listed row is addressable: you can always open it
and POST a decision to it. Loosely-named dirs (`TASKfoo`, `TASK`) are excluded
rather than shown-but-unusable.

## Human decisions (write path)

`POST /api/decisions/:id` appends a human decision to `runs/<id>/decision.yaml`
(`approve | request_changes | escalate | reject`). This is a **new input signal**,
not a mutation of `status.yaml` — so the dashboard and the driver are never
concurrent writers of the same file.

The **driver** reconciles it: at dispatch, `run-agent.sh` runs
`scripts/reconcile-decision.rb`, which reads `decision.yaml` and applies the
latest decision to `status.yaml`. This keeps the single-writer invariant — only
the driver writes `status.yaml`. It is idempotent via
`status.decision_applied_at` (= the applied decision's `decided_at`), so a
decision is applied exactly once.

| decision | phase | current_agent | dispatch |
|---|---|---|---|
| `approve` | `done` | `done` | terminal — driver stops |
| `request_changes` | `debugging` | `debugger` | continues (rework loop) |
| `escalate` | `escalated` | `free-roam` | continues |
| `reject` | `aborted` | — | terminal — driver stops |

## API

`GET /api/review` → `ReviewModelResponse` (read-only):

```json
{
  "generatedAt": "<iso>",
  "total": 81,
  "needsReviewCount": 1,
  "actionCount": 6,
  "actionCounts": {
    "awaiting_review": 1,
    "decision_pending": 1,
    "workflow_exception": 2,
    "artifact_drift": 2
  },
  "reviews": [ /* ReviewSummary[], actionable rows first */ ]
}
```

## Slice status

- Slice 1 — verdict-based review core ✅
- Slice 2 — producer contract / `validation_failed` ✅
- Slice 3 — risk / confidence (contract-backed) ✅
- Slice 4 — human decision write-back (`decision.yaml`, record + surface) ✅
- Action Center — classified operator inbox and Command evidence deep links ✅
- Driver reconcile — `run-agent.sh` applies a decision to `status.yaml` at dispatch,
  idempotently, preserving the single-writer invariant ✅
