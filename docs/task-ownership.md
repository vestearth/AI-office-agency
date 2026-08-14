# Task Ownership And Execution Leases

The per-task `.lock` already exists and is not going anywhere. It makes one
read-modify-write atomic, and `tests/integration/concurrent-status-writes.sh`
pins that with 40 concurrent writers.

It answers a different question from this one. `.lock` says *"this write will
not be torn"*. It says nothing about *"who owns this task right now"*: two
dispatches can take that lock in turn and both write, each perfectly
atomically, and the later one silently overwrites the earlier one's routing.
Ownership is the layer on top — a task-scoped mutual-exclusion register, held
for the length of an execution, tied to the active `run_id`
([run-records.md](run-records.md)).

Shape: [ownership.schema.yaml](../schemas/ownership.schema.yaml).
Writer and engine: [`scripts/task-ownership.rb`](../scripts/task-ownership.rb).
Tests: `tests/integration/task-ownership.sh`.

## The record

```yaml
task_id: TASK-EAR-259
epoch: 3                                  # fencing token, monotonic, never reset
holder:                                   # null when nobody holds the task
  run_id: run-20260815T101500Z-TASK-EAR-259-dev-k3f9a2
  agent: dev
  worktree: /Users/earth/Documents/GitHub/ai-dev-office
  mode: exclusive                         # exclusive | shared (worktree claim)
  acquired_at: 2026-08-15T10:15:00Z
  renewed_at: 2026-08-15T10:22:31Z
  lease_expires_at: 2026-08-15T10:52:31Z
released_at: null
release_reason: null
history:                                  # every displaced holder, in order
  - epoch: 2
    run_id: run-20260815T094000Z-TASK-EAR-259-dev-9ab2cd
    agent: dev
    worktree: /Users/earth/Documents/GitHub/ai-dev-office
    acquired_at: 2026-08-15T09:40:00Z
    ended_at: 2026-08-15T10:15:00Z
    ended_by: reclaimed                   # released | reclaimed | superseded
    reason: lease expired at 2026-08-15T10:10:00Z
updated_at: 2026-08-15T10:22:31Z
```

The five fields the issue asks for (`run_id`, `agent`, `worktree`,
`acquired_at`, `lease_expires_at`) are all there, nested under `holder` rather
than flat. That is the one shape deviation, and it buys something concrete:
"nobody owns this task" is `holder: null`, one unambiguous value, instead of
five independently-nullable fields that can disagree with each other.

`epoch` is the part the issue does not sketch and the design turns on. It is a
fencing token: every *grant* increments it, monotonically, for the life of the
task. Renewal does not. A holder is identified by `run_id`; `epoch` is what
makes "which generation of ownership is this" auditable after the fact.

## Storage

```
runs/<task-id>/ownership.yaml
```

One mapping per task, at a well-known path. Why not the alternatives:

- **Not `status.yaml`** — status is the workflow source of truth (*where the
  task is*), consumed by 369 existing runs, the validator, and the dashboard.
  Ownership is execution-layer state on a completely different clock: it churns
  on every renewal, which would rewrite status.yaml and its `updated_at` for
  reasons that have nothing to do with the workflow. The decisive reason is
  narrower: the fence has to decide *whether status.yaml may be written*, and
  `sync_status_from_output` already handles a corrupt status.yaml by bailing out
  (exit 4). Ownership living inside the file it guards would mean a corrupt
  status also destroys the record of who owns it.
- **Not `meta.yaml`** — that is the append-only event log. Ownership is mutable
  current state, and a renewal would rewrite the entire event log, widening
  exactly the read-modify-write window `concurrent-status-writes.sh` exists to
  pin. (Ownership *transitions* are still logged there as events; the register
  is not.)
- **Not `run-records/<run_id>.yaml`** — a run record is append-only history of
  one run, and it is keyed by the run id. Ownership must be findable *without
  already knowing who holds it*: "may I write to this task?" has to be one read
  at a known path, not a directory scan-and-sort.
- **Not a global lock table** — out of scope by the issue's own boundary
  (no distributed consensus, no scheduler). Repo-local, per-task, at the same
  granularity as the `.lock` it complements.

`ownership.yaml` is **additive**. A task with no such file is *ungoverned*: it
behaves exactly as it did before this existed. Every one of the 369 existing
`runs/TASK-*` is in that state, and none of them changed.

## Rules

All five operations serialize on the same per-task `.lock` every other writer
takes.

| Operation | Rule |
|---|---|
| **acquire** | Granted when there is no record, no holder, the lease has lapsed, or the holder is *this same run* (idempotent). Otherwise **refused**, exit 9. Every grant bumps `epoch`. |
| **renew** | Extends `lease_expires_at` only while the holder is still this run. A run that lost the lease is told so and refused — it never silently re-takes it. `epoch` is unchanged. |
| **refuse** | Any other live holder; an unreadable/incoherent ownership record; an unreadable or malformed config; a worktree conflict. Always exit 9, always with the reason and the release command. |
| **reclaim** | Is `acquire` against a lapsed lease. The zombie holder is archived into `history` with `ended_by: reclaimed` and the reason, so an abandoned run is auditable rather than merely gone. |
| **release** | Holder-only (an operator can pass `force=true`, archived as `superseded`). Clears `holder` immediately, so the next run does *not* wait out the remaining lease. Called on completion, on runner failure, and on the escalation exits of `run-agent.sh`. |

### Only one mutable owner

Directly from the acquire rule: a live holder refuses every other run. 20
concurrent acquires against a fresh task produce exactly one exit 0 and 19 exit
9s, and `epoch` lands at 1 (O1 in the test).

### The one exception: parallel dev lanes

`run_parallel_dev_agents` dispatches `dev` and `dev-2` **on the same task at the
same time**, on purpose. That is not two rival owners; it is one dispatch with
two sub-executions, and they already set
`AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true` so that neither lane writes
status — the parent auto runner routes once both finish. So a lane running with
`AI_DEV_OFFICE_PARALLEL_AUTO=true` does not take the lease at all. Making them
take it would have lane 2 refuse lane 1, which is exactly what
`tests/integration/auto-parallel.sh` fails on (verified: without the exception
that suite fails at scenario 1). They lose nothing by not holding it, because
the thing a lease protects — a status write — is something they never do.

### Worktree control

`worktree` alone cannot prevent two *different tasks* from mutating the same
checkout, because leases are per-task. So `acquire` also scans every sibling
`runs/*/ownership.yaml` and refuses when another **live, exclusive** holder
names the same worktree. Sharing is possible only when declared: `mode=shared`
on the acquire, or `ownership.allow_shared_worktree: true` in config.

That scan runs under a repo-scope lock, `runs/.ownership.lock`, taken *before*
the task `.lock`. Nothing else in the harness takes the repo lock, so the
ordering cannot invert. A sibling record that cannot be read refuses the grant —
an unreadable neighbour is not evidence that a worktree is free.

### Worktree detection

Detected, not required: `git rev-parse --show-toplevel` from the working
directory, which resolves to the checkout of a *linked* worktree exactly as it
does for a primary one — which is what this repo now actually runs agents in
(`.claude/worktrees/`). It is recorded, never trusted:

- a caller may override it with `worktree=<path>`;
- when detection fails (no git, not a working tree) the field is `null`;
- **a null worktree never matches another null worktree** in the conflict scan.
  "Unknown" is not evidence of sameness, so an undetectable worktree degrades to
  no cross-task worktree protection rather than to spurious refusals.

## The fence: a stale owner cannot overwrite a newer owner

This is the sharp requirement, and it is the classic lost-update-after-reclaim:

1. run A acquires the task and starts a long dispatch;
2. A's lease lapses (A wedged, the machine slept, the operator ^C'd the shell);
3. run B reclaims the task and writes status;
4. A wakes up and writes *its* status, silently reverting B.

Step 4 is stopped by checking ownership **inside the same critical section as
the write**. `sync_status_from_output` and `force_status_route` already open
`runs/<task>/.lock` and `flock(LOCK_EX)` before their read-modify-write; the
fence (`TaskOwnership.fence!`) is called immediately after that `flock` and
before the load, and it deliberately does *not* lock again — the caller holds
it. Check and rename therefore share one critical section, so no reclaim can
interleave between "the fence said yes" and "the file landed". That is what
makes this a property rather than a hope.

The fence's five outcomes:

| State | Outcome |
|---|---|
| no `ownership.yaml` | **allow** — ungoverned task, additive by design |
| record present, `holder: null` | **allow** — released, or never held |
| holder is this run | **allow**, and renew the lease in place |
| holder is another run | **REFUSE**, exit 9 |
| record present but unreadable/incoherent | **REFUSE**, exit 9 |
| holder present, writer carries no `run_id` | **REFUSE**, exit 9 |

`sync_status_from_output` exiting 9 lands in the driver's existing "Status sync
aborted (rc=…); not propagating downstream" branch, so a fenced-out run stops
loudly and changes nothing.

### Why "holder is this run" also renews

Consider a dispatch that legitimately outruns its own lease. If an expired
lease made its own owner's write illegal, the harness would punish slow work.
So an expired-but-still-mine lease self-renews at the fence, atomically. It is
safe precisely because it happens under the lock: the *only* way to stop being
the holder is another run explicitly reclaiming, and once that happens the
`run_id` no longer matches and the stale run can never write again.

That gives a clean invariant, which the test asserts in both orderings:
**when a stale write and a reclaim race, exactly one wins.** Either the reclaim
lands first and the stale write is fenced out (exit 9, `status.yaml`
byte-identical), or the stale write lands first — which self-renews its lease,
so the reclaim is the one refused. Never both.

The test proves this with a real interleave rather than a flag: a third process
takes the task `.lock` and holds it while the stale writer and the reclaimer are
both launched and both block on it; the holder is then killed and the two
proceed back to back with no gap. The launch order alternates round to round so
both orderings are exercised (`stale_first=3 reclaim_first=3 both=0`).

## Timing

| Knob | Default | Meaning |
|---|---|---|
| `ownership.enabled` | `true` | Master switch. `false` (or `AI_DEV_OFFICE_OWNERSHIP=off`) makes acquire/renew/release no-ops and the fence pass through — loudly, if a live holder exists. |
| `ownership.lease_seconds` | `1800` | Lease length granted by acquire and by each renewal. |
| `ownership.worktree_exclusive` | `true` | Enforce the cross-task worktree scan. |
| `ownership.allow_shared_worktree` | `false` | Blanket opt-in to sharing a worktree. |

**30 minutes** covers a long agent dispatch with wide margin while still
letting a genuinely dead run be reclaimed inside one coffee break.

**When renewal fires.** There is no background heartbeat, deliberately — the
runner call is one blocking foreground process, and a daemonised renewer would
buy a small window at the cost of orphan processes. Instead:

- the fence renews on **every status write** by the holder;
- `scripts/task-ownership.rb renew` is available for an explicit renewal.

**So what happens to a run that is slower than its lease?** It does not lose its
own task. Its lease lapses, but a lapsed lease is not a lost one — the task is
merely *reclaimable*, and if nobody reclaims, the run's next status write
self-renews and proceeds normally. The honest cost is the window: between expiry
and that write, another run *may* legitimately take the task, and if it does,
the slow run is fenced out and stops with a loud refusal rather than corrupting
state. Raise `lease_seconds` if dispatches in your setup routinely run longer.

## Fail safe

Every ambiguous state resolves to *refuse and say why*, never to a silent
free-for-all:

- **unparseable `ownership.yaml`** → every operation refuses (exit 9), naming
  the parse error;
- **structurally valid but incoherent** (no integer `epoch`, holder missing
  `run_id`/`acquired_at`/`lease_expires_at`, a `lease_expires_at` that is not
  ISO-8601 UTC, an unknown `mode`) → refuse. An unparseable timestamp is never
  read as "long ago";
- **malformed config** (`lease_seconds: "forever"`, a non-boolean flag) →
  refuse, naming the offending key, and **write nothing**. A silently-defaulted
  lease is a silently-disabled mutual exclusion;
- **unparseable `office.config.yaml`** → refuse;
- **an unreadable sibling record** → refuse the worktree-exclusive grant;
- **`scripts/task-ownership.rb` missing while `ownership.yaml` exists** → the
  status writers refuse rather than fall through unfenced.

The one deliberate non-refusal is a *missing* record, which means the task was
never governed. That is the difference between "no answer yet" and "an answer I
cannot read", and it is what keeps this additive.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | granted / renewed / released / write allowed |
| 2 | usage error |
| 3 | store error (task dir missing, unwritable) |
| **9** | **REFUSED** — a conflicting owner, unreadable state, or unreadable config |

`run-agent.sh` treats 9 from `acquire` as fatal for the dispatch (continuing
would be exactly the lost update this exists to prevent) and propagates it.
Release, by contrast, is best effort: a lease that outlives its run is
reclaimable by definition.
