# Reviewer Policy — Independent, Evidence-First, Risk-Based

How the Reviewer role reaches a verdict: in what ORDER it reads, what a `pass`
claim has to be backed by, and how deep the review goes. The contract lives in
[agents/reviewer.md](../agents/reviewer.md); the rules live in
`office.config.yaml`; the gate is `scripts/review-gate.rb`, shared by
`validate-yaml.rb` and `run-agent.sh` so the driver records exactly what the
validator blocks on.

## 1. Independence is an order, not a second agent

There is one reviewer. Independence comes from inspecting the diff, the files,
and `task.md` FIRST, writing down a preliminary assessment, and only then
reading the developer's rationale — which is treated as a claim to check, not a
description to confirm. The reviewer records this in the optional
`independent_review` block:

```yaml
independent_review:
  preliminary_assessment: "Wallet debit path takes the amount from the request body."
  rationale_reviewed_after: true
  assessment_changed: false
```

A second reviewer agent would create the appearance of independence without the
substance (it would read the same prompt, including the same rationale) and
would double the office's cost per review. Deliberately not built.

## 2. Risk decides depth — deterministically

`reviewer.risk_rules` in `office.config.yaml` maps changed paths to a level:

```yaml
reviewer:
  risk_rules:
    default_level: low
    triggers:
      - label: auth
        level: high
        patterns: ["**/auth/**", "**/*token*", ...]
  risk_depth:
    high:   { require_evidence: true,  required_checks: [compile, tests] }
    medium: { require_evidence: true,  required_checks: [compile] }
    low:    { require_evidence: false, required_checks: [] }
```

- `triggers[]` — `label` (why), `level` (`high | medium | low`), `patterns`
  (`File.fnmatch` globs, matched case-insensitively against the normalized
  artifact path: leading `./` and `/` stripped).
- Every trigger is evaluated; the **highest** matched level wins. No match →
  `default_level`.
- `risk_depth[level]` selects the depth: `require_evidence` (a `pass` claim must
  cite `evidence_refs`) and `required_checks` (these `build_check` fields must
  not be `skipped`).

Shipped high-risk triggers: auth, payment/wallet, public API contract
(`*.proto`, `**/api/**`, openapi/swagger), migrations, `.github/workflows/**`,
secrets/config, agent instructions. Medium: infrastructure, dependency
manifests. Everything else is `low` and carries **no** extra obligation — a
docs-only diff must not pay high-risk cost.

Compute it, never guess it:

```bash
ruby scripts/classify-risk.rb . --explain internal/auth/token.go docs/notes.md
# risk_level=high  labels=auth  require_evidence=true  required_checks=compile,tests
```

The reviewer publishes the level in `reviewer-output.yaml` → `risk_level`. It
may **raise** it above the computed level (with a reason in `summary`); lowering
it is a validation error in every mode, because depth is owned by the rules.

`run-agent.sh` runs the same classifier over the upstream dev artifacts at
reviewer dispatch and injects a `--- REVIEW DEPTH ---` section into the prompt,
so the reviewer is told the level rather than asked for it.

## 3. Evidence-first verification

A `build_check.compile` / `build_check.tests` value of `pass` is a claim about a
command that ran. At `high` and `medium` risk it must be backed by evidence ids
recorded through `scripts/record-evidence.sh` (see
[evidence-contract.md](evidence-contract.md)) and cited in `evidence_refs`.

The gate reports a **gap** when:

| gap | condition |
|---|---|
| unbacked claim | `require_evidence` and some `build_check` value is `pass` but no `evidence_refs` are cited |
| unidentifiable state | a cited record has `repo_sha: unknown` |
| dirty state | a cited record has `working_tree_dirty: true` — the sha does not describe what actually ran |
| split state | cited records for the same `repo` carry more than one `repo_sha` |
| shallow check | a `required_checks` entry is `skipped` |

Dangling `evidence_refs` (an id with no record) and tampered logs already fail
validation unconditionally under the #11 contract, in every mode.

### What "the reviewed state" means, and how staleness is judged

The reviewed state is **the single commit the reviewer's own cited evidence was
taken at** — read from the `repo_sha` of the cited records themselves, per
`repo`. Evidence is "stale" when the cited records disagree with each other
(build at commit A, tests at commit B), when the sha is `unknown`, or when the
tree was dirty so no sha describes what ran.

This rule consults **no live git state**, which is the point: it is
time-invariant. Re-validating a finished task months later returns the identical
answer, because the answer depends only on bytes already recorded in
`evidence.yaml`.

`EVIDENCE_STRICT_SHA=1` is a **different**, opt-in check from #11: it compares
each `repo_sha` against the live `HEAD` of `repo`. It is deliberately NOT set by
this gate, by `validate-yaml.rb`, or by `run-agent.sh` anywhere — nothing in
this issue turns it on. The operator exports it by hand for a merge-readiness
check ("is this evidence about the tree in front of me right now?"). Because it
is never baked into a run, an archived task never starts failing when its branch
moves on.

A recorded reviewed-state sha on the run itself (rather than inferred from the
evidence) is follow-up work; it belongs with run identity, not here.

## 4. Rollout: `warn_only` → `required`

The office had **zero** evidence records when this shipped. Hard enforcement as
the default would have made the next reviewer run reject everything, so the
switch defaults to non-blocking:

```yaml
reviewer:
  evidence_policy:
    mode: warn_only        # warn_only | required
```

| mode | on a gap |
|---|---|
| `warn_only` (default) | `run-agent.sh` records an `reviewer_evidence_policy` event in `meta.yaml` with the mode, level, and each gap. `validate-yaml.rb` stays silent and the verdict — including `approved` — stands. |
| `required` | the same gaps become validation errors on an `approved` verdict. `scripts/enforce-output-contract.rb` then routes the task to `validation_failed` instead of propagating, so `approved` is unreachable until the evidence exists. |

Only these two modes exist.

**Flipping it** — any one of:

- edit `office.config.yaml` → `reviewer.evidence_policy.mode: required` (office-wide);
- put the same block in `office.config.local.yaml` (this machine only);
- export `OFFICE_EVIDENCE_POLICY_MODE=required` (this shell only).

**What changes when you flip it:** nothing about `changes_requested`,
`escalate`, or `infra_failure` — those verdicts route exactly as before in both
modes, because blocking them would strand a task that already needs more work.
Only `approved` gains a precondition. Before flipping, run a reviewer pass with
`scripts/record-evidence.sh` so at least one real record exists; the gate is
satisfied by evidence, not by prose.

## 5. Backward compatibility

`risk_level` and `independent_review` are optional; every reviewer output
written before this contract validates unchanged. Under the default
`warn_only`, `validate-yaml.rb` produces byte-identical stdout, stderr, and exit
codes for all pre-existing runs — enforced by the sweep in
`tests/integration/reviewer-evidence-risk.sh`.
