# TASK-EAR-401: Make task-input-integrity T10 pass in a fresh checkout (gitignored evidence.yaml)

Repo: `ai-dev-office` (office tooling). Opened 2026-10-12 by the Claude lane
at operator request; Claude opens the run only.

## Problem

`tests/integration/task-input-integrity.sh` T10 (lines 495-525) runs the
pre-#22 validator (`458bc7b:validate-yaml.rb`) and the current
`validate-yaml.rb` over every `runs/TASK-*` and fails on any difference.

In a **fresh checkout** (a detached worktree of `origin/main`, CI, another
machine) it fails on 8 runs:

```
DIVERGED: TASK-EAR-387 (old rc=0 new rc=1)
DIVERGED: TASK-EAR-388 (old rc=1 new rc=1)
DIVERGED: TASK-EAR-394 / 395 / 397 / 398 / 399 / 400 (old rc=0 new rc=1)
[FAIL] T10: 8 task(s) validate differently after #22 — backward compatibility broken
```

Reproduced 2026-10-12 on clean `origin/main` 2b0dc0ff (before AI-office-agency#82),
so it is not caused by the runner-sandbox change. The full suite is otherwise
58 pass / 1 fail.

## Root cause (checked)

These runs' tracked `status.yaml` (and for 388 also `dev-output.yaml` /
`reviewer-output.yaml`) cite `evidence_refs`, but `evidence.yaml` and
`evidence/` are not in the `runs/` gitignore allowlist (`.gitignore` ~line 49-82),
so they never sync. In a fresh checkout the current validator reports:

```
status.yaml.completion_gates.evidence_refs references evidence but runs/TASK-EAR-394/evidence.yaml does not exist
```

The pre-#22 validator never checked evidence refs, so rc/output diverge. In
the operator's main checkout, where `evidence.yaml` exists, the same runs
validate cleanly (`ruby validate-yaml.rb TASK-EAR-394` passes). T10 itself was
not run in the main checkout.

So `validate-yaml.rb` is not portable for any run that cites evidence, and T10's
"byte-identical with pre-#22" premise cannot hold for runs created after the
evidence integration.

## Options (decide before coding; do not pick silently)

1. Validator: when a run cites `evidence_refs` and `evidence.yaml` is absent
   **because it is gitignored**, report a distinct, non-fatal finding (or skip
   the cross-check), keeping the hard error when the file is tracked or
   present but missing the id.
2. T10: restrict the byte-identical comparison to runs that do not use
   post-#22 features (evidence refs), or compare only checks that existed at
   458bc7b, and assert the newer checks separately.
3. Sync evidence: allowlist `runs/*/evidence.yaml` (not `evidence/`) in
   `.gitignore`. This conflicts with the deliberate "evidence never syncs"
   design (docs/multi-user-git.md, docs/specs evidence integration); needs an
   operator decision.

## Acceptance

- `tests/run-integration.sh` passes, including T10, in a fresh detached
  worktree of `origin/main` **and** in a checkout that has the gitignored
  evidence files.
- A regression test shows the chosen behaviour: it fails before the fix
  (reproduce with a run that cites `evidence_refs` and has no `evidence.yaml`)
  and passes after.
- `validate-yaml.rb` still hard-fails a run whose present `evidence.yaml` lacks
  a cited id (no weakening of the existing evidence-integrity check).
- bash 3.2 compatible (macOS `/bin/bash`), and the suite keeps the
  SUITE_DONE sentinel pattern.
