# Review Read Model

Read-only projection that powers the dashboard Review layer (Slices 1–4).

## Principle

The dashboard **renders** signals; it does **not** infer them. Every field is a
projection of a field that a producer emits under a schema contract. Anything
that could only be derived from free-form prose (summaries, error reasons,
review text) is intentionally **excluded** — if a signal isn't emitted under a
contract, it doesn't appear here. Derived fields (`needsReview`, `riskLevel`)
combine contracted enums via explicit, server-owned rules — never via text.

## Source of truth

| Read-model field | Provenance | Contract |
|---|---|---|
| `phase` | `runs/<id>/status.yaml` → `phase` | [status.schema.yaml](../schemas/status.schema.yaml) enum |
| `verdict` | `runs/<id>/reviewer-output.yaml` → `review_verdict` | [reviewer-output.schema.yaml](../schemas/reviewer-output.schema.yaml) enum |
| `lastReviewedAt` | `status.yaml` → `updated_at` (only when a reviewer-output exists) | — |
| `confidence` | `runs/<id>/debugger-output.yaml` → `diagnosis.confidence` | validate-yaml.rb enum (high/medium/low) |
| `issueCounts` | counts of `reviewer-output.yaml` → `artifacts[].issues[].severity` | base enum (error/warning/suggestion) |
| `latestDecision` | latest entry in `runs/<id>/decision.yaml` → `decisions[]` (human input) | [decision.schema.yaml](../schemas/decision.schema.yaml) |

Values that don't match the enum **exactly** are dropped to `null` — no
substring/fuzzy matching, no guessing. A typo or a future enum value never
leaks through as a real signal.

## Derived fields (projections, not inference)

- `inReviewQueue` = `phase ∈ {review, in_review}`
- `verdictNeedsAttention` = `verdict ∈ {changes_requested, escalate, infra_failure}`
- `needsReview` = `inReviewQueue || verdictNeedsAttention`
- `riskLevel` = `error>0 → high; warning>0 → medium; reviewed & clean → low; not reviewed → none`
  (derived only from contracted `issueCounts`, never from prose)

The queue and risk rules are **server-owned**, so the client never re-derives
them. Output shape: [run-summary.schema.yaml](../schemas/run-summary.schema.yaml).

## Field semantics

What each value means, and what `null` / `none` mean — so the UI and any
consumer read them the same way.

### `riskLevel` — how much review attention the work needs

Derived only from `issueCounts` (contracted `severity` enum) and whether a
review happened. Higher severity wins.

| value | meaning | rule |
|---|---|---|
| `high` | a reviewer flagged at least one blocking issue | `issueCounts.error > 0` |
| `medium` | non-blocking concerns only | `error == 0 && warning > 0` |
| `low` | reviewed and clean | reviewer-output exists, no error/warning |
| `none` | **not review-assessed yet** (absence of signal, not "safe") | no reviewer-output |

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
with a non-`approved` last verdict — that mismatch is exactly what
`needsReview` surfaces.

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

## Listing invariant

The Review/runs scanners list a task only if its directory name matches the same
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
  "needsReviewCount": 4,
  "reviews": [ /* ReviewSummary[], needsReview first */ ]
}
```

## Slice status

- Slice 1 — verdict-based review core ✅
- Slice 2 — producer contract / `validation_failed` ✅
- Slice 3 — risk / confidence (contract-backed) ✅
- Slice 4 — human decision write-back (`decision.yaml`, record + surface) ✅
- Driver reconcile — `run-agent.sh` applies a decision to `status.yaml` at dispatch,
  idempotently, preserving the single-writer invariant ✅
