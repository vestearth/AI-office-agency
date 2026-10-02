#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID
WRITER="$ROOT/scripts/update-task-branch.rb"
FORCE="$ROOT/scripts/force-status-route.rb"
SYNC="$ROOT/scripts/sync-status-from-output.rb"
RECONCILE="$ROOT/scripts/reconcile-decision.rb"
UNBLOCK="$ROOT/scripts/reconcile-blocked-status.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
field() {
  ruby -ryaml -rdate - "$1" "$2" <<'RUBY'
data = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true)
value = ARGV[1].split(".").reduce(data) { |node, key| node.is_a?(Hash) ? node[key] : nil }
puts value.nil? ? "" : value
RUBY
}
task() {
  local dir="$RUNS/$1"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: assigned
state: assigned
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
history: []
YAML
  echo "$dir"
}
run_writer() { ruby "$WRITER" "$@" >/dev/null; }
force_done() {
  ruby "$FORCE" "$1" "$RUNS/$1/status.yaml" 2026-10-02 done done reviewer "accept" >"$RUNS/force.log" 2>&1
}
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }

# Replay the checked-in TASK-VS-004 status. Move its existing Wave 2 prose
# wait into the branch while preserving the independent staging approval wait.
D="$(task TASK-VS-004)"
cp "$ROOT/runs/TASK-VS-004/status.yaml" "$D/status.yaml"
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
waits = s.fetch("waiting_for")
abort "VS-004 fairness wait changed" unless waits.size == 2 && waits.first.include?("fairness policy decision")
s["waiting_for"] = [waits.last]
File.write(p, YAML.dump(s))
RUBY
run_writer TASK-VS-004 declare wave_1 --actor pm --reason "bank 429 and Redis admission are executable"
run_writer TASK-VS-004 declare wave_2 --actor pm --reason "fairness policy pending" --state blocked --waiting-for "operator: fairness policy A/B/C"
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "partial block keeps task assigned"
assert_eq "$(field "$D/status.yaml" ready)" "true" "ready sibling keeps task ready"
assert_eq "$(field "$D/status.yaml" branches.wave_1.state)" "ready" "wave 1 ready"
assert_eq "$(field "$D/status.yaml" branches.wave_2.state)" "blocked" "wave 2 blocked"
grep -q 'approval for the staging multi-merchant run' "$D/status.yaml" || fail "VS-004 global staging wait was removed"
validate "$D/status.yaml" || fail "VS-004 partial branch status invalid: $(cat "$RUNS/validate.log")"
bash "$ROOT/run-agent.sh" status TASK-VS-004 >"$RUNS/status.log"
grep -q 'wave_1: ready' "$RUNS/status.log" || fail "status command hides ready branch"
grep -q 'wave_2: blocked (waiting for operator: fairness policy A/B/C)' "$RUNS/status.log" || fail "status command hides blocked branch"
ruby "$ROOT/scripts/adapter-status.rb" TASK-VS-004 | ruby -rjson -e 's = JSON.parse(STDIN.read); abort unless s.dig("branches", "wave_1", "state") == "ready" && s.dig("branches", "wave_2", "state") == "blocked"' || fail "adapter hides branches"
if force_done TASK-VS-004; then fail "an unresolved branch allowed done"; fi
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "refused done preserves phase"
grep -q "branch:wave_1" "$RUNS/force.log" || fail "unresolved branch absent from refusal"

run_writer TASK-VS-004 done wave_1 --actor dev --reason "Wave 1 acceptance complete"
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "only waiting branch blocks task"
assert_eq "$(field "$D/status.yaml" ready)" "false" "all remaining work blocked"
grep -q 'branch:wave_2' "$D/status.yaml" || fail "task-level wait lacks branch reason"
validate "$D/status.yaml" || fail "all-blocked status invalid: $(cat "$RUNS/validate.log")"

run_writer TASK-VS-004 ready wave_2 --actor pm --reason "operator chose policy A"
# Its separate staging approval remains, so the task still waits after the
# policy branch is ready. The independent no-global-wait resume is below.
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "staging approval still blocks task"

# Without an independent task-level wait, resolving the branch resumes work.
D="$(task TASK-905)"
run_writer TASK-905 declare wave_1 --actor pm --reason "Wave 1 executable"
run_writer TASK-905 declare wave_2 --actor pm --reason "policy pending" --state blocked --waiting-for "operator policy"
cat > "$D/dev-output.yaml" <<'YAML'
summary: Wave 1 implementation complete
next_action:
  agent: reviewer
  reason: Review Wave 1
YAML
ruby "$SYNC" TASK-905 dev "$D/status.yaml" "$D/dev-output.yaml" 2026-10-02 in_review >"$RUNS/sync.log"
assert_eq "$(field "$D/status.yaml" phase)" "in_review" "normal sync keeps review handoff"
grep -q 'branch:wave_2 operator policy' "$D/status.yaml" || fail "normal sync erased Wave 2 wait"
validate "$D/status.yaml" || fail "synced branch status invalid: $(cat "$RUNS/validate.log")"
cp "$D/status.yaml" "$RUNS/stale-projection.yaml"
ruby -ryaml -rdate - "$RUNS/stale-projection.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["waiting_for"] = []
File.write(p, YAML.dump(s))
RUBY
if validate "$RUNS/stale-projection.yaml"; then fail "missing branch wait passed validation"; fi
run_writer TASK-905 done wave_1 --actor dev --reason "Wave 1 accepted"
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "reviewed Wave 1 leaves only blocked Wave 2"
cp "$D/status.yaml" "$RUNS/stale-projection.yaml"
ruby -ryaml -rdate - "$RUNS/stale-projection.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["phase"] = s["state"] = "in_review"
File.write(p, YAML.dump(s))
RUBY
if validate "$RUNS/stale-projection.yaml"; then fail "only-blocked branch in review passed validation"; fi
run_writer TASK-905 ready wave_2 --actor pm --reason "policy chosen"
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "resolved wait resumes task"
assert_eq "$(field "$D/status.yaml" current_agent)" "dev" "resume routes to assigned role"
run_writer TASK-905 done wave_2 --actor dev --reason "Wave 2 acceptance complete"
force_done TASK-905 || fail "both branches done should permit done: $(cat "$RUNS/force.log")"
assert_eq "$(field "$D/status.yaml" phase)" "done" "completed branches permit task done"
validate "$D/status.yaml" || fail "completed branch status invalid: $(cat "$RUNS/validate.log")"

# A branch may be ruled out with an explicit audited na.
D="$(task TASK-906)"
run_writer TASK-906 declare optional_wave --actor pm --reason "pending decision" --state blocked --waiting-for "operator decision"
run_writer TASK-906 na optional_wave --actor pm --reason "not applicable after scope change"
if run_writer TASK-906 ready optional_wave --actor pm --reason "reopen" 2>/dev/null; then fail "terminal branch reopened"; fi
force_done TASK-906 || fail "na branch should permit done"
assert_eq "$(field "$D/status.yaml" branches.optional_wave.state)" "na" "na recorded"

# A task-level wait is not cleared when a branch becomes executable.
D="$(task TASK-909)"
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["phase"] = s["state"] = "blocked"
s["ready"] = false
s["waiting_for"] = ["operator: global release hold"]
File.write(p, YAML.dump(s))
RUBY
run_writer TASK-909 declare wave_1 --actor pm --reason "local work can proceed"
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "global wait keeps task blocked"
grep -q 'operator: global release hold' "$D/status.yaml" || fail "global wait was removed"
validate "$D/status.yaml" || fail "global wait status invalid: $(cat "$RUNS/validate.log")"

# Non-terminal force routes and human decisions retain branch projection.
D="$(task TASK-910)"
run_writer TASK-910 declare wave_1 --actor pm --reason "can run"
run_writer TASK-910 declare wave_2 --actor pm --reason "policy pending" --state blocked --waiting-for "operator policy"
ruby "$FORCE" TASK-910 "$D/status.yaml" 2026-10-02 reviewer in_review orchestrator "manual review" >"$RUNS/force.log"
assert_eq "$(field "$D/status.yaml" phase)" "in_review" "force route keeps governable phase"
grep -q 'branch:wave_2 operator policy' "$D/status.yaml" || fail "force route erased branch wait"
cat > "$D/decision.yaml" <<'YAML'
task_id: TASK-910
decisions:
  - decision: request_changes
    actor: operator
    decided_at: "2026-10-02T00:00:00Z"
YAML
ruby "$RECONCILE" TASK-910 >"$RUNS/decision.log"
assert_eq "$(field "$D/status.yaml" phase)" "debugging" "decision keeps governable phase"
grep -q 'branch:wave_2 operator policy' "$D/status.yaml" || fail "decision erased branch wait"
run_writer TASK-910 done wave_1 --actor dev --reason "accepted"
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "decision path blocks when only Wave 2 remains"
validate "$D/status.yaml" || fail "decision branch status invalid: $(cat "$RUNS/validate.log")"

# Dependency reconciliation must not drop a still-blocked branch.
D="$(task TASK-911)"
run_writer TASK-911 declare wave_1 --actor pm --reason "planned"
run_writer TASK-911 declare wave_2 --actor pm --reason "policy pending" --state blocked --waiting-for "operator policy"
run_writer TASK-911 done wave_1 --actor dev --reason "accepted"
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["blocked_on"] = ["TASK-912"]
File.write(p, YAML.dump(s))
RUBY
UPSTREAM="$(task TASK-912)"
ruby "$FORCE" TASK-912 "$UPSTREAM/status.yaml" 2026-10-02 done done reviewer "accepted" >"$RUNS/force.log"
ruby "$UNBLOCK" TASK-911 "$D/status.yaml" "$RUNS" 2026-10-02 done in_review true true true >"$RUNS/unblock.log"
assert_eq "$(field "$D/status.yaml" phase)" "blocked" "dependency release retains branch block"
grep -q 'branch:wave_2 operator policy' "$D/status.yaml" || fail "dependency release erased branch wait"
run_writer TASK-911 ready wave_2 --actor pm --reason "policy chosen"
assert_eq "$(field "$D/status.yaml" phase)" "assigned" "dependency release permits branch resume"
validate "$D/status.yaml" || fail "dependency branch status invalid: $(cat "$RUNS/validate.log")"

# A forged terminal branch is rejected by the guard and stored validator.
D="$(task TASK-907)"
run_writer TASK-907 declare wave_1 --actor pm --reason "planned"
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["branches"]["wave_1"] = { "state" => "done" }
File.write(p, YAML.dump(s))
RUBY
if force_done TASK-907; then fail "forged branch without audit metadata allowed done"; fi
if run_writer TASK-907 done wave_1 --actor dev --reason "repair forged branch" 2>/dev/null; then fail "writer accepted malformed branch"; fi
ruby -ryaml -rdate - "$D/status.yaml" <<'RUBY'
p = ARGV[0]
s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time], aliases: true)
s["phase"] = s["state"] = "done"
File.write(p, YAML.dump(s))
RUBY
if validate "$D/status.yaml"; then fail "stored done with malformed branch validated"; fi
grep -q "unresolved branch" "$RUNS/validate.log" || fail "stored-state error missing"

# Legacy tasks without branches retain the old done path.
D="$(task TASK-908)"
force_done TASK-908 || fail "legacy task without branches refused done"
validate "$D/status.yaml" || fail "legacy status invalid: $(cat "$RUNS/validate.log")"

echo "[PASS] partial-branches: VS-004 replay, normal handoff, shared projection, guarded completion, legacy compatibility"
