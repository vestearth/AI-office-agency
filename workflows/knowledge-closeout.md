# Knowledge Closeout Routing

One small decision, made once per closeout pass, that chooses among the
knowledge mechanisms that already exist. It adds no agent, no skill, no
scheduler, and no task state. The capture contract
([`knowledge-capture.md`](knowledge-capture.md)) and the librarian contract
([`knowledge-librarian.md`](knowledge-librarian.md)) are unchanged; this file
only decides which of them runs, in what order, and what each must read first.

```text
no durable delta                         -> skip
new durable task knowledge               -> capture
existing knowledge drift / conflict      -> librarian
new durable knowledge + existing impact  -> capture, then librarian_reconcile
```

## Running It

The rule is lane-neutral: Claude, Codex, Cursor, and a human run the same
script and get the same answer for the same inputs.

```text
ruby scripts/knowledge-closeout.rb --scope <key> \
  --durable-delta yes|no --existing-impact yes|no \
  [--task TASK-ID] [--evidence REF]... [--note "Knowledge Base/..."]... \
  [--comment TEXT] --record
ruby scripts/knowledge-closeout.rb --validate knowledge-reviews/closeouts/<file>.yaml
```

Without `--record` it prints the decision and writes nothing (a dry run). With
`--record` it appends one record to
`knowledge-reviews/closeouts/<timestamp>-<scope>.yaml`, validated against
[`schemas/knowledge-closeout.schema.json`](../schemas/knowledge-closeout.schema.json).
Records are append-only; the script refuses to overwrite one. The script never
dispatches an agent, writes `knowledge-base/`, or touches `status.yaml`.

## 1. Inputs

Two judgment signals come from the operator; everything else is read from disk.

| Input | Source | Meaning |
|---|---|---|
| `durable_delta` | operator | The session produced new durable knowledge: a decision, contract, flow, lesson, or concept that passes the capture gate (`knowledge-capture.md` triggers, librarian capture triggers). A routine edit is not a delta. |
| `existing_knowledge_impact` | operator | The session touched, relied on, contradicted, or invalidated an existing vault note, or found conflicting evidence about one. |
| `scope` | operator | The stable closeout scope key: parent thread plus coherent product workstream, as a lowercase slug. Same key across QA, design, implementation, config, publish, and follow-up turns. |
| `evidence_refs` | operator | What the signals rest on: `ev-NNN` ids, commits, run ids, repo-relative paths. Required when either signal is `yes`. |
| `touched_notes` | operator | Vault notes the session touched or relied on (`--note`). |
| `task_id` | operator | The TASK run, when the session is task-bound. |
| capture artifact | disk | `runs/<task>/knowledge-capture-output.yaml`, when present. |
| prior closeouts | disk | Same-scope records in `knowledge-reviews/closeouts/`. |
| prior librarian audits | disk | Same-scope audits in `knowledge-reviews/` (`<timestamp>-<scope>.yaml`). |

## 2. Precedence When Both Apply

When the session has both a durable delta and an existing-knowledge impact, the
action is `[capture, librarian_reconcile]`, in that order:

1. **Capture first.** The task-bound capture writes or updates
   `runs/<task>/knowledge-capture-output.yaml`. `capture.step` is `update`
   when that file already exists — never write a second capture for the task.
2. **Then the librarian reconciles.** It reads the capture proposal before
   proposing anything, references it instead of proposing equivalent
   knowledge, and limits its own findings to the existing-note impact (drift,
   conflicts, links, supersession).

A capture with no task has no run to write into. It routes through the
librarian's own capture triggers (`capture.via: librarian_capture_trigger`), so
the librarian is dispatched even though the action is still `capture`.

## 3. What The Librarian Inspects Before Proposing

The record's `must_inspect` list is what the librarian must read before it
proposes a capture or a note change:

- every touched vault note,
- `knowledge-base/Knowledge Base/Review Queue.md`,
- `runs/<task>/knowledge-capture-output.yaml` when present or produced this pass,
- every prior same-scope librarian audit,
- every prior same-scope closeout record.

When one of these already covers the same durable outcome, the librarian
reconciles or references it (see Capture Precedence in
`knowledge-librarian.md`) and records the source proposal or prior finding
fingerprint as evidence. It does not propose the same knowledge again.

## 4. Same-Scope Reuse

A later pass in the same scope compares its evidence against every prior
same-scope closeout record:

- **No new evidence** — the pass records `action: [skip]`,
  `reason: no_new_evidence`. The earlier pass already routed it.
- **New evidence** — the pass routes normally on the current signals.
  `librarian_dispatch` is `followup` when a same-scope librarian audit or
  librarian-dispatching closeout already exists: reuse that librarian (for
  example with `followup_task`) and reconcile its prior findings. It is `spawn`
  only when no librarian has run for the scope.
- A genuinely distinct workstream gets its own scope key, and so its own
  history.

`signals.new_evidence_refs` records what was new, so a reviewer can see why a
second pass did more than skip.

## 5. Audit Trail For A Deliberate Skip

Every closeout pass writes a record, including a skip. The two cases are
distinguishable by what is on disk:

- a record with `reason: no_durable_delta` or `no_new_evidence` — the operator
  decided nothing durable changed;
- no record for the session's scope — knowledge closeout was forgotten.

A task-bound capture may still record its own `recommended_action: skip` in
`runs/<task>/knowledge-capture-output.yaml`; that remains valid and is read as
the capture artifact's existing state.

## Boundaries (unchanged)

- Capture stays suggest-only with `requires_human_review: true`; a human
  applies it (knowledge-base ADR-0005).
- The librarian keeps its proposal-only default and its explicitly approved
  auto-write scopes; it never commits, pushes, accepts ADRs, or promotes shared
  knowledge.
- No full-vault sweep: the librarian's 5-note / 20-minute limit still applies.
- The closeout decision is independent of task `done` and never mutates task
  state. If the librarian dispatch it calls for is unavailable or fails, report
  that in the session closeout.
