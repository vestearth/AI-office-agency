# Workflow learning (issue #58)

Issue #58 scopes structured post-run observations, recurring-failure
detection, human-approved workflow proposals, and knowledge-backed preflight
warnings. This file covers **step 0**: one vocabulary for what went wrong
(`defect_class`) and a read-only collector that counts it. Nothing here
changes a contract, a policy, or a rule on its own.

## `defect_class`

The primary class of a defect, recorded where the defect is diagnosed:

- debugger: `diagnosis.defect_class` in `debugger-output.yaml`
- reviewer: `defect_class` in `reviewer-output.yaml` when the verdict is not
  `approved`

Both fields are schema-optional, so every earlier output stays valid. Both
role contracts (`agents/debugger.md`, `agents/reviewer.md`) require the field
for new work. The vocabulary is `DEFECT_CLASSES` in `validate-yaml.rb`, and
`tests/integration/schema-validator-parity.sh` pins both schemas to it.

It is **not** `failure_classification` (Phase 1D,
[failure-recovery.md](failure-recovery.md)). That is a routing judgment: who
takes the failed task next (`implementation_defect` → debugger,
`environment_runtime` → devops, …). `defect_class` describes what kind of
mistake it was, so recurring kinds can be seen across tasks. One task can carry
both.

| Class | Meaning |
|---|---|
| `missing_tests` | Behavior shipped without the test that would have caught it, or acceptance criteria left unverified. |
| `silent_fallback` | A failure is swallowed or turned into a default, empty, or success value (discarded errors, synthetic fallback data). |
| `logic_error` | The code does the wrong thing on a path it does handle (wrong condition, order, timestamp source, query shape). |
| `regression` | A change undid behavior that was already approved or tested. |
| `idempotency` | Retries, replays, or repeated calls change the outcome (keys, buckets, once-per-period rules). |
| `wrong_target` | The right change landed on the wrong item (file, request, entry, environment). |
| `contract_break` | An API, proto, or generated-artifact change breaks or skips a consumer (signature change, stale generated code). |
| `stale_context` | Work acted on an outdated read of code, docs, or runtime state. |
| `data_migration` | A migration or backfill writes wrong data or drops a constraint's meaning. |
| `config_or_environment` | Config, env vars, deploy wiring, or infrastructure differ from what the code assumes. |
| `other` | None of the above. Use it rather than forcing a poor fit. |

### Where the classes came from

These classes were derived from the 25 debugger diagnoses on record on
2026-10-19. The classification below is an operator-side reading, kept here as
provenance only. The outputs themselves were **not** backfilled.

| Class | Tasks |
|---|---|
| `missing_tests` | TASK-021, TASK-034 (with logic), TASK-055, TASK-056, TASK-EAR-098 |
| `silent_fallback` | TASK-057 (publish errors ignored), TASK-067, TASK-EAR-109, TASK-EAR-197, TASK-EAR-224 |
| `logic_error` | TASK-035, TASK-057 (timestamp source), TASK-EAR-099, TASK-EAR-110, TASK-VS-026 |
| `regression` | TASK-022, TASK-023 |
| `idempotency` | TASK-018, TASK-047 |
| `wrong_target` | TASK-044, TASK-059 |
| `contract_break` | TASK-066, TASK-EAR-107 |
| `stale_context` | TASK-032, TASK-070 |
| `data_migration` | TASK-EAR-108 |
| `config_or_environment` | none of the 25; added for the env/deploy lessons in the knowledge base (an unset env var renders `""` and crashes boot; an unset `USER_API_URL` makes every level-gated launch fail) |

## Collector v0

```bash
ruby scripts/learning-collector.rb            # markdown report
ruby scripts/learning-collector.rb --json     # machine-readable
ruby scripts/learning-collector.rb --since 2026-10-01
```

The collector is read-only (`tests/integration/workflow-learning.sh` checksums
the fixture before and after a run). It reports:

- **Rework**: per project prefix, how many runs ever moved *into*
  `debugging`, and how many such entries there were. `in_review -> in_review`
  rows are mostly progress notes, so they are never counted.
- **Defect classes**: tasks per class, from debugger and reviewer outputs.
  Unknown values and unclassified outputs are listed separately.
- **Recurring**: classes seen in 2 or more distinct tasks. These are
  candidates for a human-reviewed proposal, never a rule.
- **Repositories** named in debugger `affected_files`.
- **Knowledge closeout**: `done` runs with neither a closeout record nor a
  capture.

Baseline on 2026-10-19 (570 runs, 533 done):

- Rework: 15 of 414 EAR runs (4%) and 1 of 38 VS runs entered debugging; 18 of
  112 legacy runs (16%) did.
- Repositories: Missions appears in 11 of the 25 diagnoses.
- Defect classes: none yet (all 25 diagnoses predate the field).

## What comes next (not built)

Each step needs collected data first, and each needs a human decision:

1. **Proposals**: a recurring class with evidence (task ids, diagnoses)
   becomes a knowledge or workflow proposal through the existing capture and
   librarian lanes. It never becomes a rule automatically.
2. **Preflight lessons**: when a task opens, show at most three relevant
   lessons with their evidence and freshness. They are context, not authority,
   the same principle as [policy-preflight.md](policy-preflight.md). The cap
   keeps this from working against context efficiency.
3. **Proof it helps**: track the recurrence rate of a class after its lesson
   has been surfaced. A lesson that does not lower recurrence is retired.
