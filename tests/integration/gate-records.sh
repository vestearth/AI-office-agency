#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2C — gate run records.
#
# A passing gate can record what actually ran: `ran: {by, ref, url}` (`by`
# required, plus `ref` and/or an https `url`). A gate can opt in to requiring
# it with `requires_record: true` (declare --requires-record, or the
# require-record action on a pending gate; add-only). A required record
# missing on a stored pass leaves the gate unresolved: it blocks done and 2B
# dependants. Sections: U shared helpers, R replay (EAR-384/385), X writer
# refusals, C carry-forward / malformed state / fence, T teeth, V stored-state
# validation and S team sync / revert safety.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
AUTHZ="$ROOT/scripts/record-authorization.rb"
FORCE="$ROOT/scripts/force-status-route.rb"
OWN="$ROOT/scripts/task-ownership.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# field <file> <dotted.path> — numeric segments index into lists; prints "" when absent.
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
# task <TASK_ID> [phase] — a minimal governed task.
task() {
  local dir="$RUNS/$1" phase="${2:-assigned}"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: $phase
state: $phase
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-01'
history: []
YAML
  printf '# %s\n' "$1" > "$dir/task.md"
  echo "$dir"
}
gate() { ruby "$GATE" "$@"; }
force_done() { ruby "$FORCE" "$1" "$RUNS/$1/status.yaml" 2026-10-08 done done reviewer "accept" >"$RUNS/force.log" 2>&1; }
validate() { ruby "$VALIDATOR" "$1" >"$RUNS/validate.log" 2>&1; }
# set_gate <status.yaml> <gate> <ruby hash literal> — hand-edit one gate record (stored-state cases).
set_gate() {
  ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time])
    (s["completion_gates"] ||= {})[ARGV[1]] = eval(ARGV[2]); File.write(p, YAML.dump(s))' "$1" "$2" "$3"
}
# expect_refusal <exit> <label> <TASK_ID> <gate writer args...> — exit code matches and nothing is written.
expect_refusal() {
  local code="$1" label="$2" task_id="$3"; shift 3
  local status="$RUNS/$task_id/status.yaml"
  cp "$status" "$RUNS/before.yaml"
  rc=0; ruby "$GATE" "$task_id" "$@" >/dev/null 2>"$RUNS/refusal.log" || rc=$?
  assert_eq "$rc" "$code" "$label exit ($(cat "$RUNS/refusal.log"))"
  cmp -s "$status" "$RUNS/before.yaml" || fail "$label wrote status.yaml"
}

# --- U: shared run-record helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
meta = { "actor" => "dev-2", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" }
good = { "by" => "operator", "ref" => "05fae97f", "url" => "https://github.com/SparqLab/shared-lib/pull/88" }
check "valid ran", CompletionGuard.ran_errors(good), []
check "ref only", CompletionGuard.ran_errors({ "by" => "operator", "ref" => "abc" }), []
check "url only", CompletionGuard.ran_errors({ "by" => "operator", "url" => "https://x.example/run/1" }), []
check "not a map", CompletionGuard.ran_errors("abc"), ["ran must be a map with by and ref and/or url"]
check "no by", CompletionGuard.ran_errors({ "ref" => "abc" }), ["ran.by must be a non-empty string"]
check "neither ref nor url", CompletionGuard.ran_errors({ "by" => "op" }), ["ran needs ref or url"]
check "empty ref", CompletionGuard.ran_errors({ "by" => "op", "ref" => " " }), ["ran.ref must be a non-empty string"]
check "http url", CompletionGuard.ran_errors({ "by" => "op", "url" => "http://x" }), ["ran.url must start with https://"]
check "unknown key", CompletionGuard.ran_errors(good.merge("sha" => "x")), ["ran has unknown field(s): sha"]
required = meta.merge("status" => "pass", "requires_record" => true)
check "missing record", CompletionGuard.missing_run_record?(required), true
check "record present", CompletionGuard.missing_run_record?(required.merge("ran" => good)), false
check "malformed record", CompletionGuard.missing_run_record?(required.merge("ran" => { "by" => "op" })), true
check "na needs no record", CompletionGuard.missing_run_record?(required.merge("status" => "na")), false
check "not required", CompletionGuard.missing_run_record?(meta.merge("status" => "pass")), false
check "resolved without record", CompletionGuard.resolved?(required), false
check "resolved with record", CompletionGuard.resolved?(required.merge("ran" => good)), true
check "na resolved", CompletionGuard.resolved?(required.merge("status" => "na")), true
check "unrequired pass resolved", CompletionGuard.resolved?(meta.merge("status" => "pass")), true
check "stored errors clean", CompletionGuard.run_record_errors({ "a" => required.merge("ran" => good), "b" => { "status" => "pending", "requires_record" => true } }), []
check "requires_record not true", CompletionGuard.run_record_errors({ "a" => { "status" => "pending", "requires_record" => "yes" } }),
      ["completion_gates.a.requires_record must be true"]
check "ran on a pending gate", CompletionGuard.run_record_errors({ "a" => { "status" => "pending", "ran" => good } }),
      ["completion_gates.a.ran is only valid on a pass"]
check "malformed stored ran", CompletionGuard.run_record_errors({ "a" => meta.merge("status" => "pass", "ran" => { "by" => "op" }) }),
      ["completion_gates.a.ran needs ref or url"]
check "gate_record with record",
      CompletionGuard.gate_record(status: "pass", actor: "dev-2", reason: "r", updated_at: "T", after: ["a"], requires_record: true, ran: good).keys,
      %w[status actor reason updated_at evidence_refs after requires_record ran]
check "gate_record without record is unchanged",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T").keys,
      %w[status actor reason updated_at evidence_refs]
RUBY

SHA=05fae97f5ea5d38c7aded6f2eccbb627c0e72c2f
PR_URL=https://github.com/SparqLab/shared-lib/pull/88

# --- R: replay shapes ---
# EAR-384: the requirement is added to an existing pending gate, then the pass must carry the record.
D="$(task TASK-990)"
gate TASK-990 declare shared_lib_publication --actor pm --reason "publish shared-lib" >/dev/null
out="$(gate TASK-990 require-record shared_lib_publication --actor pm --reason "publication must cite the merge")"
assert_eq "$out" "gate shared_lib_publication: requires_record" "R require-record output"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.requires_record)" "true" "R requirement stored"
assert_eq "$(field "$D/status.yaml" history.1.phase)" "gate shared_lib_publication: requires_record" "R require-record history row"
grep -q "gate=shared_lib_publication requires_record actor=pm" "$D/meta.yaml" || fail "R require-record meta event"
expect_refusal 2 "R pass without the required record" TASK-990 pass shared_lib_publication --actor dev-2 --reason merged
grep -q "requires a ran record" "$RUNS/refusal.log" || fail "R refusal wording: $(cat "$RUNS/refusal.log")"
gate TASK-990 pass shared_lib_publication --actor dev-2 --reason "merged to main" --ran-by operator --ran-ref "$SHA" --ran-url "$PR_URL" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.ran.by)" "operator" "R ran.by"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.ran.ref)" "$SHA" "R ran.ref"
assert_eq "$(field "$D/status.yaml" completion_gates.shared_lib_publication.ran.url)" "$PR_URL" "R ran.url"
validate "$D/status.yaml" || fail "R EAR-384 invalid: $(cat "$RUNS/validate.log")"
force_done TASK-990 || fail "R done refused after the recorded pass: $(cat "$RUNS/force.log")"

# EAR-385: declared with the requirement; the operator performs, dev-2 records.
D="$(task TASK-991)"
gate TASK-991 declare authenticated_staging --actor pm --reason "staging smoke" --requires-record >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.requires_record)" "true" "R declare --requires-record"
gate TASK-991 pass authenticated_staging --actor dev-2 --reason "smoke passed" --ran-by operator --ran-url https://staging.example/run/42 >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.actor)" "dev-2" "R actor kept"
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.ran.by)" "operator" "R by distinct from actor"
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.ran.ref)" "" "R ref optional when url given"

# --- X: writer refusals write nothing ---
D="$(task TASK-992)"
gate TASK-992 declare a --actor pm --reason a >/dev/null
gate TASK-992 declare r --actor pm --reason r --requires-record >/dev/null
gate TASK-992 declare p --actor pm --reason p >/dev/null
gate TASK-992 pass p --actor reviewer --reason done >/dev/null
gate TASK-992 declare n --actor pm --reason n >/dev/null
gate TASK-992 na n --actor reviewer --reason "not needed" >/dev/null
expect_refusal 2 "X --ran-* on declare" TASK-992 declare e --actor pm --reason e --ran-by op --ran-ref x
expect_refusal 2 "X --ran-* on na" TASK-992 na a --actor pm --reason r --ran-by op --ran-ref x
expect_refusal 2 "X --ran-* on depend" TASK-992 depend a --after p --actor pm --reason r --ran-by op --ran-ref x
expect_refusal 2 "X --ran-* on require-record" TASK-992 require-record a --actor pm --reason r --ran-by op --ran-ref x
expect_refusal 2 "X --ran-ref without --ran-by" TASK-992 pass a --actor pm --reason r --ran-ref x
expect_refusal 2 "X --ran-by without ref or url" TASK-992 pass a --actor pm --reason r --ran-by op
expect_refusal 2 "X empty --ran-ref" TASK-992 pass a --actor pm --reason r --ran-by op --ran-ref ""
expect_refusal 2 "X non-https --ran-url" TASK-992 pass a --actor pm --reason r --ran-by op --ran-url http://x
expect_refusal 2 "X repeated --ran-by" TASK-992 pass a --actor pm --reason r --ran-by op --ran-by other --ran-ref x
expect_refusal 2 "X --requires-record on pass" TASK-992 pass a --actor pm --reason r --requires-record
expect_refusal 2 "X repeated --requires-record" TASK-992 declare e --actor pm --reason e --requires-record --requires-record
expect_refusal 2 "X --requires-record swallowed as the --reason value" TASK-992 declare e --actor pm --reason --requires-record
expect_refusal 2 "X --requires-record swallowed as the --actor value" TASK-992 declare e --actor --requires-record --reason e
expect_refusal 2 "X require-record on a passed gate" TASK-992 require-record p --actor pm --reason r
expect_refusal 2 "X require-record on an na gate" TASK-992 require-record n --actor pm --reason r
expect_refusal 2 "X require-record on an undeclared gate" TASK-992 require-record zz --actor pm --reason r
expect_refusal 2 "X require-record twice" TASK-992 require-record r --actor pm --reason r
expect_refusal 2 "X require-record without --reason" TASK-992 require-record a --actor pm
expect_refusal 2 "X pass a required gate without a record" TASK-992 pass r --actor pm --reason r
D="$(task TASK-993 done)"
expect_refusal 2 "X finished task" TASK-993 require-record a --actor pm --reason r

# --- C: carry-forward, optional record, malformed stored state, fence ---
D="$(task TASK-994)"
gate TASK-994 declare a --actor pm --reason a >/dev/null
gate TASK-994 declare b --actor pm --reason b --requires-record >/dev/null
gate TASK-994 depend b --after a --actor pm --reason "b after a" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "C requires_record survives depend"
gate TASK-994 declare c --actor pm --reason c --after a >/dev/null
gate TASK-994 require-record c --actor pm --reason "c needs a record" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "a" "C after survives require-record"
record_without() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); g = s["completion_gates"][ARGV[1]].dup; g.delete(ARGV[2]); print YAML.dump(g)' "$1" "$2" "$3"; }
gate TASK-994 declare d --actor pm --reason "d first" >/dev/null
before="$(record_without "$D/status.yaml" d requires_record)"
gate TASK-994 require-record d --actor reviewer --reason "added later" >/dev/null
assert_eq "$(record_without "$D/status.yaml" d requires_record)" "$before" "C require-record changes nothing but requires_record"
gate TASK-994 pass a --actor reviewer --reason ok --ran-by operator --ran-ref abc123 >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.a.ran.ref)" "abc123" "C optional record stored on an unrequired gate"
gate TASK-994 pass b --actor reviewer --reason ok --ran-by operator --ran-ref first >/dev/null
gate TASK-994 pass b --actor reviewer --reason again --ran-by operator --ran-ref second >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.ran.ref)" "second" "C a new pass replaces ran"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "C requires_record survives pass"
gate TASK-994 na b --actor reviewer --reason "not needed after all" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.ran)" "" "C na drops ran"
assert_eq "$(field "$D/status.yaml" completion_gates.b.requires_record)" "true" "C requires_record survives na"
D="$(task TASK-995)"
gate TASK-995 declare a --actor pm --reason a >/dev/null
set_gate "$D/status.yaml" b '{"status" => "pending", "requires_record" => "yes"}'
expect_refusal 3 "C stored requires_record not true" TASK-995 pass a --actor pm --reason r
D="$(task TASK-996)"
gate TASK-996 declare a --actor pm --reason a >/dev/null
set_gate "$D/status.yaml" b '{"status" => "pending", "ran" => {"by" => "op", "ref" => "x"}}'
expect_refusal 3 "C stored ran on a pending gate" TASK-996 pass a --actor pm --reason r
D="$(task TASK-997)"
gate TASK-997 declare a --actor pm --reason a >/dev/null
AI_DEV_OFFICE_HOME="$ROOT" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$D" TASK-997 agent=dev "worktree=$RUNS/wt" >/dev/null 2>&1 \
  || fail "C test setup: could not acquire a lease"
cp "$D/status.yaml" "$RUNS/before.yaml"
rc=0; AI_DEV_OFFICE_HOME="$ROOT" ruby "$GATE" TASK-997 require-record a --actor pm --reason r >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "9" "C ownership fence"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "C a fenced require-record wrote status.yaml"

# --- T: a required record missing on a stored pass has teeth ---
D="$(task TASK-998 review)"
gate TASK-998 declare deploy --actor pm --reason d --requires-record >/dev/null
gate TASK-998 declare smoke --actor pm --reason s --after deploy >/dev/null
set_gate "$D/status.yaml" deploy '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "requires_record" => true}'
expect_refusal 2 "T dependant of a pass without its record" TASK-998 pass smoke --actor reviewer --reason r
grep -q "waits on: deploy (pass, missing ran record)" "$RUNS/refusal.log" || fail "T ordering label: $(cat "$RUNS/refusal.log")"
gate TASK-998 na smoke --actor reviewer --reason "not needed" >/dev/null
if force_done TASK-998; then fail "T done allowed with a required record missing"; fi
grep -q "deploy" "$RUNS/force.log" || fail "T done refusal does not name the gate"
grep -q "A gate that requires a record also needs a ran record" "$RUNS/force.log" || fail "T done refusal does not point at the missing ran record: $(cat "$RUNS/force.log")"
# Bound and requiring a record: resolved only with both a valid grant and a ran record.
D="$(task TASK-999 review)"
gate TASK-999 declare deploy --actor pm --reason d --requires-authorization deploy_staging --requires-record >/dev/null
ruby "$AUTHZ" TASK-999 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
expect_refusal 2 "T bound gate without its record" TASK-999 pass deploy --actor devops --reason deployed --authorization authz-001
gate TASK-999 pass deploy --actor devops --reason deployed --authorization authz-001 --ran-by devops --ran-url https://github.com/x/y/actions/runs/1 >/dev/null
force_done TASK-999 || fail "T bound + record pass did not resolve: $(cat "$RUNS/force.log")"

# --- V: stored-state validation ---
# expect_invalid <status.yaml> <message fragment> <label>
expect_invalid() {
  if validate "$1"; then fail "V $3 validated"; fi
  grep -qF "$2" "$RUNS/validate.log" || fail "V $3 message: $(cat "$RUNS/validate.log")"
}
D="$(task TASK-1000)"
gate TASK-1000 declare a --actor pm --reason a --requires-record >/dev/null
gate TASK-1000 declare b --actor pm --reason b >/dev/null
validate "$D/status.yaml" || fail "V a pending requires_record gate was rejected: $(cat "$RUNS/validate.log")"
v_case() { # <label> <gate> <ruby hash> <fragment>
  local dir="$RUNS/v-$1"; mkdir -p "$dir"; cp "$D/status.yaml" "$dir/status.yaml"
  set_gate "$dir/status.yaml" "$2" "$3"
  expect_invalid "$dir/status.yaml" "$4" "$1"
}
PASSED='"status" => "pass", "actor" => "x", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []'
v_case not-true b '{"status" => "pending", "requires_record" => false}' "completion_gates.b.requires_record must be true"
v_case ran-on-pending b '{"status" => "pending", "ran" => {"by" => "op", "ref" => "x"}}' "completion_gates.b.ran is only valid on a pass"
v_case ran-no-by b "{$PASSED, \"ran\" => {\"ref\" => \"x\"}}" "completion_gates.b.ran.by must be a non-empty string"
v_case ran-no-ref-or-url b "{$PASSED, \"ran\" => {\"by\" => \"op\"}}" "completion_gates.b.ran needs ref or url"
v_case ran-http b "{$PASSED, \"ran\" => {\"by\" => \"op\", \"url\" => \"http://x\"}}" "completion_gates.b.ran.url must start with https://"
v_case ran-extra b "{$PASSED, \"ran\" => {\"by\" => \"op\", \"ref\" => \"x\", \"sha\" => \"y\"}}" "completion_gates.b.ran has unknown field(s): sha"
v_case missing-record a "{$PASSED, \"requires_record\" => true}" "completion_gates.a: requires_record but ran is missing or malformed"
mkdir -p "$RUNS/v-ok"; cp "$D/status.yaml" "$RUNS/v-ok/status.yaml"
set_gate "$RUNS/v-ok/status.yaml" a "{$PASSED, \"requires_record\" => true, \"ran\" => {\"by\" => \"operator\", \"ref\" => \"abc\"}}"
set_gate "$RUNS/v-ok/status.yaml" b "{$PASSED, \"ran\" => {\"by\" => \"operator\", \"url\" => \"https://x.example/1\"}}"
validate "$RUNS/v-ok/status.yaml" || fail "V recorded passes rejected: $(cat "$RUNS/validate.log")"

# --- S: team sync and revert safety ---
mkdir -p "$RUNS/sync/TASK-999"
cp "$RUNS/TASK-999/status.yaml" "$RUNS/TASK-999/task.md" "$RUNS/TASK-999/authorization.yaml" "$RUNS/sync/TASK-999/"
ruby "$VALIDATOR" "$RUNS/sync/TASK-999/status.yaml" >"$RUNS/validate.log" 2>&1 \
  || fail "S a git-synced copy with a bound, recorded gate does not validate: $(cat "$RUNS/validate.log")"
# As after a revert: stripping both keys leaves a valid task and the done rule unchanged.
D="$(task TASK-1001 review)"
gate TASK-1001 declare a --actor pm --reason a --requires-record >/dev/null
gate TASK-1001 declare b --actor pm --reason b >/dev/null
gate TASK-1001 pass a --actor pm --reason ok --ran-by operator --ran-ref abc >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["completion_gates"].each_value { |g| g.delete("requires_record"); g.delete("ran") }; File.write(p, YAML.dump(s))' "$D/status.yaml"
validate "$D/status.yaml" || fail "S status without the record keys invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-1001; then fail "S after stripping the keys, a pending gate no longer blocks done"; fi

echo "[PASS] gate-records: gate run records (#28 Phase 2C)"
