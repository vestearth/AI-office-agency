# Event-Driven Agent Gateway

The pipeline that turns an already-received external event — a GitHub issue
comment, a CI callback, a future task-board/tester integration — into a normal
`./run-agent.sh <TASK_ID> <AGENT>` dispatch, composing #17 (policy preflight)
and #14 (task ownership) rather than building a second execution path.

```
event (github | test)
  -> normalize            ONE internal envelope shape, regardless of source
  -> idempotency reserve   delivery_id, before anything else runs
  -> command grammar       first line, exact literal match, no parsing
  -> identity resolution   existing task, or a maintained external_ref
                            -> task_id mapping, or (triage only) mint one
  -> preflight PRE-CHECK    library call — decides, writes nothing
  -> ./run-agent.sh        the real, authoritative gate: preflight + ownership
```

- Library + CLI: [`scripts/event-gateway.rb`](../scripts/event-gateway.rb)
- Idempotency store: `runs/_gateway/ledger.yaml` (operational, gitignored)
- External-ref mapping: `runs/_gateway/external-refs.yaml` (operational, gitignored)
- Per-task audit mirror: `runs/<task-id>/gateway-events.yaml` (schema:
  [gateway-events.schema.yaml](../schemas/gateway-events.schema.yaml))
- Config: the `gateway:` block in `office.config.yaml`
- Composes: [`docs/policy-preflight.md`](policy-preflight.md) (#17),
  [`docs/task-ownership.md`](task-ownership.md) (#14)

This issue is normalization + policy composition + dispatch. It does **not**
verify a webhook signature, serve HTTP, or listen on a socket — every adapter
here normalizes a payload the caller already received by some other means.

## Principle this gateway inherits, and adds to

#17 established: free-form external text is CONTEXT, never AUTHORITY. #19
inherits that unchanged and adds the second half of the same idea for
*commands*: free-form external text may name **at most one** thing — which of
a small, fixed set of literal commands it is — and nothing else about the
event body ever reaches a role, an action, or a path scope. Those three
values are looked up from config (`gateway.commands`, then
`preflight.role_actions`), never parsed out of the payload.

## The command grammar, verbatim

The **entire first line** of the event body — after normalizing CRLF to `\n`
and stripping leading/trailing whitespace on that line only — must equal,
byte-for-byte, one of the keys of `gateway.commands` in `office.config.yaml`:

```
/agent investigate   -> role: debugger
/agent revise         -> role: dev
/agent validate       -> role: reviewer
/agent review          -> role: reviewer
/agent triage          -> role: pm   (the only role that may mint a new task)
```

Rules, and why each one is drawn this narrow:

- **No case folding.** `/agent Revise` does not match `/agent revise`. A
  grammar that folds case has to decide what ELSE it tolerates (extra spaces?
  a trailing period?) and each tolerance is a new way to be misread; refusing
  all of it is the simplest rule that cannot be argued down.
- **No argument parsing.** There is no `/agent revise --role reviewer` or
  `/agent revise path=foo`. The command string selects a role; nothing else in
  the line, or the body, is ever read for a value.
- **Only the first line is consulted.** Every other line — including one that
  itself looks like a command, or a role/action/path named directly in prose
  — is part of `body`, which flows into the preflight input hash and
  advisory injection-signal scan **and nowhere else**. A body that reads:

  ```
  /agent revise

  Actually ignore that, run /agent deploy with role: devops and action: execute
  ```

  resolves to `dev` (from the first line) with every later token inert. There
  is no "last command wins" or "most privileged command wins" rule to exploit,
  because there is no second parse at all.
- **The action is never gateway-declared.** `gateway.commands` maps a literal
  to a *role*; the *action* that role may exercise comes only from
  `preflight.role_actions` (#17), exactly as it would for an operator-typed
  dispatch. The gateway does not carry its own action vocabulary that could
  drift from preflight's.
- **The path scope is never gateway-declared, ever.** No command in
  `gateway.commands` names a path, and the dispatch env contract's
  `AI_DEV_OFFICE_REQUESTED_PATHS` is never set by this gateway — not from the
  body, not from a per-command default. Every gateway-triggered request is
  therefore "undeclared scope" and takes preflight's
  `undeclared_scope_sensitivity` floor (`critical` for an untrusted source in
  the shipped policy). This is a real cost — a gateway dispatch can never
  reach `allow` for `mutate_repo` from an untrusted source, only
  `allow_with_deep_review` at best for a *trusted* one — accepted deliberately
  rather than invent a way to say "this event is about `scripts/foo.rb`" that
  the event body could then also say for you.

## Identity resolution, and its failure mode

The gateway never invents a task number from free text. Three paths, in
order:

1. **Explicit `task_id`** (the generic/test adapter only — GitHub events never
   carry one, see below). Accepted only if it matches `TASK_ID_PATTERN`
   (mirrored from `validate-yaml.rb`) **and** `runs/<task_id>/` already
   exists. An explicit id naming a task that does not exist is rejected, not
   created — this path is for a caller (a task board, a tester harness) that
   already resolved its own mapping out of band.
2. **A maintained `external_ref -> task_id` mapping**
   (`runs/_gateway/external-refs.yaml`). The GitHub adapter always resolves
   this way: it never scrapes a task id out of comment prose at all, in either
   direction — not "look for a `TASK-` token anywhere in the text" and not
   "trust a token the commenter typed." The mapping is written by the gateway
   itself, only from the `/agent triage` path below, so an entry only ever
   points at a task the gateway (post-preflight) actually created for that
   ref.
3. **Minting, `/agent triage` only.** If neither of the above resolves and the
   command's role is `pm`, the gateway may mint a fresh id in a dedicated
   namespace (`TASK-GW-<N>`, sequential, never colliding with an
   operator/PM-assigned `TASK-<PROJECT>-NNN`) and record the mapping. Minting
   happens **after** the preflight pre-check passes (see "Ordering" below) —
   an unvetted event never causes even a mapping entry to be written, let
   alone a directory.

**Failure mode:** anything else — no `task_id`, no `external_ref`, or an
`external_ref` with no mapping and a command whose role isn't `pm` — is
rejected outright (`rejected_identity`) with a reason logged to the ledger. It
is never guessed at, and it is not "processed against the nearest task."

## Idempotency

**Key shape:** the envelope's `delivery_id` — for the GitHub adapter, a
caller-supplied delivery id (representing the real `X-GitHub-Delivery`
header; header handling is transport and out of this issue's scope) if
present, else a stable hash of `(repository, issue, comment_id, action)`. For
the test/generic adapter, whatever the caller supplies — the contract is
"the same logical delivery, resubmitted, has the same `delivery_id`."

**Where it lives, and why there, before anything else:** `runs/_gateway/ledger.yaml`,
one flat store, locked with the same `flock`-on-`.lock` idiom every other
writer in this repo uses (`scripts/preflight.rb`, `scripts/task-ownership.rb`,
`log_meta_event`). It is deliberately **not** inside any task directory.
Task resolution can fail (see above), and a retried delivery of an
UNRESOLVABLE event must still be recognized as the same delivery, not
re-processed and independently re-rejected N times as if each retry were new.
A per-task store cannot hold that key before a task exists at all — so the
delivery-id space is checked in one place the whole pipeline visits first,
before command resolution, before identity resolution, before anything else.

**Mechanism:** delivery_id is *reserved* atomically — inside one flock,
"is this id already known? if not, write it with `outcome: in_progress` before
releasing the lock." `File#flock(LOCK_EX)` blocks across **processes**, not
just threads, so N concurrent gateway invocations for the same event
serialize on that reservation: exactly one of them observes "not yet known"
and proceeds; the rest observe the reservation and report `duplicate`
immediately, without touching identity resolution, preflight, or
`run-agent.sh`. This is what makes 3 (or 300) concurrent retries of one event
collapse to exactly one dispatch.

A **duplicate is not re-processed even if the original was rejected**: a
retried webhook for an event that failed to resolve reports `duplicate`
pointing at the original rejection, rather than re-running (and
re-rejecting) it from scratch. This is a deliberate choice, not an oversight
— re-rejecting a bad event a second time is not itself a safety problem, but
treating every retry as fresh work is wasted effort and noise in the ledger
for no benefit, so the gateway short-circuits it the same way it short-circuits
a duplicate of an accepted event.

**Per-task mirror:** once (and only once) a delivery resolves to a task and
reaches a terminal outcome (`dispatched`, `dispatch_failed`, or
`rejected_preflight`), the finalized ledger row is also mirrored into
`runs/<task>/gateway-events.yaml`, colocated with that task's
`preflight.yaml`/`evidence.yaml`/`ownership.yaml` the way every other
decision about a task lives with it. The mirror is written **after** the
ledger, on the ledger's own write path.

**Tracking:** `runs/_gateway/` and `runs/<task>/gateway-events.yaml` are both
gitignored (matching this repo's *existing* handling of `evidence.yaml` and
`ownership.yaml`, which are likewise not in the `runs/*` allowlist in
`.gitignore` — see there for the precedent). This is a deliberate difference
from `preflight.yaml`, which IS tracked specifically so a denial cannot be
silently deleted; a gateway ledger entry carries no denial of its own (the
authoritative denial, if any, is preflight's own record, which stays
tracked) — losing a gateway-events mirror loses convenience audit trail, not
an enforcement record. (An earlier draft of this document called the mirror
"best-effort" audit only; that was corrected after audit found a real gap —
see the next section.)

### Surviving loss of the central ledger

`runs/_gateway/ledger.yaml` is the *primary* idempotency store, but it is
one gitignored file with no independent backing. Deleting it (an accident,
disk cleanup, an operator "resetting" the gateway without understanding what
that file is) makes `reserve_delivery` legitimately — by its own local
evidence — see every past `delivery_id` as brand new. Left uncaught, a
retried delivery of an event that already dispatched would be re-dispatched
a second time: a genuine duplicate mutable run, not merely a duplicate audit
entry.

The **per-task mirror is therefore also consulted as a second, independent
idempotency check**, not merely an audit convenience: once identity
resolution has produced a `task_id`, and before the preflight pre-check or
the driver runs again, the gateway looks up `delivery_id` in THAT task's own
`runs/<task_id>/gateway-events.yaml`. If it is already there at a **terminal**
outcome — `mirror_lookup` filters strictly on
`GATEWAY_MIRROR_TERMINAL_OUTCOMES` (`dispatched` / `dispatch_failed` /
`rejected_preflight`, the only outcomes `mirror_to_task` ever writes) — the
event is refused as a duplicate — recorded with the reason "central ledger
had no record of it" — even though the central ledger's own reservation said
"fresh." A mirror entry at any OTHER outcome (`in_progress`, or a forged /
crash-orphaned entry) is deliberately NOT treated as evidence of completion:
an earlier version of this check matched on `delivery_id` alone, which meant
a non-terminal or forged mirror row for an id that never actually ran could
permanently block the first GENUINE delivery of that id — a self-inflicted
denial-of-service, not a safety improvement. `tests/integration/event-gateway.sh`
C6 pins this: a planted `in_progress` mirror entry does not stop the real
dispatch. This is what makes losing the ledger file a loss of *convenience
audit trail on retry*, not a loss of the safety property itself: recovering
from it costs one extra file read per dispatch, on the one path (an
already-resolved task) where it can matter. It cannot help a delivery that
never resolved to a task in the first place (`rejected_command` /
`rejected_identity` / `rejected_malformed`) — those never had anywhere to
mirror into, and remain the central ledger's responsibility alone.
`tests/integration/event-gateway.sh` L1 reproduces the ledger-loss scenario
itself (dispatch, delete the ledger, redeliver the identical event, assert
exactly one `run-records/` entry).

This is also why the ledger stays the *primary* store rather than being
replaced outright by the per-task mirror: the mirror cannot exist before a
task does, and "no task yet" is a legitimate fresh state, not a loss to
recover from — the two stores answer different questions and neither
subsumes the other.

### Residual risk: losing BOTH files

Everything above recovers from losing `runs/_gateway/ledger.yaml` ALONE,
because the per-task mirror is a second, independent copy of the same fact.
It does **not** cover losing `runs/_gateway/ledger.yaml` AND the task's own
`runs/<task_id>/gateway-events.yaml` together — at that point the gateway's
idempotency protection is gone entirely, by construction: there is no third
store to recover from.

What actually stops a duplicate in that narrow window, verified under audit
rather than assumed, is **not** anything this issue built. It is whichever
of two unrelated, pre-existing guards happens to still apply:

- For a **concurrent** redelivery (both requests in flight at once), #14's
  ownership lease refuses the second `run-agent.sh` invocation outright
  ("ownership refused... held by run..."), because the first run still holds
  the lease. This is a real, designed guard — but it is #14's, not this
  issue's, and it only helps because the two dispatches overlap in time.
- For a **sequential** redelivery — the first dispatch has already
  completed and released its lease before the second one arrives — the
  ownership lease is gone by the time the second request runs, and it does
  **not** catch this case. In the audited reproduction, the second dispatch
  was instead caught incidentally by `run-agent.sh`'s own routing-state
  check (the task's `current_agent` no longer matched the role being
  dispatched, because the first run had already moved it on) — a
  side-effect of unrelated state, not a designed protection against replay,
  and not something a task in a different phase/routing state is guaranteed
  to hit.

Losing both files at once is therefore a genuine, undefended gap: this
gateway's idempotency guarantee holds only as long as at least one of its
two stores survives. Restoring `runs/_gateway/` (and the mirrors under
`runs/<task>/gateway-events.yaml`) from backup, or from git history if a
change happened to touch them before deletion, is the only real mitigation
available today. A future hardening — e.g. a third, independently-located
idempotency record, or making one of the two stores git-tracked so it
cannot be silently lost the way a gitignored file can — is out of scope for
this issue and not assumed by anything above.

### A reservation that never reaches a terminal outcome

A process can be killed (OOM, host failure, a `kill -9`) between
`reserve_delivery` (which writes `outcome: in_progress`) and its own later
`finalize_delivery` call. Without a recovery path, that one `delivery_id`
would report `duplicate: in_progress` **forever** — every future retry sees
a live-looking reservation with no way to ever complete it, a permanent
silent stuck state with no operator recourse short of hand-editing the
ledger.

The fix mirrors the self-healing lease idiom #14 already uses
(`docs/task-ownership.md` "Timing"): a reservation stuck at `in_progress`
for longer than `RESERVATION_STALE_SECONDS` (900 — 15 minutes, hardcoded in
`scripts/event-gateway.rb`; generous relative to any real dispatch, whose
command/identity/preflight steps resolve in well under a second and whose
slowest step, the driver call, normally finishes in seconds to low minutes)
is treated as abandoned. The *next* delivery of that same `delivery_id`
reclaims the row in place — appending an audited `reclaimed_stale` stage
entry (the prior attempt's history is never erased, only marked) — and
proceeds as a fresh reservation. A reservation still within the window is
NOT reclaimed early; it is refused as a live duplicate, exactly as before.
`tests/integration/event-gateway.sh` R1/R1b cover both cases. There is
deliberately no *automatic* background sweep for this — reclamation only
happens lazily, on the next delivery of the SAME id, which is the only
moment a decision is actually needed.

## Ordering: the pre-check, and why it sits where it does

`run-agent.sh` creates the task directory for a brand-new `pm` dispatch
(`mkdir -p "$TASK_DIR"`) **before** it runs its own preflight gate
(`docs/policy-preflight.md`, "Invoking the gate"). That ordering is
pre-existing, is not specific to the gateway, and this issue does not change
it — `run-agent.sh`'s gate is still the real, authoritative enforcement.

What the gateway adds is a check of its own, positioned so an unvetted event
never reaches that `mkdir` at all:

1. Normalize, reserve the delivery, resolve the command, and attempt identity
   resolution (which, for the mint path, only decides *that* a mint would be
   needed — it does not mint yet).
2. Call `decide_or_deny` — the exact decision function `scripts/preflight.rb`
   itself uses — **as a library**, with the identical request the driver will
   later construct (`source`, `role`, no path scope, the raw body as the
   input file). `decide_or_deny` is a pure function of policy + request: it
   computes an outcome and returns it; it does **not** touch disk (only the
   CLI branch at the bottom of `preflight.rb`, guarded by
   `if $PROGRAM_NAME == __FILE__`, writes a record — and that branch never
   runs when the file is `require_relative`d as a library, which is how this
   file consumes it).
3. Only if that pre-check's outcome is `allow` or `allow_with_deep_review`:
   for the mint path, mint the task id and record the mapping now; then
   invoke `./run-agent.sh <task_id> <role>` with the documented env contract.
4. `run-agent.sh` re-runs preflight itself and writes the real record. This
   is deliberate duplication, not waste: the driver's own gate is the actual
   enforcement point (already hardened over two audits), and re-running a
   cheap, deterministic, side-effect-free decision function twice — once to
   decide whether to proceed at all, once for the record — costs nothing and
   removes any need to trust the pre-check's answer instead of the real one.

The two calls see the same policy (nothing mutates it between them) and the
same request, so in the overwhelming case they agree. If they ever disagreed
— a hypothetical operator edit to `office.config.yaml` landing in the
milliseconds between them — the **driver's** decision is what governs the
dispatch; the pre-check only ever gates whether the driver runs at all.

## Structured audit metadata

Every delivery gets one ledger row with a `stages` array, appended to (never
overwritten) at each checkpoint:

| Stage | When | Records |
|---|---|---|
| `intake` | Before task resolution | that the envelope normalized and was reserved |
| `command` | Before task resolution | the resolved command + role, or the rejection reason |
| `resolve` | At task resolution | the resolved/minted/rejected task identity |
| `dispatch` | At dispatch | the preflight pre-check outcome and, if it proceeded, the driver's exit code |

`ruby scripts/event-gateway.rb handle ...` never raises past its own
top-level guard: an unanticipated failure anywhere in the pipeline is caught
and reported as `rejected_malformed`, mirroring `scripts/preflight.rb`'s own
`decide_or_deny` total guard — a bug in this file is a recorded rejection,
not a silent skip and not a crash with no audit trail.

## Adapters: one shared envelope shape

Both normalizers in `scripts/event-gateway.rb` (`normalize_github`,
`normalize_test`) produce the identical shape:

```yaml
source: string          # caller-declared origin; checked by preflight trust
delivery_id: string      # idempotency key
external_ref: string|nil # stable external identity ("owner/repo#17"), or nil
task_id: string|nil      # an EXPLICIT, already-resolved task reference, or nil
body: string              # untrusted free text — read for the command's first
                           # line, then hashed/scanned by preflight, never
                           # parsed for anything else
meta: {}                  # passthrough bookkeeping for the audit record only
```

Nothing downstream of `normalize()` branches on which adapter produced the
envelope — command resolution, identity resolution, the preflight pre-check,
and dispatch all operate on this one shape.

- **GitHub** (`normalize_github`): takes a realistic subset of an
  `issue_comment` webhook body — `action`, `issue.number`, `comment.id`,
  `comment.body`, `repository.full_name` — plus an optional `delivery_id`.
  Only `action: created` is handled; anything else is rejected
  (`rejected_malformed`) rather than silently ignored, so an `edited`/`deleted`
  event still leaves an audit trail. Does not verify a webhook signature and
  does not fetch anything over the network.
- **Test/generic** (`normalize_test`): a small, already-close-to-internal
  YAML/JSON envelope. This is what this repo's own tests drive directly, and
  what a future tester/task-board integration would produce without going
  through GitHub's shape at all.

## What this does not defend against

- **Webhook authenticity.** This gateway normalizes an *already-received*
  payload. It does not verify a GitHub webhook signature (`X-Hub-Signature-256`)
  or any other transport-level authenticity check — that is explicitly out of
  scope for this issue and must be handled by whatever receives the webhook
  before calling this gateway.
- **Delivery-id collision across sources.** Idempotency is keyed purely on
  `delivery_id`. If two different callers ever produced the same
  `delivery_id` for two different logical events, the second would be
  (incorrectly) treated as a duplicate of the first. The GitHub adapter's
  fallback derivation (hash of repository/issue/comment id/action) makes this
  very unlikely in practice but does not make it impossible — a comment
  legitimately edited and re-delivered with the same id, for instance, is
  indistinguishable from a retry by design (see "Idempotency" above).
- **Command availability, not command *safety*.** `gateway.commands` only
  decides *which role* an event may dispatch as. It does not, by itself,
  decide what that role is *allowed to do* — that is entirely
  `preflight.role_actions` and `preflight.decision_matrix`'s job (#17), and
  those are unmodified by this issue.
- **A compromised `office.config.yaml`.** If an attacker can edit the
  committed config (not a gitignored overlay — those are already blocked by
  `PROTECTED_PATHS`, see #17), they can remap `gateway.commands` or
  `preflight.role_actions` directly. That is a repository-integrity problem,
  not something this gateway is positioned to detect.
- **Capturing `handle`'s output via `$(...)`.** A dispatch that acquires
  ownership (#14) starts a background lease-renewer subshell in
  `run-agent.sh` that inherits the driver's stdout file descriptor and can
  outlive it by up to `ownership.renew_interval_seconds` before its own
  teardown reaps it. A caller that captures `ruby scripts/event-gateway.rb
  handle ...`'s output with command substitution (`out=$(...)`) will block
  until every holder of that pipe closes it — including the outliving
  renewer — even though the gateway itself has already finished and exited.
  Redirect to a file and read it back instead (`>out.log 2>err.log`, then
  read `out.log`); `tests/integration/event-gateway.sh` does exactly this,
  matching the existing idiom in `tests/integration/reviewer-evidence-risk.sh`.
  This is a property of `run-agent.sh`'s renewer, not something this issue
  changes or fixes.
- **Volume / rate limiting.** Nothing here throttles how often a source may
  submit events. A trusted-but-compromised source that is allowed to dispatch
  can still dispatch as fast as it can submit distinct `delivery_id`s.
- **`/agent triage` cannot be denied by the shipped policy.** `pm`'s action is
  `comment`, and `preflight.decision_matrix` never maps `comment` to `deny` at
  any trust/sensitivity combination in the config this repo ships (the worst
  case is `allow_with_deep_review`, for an untrusted, critical-scored
  request). In practice this means ANY source — trusted or not — that sends a
  literal `/agent triage` will have a task minted for it; the preflight
  pre-check still runs and is still obeyed (a policy override that genuinely
  denies, such as `preflight.enabled: false`, does stop the mint — see
  `tests/integration/event-gateway.sh` O1), but the shipped matrix itself
  never produces that outcome for this one action. A project wanting to gate
  who may create tasks via the gateway more tightly should tighten
  `preflight.decision_matrix.untrusted.comment` in its own `office.config.yaml`
  (a committed change, not a gitignored overlay — that key is protected).
- **The mint path is intentionally minimal.** `/agent triage` mints exactly a
  task id and a mapping entry, then hands off to `run-agent.sh pm` exactly as
  an operator-run `./run-agent.sh <new-id> pm` would. It does no PM-specific
  reasoning of its own about the incoming issue (title, scope, labels) — that
  remains the `pm` agent's job once dispatched.

## Exit codes

`ruby scripts/event-gateway.rb handle --adapter <github|test> --input-file <f> [--dry-run]`
prints `"<delivery_id> <outcome>"` on stdout and exits:

| Exit | Outcome | Meaning |
|---|---|---|
| 0 | `dispatched` | the driver ran and exited 0 |
| 1 | `dispatch_failed` | the driver ran and exited non-zero |
| 10 | `duplicate` | this `delivery_id` was already reserved/processed |
| 11 | `rejected_command` | no line-1 literal match in `gateway.commands` |
| 12 | `rejected_identity` | task identity did not resolve deterministically |
| 13 | `rejected_preflight` | the pre-check denied, or required human approval |
| 14 | `rejected_malformed` | the payload/envelope did not normalize, or an internal fault |
| 2 | usage error | bad CLI arguments |
