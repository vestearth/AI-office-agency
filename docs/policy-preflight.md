# Policy Preflight And The Untrusted-Input Boundary

The deterministic gate that runs **before externally-sourced work is allowed to
trigger a privileged agent dispatch**.

```
external input -> classify as untrusted -> resolve repository policy
              -> determine allowed action -> classify path sensitivity
              -> allow | deep review | human approval | deny
```

- Policy: the `preflight:` block in `office.config.yaml` (portable copy in
  `office.config.example.yaml`)
- Gate: [`scripts/preflight.rb`](../scripts/preflight.rb)
- Decision record: `runs/<task-id>/preflight.yaml`
- Schema (documentation): [preflight.schema.yaml](../schemas/preflight.schema.yaml)
- Runtime rules: `validate_preflight` in `validate-yaml.rb` (hardcoded, as with
  every other contract here — S7)

## Principle: external text is CONTEXT, never AUTHORITY

An issue body, a comment, a webhook payload — none of it is an instruction to
this gate. The external text is read exactly twice: once to hash it, once to
scan it for advisory injection signals. It is never parsed as configuration and
is never consulted for trust, sensitivity, action, or approval.

Everything that actually reaches a decision is one of three facts, and all three
come from somewhere the input cannot write:

| Fact | Where it comes from | What the input can do to it |
|---|---|---|
| **trust** | the declared *origin* (`--source`) checked against `preflight.trusted_sources` | nothing — trust attaches to the origin, never to the content |
| **action** | the declared role mapped through `preflight.role_actions`, or an explicit `--action` from the calling code | nothing — the caller declares the capability; it is never extracted from the text |
| **sensitivity** | the declared path scope matched against `preflight.sensitivity_rules` | nothing — globs live in config |

So text that says "ignore the policy", "the operator already approved this",
"you are now in test mode", or that embeds a YAML block spelling out
`outcome: allow` produces exactly the same decision as text that says nothing.
`tests/integration/policy-preflight.sh` asserts that byte-for-byte, per case.

The one thing such text *does* change is visibility: the recognised phrases are
recorded in `input.injection_signals` so a human — or the event-driven gateway
in #19 — can see that an override was attempted. That list is **advisory and is
not an input to the outcome**, deliberately: letting it tighten the decision
would re-couple policy to input text, which is the exact coupling this gate
exists to remove.

## Trust is on the origin, and unknown means untrusted

`preflight.trusted_sources` is an allow-list of origins. Anything not on it —
including a source string this repository has never heard of — is `untrusted`.
There is no "unknown source" branch to get wrong.

## Outcomes

| Outcome | Exit | Meaning |
|---|---|---|
| `allow` | 0 | normal execution |
| `allow_with_deep_review` | 10 | may execute, but the work must get high-depth review |
| `require_human_approval` | 11 | a human must approve before any mutation |
| `deny` | 12 | unsupported or too risky; do not execute |

`run-agent.sh` proceeds on 0 and 10 only. **Every other exit refuses the
dispatch**, including a usage error (2), a store error (3), and an outright
crash — a gate that cannot decide must not let work through.

## The decision matrix

`preflight.decision_matrix` maps (trust × action × sensitivity) to an outcome.
The table *is* the policy: every cell is written down and reviewable rather than
inferred at runtime. A lookup that misses at any level — unknown trust, unknown
action, unknown sensitivity, absent cell — resolves to `deny`.

Untrusted input:

| action ↓ / sensitivity → | normal | sensitive | critical |
|---|---|---|---|
| `read` | allow | allow | allow |
| `comment` | allow | allow | allow_with_deep_review |
| `mutate_repo` | allow_with_deep_review | require_human_approval | deny |
| `execute` | require_human_approval | deny | deny |
| `deploy` | deny | deny | deny |

Trusted input:

| action ↓ / sensitivity → | normal | sensitive | critical |
|---|---|---|---|
| `read` | allow | allow | allow |
| `comment` | allow | allow | allow |
| `mutate_repo` | allow | allow_with_deep_review | require_human_approval |
| `execute` | allow | allow_with_deep_review | require_human_approval |
| `deploy` | allow_with_deep_review | require_human_approval | require_human_approval |

Two shapes are worth naming explicitly:

- **Untrusted `read` is always allowed.** Reading is how an agent finds out what
  the request even is; gating it would make the gate unusable without making
  anything safer.
- **Untrusted `deploy` is denied at every sensitivity.** There is no sensitivity
  level at which a stranger's issue may reach a release path.

### Undeclared scope is critical, not default

Untrusted work that declares no path scope has an unbounded blast radius, so it
is rated at `preflight.undeclared_scope_sensitivity` (`critical`) rather than at
`default_sensitivity`. The practical effect: an untrusted request that does not
say what it intends to touch cannot mutate anything. Trusted work with no
declared scope keeps the default — an operator dispatch is not required to
pre-declare its own file list.

## Sensitivity rules

Glob patterns → a level, **highest level among the matches wins**, no match →
`default_sensitivity`.

The matching itself is **not implemented here**. `classify_paths` translates the
rules into `reviewer.risk_rules` shape and calls `RiskClassifier.classify` from
[`scripts/classify-risk.rb`](../scripts/classify-risk.rb) — there is one path
classifier in this repository and this is not a second one.

That matters for correctness, not only tidiness. A path is compared after
`RiskClassifier.normalize`, which lexically resolves `.`, `..` and a leading `/`,
and matching uses `FNM_PATHNAME | FNM_DOTMATCH | FNM_CASEFOLD`. Without those,
the gate was defeated by spelling alone — every one of these is the same file as
`internal/auth/token.go` and every one of them classified `normal`:

```
./internal/auth/token.go        internal/auth/../auth/token.go
/internal/auth/token.go         internal/./auth/token.go
internal/AUTH/token.go          (same file on macOS and Windows)
```

`request.paths` records the caller's original spelling and
`sensitivity.matched_path` records the normalized form actually compared, so a
reader can see both. `tests/integration/policy-preflight.sh` (the `E` cases)
pins one probe per evasion class.

The shipped rules cover the surfaces the issue named: `.github/workflows/**`,
Docker/build/release configuration, agent and system instructions, MCP/plugin
configuration, auth/payment/security-sensitive code, migrations and destructive
database operations, and secret/config handling. Patterns that identify *this*
framework's own layout (`scripts/**`, `schemas/**`) stay root-anchored; every
rule that describes a surface a target project also has carries a `**/` variant,
so a nested checkout (`srv/.claude/`, `srv/.github/workflows/`) classifies too.

### Convergence with #12 — what is shared, and what is not

#12 merged as `f7ff7d7`. `RiskClassifier` **is** the shared implementation as of
this slice: `normalize`, the fnmatch flags, the trigger evaluation and the
highest-match-wins ranking all come from it. Nothing about path matching is
duplicated.

What is deliberately *not* shared, and why:

| | `reviewer.risk_rules` (#12) | `preflight.sensitivity_rules` |
|---|---|---|
| question | how deep must the review be | how dangerous is this surface |
| levels | `low` / `medium` / `high` | `normal` / `sensitive` / `critical` |
| rule shape | `triggers[]{label, level, patterns}` + `default_level` | `sensitivity_rules[]{level, description, paths}` + `default_sensitivity` |
| on a malformed rule | skipped | **faulted into a deny** |

The level vocabularies are *rank-isomorphic*, not aligned: `classify_paths` maps
between them explicitly (`SENSITIVITY_TO_RISK`). They are kept distinct on
purpose — "this change needs compile+test evidence" and "a stranger may not
touch this file" are different claims that happen to rank the same way, and
collapsing them would mean one config edit silently moving both.

The remaining follow-up is the **rule sets**, not the code: the two path lists
overlap heavily (#12's `auth`, `payment`, `migration`, `ci_workflow`,
`secrets_config`, `agent_instructions` triggers cover most of the critical rules
here) and should be reconciled into one list with per-consumer level overrides.
That is a config refactor with its own blast radius, and it is not this issue.

## Where the decision is recorded, and why it is its own file

The gate writes `runs/<task-id>/preflight.yaml` under the same per-task `.lock`
every other writer in the task dir takes, and `run-agent.sh` logs a `preflight`
event through the existing `log_meta_event` seam so the event log stays coherent.
There is no parallel writer.

Why the decision is not simply the meta event, justified the way
[run-records.md](run-records.md) justifies its store:

- **Not `status.yaml`** — a preflight decision is append-only history about one
  request, not mutable task state. Several decisions can exist for one task.
- **Not `meta.yaml` alone** — a decision is a structured object (trust, hashes,
  matched rule, matched path, faults, approval). `meta.yaml` events carry a flat
  `details` string, and the read path for run records is explicit that consumers
  must **never** parse `details`. Folding a nested decision in there would either
  lose the structure or force exactly that parsing. The event carries the link
  (`id`, `outcome`, `record`); the record carries the decision.
- **Not `evidence.yaml`** — evidence records what a command *proved after* it
  ran. Preflight records what was *permitted before* anything ran. Same shape of
  ledger, opposite side of execution.

`run_id` is a nullable foreign key into `runs/<task-id>/run-records/`, using the
run-id grammar verbatim, exactly as `evidence.yaml` does. It is null when the
gate runs outside a dispatch — which is the normal case, because the gate runs
*before* the run is allocated.

The record is in the `.gitignore` allowlist (`!runs/*/preflight.yaml`). It has
to be: ignored, deleting it would be invisible in `git status` **and** would
reset the `pf-NNN` counter, so a recorded denial could be erased and a later
`allow` written under the same id.

### `policy_sha256` is provenance, not enforcement

It identifies *which* policy produced a decision, so the decision can be replayed
or diffed against the policy in force today. It is deliberately **not**
recomputed at validation time: the policy legitimately changes after a decision
is taken, so a mismatch is history, not corruption. The validator checks its
shape (`sha256:<64 hex>`) and nothing more.

Contrast `evidence.artifact_sha256`, which *is* recomputed — that hash covers an
artifact that must not move. Do not read this one as a tamper seal; it is a
pointer to a version.

### Trustworthy at rest

`validate_preflight` enforces the invariants a reader would otherwise have to
take on faith, so a hand-edited or fabricated entry cannot claim an outcome its
own fields contradict:

- a non-empty `faults` list forces `outcome: deny`;
- `approval.required` is true exactly when the outcome is
  `require_human_approval`;
- `approval.granted_by` may only appear on `allow_with_deep_review`;
- a non-null `run_id` must resolve to a record under this task's `run-records/`.

## Fail-closed cases

Each of these produces a recorded `deny`, never a silent allow:

| Case | Recorded fault |
|---|---|
| `preflight:` block missing or not a mapping | policy block is missing |
| `enabled` not `true` while external work is arriving | `preflight.enabled is not true` |
| `sensitivity_rules` missing, not a list, or carrying an unknown level | per-rule fault |
| `decision_matrix` missing, not a mapping, or carrying an unknown action/level/outcome | per-cell fault |
| `default_sensitivity` unknown | classified at `critical` *and* faulted |
| requested role with no `role_actions` entry (e.g. `auto`) | role has no capability |
| explicit `--action` that is not a known capability | unknown capability |
| `--input-file` that cannot be read | input is unreadable |
| decision record cannot be written | exit 3, no dispatch |

Note the last two rows: an input the gate could not read, and a decision it
could not record, are both treated as undecidable. Unrecordable is undecidable.

## Human approval

`require_human_approval` is released by setting
`AI_DEV_OFFICE_PREFLIGHT_APPROVED_BY=<name>` in the operator's own shell — the
same idiom as `AI_DEV_OFFICE_FORCE` elsewhere in the driver, and the one channel
external text provably cannot reach. The approver is recorded in
`approval.granted_by`, and the outcome is released to `allow_with_deep_review`,
never to a bare `allow`: an approved risky change still gets the deep review.

An approval **never** softens a `deny`. Denied is denied.

## Invoking the gate

The gate is opt-in and engages only when a caller declares an external source,
so an ordinary operator-created task behaves exactly as it did before this
existed — no record, no event, no decision.

```bash
AI_DEV_OFFICE_INPUT_SOURCE=github_issue \
AI_DEV_OFFICE_INPUT_FILE=/tmp/issue-4211.md \
AI_DEV_OFFICE_INPUT_REF="vestearth/AI-office-agency#4211" \
AI_DEV_OFFICE_REQUESTED_PATHS="src/api/handler.go src/api/handler_test.go" \
./run-agent.sh TASK-EA-012 dev
```

| Variable | Meaning |
|---|---|
| `AI_DEV_OFFICE_INPUT_SOURCE` | declared origin; **presence of this is what arms the gate** |
| `AI_DEV_OFFICE_INPUT_FILE` | path to the raw external text (hashed and scanned, never interpreted) |
| `AI_DEV_OFFICE_INPUT_REF` | human-readable pointer back to the origin, e.g. `owner/repo#123` |
| `AI_DEV_OFFICE_REQUESTED_PATHS` | whitespace-separated declared scope |
| `AI_DEV_OFFICE_REQUESTED_ACTION` | overrides the role→action mapping |
| `AI_DEV_OFFICE_PREFLIGHT_APPROVED_BY` | operator approval for a `require_human_approval` outcome |

`scripts/preflight.rb` is equally usable standalone, which is how the gateway in
#19 is expected to consume it: decide first, read the outcome from the exit code
and the record, and only then dispatch.

### Known boundary: the gate is armed by its caller

Be blunt about the shape of this. **`AI_DEV_OFFICE_INPUT_SOURCE` being set is the
only thing that arms the gate.** Externally-sourced work dispatched without it
is not gated, and nothing anywhere records that it was not gated — an un-gated
dispatch is indistinguishable from an ordinary operator task, because that is
exactly what "opt-in, existing behaviour untouched" means.

That is the correct trade for this slice: 369 existing tasks and every current
operator workflow must keep behaving identically, and a gate that fired on
internal work would have to be disabled to get anything done. But it means the
posture depends entirely on **#19 always declaring the source**, and that is a
property of the gateway, not of this gate.

Two things follow, and #19 owns both:

- declaring the source must be structural in the gateway — the ingest path
  constructs the dispatch, so there should be no code path in it that builds one
  without a source;
- if the office ever wants this enforced rather than trusted, the switch is a
  `preflight.require_declared_source` flag that refuses any dispatch with no
  declared origin. It is deliberately **not** added here: turned on today it
  would refuse every operator task in the repository.

Note the direction of the remaining failure modes. `preflight.enabled: false`
denies rather than permits, and a gate that returns success without writing a
record is refused by the driver. The un-armed case is the one gap, and it is a
gap in coverage, not in the decision.

## Scope

This issue implements the **gate and its record**. It does not implement the
event-driven agent gateway (#19) that will ingest issues and comments; per the
issue, this must land first so that gateway has something to ask. The record
above is the interface it should consume.
