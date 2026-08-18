# Knowledge Provenance And Stale-Evidence Invalidation

The office half of the workspace provenance contract. A captured claim records
**which task, run and evidence produced it**, and a deterministic operator
action can later mark that evidence as no longer describing the world — which
surfaces every claim resting on it as needing revalidation, without deleting or
hiding anything.

- Capture output: `runs/<task-id>/knowledge-capture-output.yaml` → optional
  `provenance:` block. Schema:
  [knowledge-capture-output.schema.json](../schemas/knowledge-capture-output.schema.json)
- Staleness ledger: `runs/<task-id>/evidence-freshness.yaml`. Schema:
  [evidence-freshness.schema.yaml](../schemas/evidence-freshness.schema.yaml)
- Writer: [`scripts/mark-evidence-stale.rb`](../scripts/mark-evidence-stale.rb)
- Reporter: [`scripts/knowledge-freshness.rb`](../scripts/knowledge-freshness.rb)
- Runtime rules: `validate-yaml.rb` (hardcoded, as with every other contract here)

Upstream contracts consumed verbatim: [evidence-contract.md](evidence-contract.md),
[run-records.md](run-records.md).

## The freshness vocabulary is not defined here

`vestearth/knowledge-base#4` shipped first and defines the **canonical** freshness
vocabulary for this workspace, in
`knowledge-base/Knowledge Base/Provenance And Freshness.md`:

| State | What it means |
|---|---|
| `current` | Checked at `verified_at`, nothing since has contradicted it. |
| `unknown` | No provenance recorded, or too little to judge. The default. |
| `maybe_stale` | A cited source moved; nobody has checked whether the claim survived. |
| `stale` | Confirmed to describe an older state of the world. |
| `invalid` | The claim was wrong when written. Not a time problem. |
| `historical` | Deliberately frozen. Never becomes stale. |

Issue #15 originally proposed a smaller `stale` / `needs_revalidation` model.
That model is **not** used: `needs_revalidation` is this vocabulary's
`maybe_stale`, and adopting the canonical names means the office and the vault
never need a translation table. There is no seventh state anywhere in this
workspace.

Two subsets are in play here, and the split is deliberate:

- **`provenance.freshness` accepts all six.** The block is written to be pasted
  into a note's frontmatter unchanged, so it must be able to express anything a
  note can express — including `historical`, which the office itself never
  produces.
- **Marks accept three: `maybe_stale`, `stale`, `invalid`.** `unknown` is the
  *absence* of a mark, `historical` is a property of a note rather than of an
  executed command, and there is deliberately no `current` mark — a
  re-verification produces a **new evidence record**, it does not rewrite the
  standing of an old one.

## The provenance block

Optional, on `knowledge-capture-output.yaml`. Field names are the vault's, so
the block promotes into YAML frontmatter with no transformation.

```yaml
provenance:
  freshness: current
  verified_at: "2026-08-15"
  task_id: TASK-EAR-259
  run_id: run-20260815T101500Z-TASK-EAR-259-dev-k3f9a2
  evidence_refs: [ev-001, ev-002]
  repo_origin: SparqLab/missions
  repo_sha: 8f295531c0a7f1e0d4b2a9c8e5f30b71d6a4c2e9
  confidence: high
```

| Field | Rule |
|---|---|
| `freshness` | One of the six. Absent reads as `unknown`. |
| `verified_at` | `YYYY-MM-DD` — the day the claim was **actually re-checked against reality**. Not the day the note was written or the task closed. |
| `task_id` | Must equal the output's own `task_id`. Repeated because `ev-NNN` ids are **task-scoped**, so a promoted note carrying `evidence_refs` is meaningless without it. |
| `run_id` | The office run-id grammar verbatim. Its embedded task must match. |
| `evidence_refs` | `ev-NNN` ids from **this** task's `evidence.yaml`. A dangling id fails validation, exactly as a dangling top-level `evidence_refs` does. |
| `repo_origin` | Portable identity, `owner/repo`. The office's local `repo` path is operator-specific and deliberately has no slot here. |
| `repo_sha` | 40-hex, or `unknown`. **Provenance, not liveness** — see below. |
| `confidence` | Only with `verified_at` **and** `run_id` or `evidence_refs`. It describes the check, not the writer. |

**Everything is optional, including the block itself.** A capture output with no
provenance validates exactly as it did before this contract existed and is
treated as `unknown` — no provenance is not an accusation.

### `repo_sha` is still not a liveness check

Nothing added here compares `repo_sha` against a current HEAD, on any code path,
at any time. `EVIDENCE_STRICT_SHA=1` remains the only sha-vs-HEAD check in this
repo and it is untouched by this feature: it is a manual operator opt-in, scoped
to `evidence.yaml`, and this contract does not read it. Freshness is decided by
recorded marks, never by a sha comparison.

## The staleness trigger, precisely

> Evidence is degraded **if and only if** `runs/<task-id>/evidence-freshness.yaml`
> contains a mark naming its `evidence_id`. Marks are appended only by an
> explicit invocation of `scripts/mark-evidence-stale.rb`.

That is the whole trigger. There is no clock, no background scan, no repo I/O,
no HEAD comparison, and no dependency graph. The same two files always produce
the same answer on any machine, at any later date. Tasks with no such file — the
overwhelming majority, and every task that predates this contract — behave
exactly as before; the file's absence is normal, not a gap.

```bash
scripts/mark-evidence-stale.rb <TASK_ID> <ev-id> --reason "..." \
    [--state maybe_stale|stale|invalid] [--by NAME]
scripts/mark-evidence-stale.rb <TASK_ID> --list
```

The mark is appended under the same per-task `.lock` the driver and
`record-evidence.sh` use. The ledger is **append-only**; the last mark for an
evidence id is the one in force, because a later operator judgment supersedes an
earlier one.

### When a human should invoke it

The trigger is deterministic; the *judgment* of when to pull it is not, and is
deliberately left to a person. Mark evidence when something it rests on provably
moved: a migration merged, a proto field or API contract changed, a service
redeployed, a config flag flipped, a cited source file rewritten.

**Conservative by design.** A source changing means the claim is *potentially*
stale, not wrong. `--state` therefore defaults to `maybe_stale`. Reserve `stale`
for a re-check that showed the behaviour actually changed, and `invalid` for
evidence that was wrong when it was recorded. Never mark to tidy up: an
unexplained mark degrades real knowledge for no reason, which is why `--reason`
is required and an empty one fails validation.

## What a mark does to knowledge

Effective freshness of a capture output is the **most severe** of its declared
`provenance.freshness` and the marks standing against every evidence id it
cites, on the ordering:

```
current < unknown < maybe_stale < stale < invalid
```

`historical` is exempt — a note that records the past on purpose never becomes
stale.

Exactly one thing is enforced, and it is narrow: **a capture output may not
declare `freshness: current` while citing marked evidence.** Validation fails
with the evidence id, its mark state, and the fix. `unknown` (including an
absent freshness key), `maybe_stale`, `stale` and `invalid` all pass, because
only the positive assertion "this is current truth" is the thing a degraded
source contradicts.

Nothing else happens. The capture output is not rewritten, moved, or deleted; no
note is touched; no file is removed. Degraded knowledge stays exactly where it
was and stays readable — it just stops being able to call itself current.

## Discoverability

```bash
scripts/knowledge-freshness.rb              # every capture output under runs/
scripts/knowledge-freshness.rb <TASK_ID>    # one task
scripts/knowledge-freshness.rb --degraded   # only the ones needing revalidation
```

Reports declared vs effective freshness with the marks that caused the gap. It
writes nothing and exits 0 — it is a report, not a gate. `validate-yaml.rb` is
the gate.

This is the point of the whole design: stale knowledge must remain **findable**.
Deleting or hiding it loses the fact that someone once verified something, and
loses the lead on what to re-check. A warning is the deliverable; a deletion is
a regression.

## Human review is unchanged

`requires_human_review: true` is still mandatory on every capture output and is
still enforced. Nothing in this contract creates an autonomous writer:

- capture stays **suggest-only** — `scripts/knowledge-capture.rb` gathers and
  emits a skeleton, and never writes to `knowledge-base/` or commits;
- `mark-evidence-stale.rb` records a judgment about evidence; it never edits a
  capture output, a note, or an evidence record;
- `knowledge-freshness.rb` only reads;
- the validator refuses a false `current` claim; it never repairs one.

A person decides what a degraded note should say.

## Promotion

The provenance block is designed to survive promotion untransformed: paste it
into the note's YAML frontmatter as-is. `scripts/knowledge-capture.rb` seeds the
`note_patch` skeleton with that frontmatter already rendered, so the promoted
note carries `task_id`, `run_id`, `evidence_refs`, `repo_origin` and `repo_sha`
without anyone re-typing them. The vault's own `scripts/check_provenance.py`
checks shapes and grammars on the other side; id **resolution** stays here,
where the ledgers live.
