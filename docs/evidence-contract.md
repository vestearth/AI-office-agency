# Execution Evidence Contract

The canonical contract for **evidence that a verification command was actually
executed**. Downstream repos (`ai-skills`, `knowledge-base`) consume this
grammar verbatim — change it here first.

- Ledger: `runs/<task-id>/evidence.yaml`
- Logs: `runs/<task-id>/evidence/<ev-id>.log`
- Schema (documentation): [evidence.schema.yaml](../schemas/evidence.schema.yaml)
- Runtime rules: `validate-yaml.rb` (hardcoded, as with every other contract here)

## Principle

A claim ("tests pass", "the build is green") is prose. Evidence is a command
that ran, its exit code, and a hash of its captured output taken at a known repo
sha. The validator **recomputes** the hash, so a fabricated record or an edited
log fails validation instead of being taken on trust.

## Recording evidence

```bash
scripts/record-evidence.sh <TASK_ID> [--type command|test|build|static_check|artifact] -- <command...>
```

Run it from the directory the command should execute in — repo provenance is
taken from that working directory, not from the office repo. It:

1. runs the command for real, capturing stdout+stderr to `evidence/<ev-id>.log`;
2. records exit code, `repo` (git toplevel path, or the cwd outside a repo),
   `repo_origin` (portable identity — see below), `repo_sha` (HEAD, or
   `unknown`), `working_tree_dirty` (`git status --porcelain`), and an ISO-8601
   UTC `executed_at`;
3. appends the record to `evidence.yaml` under the per-task `.lock` (the same
   advisory flock the driver uses for `status.yaml` / `meta.yaml`);
4. prints the evidence id and **exits with the command's exit code** — a failing
   check still fails the caller; the failure is recorded, not swallowed.

## Repository identity vs path

Two fields, two jobs:

- `repo_origin` is the **identity** — `owner/repo`, e.g. `SparqLab/missions`.
  It is normalized from `git remote get-url origin`: the remote path after the
  host, minus a trailing `.git`. Both remote forms normalize to the same value
  (`git@github.com:SparqLab/missions.git` and
  `https://github.com/SparqLab/missions.git` → `SparqLab/missions`), and GitLab
  subgroups keep their full path (`group/sub/repo`). It is `null` when the repo
  has no origin or the remote is a local / `file://` path — those carry no
  portable identity. This is the field downstream consumers should read.
- `repo` is the **local git toplevel path** (or the cwd outside a repo). It is
  operator-specific and not portable; it exists so the strict-SHA check below
  has something it can resolve on this machine.

## ID grammar

`ev-NNN` — literal `ev-`, then a zero-padded sequence of at least 3 digits
(`ev-001`, `ev-002`, … `ev-1000`). Ids are allocated by the wrapper, stable once
written, and unique within a task. They are **not** globally unique: an id is
only meaningful together with its task id.

## Referencing evidence from role outputs

Any `<role>-output.yaml` may carry an optional `evidence_refs` list at the top
level and/or per claim:

```yaml
evidence_refs: [ev-001]
claims:
  - claim: "the unit suite passes on this branch"
    evidence_refs: [ev-001, ev-002]
```

`evidence_refs` is optional — outputs written before this contract keep
validating unchanged. But every id that IS listed must exist in the same task's
`evidence.yaml`: a dangling id fails validation. Ids resolve only within the
citing task, so citing an id that happens to also exist in another task is not
detectable — evidence ids are task-scoped, not global.

## Staleness rule

`repo_sha` is provenance, not a liveness assertion. By default the validator
does **not** compare it against the repo's current HEAD — re-validating a
finished task months later must not start failing because the branch moved on.

Set `EVIDENCE_STRICT_SHA=1` to opt into the strict check, which fails validation
when `repo_sha` differs from HEAD of `repo`. It is skipped when `repo_sha` is
`unknown` or the path is no longer a git repo. Use it when the evidence is meant
to describe the tree in front of you right now (e.g. a merge-readiness gate).

## Scope

This slice implements the **producer wrapper** lane only: evidence exists because
an agent invoked the wrapper. Post-hoc re-execution of recorded commands for
high-risk tasks is separate work (issue #12).
