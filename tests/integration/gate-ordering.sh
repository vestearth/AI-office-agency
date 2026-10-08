#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2B — gate ordering.
#
# A completion gate may declare `after: [gates]`. It cannot be passed until
# those gates are resolved (the same definition the done guard uses); `na` is
# not ordered. Orderings are declared with `declare --after` or added to a
# pending gate with `depend`; add-only and acyclic.
# Sections: U shared helpers, R replay (EAR-384/385), X writer refusals,
# B bound dependencies, C carry-forward / malformed state / fence,
# V stored-state validation, S team sync and revert safety.

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

# --- U: shared ordering helpers ---
ruby - "$ROOT" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
def check(label, actual, expected)
  abort "[FAIL] U #{label}: expected #{expected.inspect}, got #{actual.inspect}" unless actual == expected
end
done = { "status" => "pass", "actor" => "x", "reason" => "r", "updated_at" => "2026-10-08T01:00:00Z" }
g = { "a" => done, "b" => { "status" => "pending", "after" => ["a"] }, "c" => { "status" => "pending", "after" => ["b"] } }
check "gate_after", CompletionGuard.gate_after(g["c"]), ["b"]
check "gate_after none", CompletionGuard.gate_after(g["a"]), []
check "gate_after non-map", CompletionGuard.gate_after(nil), []
check "reaches", CompletionGuard.gate_reaches?(g, "c", "a"), true
check "does not reach", CompletionGuard.gate_reaches?(g, "a", "c"), false
check "valid ordering", CompletionGuard.ordering_errors(g), []
check "no ordering", CompletionGuard.ordering_errors({ "a" => done }), []
check "self", CompletionGuard.ordering_errors({ "a" => { "after" => ["a"] } }), ["completion_gates.a.after names the gate itself"]
check "unknown", CompletionGuard.ordering_errors({ "a" => { "after" => ["zz"] } }), ["completion_gates.a.after names zz, which is not a declared gate"]
check "empty list", CompletionGuard.ordering_errors({ "a" => { "after" => [] } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "not a list", CompletionGuard.ordering_errors({ "a" => { "after" => "b" } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "bad name", CompletionGuard.ordering_errors({ "a" => { "after" => ["Bad"] } }), ["completion_gates.a.after must be a non-empty list of gate names"]
check "duplicate", CompletionGuard.ordering_errors({ "a" => {}, "b" => { "after" => ["a", "a"] } }), ["completion_gates.b.after lists a gate twice"]
check "2-cycle", CompletionGuard.ordering_errors({ "a" => { "after" => ["b"] }, "b" => { "after" => ["a"] } }),
      ["completion_gates.a.after creates a cycle through b"]
check "3-cycle", CompletionGuard.ordering_errors({ "a" => { "after" => ["b"] }, "b" => { "after" => ["c"] }, "c" => { "after" => ["a"] } }),
      ["completion_gates.a.after creates a cycle through b"]
check "unresolved", CompletionGuard.unresolved_dependencies(g, g["c"], nil), ["b"]
check "resolved", CompletionGuard.unresolved_dependencies(g, g["b"], nil), []
check "na counts as resolved", CompletionGuard.unresolved_dependencies({ "a" => done.merge("status" => "na") }, { "after" => ["a"] }, nil), []
check "pass without metadata is unresolved", CompletionGuard.unresolved_dependencies({ "a" => { "status" => "pass" } }, { "after" => ["a"] }, nil), ["a"]
check "gate_record with after",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T", after: ["a"]).keys,
      %w[status actor reason updated_at evidence_refs after]
check "gate_record bound with after, key order",
      CompletionGuard.gate_record(status: "pass", actor: "rv", reason: "r", updated_at: "T", requires_authorization: "live_load",
                                  authorization_refs: ["authz-001"], authorization_through: "authz-001", after: ["a"]).keys,
      %w[status actor reason updated_at evidence_refs requires_authorization authorization_refs authorization_through after]
check "gate_record without after is unchanged",
      CompletionGuard.gate_record(status: "pending", actor: "pm", reason: "r", updated_at: "T").keys,
      %w[status actor reason updated_at evidence_refs]
RUBY

# --- R: replay shapes ---
# EAR-384: a four-gate chain declared with --after.
D="$(task TASK-960)"
gate TASK-960 declare product_contract --actor pm --reason "contract locked" >/dev/null
gate TASK-960 declare shared_lib_publication --actor pm --reason "publish shared-lib" --after product_contract >/dev/null
gate TASK-960 declare implementation_verification --actor pm --reason "verify implementation" --after shared_lib_publication >/dev/null
gate TASK-960 declare authenticated_staging --actor pm --reason "staging smoke" --after implementation_verification >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.authenticated_staging.after)" "implementation_verification" "R declare stores after"
expect_refusal 2 "R pass before its dependency" TASK-960 pass authenticated_staging --actor reviewer --reason early
grep -q "waits on: implementation_verification (pending)" "$RUNS/refusal.log" || fail "R refusal names the unresolved gate: $(cat "$RUNS/refusal.log")"
expect_refusal 2 "R pass two steps early" TASK-960 pass implementation_verification --actor reviewer --reason early
for g in product_contract shared_lib_publication implementation_verification authenticated_staging; do
  gate TASK-960 pass "$g" --actor reviewer --reason "done in order" >/dev/null
done
validate "$D/status.yaml" || fail "R EAR-384 chain invalid: $(cat "$RUNS/validate.log")"
force_done TASK-960 || fail "R EAR-384 done refused after an in-order chain: $(cat "$RUNS/force.log")"

# EAR-385: gates declared at intake without ordering; the chain is added later with depend.
D="$(task TASK-961)"
for g in shared_lib_publication persistence_and_contract_verification authenticated_staging; do
  gate TASK-961 declare "$g" --actor pm --reason intake >/dev/null
done
out="$(gate TASK-961 depend persistence_and_contract_verification --after shared_lib_publication --actor pm --reason "verify against the published contract")"
assert_eq "$out" "gate persistence_and_contract_verification: after += shared_lib_publication" "R depend output"
gate TASK-961 depend authenticated_staging --after persistence_and_contract_verification --actor pm --reason "staging last" >/dev/null
assert_eq "$(field "$D/status.yaml" history.4.phase)" "gate authenticated_staging: after += persistence_and_contract_verification" "R depend history row"
assert_eq "$(field "$D/status.yaml" history.4.reason)" "staging last" "R depend history reason"
grep -q "gate=authenticated_staging after+=persistence_and_contract_verification" "$D/meta.yaml" || fail "R depend meta event"
expect_refusal 2 "R EAR-385 pass out of order" TASK-961 pass authenticated_staging --actor reviewer --reason early
for g in shared_lib_publication persistence_and_contract_verification authenticated_staging; do
  gate TASK-961 pass "$g" --actor dev-2 --reason "in order" >/dev/null
done
validate "$D/status.yaml" || fail "R EAR-385 invalid: $(cat "$RUNS/validate.log")"

# depend changes only `after`, and adds to an existing list.
D="$(task TASK-962)"
gate TASK-962 declare a --actor pm --reason a >/dev/null
gate TASK-962 declare c --actor pm --reason c >/dev/null
gate TASK-962 declare b --actor pm --reason "b first" >/dev/null
gate_without_after() { ruby -ryaml -rdate -e 's = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time]); g = s["completion_gates"][ARGV[1]].dup; g.delete("after"); print YAML.dump(g)' "$1" "$2"; }
before="$(gate_without_after "$D/status.yaml" b)"
gate TASK-962 depend b --after a --actor reviewer --reason "added later" >/dev/null
gate TASK-962 depend b --after c --actor reviewer --reason "and c" >/dev/null
assert_eq "$(gate_without_after "$D/status.yaml" b)" "$before" "R depend changes nothing but after"
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "a,c" "R depend appends"

# --- X: writer refusals write nothing ---
D="$(task TASK-963)"
gate TASK-963 declare a --actor pm --reason a >/dev/null
gate TASK-963 declare b --actor pm --reason b --after a >/dev/null
gate TASK-963 declare c --actor pm --reason c >/dev/null
gate TASK-963 pass c --actor reviewer --reason done >/dev/null
gate TASK-963 declare d --actor pm --reason d >/dev/null
gate TASK-963 na d --actor reviewer --reason "not needed" >/dev/null
gate TASK-963 declare x --actor pm --reason x >/dev/null
gate TASK-963 declare y --actor pm --reason y --after x >/dev/null
gate TASK-963 declare z --actor pm --reason z --after y >/dev/null
expect_refusal 2 "X declare after an unknown gate" TASK-963 declare e --actor pm --reason e --after zz
expect_refusal 2 "X declare after itself" TASK-963 declare e --actor pm --reason e --after e
expect_refusal 2 "X declare with a repeated name" TASK-963 declare e --actor pm --reason e --after a,a
expect_refusal 2 "X declare with an empty name" TASK-963 declare e --actor pm --reason e --after "a,"
expect_refusal 2 "X depend on a name already present" TASK-963 depend b --after a --actor pm --reason r
expect_refusal 2 "X depend creating a 2-cycle" TASK-963 depend a --after b --actor pm --reason r
expect_refusal 2 "X depend creating a 3-cycle" TASK-963 depend x --after z --actor pm --reason r
expect_refusal 2 "X depend on a passed gate" TASK-963 depend c --after a --actor pm --reason r
expect_refusal 2 "X depend on an na gate" TASK-963 depend d --after a --actor pm --reason r
expect_refusal 2 "X depend on an undeclared gate" TASK-963 depend zz --after a --actor pm --reason r
expect_refusal 2 "X depend without --after" TASK-963 depend b --actor pm --reason r
expect_refusal 2 "X depend without --reason" TASK-963 depend b --after c --actor pm
expect_refusal 2 "X --after on pass" TASK-963 pass a --actor pm --reason r --after c
expect_refusal 2 "X --after on na" TASK-963 na a --actor pm --reason r --after c
D="$(task TASK-964 done)"
expect_refusal 2 "X finished task" TASK-964 declare e --actor pm --reason e --after a

# na is not ordered; an na dependency counts as resolved.
D="$(task TASK-965)"
gate TASK-965 declare a --actor pm --reason a >/dev/null
gate TASK-965 declare b --actor pm --reason b --after a >/dev/null
gate TASK-965 declare c --actor pm --reason c --after a >/dev/null
gate TASK-965 na b --actor reviewer --reason "not needed" >/dev/null || fail "X na refused while a dependency is pending"
gate TASK-965 na a --actor reviewer --reason "not needed" >/dev/null
gate TASK-965 pass c --actor reviewer --reason ok >/dev/null || fail "X an na dependency did not count as resolved"

# --- B: dependencies bound to an authorization ---
D="$(task TASK-966)"
gate TASK-966 declare deploy --actor pm --reason "staging deploy" --requires-authorization deploy_staging >/dev/null
gate TASK-966 declare smoke --actor pm --reason "smoke after deploy" --after deploy >/dev/null
expect_refusal 2 "B bound dependency pending" TASK-966 pass smoke --actor reviewer --reason early
ruby "$AUTHZ" TASK-966 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
gate TASK-966 pass deploy --actor devops --reason deployed --authorization authz-001 >/dev/null
gate TASK-966 pass smoke --actor reviewer --reason "smoke ok" >/dev/null || fail "B pass refused after the bound dependency passed"
D="$(task TASK-967)"
gate TASK-967 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-967 declare smoke --actor pm --reason s --after deploy >/dev/null
ruby "$AUTHZ" TASK-967 grant --action deploy_staging --scope staging --actor operator --via chat --reason ok >/dev/null
gate TASK-967 pass deploy --actor devops --reason deployed --authorization authz-001 >/dev/null
ruby "$AUTHZ" TASK-967 revoke authz-001 --actor operator --via chat --reason "window closed" >/dev/null
gate TASK-967 pass smoke --actor reviewer --reason "smoke ok" >/dev/null || fail "B a revocation after the dependency passed unresolved it"
D="$(task TASK-968)"
gate TASK-968 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-968 declare smoke --actor pm --reason s --after deploy >/dev/null
set_gate "$D/status.yaml" deploy '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "requires_authorization" => "deploy_staging"}'
expect_refusal 2 "B bound dependency passed without a grant" TASK-968 pass smoke --actor reviewer --reason early
grep -q "waits on: deploy (pass, authorization not satisfied)" "$RUNS/refusal.log" || fail "B refusal wording: $(cat "$RUNS/refusal.log")"

# --- C: carry-forward, malformed stored ordering, ownership fence ---
D="$(task TASK-970)"
gate TASK-970 declare a --actor pm --reason a >/dev/null
gate TASK-970 declare b --actor pm --reason b --after a >/dev/null
gate TASK-970 declare c --actor pm --reason c --after a >/dev/null
gate TASK-970 pass a --actor reviewer --reason ok >/dev/null
gate TASK-970 pass b --actor reviewer --reason ok >/dev/null
gate TASK-970 na c --actor reviewer --reason "not needed" >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "a" "C after carried forward on pass"
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "a" "C after carried forward on na"
D="$(task TASK-971)"
gate TASK-971 declare a --actor pm --reason a >/dev/null
set_gate "$D/status.yaml" b '{"status" => "pending", "after" => ["zz"]}'
expect_refusal 3 "C stored after names an unknown gate" TASK-971 declare c --actor pm --reason c
D="$(task TASK-972)"
set_gate "$D/status.yaml" a '{"status" => "pending", "after" => ["b"]}'
set_gate "$D/status.yaml" b '{"status" => "pending", "after" => ["a"]}'
expect_refusal 3 "C stored cycle" TASK-972 pass a --actor reviewer --reason r
D="$(task TASK-973)"
gate TASK-973 declare a --actor pm --reason a >/dev/null
gate TASK-973 declare b --actor pm --reason b >/dev/null
AI_DEV_OFFICE_HOME="$ROOT" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$D" TASK-973 agent=dev "worktree=$RUNS/wt" >/dev/null 2>&1 \
  || fail "C test setup: could not acquire a lease"
cp "$D/status.yaml" "$RUNS/before.yaml"
rc=0; AI_DEV_OFFICE_HOME="$ROOT" ruby "$GATE" TASK-973 depend b --after a --actor pm --reason r >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "9" "C ownership fence"
cmp -s "$D/status.yaml" "$RUNS/before.yaml" || fail "C a fenced depend wrote status.yaml"
# Review Focus: a multi-name --after with one bad name adds nothing.
D="$(task TASK-974)"
gate TASK-974 declare a --actor pm --reason a >/dev/null
gate TASK-974 declare b --actor pm --reason b >/dev/null
expect_refusal 2 "RF depend with one unknown name among several" TASK-974 depend b --after a,zz --actor pm --reason r
assert_eq "$(field "$D/status.yaml" completion_gates.b.after)" "" "RF no partial ordering recorded"
# Review Focus: spaces around names in --after are tolerated.
gate TASK-974 declare c --actor pm --reason c --after " a , b " >/dev/null
assert_eq "$(field "$D/status.yaml" completion_gates.c.after)" "a,b" "RF --after names are trimmed"
# Review Focus: an unreadable ledger while a bound dependency is checked is exit 3.
D="$(task TASK-975)"
gate TASK-975 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-975 declare smoke --actor pm --reason s --after deploy >/dev/null
printf 'authorizations: [\n' > "$D/authorization.yaml"
expect_refusal 3 "RF corrupt ledger with a bound dependency" TASK-975 pass smoke --actor reviewer --reason r
# Review Focus: only direct dependencies are named; a transitive wait still blocks through them.
D="$(task TASK-976)"
gate TASK-976 declare a --actor pm --reason a >/dev/null
gate TASK-976 declare b --actor pm --reason b --after a >/dev/null
gate TASK-976 declare c --actor pm --reason c --after b >/dev/null
expect_refusal 2 "RF transitive wait" TASK-976 pass c --actor reviewer --reason early
grep -q "waits on: b (pending)" "$RUNS/refusal.log" || fail "RF refusal names the direct dependency: $(cat "$RUNS/refusal.log")"
# Review Focus: a gate declared by a 2A revision can be ordered with depend.
D="$(task TASK-977)"
gate TASK-977 declare publish --actor pm --reason p >/dev/null
ruby "$ROOT/scripts/revise-task-plan.rb" TASK-977 scope_expanded --actor dev --reason "scope grew" --gate backfill >/dev/null
gate TASK-977 depend backfill --after publish --actor pm --reason "backfill after publication" >/dev/null
expect_refusal 2 "RF revision-declared gate is ordered" TASK-977 pass backfill --actor reviewer --reason early
validate "$D/status.yaml" || fail "RF revision + ordering invalid: $(cat "$RUNS/validate.log")"

# --- V: stored-state validation ---
# expect_invalid <status.yaml> <message fragment> <label>
expect_invalid() {
  if validate "$1"; then fail "V $3 validated"; fi
  grep -qF "$2" "$RUNS/validate.log" || fail "V $3 message: $(cat "$RUNS/validate.log")"
}
D="$(task TASK-980)"
gate TASK-980 declare a --actor pm --reason a >/dev/null
gate TASK-980 declare b --actor pm --reason b --after a >/dev/null
validate "$D/status.yaml" || fail "V a valid ordering was rejected: $(cat "$RUNS/validate.log")"
v_case() { # <label> <gate> <ruby hash> <fragment>
  local dir="$RUNS/v-$1"; mkdir -p "$dir"; cp "$D/status.yaml" "$dir/status.yaml"
  set_gate "$dir/status.yaml" "$2" "$3"
  expect_invalid "$dir/status.yaml" "$4" "$1"
}
v_case unknown b '{"status" => "pending", "after" => ["zz"]}' "completion_gates.b.after names zz, which is not a declared gate"
v_case self b '{"status" => "pending", "after" => ["b"]}' "completion_gates.b.after names the gate itself"
v_case empty b '{"status" => "pending", "after" => []}' "completion_gates.b.after must be a non-empty list of gate names"
v_case cycle a '{"status" => "pending", "after" => ["b"]}' "creates a cycle through"
v_case early-pass b '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "after" => ["a"]}' \
  "completion_gates.b: status pass but after gate(s) unresolved: a"
mkdir -p "$RUNS/v-na"; cp "$D/status.yaml" "$RUNS/v-na/status.yaml"
set_gate "$RUNS/v-na/status.yaml" b '{"status" => "na", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "after" => ["a"]}'
validate "$RUNS/v-na/status.yaml" || fail "V na with a pending dependency rejected: $(cat "$RUNS/validate.log")"
# A bound dependency that passed without a grant does not resolve it, with the ledger in view.
D="$(task TASK-981)"
gate TASK-981 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
gate TASK-981 declare smoke --actor pm --reason s --after deploy >/dev/null
set_gate "$D/status.yaml" smoke '{"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => [], "after" => ["deploy"]}'
expect_invalid "$D/status.yaml" "completion_gates.smoke: status pass but after gate(s) unresolved: deploy" "bound dependency pending"

# --- S: team sync and revert safety ---
mkdir -p "$RUNS/sync/TASK-966"
cp "$RUNS/TASK-966/status.yaml" "$RUNS/TASK-966/task.md" "$RUNS/TASK-966/authorization.yaml" "$RUNS/sync/TASK-966/"
ruby "$VALIDATOR" "$RUNS/sync/TASK-966/status.yaml" >"$RUNS/validate.log" 2>&1 \
  || fail "S a git-synced copy with a bound dependency does not validate: $(cat "$RUNS/validate.log")"
# As after a revert: stripping every `after` leaves a valid task and the done rule unchanged.
D="$(task TASK-985 review)"
gate TASK-985 declare a --actor pm --reason a >/dev/null
gate TASK-985 declare b --actor pm --reason b --after a >/dev/null
ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time]); s["completion_gates"].each_value { |g| g.delete("after") }; File.write(p, YAML.dump(s))' "$D/status.yaml"
validate "$D/status.yaml" || fail "S status without after invalid: $(cat "$RUNS/validate.log")"
if force_done TASK-985; then fail "S after stripping after, pending gates no longer block done"; fi

echo "[PASS] gate-ordering: gate ordering (#28 Phase 2B)"
