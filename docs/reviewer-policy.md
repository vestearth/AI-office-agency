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
it is a **gap** like any other — recorded under `warn_only`, blocking an
`approved` verdict under `required` — because depth is owned by the rules, not
by the self-report.

Raising the published level raises the signal the dashboard shows, not the
obligations the gate enforces: `require_evidence` and `required_checks` always
follow the **computed** level.

Nor can the level be deflated by omission. The classifier's input is the
**union** of the paths the upstream agents declared they changed
(`dev-output.yaml`, `dev-2-output.yaml`, `debugger-output.yaml`,
`devops-output.yaml`, `free-roam-output.yaml` → `artifacts[].path`) and the
paths the reviewer listed. An empty or trimmed reviewer `artifacts[]` therefore
cannot lower the level, and any dev-declared path missing from the reviewer's
list is itself a gap ("not reviewed"). `run-agent.sh` builds its prompt section
from the same resolver (`scripts/review-gate.rb --upstream-paths`), so what the
reviewer is told and what it is held to are one value.

At reviewer dispatch `run-agent.sh` injects a `--- REVIEW DEPTH ---` section
into the prompt, so the reviewer is told the level rather than asked for it.

## 3. Evidence-first verification

A `build_check.compile` / `build_check.tests` value of `pass` is a claim about a
command that ran. At `high` and `medium` risk it must be backed by evidence ids
recorded through `scripts/record-evidence.sh` (see
[evidence-contract.md](evidence-contract.md)) and cited in `evidence_refs`.

The gate reports a **gap** when:

| gap | condition |
|---|---|
| unbacked claim | `require_evidence` and no `evidence_refs` are cited, on an `approved` verdict or alongside any `pass` claim |
| unidentifiable state | a cited record has `repo_sha: unknown` |
| dirty state | a cited record has `working_tree_dirty: true` — the sha does not describe what actually ran |
| split state | cited records for the same `repo` carry more than one `repo_sha` |
| shallow check | approving with a `required_checks` entry that is not `pass` (`fail`, `skipped` or absent), or a `skipped` entry on any other verdict |
| unreviewed path | a path an upstream output declared changed is missing from the reviewer `artifacts[]` |
| missing ground truth | a role the driver recorded as having run has no `<role>-output.yaml`, or it exists and will not parse |
| unnamed change | an `artifacts[]` entry (upstream or reviewer) has no usable `path` |
| unclassifiable | an `approved` verdict where no upstream output and no `artifacts[]` name any path |
| deflated level | the emitted `risk_level` is below the computed one |

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
| `warn_only` (default) | `run-agent.sh` records a `reviewer_evidence_policy` event in `meta.yaml` with the mode, level, and every gap. `validate-yaml.rb` stays silent — no extra stdout, no stderr, same exit code — and the verdict, including `approved`, stands. **Every** gap class behaves this way, the deflated-level one included: `warn_only` means nothing blocks. |
| `required` | the same gaps become validation errors on an `approved` verdict. `scripts/enforce-output-contract.rb` then routes the task to `validation_failed` instead of propagating, so `approved` is unreachable until the evidence exists. |

Only these two modes exist. One thing sits outside the switch: a malformed
`reviewer:` block in `office.config.yaml` fails validation in **both** modes. A
gate that cannot classify must fail closed — see §6.

**Flipping it** — any one of:

- edit `office.config.yaml` → `reviewer.evidence_policy.mode: required` (office-wide);
- put the same block in `office.config.local.yaml` (this machine only);
- export `OFFICE_EVIDENCE_POLICY_MODE=required` (this shell only) — **only
  valid when `office.config.yaml` already carries a complete `reviewer:`
  block.** The env override writes just that one key, so on an office with no
  `reviewer:` block it materialises a partial one, which §6 then rejects in
  both modes. Fail-closed, but surprising: add the block to the config file
  first, then use the env var to flip the mode.

**What changes when you flip it:** nothing about `changes_requested`,
`escalate`, or `infra_failure` — those verdicts route exactly as before in both
modes, because blocking them would strand a task that already needs more work.
Only `approved` gains a precondition.

**It is retroactive, and that is the expensive part.** `validate-yaml.rb`
revalidates finished tasks on demand, so the switch applies to the archive as
well as to new work. Measured on this repo at the time of writing:

| mode | tasks passing | tasks failing |
|---|---|---|
| `warn_only` (today) | 357 | 12 |
| `required` | 272 | 97 |

85 archived tasks stop validating — none of them wrong when they were
written, all of them predating the evidence contract, and none of them
fixable after the fact (the commands they describe cannot be re-recorded at
the sha they ran on). So:

- flip only once new work is routinely recording evidence — run a reviewer
  pass through `scripts/record-evidence.sh` first and confirm the gate is
  satisfied by the record, not by prose;
- expect `ruby validate-yaml.rb <old-task>` to fail for pre-contract tasks,
  and do not treat that as archive corruption;
- if the archive must keep validating clean, flip per-machine in
  `office.config.local.yaml` while the office-wide default stays
  `warn_only`.

## 5. Backward compatibility

`risk_level` and `independent_review` are optional; every reviewer output
written before this contract validates unchanged. Under the default
`warn_only`, `validate-yaml.rb` writes nothing extra to stdout or stderr and
returns the same exit code as before — `tests/integration/reviewer-evidence-risk.sh`
pins that on a high-risk, evidence-free `approved` output, which is the case
that would otherwise be loudest. The four verdicts (`approved`,
`changes_requested`, `escalate`, `infra_failure`) route identically in both
modes; only `approved` gains a precondition, and only under `required`.

## 6. Failure modes of the gate itself

`warn_only` is a rollout switch for evidence gaps, not permission to run a gate
that cannot do its job. If `reviewer:` is present in `office.config.yaml` but
`risk_rules` or `risk_depth` is missing, misspelled, or malformed, the gate
would silently classify every change as the default level while still reporting
`mode=required`. `ReviewGate.config_errors` shape-checks both blocks and
`validate-yaml.rb` raises them as errors in every mode, naming the offending
key. Omitting the whole `reviewer:` block is different and allowed: the gate is
then simply not configured — but see the `OFFICE_EVIDENCE_POLICY_MODE` caveat in
§4, which is the one way to end up with a partial block by accident.

Every rule the validator blocks on lives in `ReviewGate.evaluate` — the same
function the driver runs — so `meta.yaml` never records a gap set that differs
from the one that blocked. No rule exists on only one side.

## 7. Who authors each input

The property this whole design rests on: **no input that decides whether the
gate binds may be authored by the party the gate is binding.** Each round of
review found another field that broke it — `artifacts[]`, then `build_check`,
then the existence of the upstream file itself. The table is here so the next
one is read off it rather than rediscovered.

| Input `ReviewGate.evaluate` reads | Authored by | Can the reviewer weaken its own gate with it? |
|---|---|---|
| `reviewer.evidence_policy.mode` | operator, tracked in `office.config.yaml` | No — not writable from a run |
| `reviewer.risk_rules` / `risk_depth` | operator, tracked in `office.config.yaml` | No — and a malformed block fails closed in both modes (§6) |
| upstream `<role>-output.yaml` → `artifacts[].path` | the dev/debugger/devops/free-roam agent — writable by the reviewer at the filesystem level, but see Known limits 1 | **No, as of issue #22.** Deletion is caught against driver history (as before); substitution — rewriting the file to declare benign paths — is now *also* caught: `docs/task-input-integrity.md` hashes every other role's output file around the runner subprocess and hard-fails the dispatch on a mismatch, before the review gate or `enforce-output-contract.rb` ever runs. |
| `status.yaml` `history[].agent` / `handoff.from`, `meta.yaml` `events[].agent` | `run-agent.sh` (the driver) | **No, as of issue #22.** Both files are in `task-input-integrity`'s protected set (`status.yaml` byte-exact; `meta.yaml` append-only — existing entries can't change, only new ones append) and a rewrite of either is caught the same way as the row above. |
| `evidence.yaml` records (`repo`, `repo_sha`, `working_tree_dirty`) | `scripts/record-evidence.sh`; `artifact_sha256` recomputed by the validator | **Yes — still open.** `task-input-integrity` treats `evidence.yaml` as append-only (new entries are a legitimate, sanctioned part of a live dispatch), so it verifies that existing entries survive, never that an entry it accepts is authentic. Recording a trivial command still produces a real, unmodified, hash-consistent record; see Known limits 2 for how much wider than "self-record" this gap actually is. |
| reviewer `artifacts[].path` | the reviewer | No — unioned with upstream; omitting a path only adds a gap |
| reviewer `build_check.compile` / `.tests` | the reviewer | No — approving needs `pass` at the required depth; `fail`/`skipped`/absent all block |
| reviewer `evidence_refs` / `claims[].evidence_refs` | the reviewer | No — citing fewer adds gaps; every cited id must resolve to a real record |
| reviewer `risk_level` | the reviewer | No — may be raised, never lowered below the computed floor |
| reviewer `review_verdict` | the reviewer | No — see the decision row below |

And the decision the gate binds — the row whose absence let a verdict/routing
split walk past a table built to prevent exactly that:

| Decision the gate binds | Read from | Why all three |
|---|---|---|
| "does this run reach `done`?" | `review_verdict == approved` **OR** `next_action.agent == done` **OR** `transition.to_phase == done` | `run-agent.sh` routes on `next_action.agent` and falls back to `review_verdict` only when it is absent, so watching the verdict alone let `review_verdict: escalate` + `next_action: {agent: done}` complete the task with the gate reporting its gaps into the void. The gate must arm on the field that actually moves the task, and on every field that can. |

### Known limits — what this gate does NOT constrain

**This gate constrains an honest reviewer that makes mistakes. On its own, it
did not constrain a reviewer that writes the files it is judged against —
issue #22, [`docs/task-input-integrity.md`](task-input-integrity.md), closed
most of that gap by adding a mechanism outside the gate. What follows is the
current boundary, not the original (pre-#22) one.**

Every agent in this office runs with `file_write: true`, and the gate's ground
truth is ordinary files in the same task directory.

1. **Rewriting `dev-output.yaml`** to declare benign paths instead of the real
   ones, or **deleting** it (optionally alongside `meta.yaml` and a blanked
   `status.yaml` history) — **closed.** `task-input-integrity` snapshots every
   other role's output file, `status.yaml`, and `meta.yaml` before the runner
   subprocess starts and hashes them again after it returns; a reviewer
   dispatch that rewrites or deletes any of them now fails the dispatch
   outright, before the review gate or `enforce-output-contract.rb` ever
   runs. See `docs/task-input-integrity.md`'s escapes 1-3 for the exact
   reproductions.
2. **Self-record its own evidence** — `scripts/record-evidence.sh <TASK> -- true`
   produces a real record with a real sha and a real hash, which it can then
   cite. The recomputed `artifact_sha256` proves the log was not edited after
   the fact; it proves nothing about whether the command verified anything.
   **Still open, and wider than the original framing:** `task-input-integrity`
   treats `evidence.yaml` as an append-only ledger — a live dispatch is
   allowed to add entries to it, by design, so no `record-evidence.sh`
   involvement is even required. A hand-appended, schema-valid `evidence.yaml`
   entry citing a fabricated hash and a log file that no command produced
   passes the same append-only check identically to a genuine record: the
   check only verifies that *existing* entries survive unmodified, never that
   an entry it accepts is authentic. See `docs/task-input-integrity.md`'s own
   escape-4 writeup for the full framing and why closing this needs post-hoc
   re-execution or output inspection of the recorded command, not a
   file-integrity check.

Neither the closed pair nor the still-open item was ever a bug in the rules
above — they are the boundary of what any file-based gate (closed) or any
file-integrity check (open) can assert about the evaluated party's own
claims.

Two further gaps sit outside the reviewer entirely, and issue #22 does not
touch either:

3. **Upstream under-declaration.** If the dev agent omits a path from its own
   `artifacts[]`, no office artifact records that the file changed. Closing
   this needs the VCS diff as ground truth, not an agent's list.
4. **A wholly fabricated evidence record** — a record written together with a
   matching log that no command produced. Closing this needs post-hoc
   re-execution of the recorded command, explicitly deferred from this issue
   (and from #22 — see item 2 above, which is the same underlying gap).

What issue #12 delivers is therefore: deterministic depth, an evidence
requirement that an honest reviewer cannot forget, and a gate that fails
closed on absence, malformation and misconfiguration. Issue #22 adds
tamper-resistance for the task-directory files that gate reads — deletion and
substitution of the upstream record, and rewriting the driver's own
routing/log files — on top of that. **What remains open is evidence-claim
binding** (item 2 above, and item 4): nothing in this office yet verifies that
a cited evidence record's command substantively did what it claims to have
done, only that the record has not been tampered with after the fact. Read a
green gate today as *"the reviewer followed the process, and the upstream
record it reviewed is provably the one dev/debugger/devops/free-roam actually
wrote"* — not as *"the cited evidence is substantively real"*.
