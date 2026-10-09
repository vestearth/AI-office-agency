# Open a Task with Gates (#55) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `./run-agent.sh open <TASK_ID>`, a governed way for conductors to open a task that requires a completion-gate decision (presets, custom gates or `--no-gates "<reason>"`). Gates are declared with the writer's record construction.

**Architecture:** Four tasks, each building on the previous:
1. **`tasks/templates/gate-presets.yaml` and `scripts/gate-presets.rb`** load, normalize and compose the presets.
2. **`scripts/task-namespace.rb`** mirrors `run-agent.sh`'s namespace rules, with the same messages.
3. **`scripts/open-task.rb`** opens the task: it checks everything first, then creates the directory atomically and writes the files. A failed write rolls the open back. `run-agent.sh` gains the `open` dispatch and intake's open line.
4. **The conductor docs** (`AGENTS.md`, `docs/codex.md`, `docs/completion-gates.md`, the office-intake guide) make `open` the rule.

**Tech Stack:** Ruby 2.6.10 stdlib, bash (`run-agent.sh`), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-09-open-task-gates-design.md`](../specs/2026-10-09-open-task-gates-design.md) (PR #60). Read it before any task; this plan argues from it.

**Base:** `main` at f87cd9a5, plus the spec and plan commits from PR #60. Nothing else needs to merge first.

## Global Constraints

- **Ruby 2.6.10:** no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- **Locale.** Ruby run with `-e` or from stdin reads its source as US-ASCII when `LANG` is unset. Keep such snippets ASCII-only. Scripts run as files are read as UTF-8.
- **Bash tests:**
  - Never pipe into `grep -q` under `set -o pipefail`; read from a file or a here-string instead.
  - The suite's EXIT trap preserves the exit status (`trap 'rc=$?; rm -rf "$RUNS"; exit $rc' EXIT`), so a suite that aborts can never exit 0. The #28 audit found five suites that did.
- **Same bytes as the writer.**
  - Gate names and reasons, from flags and from the presets file, are `.strip`ped before merge, check and reconcile, exactly as `update-completion-gate.rb` strips `--reason`, `--actor` and `--requires-authorization`.
  - Gates are declared with `CompletionGuard.reconcile_gate_plan({}, plan, actor:, at:)`.
- **Exit codes of `open-task.rb`:** `0` opened; `1` namespace refused; `2` usage error; `3` presets file unreadable or malformed; `4` task directory already exists; `5` a write failed after the directory was created (the directory was removed). Nothing is written unless the exit is 0.
- **Signals.** INT, TERM and HUP are deferred from just before `Dir.mkdir` until the task is fully written: their handler only records the signal. A recorded signal then removes the directory, only if this run created it, and the run ends with that same signal. Only SIGKILL cannot be deferred.
- **Roles.** `--agent` and `--actor` must be one of `pm dev dev-2 reviewer debugger devops free-roam`. `done` is refused, because the validator forbids it as `assignment.primary`.
- **Test hooks.** `AI_OFFICE_GATE_PRESETS` and `AI_OFFICE_OPEN_FAIL_AT` are honoured only when `AuthorizationLedger.clock_override_allowed?` is true. Set against the live runs directory, they exit 2.
- **Tests.** Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test. `team-prefix-registry.sh`, `task-id-guidance-policy.sh` and `event-gateway.sh` must pass unmodified.
- **Commits.** Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- **Workspace.**
  - Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-55-impl` (branch `feat/issue-55-open-task`). Use absolute paths.
  - Never touch the main checkout or another session's worktree.
  - Stage files by explicit path.

## Review Focus

1. **The gate writer accepts an opened task, and the preset's ordering holds.** Passing `implementation_verification` with a run record works, while `staging_acceptance` still waits on `deploy_staging`. Pinned in Task 3, RF1.
2. **A `--gate` reason containing colons keeps everything after the first colon.** Pinned in Task 3, RF2.
3. **A preset name in another case (`--preset Staging`)** is refused with the known list, not ignored. Pinned in Task 3, RF3.
4. **A multi-line `--description`** lands in `task.md` verbatim, and `status.yaml` stays valid. Pinned in Task 3, RF4.
5. **A runs directory that does not exist yet** (a fresh clone) is created. Pinned in Task 3, RF5.

## Decisions taken while proving this plan (raise them in the PR; the spec was amended where noted)

1. **`run-agent.sh` keeps its inline namespace checks** (spec §3 amended in PR #60).
   - `tests/integration/team-prefix-registry.sh` runs intake and the PM creation gate from a sandboxed office that copies `run-agent.sh` without `scripts/`. Delegating to the module would break that suite, and the spec requires it to pass unmodified.
   - `scripts/task-namespace.rb` mirrors the rules with the same messages, and section N pins them against intake and the PM gate in a sandbox.
2. **Reserved id namespaces.** `open` refuses ids in `TASK-PKG-…`/`TASK-GW-…` even in solo mode. The prefix rule alone does not catch an id typed in another namespace.
3. **How the failure hook fails.** `AI_OFFICE_OPEN_FAIL_AT=<task_md|status|meta>` creates a directory where that file is about to be written. The real write fails, or `append_meta_event!` returns `false`; no exception is faked.
4. **One meta-event check.** Every meta event goes through one `record_event` lambda that raises when `append_meta_event!` returns `false`.
   - A mutation run found that per-event checks were not all pinned.
   - O13 adds a `--no-gates` case, where `task_opened` is the only event.
5. **Signal-safe rollback (added after review of #60/#62).** The first version rescued exceptions only from inside the write block, which had two holes:
   - Ctrl-C during the writes, and SIGTERM right after `mkdir`, could each leave a half-opened task.
   - A `rescue` cannot close the gap between `mkdir` returning and the code recording that this run created the directory.

   So `open` defers INT/TERM/HUP across the whole critical section (see Global Constraints). Three tests pin it:
   - O14 raises `Interrupt` inside a meta write;
   - O15 sends a real SIGTERM right after a successful `mkdir`;
   - O16 sends it while `mkdir` finds another invocation's directory, which must stay untouched.
6. **The presets file is loaded only when `--preset` is given.** A broken presets file does not block an open with only custom gates or with `--no-gates`.
7. **Timestamps.** The history timestamps come from `AuthorizationLedger.now_utc`, which honours `AI_OFFICE_NOW` in tests. `created_at`/`updated_at` are `Date.today`, as the writer's `updated_at` is.
8. **Proof.**
   - On 2026-10-09 every block here was applied, task by task, to a fresh worktree at f87cd9a5. Each "verify it fails" step failed as written, each "passes" step passed, and the result matched the proof tree byte for byte.
   - **Mutations:** twenty were each caught by `open-task.sh` (the last three after the review fix):
     - presets not stripped;
     - a conflicting definition merged silently;
     - a dangling `after` allowed;
     - the presets hook against live runs;
     - `GW` allowed;
     - the registry not enforced;
     - the gate decision optional;
     - `done` accepted as agent;
     - no rollback;
     - a `false` meta result ignored;
     - an existing directory overwritten;
     - no `utf8_argv`;
     - `--no-gates` combinable;
     - the failure hook against live runs;
     - `run-agent.sh open` not wired;
     - the intake line removed;
     - a custom reason not stripped;
     - no rollback on a recorded signal;
     - signals not deferred;
     - removing a directory this run did not create.
   - **Regression:** on the implementation branch after review (`bb08e1ec`, with main's #59 and #61 merged), all 56 integration suites exit 0 and each prints its own PASS line. The re-applied plan reproduces the #55 files of `bb08e1ec` byte for byte (and the same `run-agent.sh` hunks).

## File Structure

| File | Responsibility |
|---|---|
| `tasks/templates/gate-presets.yaml` (new) | the `staging`, `production` and `backfill` presets |
| `scripts/gate-presets.rb` (new) | `GatePresets.path`, `load`, `normalize`, `compose`; `Error` (exit 3) and `PlanError` (exit 2) |
| `scripts/task-namespace.rb` (new) | `TaskNamespace.check_new_task!` (prefix, reserved ids, registry); `Refused` (exit 1) |
| `scripts/open-task.rb` (new) | the command: check, `mkdir`, write, roll back |
| `run-agent.sh` | `open` dispatch, usage, intake's open line |
| `tests/integration/open-task.sh` (new) | P presets, N namespace (+ parity), O open (O1–O13), RF Review Focus, D docs |
| `AGENTS.md`, `docs/codex.md`, `docs/completion-gates.md`, `docs/skills/office-intake.md` | the conductor rule and the presets |

---

### Task 1: Gate presets

**Files:**
- Create: `tasks/templates/gate-presets.yaml`, `scripts/gate-presets.rb`
- Test: `tests/integration/open-task.sh` (new; section P)

**Interfaces:**
- Consumes: `CompletionGuard.plan_gate_errors(plan)` (2E) and `AuthorizationLedger.clock_override_allowed?` (1B).
- Produces:
  - `GatePresets::DEFAULT_PATH` and `GatePresets.path` (honours `AI_OFFICE_GATE_PRESETS` only against non-live runs; otherwise raises `PlanError`).
  - `GatePresets.load(file) → { name => [gate hash] }` (raises `Error`).
  - `GatePresets.normalize(item)`.
  - `GatePresets.compose(presets, names, custom_pairs) → [gate hash]` (raises `PlanError`).

- [ ] **Step 1: Write the failing suite**

Create `tests/integration/open-task.sh` with this content, then run `chmod +x tests/integration/open-task.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #55 — open a task with gates.
#
# `./run-agent.sh open <TASK_ID>` creates task.md, status.yaml and meta.yaml and
# requires a completion-gate decision at open: presets (staging, production,
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rc=$?; rm -rf "$RUNS"; exit $rc' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW AI_OFFICE_GATE_PRESETS AI_OFFICE_OPEN_FAIL_AT

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# presets_rb <ruby expression over P (GatePresets)> — prints the result (JSON for non-strings).
presets_rb() {
  ruby -rjson - "$ROOT" "$1" <<'RUBY'
require File.join(ARGV[0], "scripts", "gate-presets")
P = GatePresets
r = begin
  eval(ARGV[1])
rescue GatePresets::Error => e
  "Error: #{e.message}"
rescue GatePresets::PlanError => e
  "PlanError: #{e.message}"
end
puts(r.is_a?(String) ? r : JSON.generate(r))
RUBY
}

# --- P: presets ---
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH).keys')" '["staging","production","backfill"]' "P shipped presets"
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH)["staging"].map { |g| g["name"] }')" '["implementation_verification","deploy_staging","staging_acceptance"]' "P staging gates"
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH)["production"].map { |g| g["name"] }')" '["implementation_verification","deploy_staging","staging_acceptance","deploy_production","production_acceptance"]' "P production includes the staging chain"
assert_eq "$(presets_rb 'g = P.load(P::DEFAULT_PATH)["staging"][1]; [g["after"], g["requires_authorization"], g["requires_record"]]')" '[["implementation_verification"],"deploy_staging",true]' "P deploy_staging is ordered, bound and needs a record"
assert_eq "$(presets_rb 'P.load(P::DEFAULT_PATH)["backfill"]')" '[{"name":"production_backfill","reason":"the production backfill or correction ran and its result was checked","requires_authorization":"production_backfill","requires_record":true}]' "P backfill"
# Composition: merge by name; identical duplicates merge; presets first, then custom gates.
all="P.load(P::DEFAULT_PATH)"
assert_eq "$(presets_rb "P.compose($all, %w[staging production], []).map { |g| g['name'] }")" '["implementation_verification","deploy_staging","staging_acceptance","deploy_production","production_acceptance"]' "P staging + production merge"
assert_eq "$(presets_rb "P.compose($all, %w[backfill staging], [['docs', 'docs updated']]).map { |g| g['name'] }")" '["production_backfill","implementation_verification","deploy_staging","staging_acceptance","docs"]' "P backfill + staging + custom, in order"
assert_eq "$(presets_rb "P.compose($all, %w[staging], [['deploy_staging', 'by hand']])")" "PlanError: gate deploy_staging is defined differently by --gate deploy_staging and an earlier preset or gate" "P a conflicting definition is refused"
assert_eq "$(presets_rb "P.compose($all, %w[nightly], [])")" "PlanError: unknown preset 'nightly' (known: staging, production, backfill)" "P unknown preset"
assert_eq "$(presets_rb "P.compose($all, [], [['Bad-Name', 'x']])")" 'PlanError: completion_gates[0].name must match /\A[a-z][a-z0-9_]*\z/' "P a bad custom gate name"
assert_eq "$(presets_rb "P.compose($all, [], [['smoke', '   ']])")" "PlanError: completion_gates[0].reason must be a non-empty string" "P a blank custom reason"
assert_eq "$(presets_rb "P.compose($all, [], [])")" "PlanError: no gates to declare" "P an empty plan"
# Normalization: names and reasons are stripped, as the gate writer strips --reason.
assert_eq "$(presets_rb "P.compose($all, [], [[' smoke ', '  staging smoke  ']])")" '[{"name":"smoke","reason":"staging smoke"}]' "P custom gates are stripped"
printf 'p:\n  - {name: " a ", reason: "  x  ", requires_authorization: " deploy_staging "}\n' > "$RUNS/strip.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/strip.yaml')")" '{"p":[{"name":"a","reason":"x","requires_authorization":"deploy_staging"}]}' "P preset entries are stripped"
# A broken presets file is an Error (exit 3 at open), never a partial set.
printf 'staging: [\n' > "$RUNS/bad.yaml"
[[ "$(presets_rb "P.load('$RUNS/bad.yaml')")" == "Error: presets file $RUNS/bad.yaml cannot be parsed"* ]] || fail "P unparseable presets file: $(presets_rb "P.load('$RUNS/bad.yaml')")"
printf 'staging:\n  - {name: a, reason: "  "}\n' > "$RUNS/blank.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/blank.yaml')")" "Error: preset staging: completion_gates[0].reason must be a non-empty string" "P a blank preset reason"
printf 'staging:\n  - {name: b, reason: x, after: [a]}\n' > "$RUNS/dangling.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/dangling.yaml')")" "Error: preset staging: gate b waits on a, which is not in the preset" "P a dangling after"
printf -- '- staging\n' > "$RUNS/list.yaml"
assert_eq "$(presets_rb "P.load('$RUNS/list.yaml')")" "Error: presets file $RUNS/list.yaml must be a map of preset name to a list of gates" "P not a map"
[[ "$(presets_rb "P.load('$RUNS/missing.yaml')")" == "Error: presets file $RUNS/missing.yaml cannot be read"* ]] || fail "P missing presets file"
# The path hook: honoured only against a non-live runs directory.
assert_eq "$(AI_OFFICE_GATE_PRESETS="$RUNS/strip.yaml" presets_rb 'P.path')" "$RUNS/strip.yaml" "P the hook in a temp runs dir"
assert_eq "$(presets_rb 'P.path')" "$ROOT/tasks/templates/gate-presets.yaml" "P the default path"
assert_eq "$(AI_OFFICE_RUNS_DIR="$ROOT/runs" AI_OFFICE_GATE_PRESETS="$RUNS/strip.yaml" presets_rb 'P.path')" "PlanError: AI_OFFICE_GATE_PRESETS is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory" "P the hook against the live runs"

echo "[PASS] open-task: open a task with gates (#55)"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/open-task.sh`
Expected: FAIL with `cannot load such file -- …/scripts/gate-presets (LoadError)`, then `[FAIL] P shipped presets: expected '["staging","production","backfill"]', got ''`.

- [ ] **Step 3: Write the presets and the module**

Create `tasks/templates/gate-presets.yaml`:

```yaml
# Completion-gate presets for `./run-agent.sh open` (issue #55).
#
# Each preset is a list of gates in the PM gate-plan format (#28 Phase 2E):
# name, reason, and optionally after, requires_authorization (an action from
# scripts/authorization-ledger.rb) and requires_record: true. `open` merges the
# presets it is given by gate name and declares the result with the same
# record construction as scripts/update-completion-gate.rb.
#
# The sets come from replayed runs: TASK-VS-006/008 (staging deploy, then a
# runtime check), TASK-VS-003/008 (main -> staging -> production, then
# production acceptance) and TASK-VS-010 (a fix that grew into a production
# backfill). Add a preset only when a real task needs a recurring set that none
# of these covers.

staging:
  - name: implementation_verification
    reason: the change is verified on the reviewed commit (tests or checks that ran)
    requires_record: true
  - name: deploy_staging
    reason: the staging deploy ran from the reviewed commit
    after: [implementation_verification]
    requires_authorization: deploy_staging
    requires_record: true
  - name: staging_acceptance
    reason: the change is observed working on staging
    after: [deploy_staging]
    requires_record: true

production:
  - name: implementation_verification
    reason: the change is verified on the reviewed commit (tests or checks that ran)
    requires_record: true
  - name: deploy_staging
    reason: the staging deploy ran from the reviewed commit
    after: [implementation_verification]
    requires_authorization: deploy_staging
    requires_record: true
  - name: staging_acceptance
    reason: the change is observed working on staging
    after: [deploy_staging]
    requires_record: true
  - name: deploy_production
    reason: the production deploy ran from the commit accepted on staging
    after: [staging_acceptance]
    requires_authorization: deploy_production
    requires_record: true
  - name: production_acceptance
    reason: the change is observed working in production
    after: [deploy_production]
    requires_record: true

backfill:
  - name: production_backfill
    reason: the production backfill or correction ran and its result was checked
    requires_authorization: production_backfill
    requires_record: true
```

Create `scripts/gate-presets.rb`:

```ruby
# frozen_string_literal: true

# Issue #55: completion-gate presets for `./run-agent.sh open`
# (tasks/templates/gate-presets.yaml). A preset is a list of gates in the PM
# gate-plan format (#28 Phase 2E). Names, reasons and bindings are stripped
# exactly as scripts/update-completion-gate.rb strips its flags, so a gate
# declared from a preset has the same bytes as one declared by the writer.

require "yaml"
require_relative "completion-guard"
require_relative "authorization-ledger"

module GatePresets
  module_function

  # The presets file itself is broken (open exits 3).
  class Error < StandardError; end
  # The requested plan is invalid (open exits 2).
  class PlanError < StandardError; end

  DEFAULT_PATH = File.expand_path("../tasks/templates/gate-presets.yaml", __dir__)

  # AI_OFFICE_GATE_PRESETS is a TEST HOOK, honoured only when AI_OFFICE_RUNS_DIR
  # points at a non-live runs directory (the AI_OFFICE_NOW rule).
  def path
    override = ENV["AI_OFFICE_GATE_PRESETS"].to_s
    return DEFAULT_PATH if override.empty?
    unless AuthorizationLedger.clock_override_allowed?
      raise PlanError, "AI_OFFICE_GATE_PRESETS is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory"
    end

    override
  end

  # A copy of one plan entry with its strings stripped; other values are kept
  # as they are for CompletionGuard.plan_gate_errors to judge.
  def normalize(item)
    return item unless item.is_a?(Hash)

    item.each_with_object({}) do |(key, value), out|
      out[key] = if value.is_a?(String) then value.strip
                 elsif key == "after" && value.is_a?(Array) then value.map { |dep| dep.is_a?(String) ? dep.strip : dep }
                 else value
                 end
    end
  end

  def load(file)
    data = begin
      YAML.safe_load(File.read(file, encoding: "UTF-8"))
    rescue SystemCallError => e
      raise Error, "presets file #{file} cannot be read: #{e.message}"
    rescue Psych::Exception => e
      raise Error, "presets file #{file} cannot be parsed: #{e.message.lines.first.to_s.strip}"
    end
    unless data.is_a?(Hash) && !data.empty?
      raise Error, "presets file #{file} must be a map of preset name to a list of gates"
    end

    data.each_with_object({}) do |(name, plan), presets|
      raise Error, "preset #{name.inspect}: the name must be a lowercase word" unless name.is_a?(String) && name.match?(/\A[a-z][a-z0-9_-]*\z/)
      raise Error, "preset #{name}: must be a non-empty list of gates" unless plan.is_a?(Array) && !plan.empty?

      entries = plan.map { |item| normalize(item) }
      problems = CompletionGuard.plan_gate_errors(entries)
      raise Error, "preset #{name}: #{problems.first}" unless problems.empty?

      names = entries.map { |item| item["name"] }
      entries.each do |item|
        missing = Array(item["after"]) - names
        raise Error, "preset #{name}: gate #{item['name']} waits on #{missing.join(', ')}, which is not in the preset" unless missing.empty?
      end
      presets[name] = entries
    end
  end

  # The plan for `open`: the named presets in order, then the custom gates
  # ([name, reason] pairs), merged by gate name. A repeated name must carry an
  # identical definition.
  def compose(presets, names, custom)
    plan = []
    by_name = {}
    add = lambda do |item, source|
      existing = by_name[item["name"]]
      if existing.nil?
        by_name[item["name"]] = item
        plan << item
      elsif existing != item
        raise PlanError, "gate #{item['name']} is defined differently by #{source} and an earlier preset or gate"
      end
    end
    names.each do |name|
      raise PlanError, "unknown preset '#{name}' (known: #{presets.keys.join(', ')})" unless presets.key?(name)

      presets[name].each { |item| add.call(item, "preset #{name}") }
    end
    custom.each do |name, reason|
      add.call(normalize({ "name" => name, "reason" => reason }), "--gate #{name.to_s.strip}")
    end
    raise PlanError, "no gates to declare" if plan.empty?

    problems = CompletionGuard.plan_gate_errors(plan)
    raise PlanError, problems.first unless problems.empty?

    plan
  end
end
```

- [ ] **Step 4: Run the suite, with and without a locale**

Run: `bash tests/integration/open-task.sh && LANG=en_US.UTF-8 bash tests/integration/open-task.sh`
Expected: `[PASS] open-task: open a task with gates (#55)`, twice.

- [ ] **Step 5: Commit**

```bash
git add tasks/templates/gate-presets.yaml scripts/gate-presets.rb tests/integration/open-task.sh
git commit -m "feat(office): completion-gate presets for opening a task (#55)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Namespace rules for a new task

**Files:**
- Create: `scripts/task-namespace.rb`
- Test: `tests/integration/open-task.sh` (section N)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `TaskNamespace.check_new_task!(task_id, raw_prefix, registry_path)`: returns `nil`, or raises `TaskNamespace::Refused` with the one line to print.
  - The helpers it uses: `prefix_problem`, `reserved_id_problem`, `load_registry`, `registry_problem`.

- [ ] **Step 1: Write the failing tests**

Save as `55-t2-test-patch.rb` in the scratchpad, then run `ruby <scratchpad>/55-t2-test-patch.rb tests/integration/open-task.sh`:

```ruby
# encoding: utf-8
# #55 Task 2: namespace tests (section N).
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
# requires a completion-gate decision at open: presets (staging, production,
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
OLD
# requires a completion-gate decision at open: presets (staging, production,
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
NEW

rep!(s, <<'OLD', <<'NEW')
assert_eq "$(presets_rb 'P.path')" "$ROOT/tasks/templates/gate-presets.yaml" "P the default path"
assert_eq "$(AI_OFFICE_RUNS_DIR="$ROOT/runs" AI_OFFICE_GATE_PRESETS="$RUNS/strip.yaml" presets_rb 'P.path')" "PlanError: AI_OFFICE_GATE_PRESETS is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory" "P the hook against the live runs"

echo "[PASS] open-task: open a task with gates (#55)"
OLD
assert_eq "$(presets_rb 'P.path')" "$ROOT/tasks/templates/gate-presets.yaml" "P the default path"
assert_eq "$(AI_OFFICE_RUNS_DIR="$ROOT/runs" AI_OFFICE_GATE_PRESETS="$RUNS/strip.yaml" presets_rb 'P.path')" "PlanError: AI_OFFICE_GATE_PRESETS is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory" "P the hook against the live runs"

# --- N: namespace rules (scripts/task-namespace.rb) ---
REG="$RUNS/office.team.yaml"
# ns <task_id> <prefix> [registry] — prints the refusal message, or "ok".
ns() {
  ruby - "$ROOT" "$1" "$2" "${3:-$REG}" <<'RUBY'
require File.join(ARGV[0], "scripts", "task-namespace")
begin
  TaskNamespace.check_new_task!(ARGV[1], ARGV[2], ARGV[3])
  puts "ok"
rescue TaskNamespace::Refused => e
  puts e.message
end
RUBY
}
printf 'prefixes:\n  EA: Earth\n  BOB: Bob\n  GW: "Event gateway (reserved)"\n' > "$REG"
assert_eq "$(ns TASK-EA-001 EA)" "ok" "N own namespace"
assert_eq "$(ns TASK-EA-001 ea)" "ok" "N prefix is case-insensitive"
assert_eq "$(ns TASK-001 EA)" "[ERROR] new task id must use active namespace TASK-EA-NNN; run intake and use its returned id" "N unprefixed id"
assert_eq "$(ns TASK-BOB-001 EA)" "[ERROR] new task id must use active namespace TASK-EA-NNN; run intake and use its returned id" "N another user's namespace"
assert_eq "$(ns TASK-EA-001 '')" "[ERROR] set your Dashboard name before creating a task" "N no prefix while the registry is active"
assert_eq "$(ns TASK-ZZ-001 ZZ)" "[ERROR] prefix ZZ is not registered" "N unregistered prefix"
assert_eq "$(ns TASK-GW-001 GW)" "[ERROR] task prefix GW is reserved for the event gateway's minted TASK-GW-N ids - pick a personal prefix" "N GW prefix"
assert_eq "$(ns TASK-PKG-001 PKG)" "[ERROR] task prefix PKG is reserved for package tasks - pick a personal prefix" "N PKG prefix"
assert_eq "$(ns TASK-EA-001 'e a')" '[ERROR] task prefix "e a" must be letters/digits starting with a letter (e.g. EA, BOB)' "N prefix grammar"
assert_eq "$(ns TASK-001 '' "$RUNS/absent.yaml")" "ok" "N no registry file: solo mode"
printf 'prefixes: {}\n' > "$RUNS/empty.yaml"
assert_eq "$(ns TASK-001 '' "$RUNS/empty.yaml")" "ok" "N empty registry: any valid id"
assert_eq "$(ns TASK-ZZ-001 ZZ "$RUNS/empty.yaml")" "ok" "N empty registry: any prefix"
assert_eq "$(ns TASK-GW-7 '' "$RUNS/empty.yaml")" "[ERROR] TASK-GW-7 is in the reserved GW namespace (reserved for the event gateway's minted TASK-GW-N ids); open a task in your own namespace" "N a reserved id namespace, solo"
assert_eq "$(ns TASK-PKG-001 '' "$RUNS/empty.yaml")" "[ERROR] TASK-PKG-001 is in the reserved PKG namespace (reserved for package tasks); open a task in your own namespace" "N PKG id namespace, solo"
assert_eq "$(ns TASK-12 '' "$RUNS/empty.yaml")" "ok" "N a legacy id in solo mode"
printf 'prefixes: [\n' > "$RUNS/broken.yaml"
[[ "$(ns TASK-001 '' "$RUNS/broken.yaml")" == "[ERROR] office.team.yaml exists but cannot be parsed"* ]] || fail "N a broken registry fails closed: $(ns TASK-001 '' "$RUNS/broken.yaml")"
printf -- '- EA\n' > "$RUNS/list.yaml"
assert_eq "$(ns TASK-001 '' "$RUNS/list.yaml")" "[ERROR] office.team.yaml must be a map with a 'prefixes:' entry (got Array)" "N a registry that is not a map"
# Parity: the PM creation gate and intake in a sandboxed office give the same messages.
OFFICE="$RUNS/office"
mkdir -p "$OFFICE/runs" "$OFFICE/tasks" "$OFFICE/agents"
cp "$ROOT/run-agent.sh" "$OFFICE/"
cp -R "$ROOT/scripts" "$OFFICE/scripts"
printf 'office:\n  name: Sandbox\n' > "$OFFICE/office.config.yaml"
printf 'prefixes:\n  EA: Earth\n  BOB: Bob\n' > "$OFFICE/office.team.yaml"
parity_pm() { # <task_id> <prefix> — the PM gate's [ERROR] line must equal the module's message
  local out; out="$(cd "$OFFICE" && OFFICE_TASK_PREFIX="$2" AI_OFFICE_RUNS_DIR="$OFFICE/runs" ./run-agent.sh "$1" pm cursor 2>&1 || true)"
  assert_eq "$(grep -m1 '^\[ERROR\]' <<<"$out")" "$(ns "$1" "$2" "$OFFICE/office.team.yaml")" "N parity with the PM gate for $1 / '$2'"
}
parity_pm TASK-001 EA
parity_pm TASK-BOB-001 EA
parity_pm TASK-EA-001 ""
parity_intake() { # <prefix> — intake's first [ERROR] line must equal the module's message
  local out; out="$(cd "$OFFICE" && OFFICE_TASK_PREFIX="$1" AI_OFFICE_RUNS_DIR="$OFFICE/runs" ./run-agent.sh intake "x" 2>&1 || true)"
  assert_eq "$(grep -m1 '^\[ERROR\]' <<<"$out")" "$(ns TASK-001 "$1" "$OFFICE/office.team.yaml")" "N parity with intake for '$1'"
}
parity_intake GW
parity_intake PKG
parity_intake "e a"

echo "[PASS] open-task: open a task with gates (#55)"
NEW
File.write(path, s)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/open-task.sh`
Expected: FAIL with `cannot load such file -- …/scripts/task-namespace (LoadError)`, then `[FAIL] N own namespace: expected 'ok', got ''`.

- [ ] **Step 3: Write the module**

Create `scripts/task-namespace.rb`:

```ruby
# frozen_string_literal: true

# Issue #55: the namespace rules a NEW task id must pass, for
# `./run-agent.sh open`. They mirror, with the same messages, the two checks
# run-agent.sh already makes inline: intake's prefix rules (grammar; PKG and GW
# reserved) and the PM creation gate's registry rule (enforce_new_task_namespace:
# once office.team.yaml lists prefixes, a new id must be TASK-<your prefix>-NNN).
# run-agent.sh keeps its inline copies because tests run it from a sandboxed
# office without scripts/; tests/integration/open-task.sh (section N) pins the
# messages against both.

require "yaml"

module TaskNamespace
  module_function

  # The new id is refused (open exits 1). The message is the line to print.
  class Refused < StandardError; end

  RESERVED = {
    "PKG" => "reserved for package tasks",
    "GW" => "reserved for the event gateway's minted TASK-GW-N ids"
  }.freeze

  def prefix_problem(raw_prefix)
    prefix = raw_prefix.to_s.strip.upcase
    unless prefix.empty? || prefix.match?(/\A[A-Z][A-Z0-9]*\z/)
      return "[ERROR] task prefix #{raw_prefix.inspect} must be letters/digits starting with a letter (e.g. EA, BOB)"
    end
    return "[ERROR] task prefix #{prefix} is #{RESERVED[prefix]} - pick a personal prefix" if RESERVED.key?(prefix)

    nil
  end

  def reserved_id_problem(task_id)
    namespace = task_id.to_s[/\ATASK-([A-Z][A-Z0-9]*)-\d+\z/, 1]
    return nil unless RESERVED.key?(namespace)

    "[ERROR] #{task_id} is in the reserved #{namespace} namespace (#{RESERVED[namespace]}); open a task in your own namespace"
  end

  # Fails closed like intake: an unparseable or mis-shaped registry refuses,
  # it never silently turns prefix enforcement off. Absent file, comments only,
  # or no `prefixes:` is the empty (solo) registry.
  def load_registry(path)
    return {} unless path && File.exist?(path)

    data = begin
      YAML.safe_load(File.read(path))
    rescue StandardError => e
      raise Refused, "[ERROR] office.team.yaml exists but cannot be parsed (#{e.class}: #{e.message.lines.first&.strip})"
    end
    return {} if data.nil?
    raise Refused, "[ERROR] office.team.yaml must be a map with a 'prefixes:' entry (got #{data.class})" unless data.is_a?(Hash)

    raw = data["prefixes"]
    return {} if raw.nil?
    raise Refused, "[ERROR] office.team.yaml 'prefixes:' must be a map of PREFIX: Name (got #{raw.class})" unless raw.is_a?(Hash)

    raw.each_with_object({}) { |(key, owner), memo| memo[key.to_s.strip.upcase] = owner.to_s }
  end

  def registry_problem(task_id, raw_prefix, registry)
    return nil if registry.empty?

    prefix = raw_prefix.to_s.strip.upcase
    return "[ERROR] set your Dashboard name before creating a task" if prefix.empty?
    owner = registry[prefix]
    return "[ERROR] prefix #{prefix} is not registered" unless owner && !owner.empty?
    return nil if task_id.to_s.match?(/\ATASK-#{Regexp.escape(prefix)}-\d+\z/)

    "[ERROR] new task id must use active namespace TASK-#{prefix}-NNN; run intake and use its returned id"
  end

  # Raises Refused with the first problem; returns nil when the id may be opened.
  def check_new_task!(task_id, raw_prefix, registry_path)
    problem = prefix_problem(raw_prefix) || reserved_id_problem(task_id)
    problem ||= registry_problem(task_id, raw_prefix, load_registry(registry_path))
    raise Refused, problem if problem

    nil
  end
end
```

- [ ] **Step 4: Run the suite and the suites that own the inline rules**

Run: `bash tests/integration/open-task.sh && bash tests/integration/team-prefix-registry.sh && bash tests/integration/task-id-guidance-policy.sh`
Expected: each prints its own PASS line. Section N's parity checks run intake and the PM gate in a sandbox and compare their `[ERROR]` lines with the module's.

- [ ] **Step 5: Commit**

```bash
git add scripts/task-namespace.rb tests/integration/open-task.sh
git commit -m "feat(office): namespace rules for opening a task (#55)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `open-task.rb` and `run-agent.sh open`

**Files:**
- Create: `scripts/open-task.rb`
- Modify: `run-agent.sh`
- Test: `tests/integration/open-task.sh` (sections O and RF)

**Interfaces:**
- Consumes:
  - `GatePresets.path` / `load` / `compose`, plus `Error` and `PlanError` (Task 1);
  - `TaskNamespace.check_new_task!` and `Refused` (Task 2);
  - `CompletionGuard.utf8_argv`, `reconcile_gate_plan`, `event_agent` and `append_meta_event!`;
  - `AuthorizationLedger.now_utc`, `format_time` and `clock_override_allowed?`;
  - `OfficeConfigResolver#get`.
- Produces:
  - `ruby scripts/open-task.rb <TASK_ID> --title … (--preset … | --gate name:reason … | --no-gates "…") [--agent R] [--actor R] [--description …]`, with exit codes 0–5;
  - `./run-agent.sh open …`, which hands off to it;
  - intake's line `Or open it as a conductor: ./run-agent.sh open <ID> …`.

- [ ] **Step 1: Write the failing tests**

Save as `55-t3-test-patch.rb` in the scratchpad, then run `ruby <scratchpad>/55-t3-test-patch.rb tests/integration/open-task.sh`:

```ruby
# encoding: utf-8
# #55 Task 3: open tests (sections O and RF).
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
OLD
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake), O open (O1-O13), RF Review Focus.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
NEW

rep!(s, <<'OLD', <<'NEW')
parity_intake PKG
parity_intake "e a"

echo "[PASS] open-task: open a task with gates (#55)"
OLD
parity_intake PKG
parity_intake "e a"

# --- O: open ---
GATE="$ROOT/scripts/update-completion-gate.rb"
T0=2026-10-09T01:00:00Z
export OFFICE_TASK_PREFIX=EAR
# opn <args...> — runs the opener; stdout+stderr in $RUNS/open.log; prints the exit code.
opn() { local rc=0; ruby "$ROOT/scripts/open-task.rb" "$@" >"$RUNS/open.log" 2>&1 || rc=$?; echo "$rc"; }
field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) do |node, key|
  if node.is_a?(Array) && key.match?(/\A\d+\z/) then node[key.to_i]
  elsif node.is_a?(Hash) then node[key]
  end
end
puts value.nil? ? "" : (value.is_a?(Array) ? value.join(",") : value)
RUBY
}
# gate_bytes <task_dir> — completion_gates and every gate history row (rows after the first), as YAML.
gate_bytes() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0] + "/status.yaml"), permitted_classes: [Date, Time]); print YAML.dump([s["completion_gates"], s["history"].select { |h| h["phase"].to_s.start_with?("gate ") }])' "$1"; }
gate_events() { ruby -ryaml -e 'm = YAML.safe_load(File.read(ARGV[0] + "/meta.yaml")); print m["events"].select { |e| e["type"] == "completion_gate_updated" }.map { |e| [e["agent"], e["details"]].join(" ") }.join("\n")' "$1"; }
# reference <TASK_ID> <ruby list of [name, flags...]> — the same gates declared one by one by the writer.
reference() {
  local dir="$RUNS/$1"; mkdir -p "$dir"
  printf 'task_id: %s\nphase: assigned\nstate: assigned\niteration: 0\ncurrent_agent: dev\nupdated_at: "2026-10-09"\nhistory: []\n' "$1" > "$dir/status.yaml"
  ruby -e 'eval(ARGV[1]).each { |args| system("ruby", ARGV[2], ARGV[0], "declare", *args, "--actor", "pm", out: File::NULL) or abort("writer failed: #{args.inspect}") }' "$1" "$2" "$GATE"
}
preset_writer_args() { # <preset> — the writer flags for each gate of a shipped preset
  ruby -ryaml -e 'puts YAML.safe_load(File.read(ARGV[0]))[ARGV[1]].map { |g| [g["name"], "--reason", g["reason"]] + (g["requires_authorization"] ? ["--requires-authorization", g["requires_authorization"]] : []) + (g["after"] ? ["--after", g["after"].join(",")] : []) + (g["requires_record"] ? ["--requires-record"] : []) }.inspect' "$ROOT/tasks/templates/gate-presets.yaml" "$1"
}

# O1: a preset opens a governed task whose gates are byte-identical to the writer's.
assert_eq "$(AI_OFFICE_NOW=$T0 opn TASK-EAR-901 --title "Staging change" --agent dev --preset staging)" "0" "O1 open ($(cat "$RUNS/open.log"))"
D="$RUNS/TASK-EAR-901"
assert_eq "$(head -1 "$D/task.md")" "# TASK-EAR-901: Staging change" "O1 task.md heading"
assert_eq "$(field "$D/status.yaml" task_label)|$(field "$D/status.yaml" phase)|$(field "$D/status.yaml" state)|$(field "$D/status.yaml" iteration)|$(field "$D/status.yaml" current_agent)|$(field "$D/status.yaml" ready)|$(field "$D/status.yaml" assignment.primary)" "Staging change|assigned|assigned|0|dev|true|dev" "O1 status fields"
assert_eq "$(field "$D/status.yaml" history.0.phase)|$(field "$D/status.yaml" history.0.agent)|$(field "$D/status.yaml" history.0.reason)" "created -> assigned|pm|opened with completion gates: implementation_verification, deploy_staging, staging_acceptance" "O1 created row"
AI_OFFICE_NOW=$T0 reference TASK-EAR-902 "$(preset_writer_args staging)"
assert_eq "$(gate_bytes "$D")" "$(gate_bytes "$RUNS/TASK-EAR-902")" "O1 gate records and history rows are the writer's bytes"
assert_eq "$(gate_events "$D")" "$(gate_events "$RUNS/TASK-EAR-902")" "O1 completion_gate_updated events are the writer's"
assert_eq "$(ruby -ryaml -e 'm = YAML.safe_load(File.read(ARGV[0])); e = m["events"].first; print [e["type"], e["agent"], e["details"]].join(" | ")' "$D/meta.yaml")" "task_opened | pm | gates=implementation_verification,deploy_staging,staging_acceptance" "O1 task_opened event"
ruby "$ROOT/validate-yaml.rb" "$D" >"$RUNS/validate.log" 2>&1 || fail "O1 validate-yaml: $(cat "$RUNS/validate.log")"
grep -qxF "Gates: 0/3 resolved" <<<"$(bash "$ROOT/run-agent.sh" status TASK-EAR-901)" || fail "O1 status Gates block: $(bash "$ROOT/run-agent.sh" status TASK-EAR-901)"
assert_eq "$(ruby "$ROOT/scripts/gate-view-json.rb" "$D" | ruby -rjson -e 'print JSON.parse(STDIN.read)["readable"]')" "true" "O1 gate view readable"
# A custom reason with surrounding spaces is stored stripped, as the writer stores --reason.
assert_eq "$(AI_OFFICE_NOW=$T0 opn TASK-EAR-903 --title x --gate "smoke:  staging smoke  ")" "0" "O1 custom gate ($(cat "$RUNS/open.log"))"
AI_OFFICE_NOW=$T0 reference TASK-EAR-904 '[["smoke", "--reason", "  staging smoke  "]]'
assert_eq "$(gate_bytes "$RUNS/TASK-EAR-903")" "$(gate_bytes "$RUNS/TASK-EAR-904")" "O1 stripped custom reason matches the writer"

# O2: composition.
assert_eq "$(opn TASK-EAR-905 --title x --preset production)" "0" "O2 production"
assert_eq "$(field "$RUNS/TASK-EAR-905/status.yaml" completion_gates.deploy_production.after)" "staging_acceptance" "O2 production follows the staging chain"
assert_eq "$(opn TASK-EAR-906 --title x --preset staging --preset production --preset backfill)" "0" "O2 staging + production + backfill"
assert_eq "$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV[0]))["completion_gates"].keys.join(",")' "$RUNS/TASK-EAR-906/status.yaml")" "implementation_verification,deploy_staging,staging_acceptance,deploy_production,production_acceptance,production_backfill" "O2 merged order"

# O3: custom gates after presets; a conflicting definition is refused and nothing is written.
assert_eq "$(opn TASK-EAR-907 --title x --preset backfill --gate "docs:docs updated")" "0" "O3 preset + custom"
assert_eq "$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV[0]))["completion_gates"].keys.join(",")' "$RUNS/TASK-EAR-907/status.yaml")" "production_backfill,docs" "O3 order"
assert_eq "$(opn TASK-EAR-908 --title x --preset staging --gate "deploy_staging:by hand")" "2" "O3 conflict"
grep -qF "defined differently" "$RUNS/open.log" || fail "O3 conflict message: $(cat "$RUNS/open.log")"
[[ ! -e "$RUNS/TASK-EAR-908" ]] || fail "O3 a refused open wrote the task"

# O4: --no-gates records its reason; it cannot be combined.
assert_eq "$(opn TASK-EAR-909 --title "Docs fix" --no-gates "  docs only  ")" "0" "O4 no gates"
assert_eq "$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV[0])).key?("completion_gates")' "$RUNS/TASK-EAR-909/status.yaml")" "false" "O4 no completion_gates key"
assert_eq "$(field "$RUNS/TASK-EAR-909/status.yaml" history.0.reason)|$(field "$RUNS/TASK-EAR-909/status.yaml" phase)" "opened without completion gates: docs only|pending" "O4 reason recorded, default pm is pending"
grep -qF "details: gates=none reason=docs only" "$RUNS/TASK-EAR-909/meta.yaml" || fail "O4 task_opened details: $(cat "$RUNS/TASK-EAR-909/meta.yaml")"
assert_eq "$(opn TASK-EAR-910 --title x --no-gates "docs" --preset staging)" "2" "O4 --no-gates with --preset"
assert_eq "$(opn TASK-EAR-910 --title x --no-gates "   ")" "2" "O4 a blank --no-gates reason"

# O5: a gate decision and a title are required.
assert_eq "$(opn TASK-EAR-910 --title x)" "2" "O5 no gate decision"
grep -qF -- "--no-gates" "$RUNS/open.log" || fail "O5 guidance: $(cat "$RUNS/open.log")"
assert_eq "$(opn TASK-EAR-910 --preset staging)" "2" "O5 no title"
assert_eq "$(opn TASK-EAR-910 --title "   " --preset staging)" "2" "O5 a blank title"
assert_eq "$(opn TASK-EAR-910 --title x --preset staging --colour red)" "2" "O5 an unknown flag"
assert_eq "$(opn task-ear-910 --title x --preset staging)" "2" "O5 a malformed id"
[[ ! -e "$RUNS/TASK-EAR-910" ]] || fail "O5 a refused open wrote the task"

# O6: namespace (the live registry lists EAR, KAS, VS and the reserved GW).
assert_eq "$(OFFICE_TASK_PREFIX=VS opn TASK-EAR-911 --title x --no-gates y)" "1" "O6 someone else's namespace"
assert_eq "$(OFFICE_TASK_PREFIX=ZZ opn TASK-ZZ-001 --title x --no-gates y)" "1" "O6 an unregistered prefix"
assert_eq "$(OFFICE_TASK_PREFIX=GW opn TASK-GW-001 --title x --no-gates y)" "1" "O6 the reserved GW prefix"
assert_eq "$(opn TASK-GW-12 --title x --no-gates y)" "1" "O6 a reserved id namespace"
grep -qF "reserved GW namespace" "$RUNS/open.log" || fail "O6 reserved message: $(cat "$RUNS/open.log")"
# An empty registry (solo mode), in a sandboxed office.
SOLO="$RUNS/solo"
mkdir -p "$SOLO/runs"
cp "$ROOT/run-agent.sh" "$ROOT/validate-yaml.rb" "$SOLO/"
cp -R "$ROOT/scripts" "$ROOT/tasks" "$SOLO/"
printf 'office:\n  name: Sandbox\n' > "$SOLO/office.config.yaml"
printf 'prefixes: {}\n' > "$SOLO/office.team.yaml"
rc=0; OFFICE_TASK_PREFIX= ruby "$SOLO/scripts/open-task.rb" TASK-001 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "O6 solo mode opens any valid id ($(cat "$RUNS/open.log"))"
[[ -f "$RUNS/TASK-001/status.yaml" ]] || fail "O6 solo task not written"

# O7: an existing task is never touched.
before="$(find "$RUNS/TASK-EAR-901" -type f -exec shasum {} + | sort)"
assert_eq "$(opn TASK-EAR-901 --title other --no-gates y)" "4" "O7 existing task"
assert_eq "$(find "$RUNS/TASK-EAR-901" -type f -exec shasum {} + | sort)" "$before" "O7 existing files unchanged"

# O8: a broken presets file is exit 3; the hook against live runs is exit 2.
printf 'staging: [\n' > "$RUNS/bad-presets.yaml"
assert_eq "$(AI_OFFICE_GATE_PRESETS="$RUNS/bad-presets.yaml" opn TASK-EAR-912 --title x --preset staging)" "3" "O8 unparseable presets"
printf 'staging:\n  - {name: a, reason: "  "}\n' > "$RUNS/blank-presets.yaml"
assert_eq "$(AI_OFFICE_GATE_PRESETS="$RUNS/blank-presets.yaml" opn TASK-EAR-912 --title x --preset staging)" "3" "O8 a blank preset reason"
[[ ! -e "$RUNS/TASK-EAR-912" ]] || fail "O8 a refused open wrote the task"
rc=0; AI_OFFICE_RUNS_DIR="$SOLO/runs" AI_OFFICE_GATE_PRESETS="$RUNS/bad-presets.yaml" OFFICE_TASK_PREFIX= ruby "$SOLO/scripts/open-task.rb" TASK-002 --title x --preset staging >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "O8 the presets hook against the live runs"
[[ ! -e "$SOLO/runs/TASK-002" ]] || fail "O8 the live-runs refusal wrote the task"

# O9: Thai text with no locale is stored as UTF-8, never !binary.
rc=0; env -u LANG -u LC_ALL -u LC_CTYPE ruby "$ROOT/scripts/open-task.rb" TASK-EAR-913 --title "ทดสอบเปิดงาน" --gate "smoke:ตรวจบน staging" >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "O9 Thai open ($(cat "$RUNS/open.log"))"
! grep -q '!binary' "$RUNS/TASK-EAR-913/status.yaml" || fail "O9 status.yaml stored !binary"
assert_eq "$(field "$RUNS/TASK-EAR-913/status.yaml" task_label)|$(field "$RUNS/TASK-EAR-913/status.yaml" completion_gates.smoke.reason)" "ทดสอบเปิดงาน|ตรวจบน staging" "O9 Thai text"

# O10: assignable roles only.
assert_eq "$(opn TASK-EAR-914 --title x --agent done --no-gates y)" "2" "O10 --agent done"
assert_eq "$(opn TASK-EAR-914 --title x --agent boss --no-gates y)" "2" "O10 an unknown agent"
assert_eq "$(opn TASK-EAR-914 --title x --actor orchestrator --no-gates y)" "2" "O10 an actor that is not an assignable role"
assert_eq "$(opn TASK-EAR-914 --title x --agent devops --actor dev --no-gates y)" "0" "O10 devops"
assert_eq "$(field "$RUNS/TASK-EAR-914/status.yaml" phase)|$(field "$RUNS/TASK-EAR-914/status.yaml" history.0.agent)" "assigned|dev" "O10 phase and actor"

# O11: two concurrent opens of one id: exactly one succeeds.
for i in 1 2 3 4 5 6; do
  ( rc=0; ruby "$ROOT/scripts/open-task.rb" TASK-EAR-920 --title "race $i" --no-gates y >/dev/null 2>&1 || rc=$?; echo "$rc" > "$RUNS/race-$i" ) &
done
wait
assert_eq "$(cat "$RUNS"/race-* | sort | tr '\n' ' ')" "0 4 4 4 4 4 " "O11 one winner, the rest exit 4"
ruby "$ROOT/validate-yaml.rb" "$RUNS/TASK-EAR-920" >"$RUNS/validate.log" 2>&1 || fail "O11 the winner's task is valid: $(cat "$RUNS/validate.log")"

# O12: run-agent.sh open passes the exit status through; intake shows the open line.
rc=0; bash "$ROOT/run-agent.sh" open TASK-EAR-921 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "O12 run-agent.sh open ($(cat "$RUNS/open.log"))"
rc=0; bash "$ROOT/run-agent.sh" open TASK-EAR-922 --title x >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "O12 run-agent.sh open passes exit 2 through"
grep -qF 'Or open it as a conductor: ./run-agent.sh open TASK-EAR-' <<<"$(bash "$ROOT/run-agent.sh" intake "Fix the wallet callback")" || fail "O12 intake open line: $(bash "$ROOT/run-agent.sh" intake "Fix the wallet callback")"

# O13: any write failure after mkdir rolls the open back (exit 5, no directory left).
for step in task_md status meta; do
  assert_eq "$(AI_OFFICE_OPEN_FAIL_AT=$step opn TASK-EAR-930 --title x --preset staging)" "5" "O13 failure at $step"
  [[ ! -e "$RUNS/TASK-EAR-930" ]] || fail "O13 failure at $step left the task directory"
done
assert_eq "$(AI_OFFICE_OPEN_FAIL_AT=meta opn TASK-EAR-930 --title x --no-gates "docs only")" "5" "O13 failure at the only meta event"
[[ ! -e "$RUNS/TASK-EAR-930" ]] || fail "O13 failure at the only meta event left the task directory"
assert_eq "$(opn TASK-EAR-930 --title x --preset staging)" "0" "O13 the same id then opens"
rc=0; AI_OFFICE_RUNS_DIR="$SOLO/runs" AI_OFFICE_OPEN_FAIL_AT=meta OFFICE_TASK_PREFIX= ruby "$SOLO/scripts/open-task.rb" TASK-003 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "O13 the failure hook against the live runs"
[[ ! -e "$SOLO/runs/TASK-003" ]] || fail "O13 the live-runs refusal wrote the task"

# O14: a signal mid-write (Ctrl-C, SIGTERM) also rolls the open back; the signal still ends the run.
cat > "$RUNS/interrupt.rb" <<'RUBY'
require File.join(ENV.fetch("OPEN_TASK_ROOT"), "scripts", "completion-guard")
module CompletionGuard
  class << self
    alias_method :append_meta_event_before_interrupt!, :append_meta_event!
    def append_meta_event!(*args, **kwargs)
      @interrupt_calls = (@interrupt_calls || 0) + 1
      raise Interrupt if @interrupt_calls == 2
      append_meta_event_before_interrupt!(*args, **kwargs)
    end
  end
end
RUBY
rc=0; OPEN_TASK_ROOT="$ROOT" ruby -r "$RUNS/interrupt.rb" "$ROOT/scripts/open-task.rb" TASK-EAR-950 --title x --preset staging >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "130" "O14 an interrupt ends the run as an interrupt ($(tail -2 "$RUNS/open.log"))"
[[ ! -e "$RUNS/TASK-EAR-950" ]] || fail "O14 an interrupt mid-write left the task directory"
assert_eq "$(opn TASK-EAR-950 --title x --preset staging)" "0" "O14 the same id then opens"

# O15/O16: a real SIGTERM at the mkdir boundary. The patch sends it from inside
# Dir.mkdir for the task directory: after a successful mkdir (O15), or before a
# mkdir that finds another invocation's directory (O16).
cat > "$RUNS/term-at-mkdir.rb" <<'RUBY'
class Dir
  class << self
    alias_method :mkdir_before_term, :mkdir
    def mkdir(path, *rest)
      target = File.basename(path.to_s) == ENV.fetch("TERM_AT_MKDIR")
      Process.kill("TERM", Process.pid) if target && ENV["TERM_WHEN"] == "before"
      result = mkdir_before_term(path, *rest)
      Process.kill("TERM", Process.pid) if target && ENV["TERM_WHEN"] == "after"
      result
    end
  end
end
RUBY
rc=0; TERM_AT_MKDIR=TASK-EAR-951 TERM_WHEN=after ruby -r "$RUNS/term-at-mkdir.rb" "$ROOT/scripts/open-task.rb" TASK-EAR-951 --title x --preset staging >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "143" "O15 SIGTERM right after mkdir still ends the run as SIGTERM ($(tail -2 "$RUNS/open.log"))"
[[ ! -e "$RUNS/TASK-EAR-951" ]] || fail "O15 SIGTERM right after mkdir left the task directory: $(ls -A "$RUNS/TASK-EAR-951")"
assert_eq "$(opn TASK-EAR-951 --title x --preset staging)" "0" "O15 the same id then opens"
mkdir -p "$RUNS/TASK-EAR-952" && printf 'keep\n' > "$RUNS/TASK-EAR-952/other-invocation.txt"
rc=0; TERM_AT_MKDIR=TASK-EAR-952 TERM_WHEN=before ruby -r "$RUNS/term-at-mkdir.rb" "$ROOT/scripts/open-task.rb" TASK-EAR-952 --title x --preset staging >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "143" "O16 SIGTERM while the id already exists ends the run as SIGTERM ($(tail -2 "$RUNS/open.log"))"
assert_eq "$(ls -A "$RUNS/TASK-EAR-952")|$(cat "$RUNS/TASK-EAR-952/other-invocation.txt")" "other-invocation.txt|keep" "O16 another invocation's directory is untouched"

# --- Review Focus ---
# RF1: the gate writer accepts an opened task, and the preset's ordering holds.
rc=0; ruby "$GATE" TASK-EAR-901 pass implementation_verification --actor dev --reason "suite green" --ran-by dev --ran-ref abc123 >"$RUNS/gate.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "RF1 the writer passes a gate of an opened task ($(cat "$RUNS/gate.log"))"
rc=0; ruby "$GATE" TASK-EAR-901 pass staging_acceptance --actor dev --reason early --ran-by dev --ran-ref abc123 >"$RUNS/gate.log" 2>&1 || rc=$?
assert_eq "$rc" "2" "RF1 staging_acceptance still waits on deploy_staging"
grep -qF "waits on: deploy_staging (pending)" "$RUNS/gate.log" || fail "RF1 ordering message: $(cat "$RUNS/gate.log")"
# RF2: a custom reason keeps everything after the first colon.
assert_eq "$(opn TASK-EAR-940 --title x --gate "smoke:check: staging, then prod")" "0" "RF2 colon in a reason"
assert_eq "$(field "$RUNS/TASK-EAR-940/status.yaml" completion_gates.smoke.reason)" "check: staging, then prod" "RF2 reason kept whole"
# RF3: preset names are exact; another case is refused with the known list.
assert_eq "$(opn TASK-EAR-941 --title x --preset Staging)" "2" "RF3 --preset Staging"
grep -qF "unknown preset 'Staging' (known: staging, production, backfill)" "$RUNS/open.log" || fail "RF3 message: $(cat "$RUNS/open.log")"
# RF4: a multi-line description lands in task.md verbatim; status.yaml stays valid.
assert_eq "$(opn TASK-EAR-942 --title x --no-gates y --description "$(printf 'Scope:\n- line one\n- line two')")" "0" "RF4 multi-line description"
assert_eq "$(sed -n 3,5p "$RUNS/TASK-EAR-942/task.md")" "$(printf 'Scope:\n- line one\n- line two')" "RF4 task.md body"
ruby "$ROOT/validate-yaml.rb" "$RUNS/TASK-EAR-942" >"$RUNS/validate.log" 2>&1 || fail "RF4 validate: $(cat "$RUNS/validate.log")"
# RF5: a runs directory that does not exist yet is created.
rc=0; AI_OFFICE_RUNS_DIR="$RUNS/fresh/runs" ruby "$ROOT/scripts/open-task.rb" TASK-EAR-943 --title x --no-gates y >"$RUNS/open.log" 2>&1 || rc=$?
assert_eq "$rc" "0" "RF5 a fresh runs directory ($(cat "$RUNS/open.log"))"
[[ -f "$RUNS/fresh/runs/TASK-EAR-943/status.yaml" ]] || fail "RF5 task not written"

echo "[PASS] open-task: open a task with gates (#55)"
NEW
File.write(path, s)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/open-task.sh`
Expected: FAIL with `[FAIL] O1 open (ruby: No such file or directory -- …/scripts/open-task.rb (LoadError)): expected '0', got '1'`.

- [ ] **Step 3: Write the opener**

Create `scripts/open-task.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Issue #55: open a task with a completion-gate decision.
#
# A conductor opens a new task with this instead of hand-writing status.yaml.
# It creates runs/<TASK_ID>/task.md, status.yaml and meta.yaml, and requires a
# decision about completion gates: presets (tasks/templates/gate-presets.yaml),
# custom gates, or --no-gates "<reason>". Gates are declared with the PM
# gate-plan reconcile (#28 Phase 2E), so every record and history row is
# byte-identical to scripts/update-completion-gate.rb declare.
#
# Usage:
#   ruby scripts/open-task.rb <TASK_ID> --title "<title>" [--agent <role>] [--actor <role>]
#     [--description "<text>"] ( --preset <name> ... | --gate <name>:<reason> ... | --no-gates "<reason>" )
#
# Exit: 0 opened; 1 namespace refused; 2 usage error; 3 the presets file is
# unreadable or malformed; 4 the task directory already exists; 5 a write failed
# after the directory was created (the directory was removed). Nothing is
# written unless the exit is 0.

require "yaml"
require "date"
require "fileutils"
require_relative "completion-guard"
require_relative "authorization-ledger"
require_relative "gate-presets"
require_relative "task-namespace"
require_relative "resolve-office-config"

OFFICE_DIR = File.expand_path("..", __dir__)
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
# validate-yaml.rb's TASK_ID_PATTERN.
TASK_ID_PATTERN = /\ATASK(?:-[A-Z][A-Z0-9]*)?-\d+\z/.freeze
# Roles that can take work: the validator forbids `done` as assignment.primary.
ASSIGNABLE_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
FAIL_STEPS = %w[task_md status meta].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: open-task.rb <TASK_ID> --title \"<title>\" [--agent <role>] [--actor <role>] [--description \"<text>\"] " \
       "( --preset <name> ... | --gate <name>:<reason> ... | --no-gates \"<reason>\" )"
  exit 2
end

args, not_utf8 = CompletionGuard.utf8_argv(ARGV)
usage!("argument #{not_utf8.scrub.inspect} is not valid UTF-8") if not_utf8
task_id = args.shift.to_s.strip
usage! if task_id.empty? || task_id.start_with?("--")

opts = { presets: [], gates: [] }
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--title", "--description", "--agent", "--actor", "--no-gates"
    key = flag.delete_prefix("--").tr("-", "_").to_sym
    usage!("duplicate #{flag}") if opts.key?(key)
    opts[key] = value.strip
  when "--preset" then opts[:presets] << value.strip
  when "--gate"
    name, separator, reason = value.partition(":")
    usage!("--gate needs <name>:<reason>, got #{value.inspect}") if separator.empty?
    opts[:gates] << [name, reason]
  else usage!("unknown flag #{flag}")
  end
end

usage!("task id '#{task_id}' must match #{TASK_ID_PATTERN.inspect}") unless task_id.match?(TASK_ID_PATTERN)
usage!("--title is required") if opts[:title].to_s.empty?
agent = opts.fetch(:agent, "pm")
actor = opts.fetch(:actor, "pm")
usage!("--agent must be one of #{ASSIGNABLE_ROLES.join(', ')}") unless ASSIGNABLE_ROLES.include?(agent)
usage!("--actor must be one of #{ASSIGNABLE_ROLES.join(', ')}") unless ASSIGNABLE_ROLES.include?(actor)
gate_flags = !opts[:presets].empty? || !opts[:gates].empty?
if opts.key?(:no_gates)
  usage!("--no-gates cannot be combined with --preset or --gate") if gate_flags
  usage!("--no-gates needs a reason") if opts[:no_gates].empty?
elsif !gate_flags
  usage!("choose the task's completion gates: --preset <name> (#{%w[staging production backfill].join(', ')}), " \
         "--gate <name>:<reason>, or --no-gates \"<reason>\"")
end

# AI_OFFICE_OPEN_FAIL_AT is a TEST HOOK (the AI_OFFICE_NOW rule): it puts an
# obstacle where that file is about to be written, so the real write fails.
fail_at = ENV["AI_OFFICE_OPEN_FAIL_AT"].to_s
unless fail_at.empty?
  unless AuthorizationLedger.clock_override_allowed?
    usage!("AI_OFFICE_OPEN_FAIL_AT is a test hook: it requires AI_OFFICE_RUNS_DIR to point at a non-live runs directory")
  end
  usage!("AI_OFFICE_OPEN_FAIL_AT must be one of #{FAIL_STEPS.join(', ')}") unless FAIL_STEPS.include?(fail_at)
end

plan = nil
if gate_flags
  begin
    presets = opts[:presets].empty? ? {} : GatePresets.load(GatePresets.path)
    plan = GatePresets.compose(presets, opts[:presets], opts[:gates])
  rescue GatePresets::PlanError => e
    usage!(e.message)
  rescue GatePresets::Error => e
    warn e.message
    exit 3
  end
end

prefix = ENV["OFFICE_TASK_PREFIX"].to_s
if prefix.empty?
  profile = ENV["OFFICE_PROFILE"].to_s.strip
  prefix = OfficeConfigResolver.new(OFFICE_DIR, profile: profile.empty? ? nil : profile).get("office.task_prefix", "").to_s
end
begin
  TaskNamespace.check_new_task!(task_id, prefix, File.join(OFFICE_DIR, "office.team.yaml"))
rescue TaskNamespace::Refused => e
  warn e.message
  exit 1
end

at = begin
  AuthorizationLedger.format_time(AuthorizationLedger.now_utc)
rescue AuthorizationLedger::Error => e
  usage!(e.message)
end
phase = agent == "pm" ? "pending" : "assigned"
gates = nil
changes = []
if plan
  gates, changes, conflict = CompletionGuard.reconcile_gate_plan({}, plan, actor: actor, at: at)
  usage!("the gate plan cannot be declared: #{conflict}") if conflict
end
gate_names = plan ? plan.map { |item| item["name"] } : []
opened_reason = if plan
                  "opened with completion gates: #{gate_names.join(', ')}"
                else
                  "opened without completion gates: #{opts[:no_gates]}"
                end
today = Date.today.to_s
status = {
  "task_id" => task_id,
  "task_label" => opts[:title],
  "phase" => phase,
  "state" => phase,
  "iteration" => 0,
  "current_agent" => agent,
  "ready" => true,
  "blocked_on" => [],
  "waiting_for" => [],
  "assignment" => { "primary" => agent, "parallel" => false },
  "created_at" => today,
  "updated_at" => today,
  "history" => [{ "phase" => "created -> #{phase}", "agent" => CompletionGuard.event_agent(actor),
                  "reason" => opened_reason, "at" => at }] + changes.map(&:first)
}
status["completion_gates"] = gates if plan
description = opts[:description].to_s.empty? ? "Describe the scope and acceptance criteria here before work starts." : opts[:description]
task_md = "# #{task_id}: #{opts[:title]}\n\n#{description}\n"
opened_details = plan ? "gates=#{gate_names.join(',')}" : "gates=none reason=#{opts[:no_gates]}"

FileUtils.mkdir_p(RUNS_DIR)
task_dir = File.join(RUNS_DIR, task_id)

# The critical section runs from before mkdir until the task is fully written
# or rolled back. Signals that would end the run are deferred across it: their
# handler only records the signal, so no signal can land between mkdir and the
# rollback that owns the directory. Afterwards a recorded signal rolls the open
# back and ends the run with that same signal. Only SIGKILL cannot be deferred.
received = nil
previous_handlers = %w[INT TERM HUP].map { |sig| [sig, trap(sig) { received ||= sig }] }
created = false
failure = nil
outcome = begin
  Dir.mkdir(task_dir)
  created = true

  lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
  lock.flock(File::LOCK_EX)
  obstacle = ->(step, path) { Dir.mkdir(path) if fail_at == step }

  task_md_path = File.join(task_dir, "task.md")
  obstacle.call("task_md", task_md_path)
  File.write(task_md_path, task_md)

  status_path = File.join(task_dir, "status.yaml")
  obstacle.call("status", status_path)
  tmp_path = "#{status_path}.tmp.#{$$}"
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)

  obstacle.call("meta", File.join(task_dir, "meta.yaml"))
  # append_meta_event! warns and returns false on a write error; here that is a
  # failure, so every event goes through this one check.
  record_event = lambda do |type, details|
    recorded = CompletionGuard.append_meta_event!(task_dir, type: type, agent: CompletionGuard.event_agent(actor), details: details)
    raise IOError, "could not record the #{type} event in meta.yaml" unless recorded
  end
  record_event.call("task_opened", opened_details)
  changes.each { |_row, details| record_event.call("completion_gate_updated", details) }
  :opened
rescue Exception => e # rubocop:disable Lint/RescueException -- every failure after mkdir must roll back
  failure = e
  created ? :failed : :not_created
ensure
  lock&.close
end
# Only a directory this invocation created is ever removed.
FileUtils.rm_rf(task_dir) if created && (outcome == :failed || received)
previous_handlers.each { |sig, handler| trap(sig, handler || "DEFAULT") }

if received
  warn "Interrupted (SIG#{received}) while opening #{task_id}." + (created ? " The task directory was removed." : "")
  raise SignalException, received
end
if outcome == :not_created
  if failure.is_a?(Errno::EEXIST)
    warn "#{task_id} already exists at #{task_dir}; open a new id (run intake for the next one)."
    exit 4
  end
  raise failure
end
if outcome == :failed
  if failure.is_a?(SignalException) || failure.is_a?(SystemExit)
    warn "Interrupted while opening #{task_id}. The task directory was removed."
    raise failure
  end
  warn "Could not open #{task_id}: #{failure.message}. The task directory was removed."
  exit 5
end

puts "Opened #{task_id} (#{phase}, #{agent})" + (plan ? " with completion gates: #{gate_names.join(', ')}" : " without completion gates: #{opts[:no_gates]}")
puts "Next: ./run-agent.sh status #{task_id}"
```

Run: `bash tests/integration/open-task.sh`
Expected: FAIL at `O12 run-agent.sh open` (`Error: Task directory not found: …/open`), because `run-agent.sh` does not know `open` yet. Everything before O12 passes.

- [ ] **Step 4: Wire `run-agent.sh`**

Save as `55-runagent-patch.rb` in the scratchpad, then run `ruby <scratchpad>/55-runagent-patch.rb run-agent.sh`:

```ruby
# encoding: utf-8
# #55 Task 3: run-agent.sh open, usage and the intake open line.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
       ./run-agent.sh [--profile <name>] <TASK_ID> scaffold <dev|dev-2|reviewer> [--force]
       ./run-agent.sh [--profile <name>] status [TASK_ID]
       ./run-agent.sh [--profile <name>] intake "<request>"
       ./run-agent.sh [--profile <name>] verify <TASK_ID>
       ./run-agent.sh [--profile <name>] cleanup

OLD
       ./run-agent.sh [--profile <name>] <TASK_ID> scaffold <dev|dev-2|reviewer> [--force]
       ./run-agent.sh [--profile <name>] status [TASK_ID]
       ./run-agent.sh [--profile <name>] intake "<request>"
       ./run-agent.sh [--profile <name>] open <TASK_ID> --title "<title>" (--preset <name> | --gate <name>:<reason> | --no-gates "<reason>")
       ./run-agent.sh [--profile <name>] verify <TASK_ID>
       ./run-agent.sh [--profile <name>] cleanup

NEW

rep!(s, <<'OLD', <<'NEW')

Operator helpers:
  ./run-agent.sh intake "Fix wallet callback failure"
  ./run-agent.sh verify TASK-011
  ./run-agent.sh cleanup
EOF
OLD

Operator helpers:
  ./run-agent.sh intake "Fix wallet callback failure"
  ./run-agent.sh open TASK-EAR-012 --title "Fix wallet callback" --agent dev --preset staging
  ./run-agent.sh verify TASK-011
  ./run-agent.sh cleanup
EOF
NEW

rep!(s, <<'OLD', <<'NEW')
puts "Unknowns: #{unknowns.empty? ? 'none' : unknowns.join(', ')}"
puts "Question: #{unknowns.empty? ? 'none' : "Please clarify #{unknowns.first}."}"
puts "Next: ./run-agent.sh #{next_task_id} pm"
RUBY
}

OLD
puts "Unknowns: #{unknowns.empty? ? 'none' : unknowns.join(', ')}"
puts "Question: #{unknowns.empty? ? 'none' : "Please clarify #{unknowns.first}."}"
puts "Next: ./run-agent.sh #{next_task_id} pm"
puts "Or open it as a conductor: ./run-agent.sh open #{next_task_id} --title \"...\" (--preset <name> | --no-gates \"<reason>\")"
RUBY
}

NEW

rep!(s, <<'OLD', <<'NEW')
  exit $?
fi

if [[ "${1:-}" == "verify" ]]; then
  [[ $# -ge 2 ]] || usage
  show_verify_plan "$2"
OLD
  exit $?
fi

# Issue #55: a conductor opens a task with a completion-gate decision.
if [[ "${1:-}" == "open" ]]; then
  [[ $# -ge 2 ]] || usage
  shift
  exec ruby "$OFFICE_DIR/scripts/open-task.rb" "$@"
fi

if [[ "${1:-}" == "verify" ]]; then
  [[ $# -ge 2 ]] || usage
  show_verify_plan "$2"
NEW
File.write(path, s)
```

- [ ] **Step 5: Run the suite and the regression suites**

Run: `bash tests/integration/open-task.sh && bash tests/integration/team-prefix-registry.sh && bash tests/integration/task-id-guidance-policy.sh && bash tests/integration/event-gateway.sh && bash tests/integration/status-command.sh && bash tests/integration/operator-commands.sh && bash tests/integration/git-sync.sh`
Expected: each prints its own PASS line. `LC_ALL=C grep -n '[^ -~]' <(git diff run-agent.sh | grep '^+')` prints nothing: the added `run-agent.sh` lines are ASCII.

- [ ] **Step 6: Commit**

```bash
git add scripts/open-task.rb run-agent.sh tests/integration/open-task.sh
git commit -m "feat(office): open a task with a completion-gate decision (#55)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Conductor docs, and the full suite

**Files:**
- Modify: `AGENTS.md`, `docs/codex.md`, `docs/completion-gates.md`, `docs/skills/office-intake.md`
- Test: `tests/integration/open-task.sh` (section D)

**Interfaces:**
- Consumes: the command from Task 3. Produces: no code.

- [ ] **Step 1: Write the failing doc checks**

Save as `55-t4-test-patch.rb` in the scratchpad, then run `ruby <scratchpad>/55-t4-test-patch.rb tests/integration/open-task.sh`:

```ruby
# encoding: utf-8
# #55 Task 4: docs tests (section D).
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake), O open (O1-O13), RF Review Focus.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
OLD
# backfill), custom gates, or --no-gates "<reason>". Gates are declared with the
# same record construction as scripts/update-completion-gate.rb.
# Sections: P presets (load + compose), N namespace rules (and parity with
# run-agent.sh's PM creation gate and intake), O open (O1-O13), RF Review Focus,
# D docs.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
NEW

rep!(s, <<'OLD', <<'NEW')
assert_eq "$rc" "0" "RF5 a fresh runs directory ($(cat "$RUNS/open.log"))"
[[ -f "$RUNS/fresh/runs/TASK-EAR-943/status.yaml" ]] || fail "RF5 task not written"

echo "[PASS] open-task: open a task with gates (#55)"
OLD
assert_eq "$rc" "0" "RF5 a fresh runs directory ($(cat "$RUNS/open.log"))"
[[ -f "$RUNS/fresh/runs/TASK-EAR-943/status.yaml" ]] || fail "RF5 task not written"

# --- D: conductors are told to open tasks this way ---
grep -qF './run-agent.sh open <TASK_ID>' "$ROOT/AGENTS.md" || fail "D AGENTS.md does not tell conductors to open tasks with run-agent.sh open"
grep -qF 'never by hand-writing' "$ROOT/AGENTS.md" || fail "D AGENTS.md does not forbid hand-written status.yaml"
grep -qF './run-agent.sh open <TASK_ID>' "$ROOT/docs/codex.md" || fail "D docs/codex.md lacks the open rule"
grep -qF '## Opening a task with gates (#55)' "$ROOT/docs/completion-gates.md" || fail "D docs/completion-gates.md lacks the section"
grep -qF 'run-agent.sh open <TASK_ID>' "$ROOT/docs/skills/office-intake.md" || fail "D office-intake guide lacks the open step"
for preset in staging production backfill; do
  grep -qF "| \`$preset\` |" "$ROOT/docs/completion-gates.md" || fail "D completion-gates.md does not list preset $preset"
done

echo "[PASS] open-task: open a task with gates (#55)"
NEW
File.write(path, s)
```

Run: `bash tests/integration/open-task.sh`
Expected: FAIL with `[FAIL] D AGENTS.md does not tell conductors to open tasks with run-agent.sh open`.

- [ ] **Step 2: Update the docs**

Save each script in the scratchpad and run it on its file:
- `ruby <scratchpad>/55-agents-patch.rb AGENTS.md`
- `ruby <scratchpad>/55-codex-patch.rb docs/codex.md`
- `ruby <scratchpad>/55-cg-doc-patch.rb docs/completion-gates.md`
- `ruby <scratchpad>/55-intake-doc-patch.rb docs/skills/office-intake.md`

`55-agents-patch.rb`:

```ruby
# encoding: utf-8
# #55 Task 4: conductors open tasks with run-agent.sh open.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
strength), and subagent output is verified before it is accepted. Over-delegation
is an anti-pattern.

### Lightweight-to-formal escalation

The conductor lane is for daily work (review, debug, implementation loop, small to
OLD
strength), and subagent output is verified before it is accepted. Over-delegation
is an anti-pattern.

**Opening a task.** A conductor opens a new task with
`./run-agent.sh open <TASK_ID> --title "…"`, never by hand-writing
`runs/<TASK_ID>/status.yaml`. Opening requires a completion-gate decision:
`--preset staging|production|backfill` (deploy and data work), custom
`--gate <name>:<reason>`, or `--no-gates "<reason>"` for work with nothing to
gate. After that, gates change only through `scripts/update-completion-gate.rb`.
See [docs/completion-gates.md](docs/completion-gates.md#opening-a-task-with-gates-55).

### Lightweight-to-formal escalation

The conductor lane is for daily work (review, debug, implementation loop, small to
NEW
File.write(path, s)
```

`55-codex-patch.rb`:

````ruby
# encoding: utf-8
# #55 Task 4: the open rule for Codex as conductor.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
ai-skills, project `AGENTS.md`, current tests/checks, and verification results.
It must not treat SocratiCode, run records, or historical notes as final truth.

## Basic usage

```bash
OLD
ai-skills, project `AGENTS.md`, current tests/checks, and verification results.
It must not treat SocratiCode, run records, or historical notes as final truth.

As a conductor, Codex opens a new task with `./run-agent.sh open <TASK_ID>`
and a completion-gate decision (`--preset`, `--gate`, or `--no-gates "<reason>"`),
never by hand-writing `status.yaml` (see
[completion-gates.md](completion-gates.md#opening-a-task-with-gates-55)).

## Basic usage

```bash
NEW
File.write(path, s)
````

`55-cg-doc-patch.rb`:

````ruby
# encoding: utf-8
# #55 Task 4: opening a task with gates.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
passes a gate. Spec:
[`superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md`](superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md).

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
OLD
passes a gate. Spec:
[`superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md`](superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md).

## Opening a task with gates (#55)

Conductors open a task with `./run-agent.sh open` (`scripts/open-task.rb`)
instead of hand-writing `status.yaml`. It writes `task.md`, `status.yaml` and
`meta.yaml` and requires a gate decision:

```
./run-agent.sh open <TASK_ID> --title "<title>" [--agent <role>] [--actor <role>] [--description "<text>"]
    ( --preset <name> ... | --gate <name>:<reason> ... | --no-gates "<reason>" )
```

Presets live in `tasks/templates/gate-presets.yaml`:

| Preset | Gates, in order |
|---|---|
| `staging` | `implementation_verification` → `deploy_staging` (bound to `deploy_staging`) → `staging_acceptance` |
| `production` | the `staging` chain → `deploy_production` (bound to `deploy_production`) → `production_acceptance` |
| `backfill` | `production_backfill` (bound to `production_backfill`) |

Every preset gate requires a run record (`--ran-by` plus `--ran-ref`/`--ran-url`
on pass), and each is ordered after the one before it. Presets merge by gate
name, then custom gates follow; the same name with a different definition is
refused. Names and reasons are stripped exactly as the writer strips its flags,
and the plan is declared with the PM gate-plan reconcile (Phase 2E), so every
record and history row is byte-identical to `update-completion-gate.rb declare`.

- `--gate <name>:<reason>` declares a plain pending gate. Ordering and record
  requirements can be added later (`depend`, `require-record`); an
  authorization binding cannot (it is declare-only and immutable), so a gate
  that needs a grant comes from a preset, or is declared as a new gate with
  `declare --requires-authorization`.
- `--no-gates "<reason>"` opens without `completion_gates` and records the
  reason in the first history row and the `task_opened` meta event.
- `--agent` is the role taking the task (default `pm`, phase `pending`; any
  other of `dev dev-2 reviewer debugger devops free-roam` gives `assigned`).
- The id must pass the same namespace rules as intake and the PM creation gate
  (`scripts/task-namespace.rb`); `PKG` and `GW` are reserved.

Exit codes: `0` opened; `1` namespace refused; `2` usage error; `3` the presets
file is unreadable or malformed; `4` the task already exists; `5` a write failed
after the directory was created (the directory was removed). Nothing is written
unless the exit is 0. INT, TERM and HUP are deferred from just before the
directory is created until the task is fully written: a signal in that window
rolls the open back (removing only the directory this run created) and then
ends the run with that signal. Only an uncatchable SIGKILL can leave a partly
written task behind. `open` makes no git commit, push or sync. Spec:
[`superpowers/specs/2026-10-09-open-task-gates-design.md`](superpowers/specs/2026-10-09-open-task-gates-design.md).

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
NEW
File.write(path, s)
````

`55-intake-doc-patch.rb`:

```ruby
# encoding: utf-8
# #55 Task 4: the open step after intake.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
- Known scope and unknowns
- One concise clarification question when required
- Recommended next command, usually `./ai-dev-office/run-agent.sh <TASK_ID> pm` using the exact id returned by intake

## Parallel Intake Guidance

OLD
- Known scope and unknowns
- One concise clarification question when required
- Recommended next command, usually `./ai-dev-office/run-agent.sh <TASK_ID> pm` using the exact id returned by intake
- For a conductor-run task: `./ai-dev-office/run-agent.sh open <TASK_ID> --title "…"` with a completion-gate decision (`--preset staging|production|backfill`, `--gate <name>:<reason>`, or `--no-gates "<reason>"`); intake prints this line too

## Parallel Intake Guidance

NEW
File.write(path, s)
```

- [ ] **Step 3: Run the suite, then everything**

Run: `bash tests/integration/open-task.sh`
Expected: `[PASS] open-task: open a task with gates (#55)`.

Then, from the worktree root, run every suite and check that each one ends with its own PASS line, not only exit 0:

```bash
for t in tests/integration/*.sh; do n=$(basename "$t" .sh); if bash "$t" > "<scratchpad>/s-$n.log" 2>&1; then tail -3 "<scratchpad>/s-$n.log" | grep -qiE '\[PASS\]|^PASS|passed$' || echo "EXIT 0 WITHOUT PASS LINE: $n"; else echo "FAIL: $n"; fi; done
```

Expected: on a base that includes main's #59, every suite exits 0 and prints its own PASS line or "... passed". On f87cd9a5 alone, `dashboard-dev-wait` exits 0 silently, and `idempotency-and-reentry`, `loop-guard-bounded`, `observability`, `state-machine-consistency` and `task-ownership` exit 0 after an `OFFICE_DIR: unbound variable` line. That is pre-existing and fixed by #59. Any other suite without its PASS line, or any non-zero exit, is a regression: fix the code, never the test.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/codex.md docs/completion-gates.md docs/skills/office-intake.md tests/integration/open-task.sh
git commit -m "docs(office): conductors open tasks with run-agent.sh open (#55)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
