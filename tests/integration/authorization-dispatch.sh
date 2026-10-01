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
echo "[PASS] authorization-dispatch: dispatch-time authorization check (#28 Phase 1B.2)"
