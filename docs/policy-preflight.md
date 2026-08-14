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

Same trigger shape as `reviewer.risk_rules` (#12): glob patterns → a level,
**highest level among the matches wins**, no match → `default_sensitivity`.
Matching is `File.fnmatch?` with `FNM_PATHNAME | FNM_EXTGLOB`, in which a
leading `**/` already matches zero directories — so `**/auth/**` covers both
`auth/x.go` and `internal/auth/x.go` without a second pattern.

The shipped rules cover the surfaces the issue named: `.github/workflows/**`,
Docker/build/release configuration, agent and system instructions, MCP/plugin
configuration, auth/payment/security-sensitive code, migrations and destructive
database operations, and secret/config handling.

### Convergence with #12

Issue #12 builds a deterministic path→risk classifier (`scripts/classify-risk.rb`,
rules under `reviewer.risk_rules`). **This is not a second classifier and must
not become one.** The rule shape here — a list of `{level, paths[]}` triggers,
highest match wins, default on no match — is deliberately identical to it, and
the rules live under their own `preflight:` key precisely so the two sets can be
diffed and reconciled rather than silently diverging.

When #12 merges, `RiskClassifier` becomes the shared implementation:
`classify_paths` in `scripts/preflight.rb` should be replaced by a call into it,
and the two rule sets should be reconciled into one list with per-consumer
overrides. The level vocabularies are already aligned (`low|medium|high` there,
`normal|sensitive|critical` here — a straight three-way rename), and #12's
sensitive-path list already covers most of the entries above.

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

## Scope

This issue implements the **gate and its record**. It does not implement the
event-driven agent gateway (#19) that will ingest issues and comments; per the
issue, this must land first so that gateway has something to ask. The record
above is the interface it should consume.
