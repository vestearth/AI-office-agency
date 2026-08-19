# Task Input Integrity

Three consecutive independent audits defeated the deterministic review gate
([reviewer-policy.md](reviewer-policy.md), issue #12) after the first two
rounds of fixes closed everything closeable *inside* the gate's own rules.
Every remaining escape had the same root: the reviewer runs as
`codex --ask-for-approval never exec` with `file_write: true` and
`shell_exec: true` ([`runners/codex.yaml`](../runners/codex.yaml),
[`run-agent.sh`](../run-agent.sh)), and nothing distinguished "the output this
agent is supposed to write" from "the record it is judged against". A rule
cannot defend the data it reads. This file adds a mechanism outside the gate
that does.

Shape (audit log, not the protected files themselves — those have their own
existing schemas): [`task-input-integrity.schema.yaml`](../schemas/task-input-integrity.schema.yaml).
Engine: [`scripts/task-input-integrity.rb`](../scripts/task-input-integrity.rb).
Wired into: [`run-agent.sh`](../run-agent.sh) (`task_input_integrity_snapshot`
/ `task_input_integrity_verify`). Tests:
`tests/integration/task-input-integrity.sh`.

## The four escapes this closes

Proven end-to-end through the real driver at
`OFFICE_EVIDENCE_POLICY_MODE=required`, each reaching `phase=done` on an
unbacked change touching wallet and auth paths, before this issue:

1. **Delete the upstream record** — `rm dev-output.yaml` + `rm meta.yaml` +
   blank `status.yaml` history → `risk_level=low gaps=0`.
2. **Rewrite history instead of deleting it** — rename `history[0].agent`
   from `dev` to `claude` (a free string, not enum-checked) → same result.
3. **Edit the upstream record rather than removing it (quietest)** — rewrite
   `dev-output.yaml` to declare `docs/readme.md` instead of the real paths →
   `gaps=0`.
4. **Self-record trivial evidence** — run the real
   `scripts/record-evidence.sh` on `true` and `echo nothing-was-built`, cite
   the returned ids as build/test evidence → valid hash, valid `repo_sha`,
   `gaps=0` on a high-risk approval.

(1)-(3) are closed here. (4) is explicitly **not** — see
["What this does not defend against"](#what-this-does-not-defend-against)
below.

## Mechanism: snapshot + hash, not a restricted working copy

The issue named two candidate mechanisms:

- **(a) snapshot + hash** the protected file set before dispatch, verify
  after, treat a mismatch as a hard failure recorded in run history.
- **(b) dispatch the agent against a task directory where only its own output
  path is writable** (filesystem permissions or a restricted working copy).

This implements **(a)**, per the issue's own steer: *"Prefer the boring
mechanism. A hash comparison over a named file set is easy to reason about at
2 AM; a permissions model spread across the runner, the driver, and three
contracts is not."*

Concretely, (b) would also have needed:

- The runner subprocess (`codex`/`cursor`, `runners/*.yaml`) to run with a
  filesystem view where every protected file is read-only or absent, while
  the agent's own `<agent>-output.yaml` path (and its working tree checkout,
  which is a *different* filesystem entirely — see
  ["What this does not defend against"](#what-this-does-not-defend-against))
  stays writable.
- That view to be re-derived per role (the writable file differs for every
  dispatch), which is exactly the "runner's permission model configurable
  per role" this issue explicitly puts out of scope as a candidate follow-up.
- No portable, dependency-free way to enforce it across the two supported
  runner backends without OS-level sandboxing or containers, which is also
  explicitly out of scope (no new dependencies, no containers).

(a) needed none of that: one Ruby script, two named hook-point calls, and a
config block. It was implemented, tested against real tamper reproductions,
and even then needed one real bug fix (`meta.yaml`, below) found by running
it — that fix was a five-line config change, not a redesign. That responsiveness
to a real bug is itself evidence for "boring and easy to reason about."

## The protected set

Configured in `office.config.yaml` under `task_input_integrity:` (see the
shipped file for the live values; defaults live in
`scripts/task-input-integrity.rb::DEFAULT_FROZEN_FILES` /
`DEFAULT_APPEND_ONLY_FILES`, used only if the block is entirely absent — an
office that predates this issue). The whole block, not just `enabled`, is
listed in `scripts/resolve-office-config.rb::PROTECTED_PATHS` — see
["Why `enabled` is fully protected"](#why-enabled-is-fully-protected).

| File | Class | Why | Legitimate mid-dispatch writer (if any) |
|---|---|---|---|
| `status.yaml` | frozen (byte-exact) | routing state; `history[].agent` is the exact field escape 2 rewrote | none — only `sync_status_from_output`, which runs *after* verify |
| `preflight.yaml` | frozen | opt-in trust/sensitivity decision, must predate the dispatch it gates | none — written before snapshot, by the preflight block |
| `evidence-freshness.yaml` | frozen | issue #15's staleness ledger the gate consults | none within one dispatch |
| `gateway-events.yaml` | frozen | issue #19's gateway mirror — authored by the gateway *before* dispatch, not by the running agent (see below) | none |
| `<role>-output.yaml` for every role **except** the one currently dispatching | frozen | exactly the "upstream record" escapes 1 and 3 deleted/rewrote | none — the currently-dispatching role's *own* output is excluded and stays freely writable |
| `meta.yaml` | append-only (`events` grows) | the append-only dispatch log; deleting it is escape 1's second file | **the driver itself**, inside this exact window (see below) |
| `evidence.yaml` | append-only (`evidence` grows) | the append-only evidence ledger evidence #4 abuses the trustworthiness of, without touching its append-only-ness | the dispatched agent, via `scripts/record-evidence.sh`, which is the *sanctioned* way to record real evidence mid-run |
| `run-records/*.yaml` (all but the current run's own record) | existence-only | run identity/provenance history; silently deleting an old run's record is the same shape as escape 1 | none |
| `ownership.yaml` | **not protected** | see below | the background lease renewer, inside this exact window |

### `ownership.yaml` — deliberately excluded

`ownership.yaml`'s own epoch-fencing mechanism
([task-ownership.md](task-ownership.md)) already protects the property that
matters (exactly one mutable owner, a stale owner cannot overwrite a newer
one's status). Its background lease renewer legitimately rewrites the file
*inside this exact snapshot/verify window* on any dispatch longer than
`ownership.renew_interval_seconds` (300s by default) — freezing it byte-exact
would false-positive on every such run. It was not made append-only either:
`ownership.yaml` is a single current-state record, not a ledger, so "existing
entries survive, growth is fine" does not apply to it the way it applies to
`meta.yaml`/`evidence.yaml`. It is out of scope here on its own merits, not
by omission.

### `gateway-events.yaml` — protected, on different footing than the rest

Every other file in the table can, in principle, be written by something
running *during* the dispatch (the driver, or — before this issue — the
agent). `runs/<task>/gateway-events.yaml` is different: issue #19's event
gateway writes it once, before the dispatch it triggers even begins, as the
record of the decision to dispatch at all. That makes it closer in shape to
`preflight.yaml` (an upstream, pre-dispatch decision) than to `meta.yaml` (an
in-flight log) — hence frozen, not append-only. It is listed because the
issue asked to decide it explicitly: nothing currently writes it mid-dispatch,
so protecting it costs nothing, and a future change that *did* write it
mid-dispatch would need to move it to `append_only_files` the same way
`meta.yaml` had to move.

### `meta.yaml` — a real bug found while building this

`meta.yaml` was initially placed in the byte-exact set (it is, after all, the
literal "driver-authored, not agent-authored" file the escapes target). That
broke immediately: the line right after `task_input_integrity_snapshot` is
itself a `log_meta_event` call recording that the snapshot was taken, so
`meta.yaml` changes on the very next line of `run-agent.sh` after every
snapshot. `run_runner_with_fallback`'s own `runner_retry`/`runner_switch`
events, and the `runner_complete` event logged right before `verify` runs,
are further legitimate writes inside the same window. Reproduced manually: a
single legitimate retry event tripped `verify` at rc=9 with zero attacker
involvement. Fixed by moving `meta.yaml` into `append_only_files` (`events`
grows) — the same treatment `evidence.yaml` already had, for the same reason:
both are append-only ledgers with a legitimate in-window writer, not
single-owner state files. `tests/integration/task-input-integrity.sh` pins
this regression directly (a bare retry/append with zero tampering must verify
clean).

## Why `enabled` is fully protected

`ownership.enabled` and `preflight.enabled` are deliberately left overridable
by a local/profile overlay: they are **kill switches**, and turning either
off *denies* privileged behavior — the safe direction for an accidental or
malicious local override. `task_input_integrity.enabled: false` is the
opposite: it **removes** a protection. A gitignored
`office.config.local.yaml` line flipping it off would silently recreate every
one of the four proven escapes with zero trace in `git status` — exactly the
vulnerability class `resolve-office-config.rb`'s own docstring warns about
("one gitignored line... turns every later denial into an allow"). So the
whole `task_input_integrity:` block, `enabled` included, is listed in
`PROTECTED_PATHS` as a single top-level entry — an overlay cannot weaken any
key under it, including turning it off.

## The two hook points

Both are small, named function calls in `run-agent.sh` — not inlined into
the middle of existing control flow, so a rebase against issue #16's
execution-budget-guard changes (touching the same dispatch path
concurrently) stays mechanical.

```
prompt_assembly logged
ownership_acquire done
  ↓
task_input_integrity_snapshot "$AGENT"      # <-- hook 1: after every driver
log_meta_event ... task_input_integrity_snapshot   pre-dispatch write, before
                                                     the runner subprocess starts
  ↓
run_runner_with_fallback "$RUNNER"          # the actual codex/cursor subprocess,
                                             # file_write:true, shell_exec:true
  ↓
record_run_update finish ...
log_meta_event ... runner_complete
task_input_integrity_verify "$AGENT"        # <-- hook 2: after the runner
  (exit 9/other -> hard failure, do NOT     #     returns, before enforce-
   reach enforce-output-contract.rb or      #     output-contract.rb or
   sync_status_from_output)                 #     sync_status_from_output
  ↓
enforce-output-contract.rb / sync_status_from_output (only reached if clean)
```

Snapshot is taken *after* `ownership_acquired`/`prompt_assembly` are logged
(the driver's own legitimate pre-dispatch writes to `meta.yaml`) so those are
never flagged; verify runs *before* the agent's `<agent>-output.yaml` is
enforced or synced into `status.yaml`, so a tampered dispatch never reaches
`ReviewGate.evaluate` or any downstream routing at all — it exits with the
verify exit code, releases ownership with reason `"task input integrity
violation"`, and neither `record_run_update` nor `sync_status_from_output`
runs.

## Fail-closed rules

| Baseline state at snapshot time | State at verify time | Verdict |
|---|---|---|
| File absent (e.g. a brand-new task has no `evidence.yaml` yet) | Still absent | **Clean.** Absence-to-absence is a normal task-lifecycle state, not a tamper signal. |
| File absent | Now present (frozen files only) | **Tampered — `appeared`.** A protected file that did not exist should not be fabricated mid-dispatch (e.g. planting a fake `dev-output.yaml`, `preflight.yaml`, or `gateway-events.yaml` where none existed). Append-only files are exempt from this rule by design: a task's *first* `evidence.yaml` (or, in principle, `meta.yaml`) legitimately comes into existence via its sanctioned writer. |
| File present, hash H | Still present, same hash | **Clean.** |
| File present, hash H | Absent | **Tampered — `deleted`.** This is escape 1's exact shape. |
| File present, hash H1 | Present, hash H2 ≠ H1 (frozen files) | **Tampered — `modified`.** This is escapes 2 and 3's exact shape. |
| File present, N entries, hashes [h0..hN-1] | Present, entries [0..N-1] hash-identical, M ≥ N entries total | **Clean** (append-only files only — growth is legitimate). |
| File present, N entries | Present, fewer than N entries | **Tampered — `truncated`.** |
| File present, N entries | Present, N+ entries but entry *i* < N changed | **Tampered — `rewritten`**, reporting the first diverging index. |
| Snapshot file itself missing at verify time | — | **Hard failure, `baseline_missing`-shaped** (a `Failure` raised by `verify`; the CLI dies with exit `STORE_ERROR=3`). A missing baseline is indistinguishable from an attacker deleting it to dodge verification — treated exactly as hard as a genuine mismatch, never as "nothing to check." |
| Snapshot file unreadable/malformed YAML at verify time | — | Same as above — refuses rather than trusting a corrupt or partial baseline. |
| A protected file was unreadable (permissions, I/O error) *at snapshot time* | — | Recorded as `"exists": true` with the read failure raising `Failure`; `snapshot` itself dies (`STORE_ERROR`) rather than silently omitting that file from the protected set. An unreadable file that clearly exists is a tamper signal in its own right, never conflated with "absent." |
| `task_input_integrity.enabled: false` at snapshot time | — | `verify` short-circuits to `{"ok": true, "enabled": false}` and records nothing beyond that the check was skipped. This is the one place disabling the feature is visible in-band — see why `enabled` itself cannot be locally overridden, above. |

`run-records/*.yaml` uses **existence-only** checks, not this hash table: a
missing file that was present at snapshot is `deleted` (tampered); a present
file is never inspected for content changes. See
["Performance"](#performance) for why.

## What this does not defend against

Every prose section in this repository that has overstated a guarantee has
been caught by a later audit ([reviewer-policy.md](reviewer-policy.md)
§"Known limits" is itself the record of that happening twice). In that
spirit:

1. **Evidence-claim binding (escape 4) is explicitly not closed here.**
   `scripts/record-evidence.sh <TASK> -- true` produces a genuine record with
   a genuine hash — the hash proves the log was not edited after the fact, it
   proves nothing about whether the command verified anything. Snapshot/hash
   integrity cannot distinguish a real `go test ./...` run from `true`: both
   are real commands that really ran, really produced a log, and really
   hashed to what the record claims. Closing this needs post-hoc
   re-execution or output inspection of the *recorded command*, which this
   issue explicitly does not attempt (see "Optional partial mitigation"
   below for the one narrow, cheap thing it does add). Read a clean
   `task-input-integrity.yaml` (`verdict: ok`) as *"the recorded files were
   not tampered with,"* never as *"the recorded evidence is substantively
   real."*
2. **The working tree the agent edits is not `runs/<task>/` and is not
   protected by this mechanism at all.** This issue hashes files inside the
   task directory only. Nothing here inspects, hashes, or constrains the
   actual code changes in the target repository — that remains entirely
   `git diff`/evidence-based, exactly as before #22.
3. **A protected file's *absence* at snapshot time is trusted at face
   value.** If a prior, already-tampered dispatch left `dev-output.yaml`
   deleted and that was never caught (e.g. the feature was disabled at the
   time), a later dispatch's snapshot simply records "absent" and moves on —
   this mechanism has no memory of what *should* have existed, only of what
   changes *during the window it observes*.
4. **`run-records/*.yaml` in-place, same-size rewrites are not detected.**
   Existence-only checking (see "Performance") catches deletion, not content
   substitution of an old run's record that keeps the same filename.
5. **This does not stop a reviewer from writing an honestly bad review**, or
   from being wrong in good faith. It only stops it from rewriting the record
   the review is judged against. Everything `reviewer-policy.md` already says
   about the review gate's own rules (risk depth, evidence policy mode,
   backward compatibility) is unchanged by this issue.
6. **No OS-level sandboxing, containers, or multi-tenant isolation.** A
   sufficiently motivated tamper that operates entirely *outside* the
   protected set and the verify window (e.g. exfiltrating credentials, or
   mutating a file this office does not consider "task input" at all) is
   outside this issue's scope by design (see "Mechanism").
7. **The runner's permission model is not configurable per role.** Every
   dispatch runs with the same `file_write`/`shell_exec` grant regardless of
   role; this issue narrows what happens to *files that matter to the
   verdict*, not the process's OS-level capabilities. A follow-up issue
   scoping per-role runner permissions is a reasonable next step, but is not
   attempted here (explicitly out of scope per the issue brief).

### Optional partial mitigation (not required, not wired to block anything)

The issue allows proposing "a genuinely cheap, deterministic partial
mitigation" for the evidence-claim-binding gap, clearly separate from the
core deliverable and never blocking it. One is plausible: **reject a
build/test-typed evidence record whose recorded `command` string is empty or
a trivial no-op** (bare `true`, `:`, or a bare `echo` with no other content) —
cheap, deterministic, string-level, and does not attempt command-substance
verification (verifying `go test ./...` actually ran the real suite, versus
some other command that happens to exit 0, is the "much larger problem" the
issue explicitly says not to solve here). This is **not implemented** in
`scripts/task-input-integrity.rb` or `scripts/record-evidence.sh` — it is
named here, per the issue's instruction to "at minimum, make the gap explicit
rather than implied," and left as a candidate follow-up rather than shipped
half-clean. `tests/integration/task-input-integrity.sh` includes a test that
asserts escape 4 **remains open** today (a `record-evidence.sh <TASK> -- true`
citation still passes `task-input-integrity.yaml` with `verdict: ok`), so the
gap is enforced-as-documented, not just described.

## Performance

An ordinary single-agent run is unaffected in behaviour: nothing routes
differently, and the two calls are each a single short Ruby process reading a
handful of small files. `run-records/*.yaml` deliberately does **not**
content-hash every prior run's record on every dispatch — a task with a long
history must not make every later dispatch progressively slower. Instead it
is existence-checked only (a filename comparison against the snapshot's
recorded list), which is O(current file count under `run-records/`) via one
`Dir.glob`, not O(total history bytes) via re-reading every record. The
snapshot excludes the current dispatch's own `run_id.yaml` (it is created by
`record_run_start` before the snapshot and only updated by
`record_run_update finish` *after* verify, so there is nothing to check for
it inside the window anyway). Everything else in the protected set — the
frozen files, `meta.yaml`, `evidence.yaml` — is a small number of individually
small YAML files; hashing them is a handful of `Digest::SHA256.file` calls,
not a scan of the repository.

## Backward compatibility

A task directory with no `task-input-integrity.yaml` (every task that
predates this issue, or that never completed a runner dispatch since it was
enabled) validates exactly as before — `validate_task_input_integrity` in
`validate-yaml.rb` only runs when the file exists. `tests/integration/task-input-integrity.sh`
extracts `validate-yaml.rb` at the pre-#22 commit into the repo tree (it
resolves paths from its own location) and diffs its stdout/stderr/exit code
against the current validator across the full `runs/TASK-*` set, byte for
byte.
