#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 1B.2 — dispatch-time authorization check.
#
# run-agent.sh checks, at the final stable role/policy admission point, that a
# dispatch of a configured role (default devops) for a task with a completion
# gate that is `pending` and carries `requires_authorization` has a grant of
# exactly that action valid NOW. warn_only records and warns; required refuses.
# When the checker cannot give a trustworthy answer the driver records
# `check_error` and recovers mode and scope WITHOUT the checker.
#
# Every driver case runs against a COPY of the office (the checker and the
# config resolver read their own office dir), with a temp runs dir and a stub
# codex runner that only counts its invocations.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"' EXIT

unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW OFFICE_PROFILE \
  AI_DEV_OFFICE_INPUT_SOURCE AI_DEV_OFFICE_GIT_SYNCED AI_DEV_OFFICE_CONFIG_DIR
export OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false

OFFICE="$WORK/office"
RUNS="$WORK/runs"
BIN="$WORK/bin"
CALL="$WORK/call"
mkdir -p "$OFFICE" "$RUNS" "$BIN" "$CALL"
export AI_OFFICE_RUNS_DIR="$RUNS"
# A fixed clock for every grant/expiry case (honored: RUNS is not the live runs/).
export AI_OFFICE_NOW="2026-10-01T12:00:00Z"

for f in run-agent.sh validate-yaml.rb office.config.yaml office.team.yaml; do cp "$ROOT_DIR/$f" "$OFFICE/"; done
for d in agents scripts schemas workflows templates profiles runners; do cp -R "$ROOT_DIR/$d" "$OFFICE/"; done
CHECKER="$OFFICE/scripts/authorization-dispatch-check.rb"
cp "$CHECKER" "$WORK/checker.orig.rb" 2>/dev/null || true
cp "$OFFICE/run-agent.sh" "$WORK/driver.orig.sh"
cp "$OFFICE/scripts/resolve-office-config.rb" "$WORK/resolver.orig.rb"

# The shipped config with any authorization_dispatch block removed; each case
# appends its own raw block text (so malformed YAML forms can be written).
ruby -e '
  lines = File.readlines(ARGV[0]); out = []; skip = false
  lines.each do |line|
    if line.start_with?("authorization_dispatch:") then skip = true; next end
    skip = false if skip && !line.start_with?(" ", "\t", "#") && !line.strip.empty?
    out << line unless skip
  end
  File.write(ARGV[1], out.join)' "$OFFICE/office.config.yaml" "$WORK/base-config.yaml"

set_block() {  # <raw block text, empty = the whole block absent>
  { cat "$WORK/base-config.yaml"; printf '\n%s\n' "$1"; } > "$OFFICE/office.config.yaml"
}

printf '#!/usr/bin/env bash\nc="%s/count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"\nexit 0\n' "$CALL" > "$BIN/codex"
chmod +x "$BIN/codex"

fail() { echo "[FAIL] $1"; exit 1; }
ok() { echo "  ok: $1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$1' got '$2'"; }

PENDING_DEPLOY='completion_gates:
  prod_deploy:
    status: pending
    requires_authorization: deploy_production'

# mk_task <task_id> [<extra top-level yaml>] [<current_agent>] — echoes the dir
mk_task() {
  local dir="$RUNS/$1" agent="${3:-devops}"
  rm -rf "$dir"; mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: assigned
state: assigned
iteration: 0
current_agent: $agent
assignment:
  primary: $agent
  parallel: false
ready: true
created_at: "2026-10-01"
updated_at: "2026-10-01"
history: []
${2:-}
YAML
  echo "$dir"
}

# write_ledger <task_dir> <entries yaml, indented two spaces>
write_ledger() {
  printf 'task_id: %s\nauthorizations:\n%s\n' "$(basename "$1")" "$2" > "$1/authorization.yaml"
}

# grant_yaml <id> <action> [<expires_at>]
grant_yaml() {
  printf '  - id: %s\n    type: grant\n    action: %s\n    scope: "prod"\n    actor: alice\n    via: chat\n    reason: "approved"\n    at: "2026-09-01T00:00:00Z"\n' "$1" "$2"
  [[ -z "${3:-}" ]] || printf '    expires_at: "%s"\n' "$3"
}

revoke_yaml() {  # <id> <revokes>
  printf '  - id: %s\n    type: revoke\n    revokes: %s\n    actor: alice\n    via: chat\n    reason: "withdrawn"\n    at: "2026-09-02T00:00:00Z"\n' "$1" "$2"
}

# check <task_id> <role> — runs the checker; sets CK_OUT, CK_RC; stderr in $WORK/ck.err
check() {
  CK_RC=0
  CK_OUT="$(ruby "$CHECKER" decide "$1" --role "$2" 2>"$WORK/ck.err")" || CK_RC=$?
}

expect_check() {  # <task_id> <role> <expected line> <expected rc> <label>
  check "$1" "$2"
  assert_eq "$3" "$CK_OUT" "$5 (line)"
  assert_eq "$4" "$CK_RC" "$5 (exit code)"
}

# events <task_dir> — one line per authorization_dispatch_check event:
# "<agent>|<details>|<run_id or ->"
events() {
  ruby - "$1/meta.yaml" <<'RUBY'
require "yaml"; require "date"
path = ARGV[0]
exit 0 unless File.exist?(path)
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
Array(d["events"]).each do |e|
  next unless e.is_a?(Hash) && e["type"] == "authorization_dispatch_check"
  puts [e["agent"], e["details"], e.key?("run_id") ? e["run_id"] : "-"].join("|")
end
RUBY
}

event_count() { events "$1" | grep -c . || true; }

meta_count() {  # <task_dir> <type>
  ruby - "$1/meta.yaml" "$2" <<'RUBY'
require "yaml"; require "date"
path, type = ARGV
unless File.exist?(path)
  puts 0
  exit 0
end
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts Array(d["events"]).count { |e| e.is_a?(Hash) && e["type"] == type }
RUBY
}

# dispatch <task_id> <role> [VAR=value ...] — runs the office copy's driver;
# sets D_RC, D_OUT, D_CALLS (runner invocations).
dispatch() {
  local task="$1" role="$2"
  shift 2
  rm -f "$CALL/count"
  D_RC=0
  # To a file, not $(...): the driver's ownership renewer leaves a `sleep` that
  # inherits stdout, and a command substitution would wait for it to exit.
  env "$@" PATH="$BIN:$PATH" bash "$OFFICE/run-agent.sh" "$task" "$role" codex >"$WORK/dispatch.log" 2>&1 || D_RC=$?
  D_OUT="$(cat "$WORK/dispatch.log")"
  D_CALLS=0
  [[ -f "$CALL/count" ]] && D_CALLS="$(cat "$CALL/count")"
  return 0
}
echo "== L: ledger Index#any_valid_grant? =="
D="$(mk_task TASK-AD-000 "$PENDING_DEPLOY")"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production 2026-10-01T00:00:00Z; grant_yaml authz-002 deploy_production; revoke_yaml authz-003 authz-002; grant_yaml authz-1000 live_load)"
ruby - "$ROOT_DIR/scripts/authorization-ledger.rb" "$D" <<'RUBY' || fail "L: Index#any_valid_grant?"
require ARGV[0]
index = AuthorizationLedger.load(ARGV[1])
now = Time.utc(2026, 10, 1, 12)
expect = lambda do |label, got, want|
  abort "#{label}: expected #{want}, got #{got.inspect}" unless got == want
end
expect.call("expired + revoked -> none", index.any_valid_grant?(action: "deploy_production", at: now, through: "authz-1000"), false)
expect.call("a grant is valid below its revoke's id", index.any_valid_grant?(action: "deploy_production", at: now, through: "authz-002"), true)
expect.call("numeric snapshot past 999", index.any_valid_grant?(action: "live_load", at: now, through: "authz-1000"), true)
expect.call("a grant above the snapshot", index.any_valid_grant?(action: "live_load", at: now, through: "authz-003"), false)
expect.call("exact action only", index.any_valid_grant?(action: "deploy_staging", at: now, through: "authz-1000"), false)
expect.call("before expiry", index.any_valid_grant?(action: "deploy_production", at: Time.utc(2026, 9, 30), through: "authz-001"), true)
expect.call("timestamp string accepted", index.any_valid_grant?(action: "live_load", at: "2026-10-01T12:00:00Z", through: "authz-1000"), true)
empty = AuthorizationLedger::Index.new([])
expect.call("empty ledger", empty.any_valid_grant?(action: "live_load", at: now, through: "authz-001"), false)
RUBY
ok "L: any_valid_grant? reuses valid_grant? (numeric ids, append-order revoke, expiry, exact action)"
echo "== C: checker decide =="
set_block ""
NA="outcome=not_applicable mode=none actions="

# C1: no pending bound gate -> not_applicable, and the ledger is never read (a
# corrupt ledger that WOULD warn on stderr if loaded stays silent).
D="$(mk_task TASK-AD-001)"; printf 'garbage: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-001 devops "$NA" 0 "C1 no completion_gates"
[[ ! -s "$WORK/ck.err" ]] || fail "C1: the ledger must not be read without a pending bound gate: $(cat "$WORK/ck.err")"
D="$(mk_task TASK-AD-002 'completion_gates:
  smoke:
    status: pending')"; printf 'garbage: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-002 devops "$NA" 0 "C1 only unbound pending gates"
[[ ! -s "$WORK/ck.err" ]] || fail "C1: unbound gates must not read the ledger"
D="$(mk_task TASK-AD-003 'completion_gates:
  prod_deploy:
    status: na
    requires_authorization: deploy_production
    actor: alice
    reason: "not deploying"
    updated_at: "2026-09-30T10:00:00Z"')"; printf 'garbage: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-003 devops "$NA" 0 "C1 only resolved bound gates"
[[ ! -s "$WORK/ck.err" ]] || fail "C1: resolved bound gates must not read the ledger"
mkdir -p "$RUNS/TASK-AD-004"
expect_check TASK-AD-004 devops "$NA" 0 "C1 no status.yaml"
set_block 'authorization_dispatch:
  mode: of'
expect_check TASK-AD-001 devops "$NA" 0 "C1 a config typo without a pending bound gate (condition 3 first)"
# A syntactically broken office.config.yaml must not reach a task without a pending bound gate.
printf 'garbage: [\n' > "$OFFICE/office.config.yaml"
expect_check TASK-AD-001 devops "$NA" 0 "C1 a broken office.config.yaml without a pending bound gate"
set_block ""
ok "C1: no pending bound gate -> not_applicable, ledger unread, config unread"

# C2: grants, as of now (AI_OFFICE_NOW) and the current high-water id.
D="$(mk_task TASK-AD-010 "$PENDING_DEPLOY")"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 absent ledger"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 valid grant"
write_ledger "$D" "$(grant_yaml authz-001 external_side_effect)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 grant for another action"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production 2026-10-01T12:00:00Z)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 expires_at == now is not valid"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production 2026-10-01T12:00:01Z)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 expires one second after now"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production; revoke_yaml authz-002 authz-001)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 revoked before the check"
write_ledger "$D" "$(grant_yaml authz-999 live_load; grant_yaml authz-1000 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 numeric ids past 999"
printf 'task_id: TASK-AD-010\nauthorizations: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 corrupt ledger"
grep -q "ledger unavailable" "$WORK/ck.err" || fail "C2: a corrupt ledger must be reported on stderr"
D="$(mk_task TASK-AD-011 'completion_gates:
  prod_deploy:
    status: pending
    requires_authorization: deploy_production
  backfill:
    status: pending
    requires_authorization: production_backfill')"
write_ledger "$D" "$(grant_yaml authz-001 production_backfill)"
expect_check TASK-AD-011 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 two gates, one satisfied"
write_ledger "$D" "$(grant_yaml authz-001 production_backfill; grant_yaml authz-002 deploy_production)"
expect_check TASK-AD-011 devops "outcome=authorized mode=warn_only actions=deploy_production,production_backfill" 0 "C2 two gates, both satisfied"
mk_task TASK-AD-012 'completion_gates:
  moon:
    status: pending
    requires_authorization: deploy_moon' >/dev/null
expect_check TASK-AD-012 devops "outcome=missing_authorization mode=warn_only actions=deploy_moon" 0 "C2 unknown action"
# The check is as of NOW: a revoke appended after an authorized check is seen by the next check.
D="$RUNS/TASK-AD-010"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 before the revoke"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production; revoke_yaml authz-002 authz-001)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 after the revoke"
ok "C2: exact action, expiry (now >= expires_at), append-order revoke, numeric ids, corrupt ledger, multi-gate"

# C3: roles, modes, exit codes.
D="$RUNS/TASK-AD-010"; rm -f "$D/authorization.yaml"
expect_check TASK-AD-010 dev "outcome=not_applicable mode=warn_only actions=" 0 "C3 role outside the default roles"
set_block 'authorization_dispatch:
  mode: "off"
  roles: [devops]'
expect_check TASK-AD-010 devops "outcome=not_applicable mode=off actions=" 0 "C3 mode off"
for role in pm dev dev-2 reviewer debugger devops free-roam; do
  set_block "authorization_dispatch:
  mode: warn_only
  roles: [$role]"
  expect_check TASK-AD-010 "$role" "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C3 $role configured"
done
set_block 'authorization_dispatch:
  mode: required
  roles: [devops]'
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=required actions=deploy_production" 14 "C3 required refuses missing"
expect_check TASK-AD-010 dev "outcome=not_applicable mode=required actions=" 0 "C3 required, unconfigured role"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=required actions=deploy_production" 0 "C3 required, authorized"
rm -f "$D/authorization.yaml"
set_block ""
ok "C3: role list, off, every concrete role configurable, exit 0 vs 14"

# C4: normalization (section 4), on a task WITH a pending bound gate.
norm() {  # <raw block> <expected line> <expected rc> <label>
  set_block "$1"
  expect_check TASK-AD-010 devops "$2" "$3" "C4 $4"
}
CE_REQ="outcome=config_error mode=required actions=deploy_production"
norm "" "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "whole block absent -> defaults"
norm 'authorization_dispatch: 5' "$CE_REQ" 14 "non-mapping block"
norm 'authorization_dispatch:' "$CE_REQ" 14 "null block"
norm 'authorization_dispatch:
  roles: [devops]' "$CE_REQ" 14 "present block, mode missing"
for bad in '[warn_only]' '""' '' '{a: b}' '5' 'true' 'of' 'warn-only'; do
  norm "authorization_dispatch:
  mode: $bad
  roles: [devops]" "$CE_REQ" 14 "mode: $bad"
done
# YAML 1.1: an unquoted off/no/false is a BOOLEAN, not the string "off". It is
# untrustworthy like any non-string, so it fails closed instead of disabling.
for bad in 'off' 'no' 'false'; do
  norm "authorization_dispatch:
  mode: $bad
  roles: [devops]" "$CE_REQ" 14 "unquoted mode: $bad (a YAML boolean)"
done
norm 'authorization_dispatch:
  mode: "off"
  roles: 5' "outcome=not_applicable mode=off actions=" 0 "off with malformed roles"
norm 'authorization_dispatch:
  mode: "off"' "outcome=not_applicable mode=off actions=" 0 "off with roles missing"
for bad in 'devops' '{devops: true}' '' '[devops, 5]' '[devops, nosuchrole]'; do
  norm "authorization_dispatch:
  mode: warn_only
  roles: $bad" "outcome=config_error mode=warn_only actions=deploy_production" 0 "warn_only roles: $bad"
  norm "authorization_dispatch:
  mode: required
  roles: $bad" "$CE_REQ" 14 "required roles: $bad"
done
norm 'authorization_dispatch:
  mode: warn_only' "outcome=config_error mode=warn_only actions=deploy_production" 0 "warn_only, roles missing"
norm 'authorization_dispatch:
  mode: required' "$CE_REQ" 14 "required, roles missing"
norm 'authorization_dispatch:
  mode: required
  roles: []' "outcome=not_applicable mode=required actions=" 0 "empty roles"
set_block ""
ok "C4: normalization table, including partial blocks (only a wholly absent block means defaults)"

# C5: cannot judge -> neither 0 nor 14 (the driver records check_error).
D="$(mk_task TASK-AD-020)"; printf 'phase: [\n' > "$D/status.yaml"
check TASK-AD-020 devops; assert_eq 3 "$CK_RC" "C5 corrupt status.yaml"
mk_task TASK-AD-021 'completion_gates: [prod_deploy]' >/dev/null
check TASK-AD-021 devops; assert_eq 3 "$CK_RC" "C5 completion_gates not a map"
mk_task TASK-AD-022 'completion_gates:
  prod_deploy: pending' >/dev/null
check TASK-AD-022 devops; assert_eq 3 "$CK_RC" "C5 a gate that is not a map"
# AI_OFFICE_NOW is a test hook: against the live runs dir it is refused.
mkdir -p "$OFFICE/runs/TASK-AD-023"; cp "$RUNS/TASK-AD-010/status.yaml" "$OFFICE/runs/TASK-AD-023/status.yaml"
rc=0; AI_OFFICE_RUNS_DIR="$OFFICE/runs" ruby "$CHECKER" decide TASK-AD-023 --role devops >/dev/null 2>"$WORK/ck.err" || rc=$?
assert_eq 3 "$rc" "C5 AI_OFFICE_NOW against the live runs dir"
grep -q "test hook" "$WORK/ck.err" || fail "C5: the refusal must name the test hook"
rm -rf "$OFFICE/runs/TASK-AD-023"
for args in "" "decide" "verify TASK-AD-010 --role devops" "decide TASK-AD-010" "decide ../x --role devops" "decide TASK-AD-010 --role devops extra"; do
  rc=0
  # shellcheck disable=SC2086  # intentional word-split of the argument list
  ruby "$CHECKER" $args >/dev/null 2>&1 || rc=$?
  assert_eq 2 "$rc" "C5 usage: '$args'"
done
ok "C5: unjudgeable state exits 3, usage errors exit 2, AI_OFFICE_NOW refused against live runs"

# C6: the checker never writes.
D="$RUNS/TASK-AD-011"
before="$(cat "$D/status.yaml" "$D/authorization.yaml" | cksum)"
check TASK-AD-011 devops
[[ "$(cat "$D/status.yaml" "$D/authorization.yaml" | cksum)" == "$before" ]] || fail "C6: the checker modified status or ledger"
[[ ! -e "$D/meta.yaml" ]] || fail "C6: the checker must not write meta.yaml (the driver does)"
ok "C6: the checker never writes status.yaml, gates, the ledger or meta.yaml"
echo "== P: shipped config =="
# P1: the shipped block is valid, ships warn_only/[devops], and every key is protected.
ruby - "$ROOT_DIR" <<'RUBY' || fail "P1: shipped authorization_dispatch block"
root = ARGV[0]
require File.join(root, "scripts/authorization-dispatch-check.rb")
require "yaml"; require "date"
raw = YAML.safe_load(File.read(File.join(root, "office.config.yaml")), permitted_classes: [Date, Time], aliases: true)
block = raw["authorization_dispatch"]
abort "shipped config has no authorization_dispatch block" unless block.is_a?(Hash)
config = AuthorizationDispatchCheck.normalize(raw)
abort "shipped block must normalize to ok/warn_only/[devops], got #{config.to_a.inspect}" unless config.to_a == [:ok, "warn_only", ["devops"]]
resolver = OfficeConfigResolver.new(root)
block.each_key do |key|
  abort "authorization_dispatch.#{key} is not protected" unless resolver.send(:protected_path?, ["authorization_dispatch", key])
end
abort "the block itself must be protected" unless resolver.send(:protected_path?, ["authorization_dispatch"])
RUBY
# P2: a local overlay setting mode off is ignored by the merged config.
cp "$ROOT_DIR/office.config.yaml" "$WORK/office/office.config.yaml"
printf 'authorization_dispatch:\n  mode: "off"\n' > "$OFFICE/office.config.local.yaml"
merged_mode="$(ruby "$OFFICE/scripts/resolve-office-config.rb" dump "$OFFICE" | ruby -ryaml -rdate -e 'puts YAML.safe_load(STDIN.read, permitted_classes: [Date, Time], aliases: true)["authorization_dispatch"]["mode"]')"
assert_eq "warn_only" "$merged_mode" "P2 local overlay cannot set mode off"
rm -f "$OFFICE/office.config.local.yaml"
ok "P: the shipped block is valid, warn_only/[devops], fully protected; overlays cannot weaken it"

echo "== D: driver =="
WARN_BLOCK='authorization_dispatch:
  mode: warn_only
  roles: [devops]'
REQ_BLOCK='authorization_dispatch:
  mode: required
  roles: [devops]'
OFF_BLOCK='authorization_dispatch:
  mode: "off"
  roles: [devops]'

assert_events() {  # <task_dir> <expected "agent|details|run_id" lines, newline-separated> <label>
  assert_eq "$2" "$(events "$1")" "$3 (events)"
}

# D1: warn_only records and warns, never blocks.
set_block "$WARN_BLOCK"
D="$(mk_task TASK-AD-101 "$PENDING_DEPLOY")"
dispatch TASK-AD-101 devops
assert_eq 1 "$D_CALLS" "D1 warn_only missing grant: the runner runs"
grep -q "Authorization check: deploy_production have no valid grant for TASK-AD-101" <<<"$D_OUT" || fail "D1: warning missing: $D_OUT"
assert_events "$D" "devops|task=TASK-AD-101 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D1 missing"
D="$(mk_task TASK-AD-102 "$PENDING_DEPLOY")"; write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
dispatch TASK-AD-102 devops
assert_eq 1 "$D_CALLS" "D1 authorized: the runner runs"
assert_events "$D" "devops|task=TASK-AD-102 mode=warn_only outcome=authorized actions=deploy_production|-" "D1 authorized"
D="$(mk_task TASK-AD-103 "$PENDING_DEPLOY" dev)"
dispatch TASK-AD-103 dev
assert_eq 1 "$D_CALLS" "D1 dev dispatch runs"
assert_eq 0 "$(event_count "$D")" "D1 an unconfigured role logs nothing"
D="$(mk_task TASK-AD-104 "$PENDING_DEPLOY")"
dispatch TASK-AD-104 devops AI_DEV_OFFICE_RUN_ID=run-leaked-from-a-parent
assert_events "$D" "devops|task=TASK-AD-104 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D1 no run_id even if one leaked"
ruby "$OFFICE/validate-yaml.rb" "$RUNS/TASK-AD-101/meta.yaml" >/dev/null || fail "D1: meta.yaml with the new event must validate"
ok "D1: warn_only proceeds, warns, logs one event without run_id; unconfigured role logs nothing"

# D2: required refuses before any run record, lease or runner exists.
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-111 "$PENDING_DEPLOY")"
before="$(cksum < "$D/status.yaml")"
dispatch TASK-AD-111 devops
assert_eq 1 "$D_RC" "D2 required missing grant: exit 1"
assert_eq 0 "$D_CALLS" "D2 the runner is not invoked"
assert_eq "$before" "$(cksum < "$D/status.yaml")" "D2 status untouched"
[[ ! -e "$D/run-records" ]] || fail "D2: a refusal must leave no run record"
[[ ! -e "$D/ownership.yaml" ]] || fail "D2: a refusal must leave no ownership lease"
grep -q "record-authorization.rb" <<<"$D_OUT" || fail "D2: the refusal must point at record-authorization.rb: $D_OUT"
assert_events "$D" "devops|task=TASK-AD-111 mode=required outcome=missing_authorization actions=deploy_production|-" "D2 missing"
D="$(mk_task TASK-AD-112 "$PENDING_DEPLOY")"; write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
dispatch TASK-AD-112 devops
assert_eq 1 "$D_CALLS" "D2 required with a grant: the runner runs"
assert_events "$D" "devops|task=TASK-AD-112 mode=required outcome=authorized actions=deploy_production|-" "D2 authorized"
set_block 'authorization_dispatch:
  mode: required
  roles: devops'
D="$(mk_task TASK-AD-113 "$PENDING_DEPLOY")"
dispatch TASK-AD-113 devops
assert_eq 1 "$D_RC" "D2 required config_error: exit 1"
assert_eq 0 "$D_CALLS" "D2 config_error: the runner is not invoked"
assert_events "$D" "devops|task=TASK-AD-113 mode=required outcome=config_error actions=deploy_production|-" "D2 config_error"
ok "D2: required refuses missing grants and config errors, with no run record/lease/runner; a grant proceeds"

# D8: the event write is guarded. Corrupting meta.yaml cannot reach this block
# (the driver's earlier, unguarded context_provider event fails first), so the
# sink failure is injected into the office copy's driver.
cp "$WORK/driver.orig.sh" "$OFFICE/run-agent.sh"
ruby -e 'src = File.read(ARGV[0], encoding: "UTF-8"); n = src.scan(%(if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event)).size
  abort "D8: expected exactly one guarded event write, found #{n}" unless n == 1
  File.write(ARGV[0], src.sub(%(if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event), %(if ! AI_DEV_OFFICE_RUN_ID="" false)))' "$OFFICE/run-agent.sh"
set_block "$WARN_BLOCK"
D="$(mk_task TASK-AD-701 "$PENDING_DEPLOY")"
dispatch TASK-AD-701 devops
assert_eq 1 "$D_CALLS" "D8 warn_only: proceeds when the event cannot be written"
grep -q "WARNING: could not record the authorization_dispatch_check event" <<<"$D_OUT" || fail "D8: warn_only must warn: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D8 warn_only: no event written"
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-702 "$PENDING_DEPLOY")"; write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
dispatch TASK-AD-702 devops
assert_eq 1 "$D_RC" "D8 required + authorized: refused when the event cannot be written"
assert_eq 0 "$D_CALLS" "D8 required + authorized: no runner"
D="$(mk_task TASK-AD-703 "$PENDING_DEPLOY")"
dispatch TASK-AD-703 devops
assert_eq 1 "$D_RC" "D8 required + missing: refused"
cp "$WORK/driver.orig.sh" "$OFFICE/run-agent.sh"
ok "D8: an unwritable event warns and proceeds in warn_only, refuses in required"

# D9: admission is not execution — a live lease held by another run refuses
# AFTER the check, so a valid event exists for an attempt that never ran.
set_block "$WARN_BLOCK"
for grant in no yes; do
  D="$(mk_task "TASK-AD-80$([[ $grant == yes ]] && echo 2 || echo 1)" "$PENDING_DEPLOY")"
  T="$(basename "$D")"
  [[ "$grant" == yes ]] && write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
  AI_DEV_OFFICE_RUN_ID=run-other-owner ruby "$OFFICE/scripts/task-ownership.rb" acquire "$D" "$T" agent=devops \
    "office_dir=$OFFICE" >/dev/null
  dispatch "$T" devops
  assert_eq 9 "$D_RC" "D9 ($grant grant) ownership refuses"
  assert_eq 0 "$D_CALLS" "D9 ($grant grant) no runner"
  assert_eq 1 "$(event_count "$D")" "D9 ($grant grant) exactly one admission-attempt event"
  assert_eq 0 "$(meta_count "$D" ownership_acquired)" "D9 ($grant grant) no ownership_acquired"
done
ok "D9: an ownership refusal after a successful admission leaves one event and no runner (expected)"

# D10: placement.
set_block 'authorization_dispatch:
  mode: warn_only
  roles: [debugger]'
review_task() {  # <task_id> — in review, with a pending request_changes decision
  local dir="$RUNS/$1"
  rm -rf "$dir"; mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
created_at: "2026-10-01"
updated_at: "2026-10-01"
history: []
$PENDING_DEPLOY
YAML
  cat > "$dir/decision.yaml" <<YAML
task_id: $1
decisions:
  - decision: request_changes
    actor: alice
    decided_at: "2026-10-01T10:00:00Z"
YAML
  echo "$dir"
}
D="$(review_task TASK-AD-901)"
dispatch TASK-AD-901 reviewer
grep -q "dispatching that instead" <<<"$D_OUT" || fail "D10: precondition — the decision must reroute: $D_OUT"
assert_events "$D" "debugger|task=TASK-AD-901 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D10 the rerouted role is checked"
set_block 'authorization_dispatch:
  mode: warn_only
  roles: [reviewer]'
D="$(review_task TASK-AD-902)"
dispatch TASK-AD-902 reviewer
assert_eq 0 "$(event_count "$D")" "D10 the original (configured) role is not checked after a reroute"
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-903 "$PENDING_DEPLOY")"
ruby -e 'p = ARGV[0]; s = File.read(p).sub("state: assigned", "state: blocked"); File.write(p, s)' "$D/status.yaml"
dispatch TASK-AD-903 devops
grep -q "is blocked" <<<"$D_OUT" || fail "D10: precondition — blocked guard: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 a blocked task never reaches the check"
D="$(mk_task TASK-AD-904 "$PENDING_DEPLOY" dev)"
dispatch TASK-AD-904 devops
grep -q "is currently routed to 'dev'" <<<"$D_OUT" || fail "D10: precondition — route guard: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 a route mismatch never reaches the check"
D="$(mk_task TASK-AD-905 "$PENDING_DEPLOY")"
ruby -e 'p = ARGV[0]; s = File.read(p).sub("iteration: 0", "iteration: 99"); File.write(p, s)' "$D/status.yaml"
dispatch TASK-AD-905 devops
grep -q "Loop guard triggered" <<<"$D_OUT" || fail "D10: precondition — loop guard: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 the loop guard stops before the check"
D="$(mk_task TASK-AD-906 "$PENDING_DEPLOY")"
SHA="$(printf 'same failure' | shasum -a 256 | cut -d' ' -f1)"
cat > "$D/evidence.yaml" <<YAML
task_id: TASK-AD-906
evidence:
  - id: ev-001
    type: command
    command: "make deploy"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-09-30T00:00:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$SHA"
  - id: ev-002
    type: command
    command: "make deploy"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-09-30T00:05:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$SHA"
YAML
dispatch TASK-AD-906 devops
grep -q "Execution budget exhausted" <<<"$D_OUT" || fail "D10: precondition — execution budget: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 the execution budget stops before the check"
# The auto umbrella always starts with a concrete pm sub-dispatch (a fresh
# run-agent.sh process); with pm configured, that sub-dispatch is checked and
# the umbrella itself (AGENT=auto) is not.
set_block 'authorization_dispatch:
  mode: warn_only
  roles: [pm]'
D="$(mk_task TASK-AD-907 "$PENDING_DEPLOY" pm)"
dispatch TASK-AD-907 auto
grep -q ">>> Running pm" <<<"$D_OUT" || fail "D10: precondition — auto must launch pm: $D_OUT"
assert_events "$D" "pm|task=TASK-AD-907 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D10 auto: only the concrete sub-dispatch is checked"
ok "D10: the rerouted role is checked; guards stop before the check; auto is checked per concrete role"
echo "[PASS] authorization-dispatch: dispatch-time authorization check (#28 Phase 1B.2)"
