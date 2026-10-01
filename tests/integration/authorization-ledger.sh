#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 1B.1 — authorization ledger and completion binding.
#
# Revocation is decided by ledger append order (authorization_through), never
# by wall-clock timestamps; ids are compared numerically. Tasks and gates that
# do not use `requires_authorization` behave exactly as in Phase 1A.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RECORD="$ROOT_DIR/scripts/record-authorization.rb"
GATE="$ROOT_DIR/scripts/update-completion-gate.rb"
SYNC="$ROOT_DIR/scripts/sync-status-from-output.rb"
RECONCILE="$ROOT_DIR/scripts/reconcile-decision.rb"
FORCE="$ROOT_DIR/scripts/force-status-route.rb"
DECIDE="$ROOT_DIR/scripts/decide-next-step.rb"
OWN="$ROOT_DIR/scripts/task-ownership.rb"
VALIDATOR="$ROOT_DIR/validate-yaml.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
# No ownership record exists in the temp runs dir, so writes are allowed; make
# sure a leaked lease/epoch/clock from a parent run cannot change that.
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
trap 'rm -rf "$TMP_RUNS"' EXIT

T0="2026-09-30T10:00:00Z"
T1="2026-09-30T10:05:00Z"

fail() { echo "[FAIL] $1"; exit 1; }

assert_eq() {
  if [[ "$1" != "$2" ]]; then echo "[FAIL] $3: expected '$1' got '$2'"; exit 1; fi
}

# yaml_get <file> <dotted.key.path> — prints the value, or empty when absent (numeric path parts index lists).
yaml_get() {
  ruby - "$1" "$2" <<'RUBY'
require "yaml"; require "date"
d = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Date, Time], aliases: true) || {}
v = ARGV[1].split(".").reduce(d) { |n, k| n.is_a?(Hash) ? n[k] : (n.is_a?(Array) && k.match?(/\A\d+\z/) ? n[k.to_i] : nil) }
puts v.nil? ? "" : v.to_s
RUBY
}

# event_count <task_dir> <type> — number of meta.yaml events of that type.
event_count() {
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

new_task() {  # <task_id> — creates and echoes the task dir
  local dir="$TMP_RUNS/$1"
  mkdir -p "$dir"
  echo "$dir"
}

# write_status <task_dir> <task_id> <phase> [<extra yaml, top-level keys>]
write_status() {
  cat > "$1/status.yaml" <<YAML
task_id: $2
phase: $3
state: $3
iteration: 1
current_agent: reviewer
${4:-}
YAML
}

# write_ledger <task_dir> <yaml body of the authorizations: list, already indented>
write_ledger() {
  printf 'task_id: %s\nauthorizations:\n%s\n' "$(basename "$1")" "$2" > "$1/authorization.yaml"
}

write_reviewer_approved() {  # <task_dir>
  cat > "$1/reviewer-output.yaml" <<'YAML'
review_verdict: approved
next_action:
  agent: done
  reason: approved
YAML
}

authz() { ruby "$RECORD" "$@"; }
gate()  { ruby "$GATE" "$@"; }

# ---------------------------------------------------------------------------
# Task 1 — AuthorizationLedger library (unit level)
# ---------------------------------------------------------------------------
ruby - "$ROOT_DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "authorization-ledger")
L = AuthorizationLedger

def check(cond, msg)
  abort "[FAIL] ledger: #{msg}" unless cond
end

def grant(n, action: "deploy_production", at: "2026-09-30T10:00:00Z", extra: {})
  { "id" => L.format_id(n), "type" => "grant", "action" => action, "scope" => "s",
    "actor" => "alice", "via" => "cli", "reason" => "r", "at" => at }.merge(extra)
end

def revoke(n, target, at: "2026-09-30T11:00:00Z")
  { "id" => L.format_id(n), "type" => "revoke", "revokes" => L.format_id(target),
    "actor" => "alice", "via" => "cli", "reason" => "r", "at" => at }
end

# --- constants and id grammar ------------------------------------------------
check L::ACTIONS == %w[deploy_staging deploy_production production_data_mutation production_backfill live_load external_side_effect],
      "the closed action enum is exactly the six actions from the spec"
check L::TYPES == %w[grant revoke], "types are grant/revoke"
check L::COMMON_REQUIRED_KEYS == %w[id type actor via reason at], "common audit keys"
check L::FILENAME == "authorization.yaml", "ledger file name"

# --- numeric ids -------------------------------------------------------------
check L.id_number("authz-007") == 7, "id_number parses leading zeros"
check L.id_number("authz-1000") == 1000, "id_number parses four digits"
check L.id_number("authz-01").nil?, "fewer than three digits is not an id"
check L.id_number("authz-abc").nil?, "non-numeric suffix is not an id"
check L.id_number("AUTHZ-001").nil?, "prefix is case sensitive"
check L.id_number(nil).nil?, "nil is not an id"
check L.format_id(7) == "authz-007", "format_id pads to three digits"
check L.format_id(999) == "authz-999", "format_id 999"
check L.format_id(1000) == "authz-1000", "format_id grows past three digits"
check L.id_number("authz-999") < L.id_number("authz-1000"), "numeric order across the width boundary"

# --- timestamps and clock ----------------------------------------------------
t = L.parse_time("2026-09-30T10:00:00Z")
check t.is_a?(Time) && t.utc? && t.year == 2026, "parse_time returns UTC Time"
check L.parse_time("2026-09-30 10:00:00").nil?, "non-ISO timestamps are rejected"
check L.parse_time("2026-09-30T10:00:00+07:00").nil?, "only Z timestamps are accepted"
check L.parse_time(nil).nil?, "nil timestamp"
check L.format_time(t) == "2026-09-30T10:00:00Z", "format_time round trip"
ENV.delete("AI_OFFICE_NOW")
real = L.now_utc
check real.is_a?(Time) && real.usec.zero?, "now_utc floors to whole seconds"
ENV["AI_OFFICE_NOW"] = "2026-09-30T12:34:56Z"
check L.format_time(L.now_utc) == "2026-09-30T12:34:56Z", "AI_OFFICE_NOW overrides the clock"
ENV["AI_OFFICE_NOW"] = "yesterday"
begin
  L.now_utc
  abort "[FAIL] ledger: a malformed AI_OFFICE_NOW must raise"
rescue L::Error
  nil
end
ENV.delete("AI_OFFICE_NOW")

# --- validate_entries: valid shapes -----------------------------------------
check L.validate_entries([]).empty?, "an empty ledger is valid"
check L.validate_entries([grant(1), revoke(2, 1)]).empty?, "grant then revoke is valid"
check L.validate_entries([grant(999), grant(1000), revoke(1001, 999)]).empty?, "ids cross the 999/1000 boundary in numeric order"
check L.validate_entries([grant(1, extra: { "expires_at" => "2026-09-30T12:00:00Z" })]).empty?, "expires_at after at is valid"
check L.validate_entries([grant(1, at: "2026-09-30T10:00:00Z"), revoke(2, 1, at: "2026-09-30T09:00:00Z")]).empty?,
      "a revoke with an earlier `at` than its grant is valid: revocation is by append order, not by clock"

# --- validate_entries: invalid shapes ---------------------------------------
def invalid(entries, needle)
  errors = AuthorizationLedger.validate_entries(entries)
  abort "[FAIL] ledger: expected an error mentioning #{needle.inspect}, got #{errors.inspect}" unless errors.any? { |e| e.include?(needle) }
end

invalid("nope", "must be a list")
invalid([grant(1), grant(1)], "duplicates")
invalid([{ "id" => "authz-001" }.merge(grant(1)), grant(1).merge("id" => "authz-0001")], "duplicates")
invalid([grant(2), grant(1)], "greater than the previous id")
invalid([grant(1000), grant(999)], "greater than the previous id")
invalid([grant(1).merge("id" => "authz-01")], "id must match")
invalid([grant(1).merge("type" => "renew")], "type must be one of")
invalid([grant(1).merge("action" => "deploy_prod")], "action must be one of")
invalid([grant(1).merge("scope" => " ")], "scope must be a non-empty string")
%w[actor via reason].each { |k| invalid([grant(1).merge(k => "")], "#{k} must be a non-empty string") }
invalid([grant(1).merge("at" => "2026-09-30 10:00:00")], "at must be a UTC timestamp")
invalid([grant(1, extra: { "expires_at" => "2026-09-30T10:00:00Z" })], "strictly after at")
invalid([grant(1, extra: { "expires_at" => "2026-09-30T09:00:00Z" })], "strictly after at")
invalid([grant(1, extra: { "expires_at" => "soon" })], "expires_at must be a UTC timestamp")
invalid([grant(1, extra: { "revokes" => "authz-001" })], "revokes is only valid on a revoke")
invalid([revoke(1, 2)], "earlier entry")
invalid([revoke(2, 1)], "earlier grant")
invalid([grant(1), revoke(2, 1), revoke(3, 1)], "already revoked")
invalid([grant(1), revoke(2, 1), revoke(3, 2)], "earlier grant")
invalid([grant(1), revoke(2, 1).merge("action" => "deploy_production")], "only valid on a grant")

# --- Index: high water and validity as of (T, S) -----------------------------
idx = L::Index.new([grant(1), revoke(2, 1), grant(3, action: "live_load")])
check idx.high_water_id == "authz-003", "high_water_id is the numeric max"
check L::Index.new([]).high_water_id.nil?, "an empty ledger has no high-water id"
check L::Index.new([grant(999), grant(1000)]).high_water_id == "authz-1000", "high_water_id is numeric, not lexical"
check idx.entry?("authz-002") && !idx.entry?("authz-009"), "entry? by id"

g = L::Index.new([grant(1, extra: { "expires_at" => "2026-09-30T10:30:00Z" }), revoke(2, 1, at: "2026-09-30T09:00:00Z")])
T = "2026-09-30T10:05:00Z"
check g.valid_grant?("authz-001", action: "deploy_production", at: T, through: "authz-001"),
      "valid as of a snapshot taken before the revoke"
check !g.valid_grant?("authz-001", action: "deploy_production", at: T, through: "authz-002"),
      "a revoke with id <= S revokes the grant even though its `at` is EARLIER than T"
check !g.valid_grant?("authz-001", action: "external_side_effect", at: T, through: "authz-001"), "exact action match only"
check !g.valid_grant?("authz-001", action: "deploy_production", at: "2026-09-30T09:59:59Z", through: "authz-001"), "not valid before its start"
check g.valid_grant?("authz-001", action: "deploy_production", at: "2026-09-30T10:00:00Z", through: "authz-001"), "valid exactly at its start"
check g.valid_grant?("authz-001", action: "deploy_production", at: "2026-09-30T10:29:59Z", through: "authz-001"), "valid just before expiry"
check !g.valid_grant?("authz-001", action: "deploy_production", at: "2026-09-30T10:30:00Z", through: "authz-001"), "not valid at expires_at"
check !g.valid_grant?("authz-002", action: "deploy_production", at: T, through: "authz-002"), "a revoke is not a grant"
check !g.valid_grant?("authz-009", action: "deploy_production", at: T, through: "authz-009"), "an unknown id is not valid"

future = L::Index.new([grant(1), revoke(2, 1, at: "2026-09-30T23:00:00Z")])
check !future.valid_grant?("authz-001", action: "deploy_production", at: "2026-09-30T10:05:00Z", through: "authz-002"),
      "a future-dated revoke already in the snapshot still revokes (append order, not timestamp)"
check future.valid_grant?("authz-001", action: "deploy_production", at: "2026-09-30T10:05:00Z", through: "authz-001"),
      "a later revoke (id > S) is ignored for a historical pass"

wide = L::Index.new([grant(999), grant(1000), revoke(1001, 999)])
check wide.valid_grant?("authz-1000", action: "deploy_production", at: T, through: "authz-1000"), "authz-1000 is inside S = authz-1000"
check !wide.valid_grant?("authz-1000", action: "deploy_production", at: T, through: "authz-999"),
      "authz-1000 is NOT inside S = authz-999 (numeric, not lexical)"
check wide.valid_grant?("authz-999", action: "deploy_production", at: T, through: "authz-1000"),
      "authz-999 stays valid as of S = authz-1000 because its revoke is authz-1001 (id > S)"
check !wide.valid_grant?("authz-999", action: "deploy_production", at: T, through: "authz-1001"),
      "authz-999 is revoked as of S = authz-1001"
RUBY
echo "[ok] authorization-ledger unit checks"

# ---------------------------------------------------------------------------
# Task 2 — the record-authorization.rb writer
# ---------------------------------------------------------------------------
GRANT_ARGS=(--action production_backfill --scope "prod slip-api DB" --actor alice --via cli --reason "operator approved")

DIR="$(new_task TASK-A01)"
write_status "$DIR" TASK-A01 review ""
out="$(AI_OFFICE_NOW=$T0 authz TASK-A01 grant "${GRANT_ARGS[@]}")"
assert_eq "authz-001 grant" "$out" "first grant is authz-001"
out="$(AI_OFFICE_NOW=$T1 authz TASK-A01 grant --action live_load --scope "staging load run" --actor alice --via cli --reason "ok")"
assert_eq "authz-002 grant" "$out" "second grant is authz-002"
assert_eq "$T0" "$(yaml_get "$DIR/authorization.yaml" authorizations.0.at)" "at is written by the writer"
assert_eq "production_backfill" "$(yaml_get "$DIR/authorization.yaml" authorizations.0.action)" "action stored"
assert_eq "2" "$(event_count "$DIR" authorization_recorded)" "each append is recorded in meta.yaml"
out="$(AI_OFFICE_NOW=$T1 authz TASK-A01 revoke authz-001 --actor alice --via cli --reason "plan changed")"
assert_eq "authz-003 revoke" "$out" "revoke gets the next id"
assert_eq "authz-001" "$(yaml_get "$DIR/authorization.yaml" authorizations.2.revokes)" "revoke references the grant"

# Refused appends leave the ledger byte-for-byte untouched.
before="$(cksum < "$DIR/authorization.yaml")"
rc=0; authz TASK-A01 revoke authz-001 --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "revoking an already-revoked grant is refused"
rc=0; authz TASK-A01 revoke authz-009 --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "revoking an unknown id is refused"
rc=0; authz TASK-A01 revoke authz-003 --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "revoking a revoke is refused"
rc=0; authz TASK-A01 grant --action deploy_prod --scope s --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "an action outside the enum is refused"
rc=0; authz TASK-A01 grant --action live_load --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a grant without a scope is refused"
rc=0; authz TASK-A01 grant --action live_load --scope s --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a grant without an actor is refused"
rc=0; authz TASK-A01 revoke authz-002 --actor a --via cli >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a revoke without a reason is refused"
assert_eq "$before" "$(cksum < "$DIR/authorization.yaml")" "refused appends leave the ledger untouched"

# expires_at must be strictly after `at`.
rc=0; AI_OFFICE_NOW=$T1 authz TASK-A01 grant --action live_load --scope s --actor a --via cli --reason r --expires-at "$T1" >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "expires_at equal to at is refused"
rc=0; AI_OFFICE_NOW=$T1 authz TASK-A01 grant --action live_load --scope s --actor a --via cli --reason r --expires-at "$T0" >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "expires_at before at is refused"
out="$(AI_OFFICE_NOW=$T1 authz TASK-A01 grant --action live_load --scope s --actor a --via cli --reason r --expires-at "2026-09-30T11:00:00Z")"
assert_eq "authz-004 grant" "$out" "a later expires_at is accepted"
assert_eq "2026-09-30T11:00:00Z" "$(yaml_get "$DIR/authorization.yaml" authorizations.3.expires_at)" "expires_at stored"

# The writer never refuses because the local clock stepped backwards.
out="$(AI_OFFICE_NOW=2026-09-30T08:00:00Z authz TASK-A01 grant --action live_load --scope s --actor a --via cli --reason r)"
assert_eq "authz-005 grant" "$out" "a backward clock does not block an append"
out="$(AI_OFFICE_NOW=2026-09-30T07:00:00Z authz TASK-A01 revoke authz-004 --actor a --via cli --reason r)"
assert_eq "authz-006 revoke" "$out" "a revoke whose at is earlier than its grants is accepted (append order decides)"

# grant on a finished task is refused; revoke is allowed.
DIR="$(new_task TASK-A02)"
write_status "$DIR" TASK-A02 review ""
authz TASK-A02 grant "${GRANT_ARGS[@]}" >/dev/null
write_status "$DIR" TASK-A02 done ""
rc=0; authz TASK-A02 grant "${GRANT_ARGS[@]}" >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "grant on a done task is refused"
out="$(authz TASK-A02 revoke authz-001 --actor alice --via cli --reason "audit after the fact")"
assert_eq "authz-002 revoke" "$out" "revoke on a done task is allowed"

# Missing status.yaml / corrupt ledger.
rc=0; authz TASK-NOPE grant "${GRANT_ARGS[@]}" >/dev/null 2>&1 || rc=$?
assert_eq "3" "$rc" "a task without status.yaml is exit 3"
DIR="$(new_task TASK-A03)"
write_status "$DIR" TASK-A03 review ""
printf 'authorizations: [unterminated\n' > "$DIR/authorization.yaml"
rc=0; authz TASK-A03 grant "${GRANT_ARGS[@]}" >/dev/null 2>&1 || rc=$?
assert_eq "3" "$rc" "a corrupt ledger is exit 3"
write_ledger "$DIR" '  - {id: authz-002, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}
  - {id: authz-001, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
rc=0; authz TASK-A03 grant "${GRANT_ARGS[@]}" >/dev/null 2>&1 || rc=$?
assert_eq "3" "$rc" "a ledger that violates an integrity rule is exit 3"

# Ids cross the 999/1000 boundary in numeric order (pre-seeded at authz-998/999).
DIR="$(new_task TASK-A04)"
write_status "$DIR" TASK-A04 review ""
write_ledger "$DIR" '  - {id: authz-998, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}
  - {id: authz-999, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
assert_eq "authz-1000 grant" "$(authz TASK-A04 grant "${GRANT_ARGS[@]}")" "allocation crosses 999 -> 1000"
assert_eq "authz-1001 grant" "$(authz TASK-A04 grant "${GRANT_ARGS[@]}")" "and keeps growing"
assert_eq "authz-1002 revoke" "$(authz TASK-A04 revoke authz-999 --actor a --via cli --reason r)" "a revoke of authz-999 recorded as authz-1002 is accepted"
ruby - "$ROOT_DIR" "$DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "authorization-ledger")
index = AuthorizationLedger.load(ARGV[1])
abort "[FAIL] boundary: high_water_id is #{index.high_water_id}" unless index.high_water_id == "authz-1002"
ids = index.entries.map { |e| AuthorizationLedger.id_number(e["id"]) }
abort "[FAIL] boundary: ids not increasing numerically: #{ids.inspect}" unless ids == ids.sort
RUBY

# A live lease held by another run refuses the writer (ownership fence).
DIR="$(new_task TASK-A05)"
write_status "$DIR" TASK-A05 review ""
AI_DEV_OFFICE_HOME="$ROOT_DIR" AI_DEV_OFFICE_RUN_ID="run-holder" ruby "$OWN" acquire "$DIR" TASK-A05 agent=dev "worktree=$TMP_RUNS/wt" >/dev/null 2>&1 \
  || fail "test setup: could not acquire a lease for the fence test"
rc=0; AI_DEV_OFFICE_HOME="$ROOT_DIR" authz TASK-A05 grant "${GRANT_ARGS[@]}" >/dev/null 2>&1 || rc=$?
assert_eq "9" "$rc" "a stale/foreign owner cannot append an authorization (fence refused)"
[[ ! -f "$DIR/authorization.yaml" ]] || fail "a fenced append must not create the ledger"
echo "[ok] record-authorization writer"

# ---------------------------------------------------------------------------
# Task 3 — the guard validates authorization truth (forged refs are blocked
# by CompletionGuard itself, through sync / approve / force / the auto loop)
# ---------------------------------------------------------------------------
BOUND_PASS='completion_gates:
  production_backfill:
    status: pass
    actor: alice
    reason: backfill ran under authz-001
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - authz-001
    authorization_through: authz-001
    evidence_refs: []'
G001='  - {id: authz-001, type: grant, action: production_backfill, scope: "prod db", actor: alice, via: cli, reason: ok, at: "2026-09-30T10:00:00Z"}'

sync_rc() {  # <dir> <task_id> — runs a reviewer-approved sync; echoes the exit code
  local rc=0
  write_reviewer_approved "$1"
  ruby "$SYNC" "$2" reviewer "$1/status.yaml" "$1/reviewer-output.yaml" 2026-09-30 in_review >/dev/null 2>&1 || rc=$?
  echo "$rc"
}

# Pure-function checks on CompletionGuard.
ruby - "$ROOT_DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "completion-guard")
G = CompletionGuard
L = AuthorizationLedger

def check(cond, msg)
  abort "[FAIL] guard(1B.1): #{msg}" unless cond
end

entry = { "id" => "authz-001", "type" => "grant", "action" => "production_backfill", "scope" => "s",
          "actor" => "a", "via" => "cli", "reason" => "r", "at" => "2026-09-30T10:00:00Z" }
index = L::Index.new([entry])
meta = { "actor" => "alice", "reason" => "ran", "updated_at" => "2026-09-30T10:05:00Z" }
bound = meta.merge("status" => "pass", "requires_authorization" => "production_backfill",
                   "authorization_refs" => ["authz-001"], "authorization_through" => "authz-001")
status = ->(gate) { { "completion_gates" => { "g" => gate } } }

check G.can_transition_to_done(status.(bound), authorizations: index).allowed, "a genuine bound pass is resolved"
check !G.can_transition_to_done(status.(bound), authorizations: nil).allowed, "no ledger => bound gate unresolved (fail closed)"
check !G.can_transition_to_done(status.(bound)).allowed, "the default (no ledger argument) is fail closed for a bound gate"
check !G.can_transition_to_done(status.(bound.merge("authorization_refs" => ["authz-999"])), authorizations: index).allowed, "a forged ref is unresolved"
check !G.can_transition_to_done(status.(bound.merge("authorization_refs" => [])), authorizations: index).allowed, "empty refs are unresolved"
check !G.can_transition_to_done(status.(bound.reject { |k, _| k == "authorization_refs" }), authorizations: index).allowed, "missing refs are unresolved"
check !G.can_transition_to_done(status.(bound.reject { |k, _| k == "authorization_through" }), authorizations: index).allowed, "missing through is unresolved"
check !G.can_transition_to_done(status.(bound.merge("authorization_through" => "authz-009")), authorizations: index).allowed, "unknown through is unresolved"
check !G.can_transition_to_done(status.(bound.merge("updated_at" => "yesterday")), authorizations: index).allowed, "unparseable updated_at is unresolved"
check !G.can_transition_to_done(status.(bound.merge("requires_authorization" => "deploy_production")), authorizations: index).allowed, "action mismatch is unresolved"
check !G.can_transition_to_done(status.(bound.merge("requires_authorization" => "prod_backfill")), authorizations: index).allowed, "an unknown required action is unresolved"
check !G.can_transition_to_done(status.(bound.merge("updated_at" => "2026-09-30T09:59:59Z")), authorizations: index).allowed, "a pass before the grant started is unresolved"

na_ok = meta.merge("status" => "na", "requires_authorization" => "production_backfill")
check G.can_transition_to_done(status.(na_ok), authorizations: index).allowed, "na on a bound gate needs no authorization"
check !G.can_transition_to_done(status.(na_ok), authorizations: nil).allowed, "an UNAVAILABLE ledger (nil) leaves even a bound na unresolved (fail closed)"
check G.can_transition_to_done(status.(na_ok), authorizations: L::Index.new([])).allowed, "an ABSENT ledger is an empty Index: a bound na stays resolvable"
check !G.can_transition_to_done(status.(bound), authorizations: L::Index.new([])).allowed, "an empty ledger leaves a bound pass unresolved (no ref can resolve)"
check !G.can_transition_to_done(status.(na_ok.merge("authorization_refs" => ["authz-001"])), authorizations: index).allowed, "na must not carry authorization_refs"
check !G.can_transition_to_done(status.(na_ok.merge("authorization_through" => "authz-001")), authorizations: index).allowed, "na must not carry authorization_through"

# Unbound gates are exactly Phase 1A: the ledger argument is irrelevant.
plain = meta.merge("status" => "pass")
check G.can_transition_to_done(status.(plain), authorizations: nil).allowed, "an unbound gate resolves without a ledger"
check G.can_transition_to_done(status.(plain.merge("authorization_refs" => ["authz-999"])), authorizations: nil).allowed, "stray refs on an unbound gate are ignored by the guard (the validator flags them)"

# Numeric comparison inside the guard.
wide = L::Index.new([entry.merge("id" => "authz-999"), entry.merge("id" => "authz-1000")])
b1000 = bound.merge("authorization_refs" => ["authz-1000"])
check !G.can_transition_to_done(status.(b1000.merge("authorization_through" => "authz-999")), authorizations: wide).allowed,
      "ref authz-1000 with through authz-999 is unresolved (lexically 'authz-999' > 'authz-1000' would wrongly pass)"
check G.can_transition_to_done(status.(b1000.merge("authorization_through" => "authz-1000")), authorizations: wide).allowed,
      "ref authz-1000 with through authz-1000 is resolved"

# Snapshot semantics inside the guard.
revoked = L::Index.new([entry, { "id" => "authz-002", "type" => "revoke", "revokes" => "authz-001",
                                 "actor" => "a", "via" => "cli", "reason" => "r", "at" => "2026-09-30T09:00:00Z" }])
check G.can_transition_to_done(status.(bound), authorizations: revoked).allowed,
      "a later revoke (id > through) does not reopen the gate, even with an EARLIER timestamp"
check !G.can_transition_to_done(status.(bound.merge("authorization_through" => "authz-002")), authorizations: revoked).allowed,
      "a revoke inside the snapshot (id <= through) makes the grant invalid"

check G.can_transition_to_done({ "completion_gates" => { "g" => plain } }, authorizations: nil).unresolved.empty?, "unresolved list is empty when resolved"
check G.blocked_message(["g"]).include?("authorization"), "the blocked message mentions authorization"
RUBY
echo "[ok] guard authorization rules (pure)"

# --- forged / missing / corrupt state blocked through every writer ---
DIR="$(new_task TASK-B01)"
write_status "$DIR" TASK-B01 review "$BOUND_PASS"          # gate says authz-001 but there is NO ledger
assert_eq "5" "$(sync_rc "$DIR" TASK-B01)" "forged refs (no ledger): sync is blocked by the guard"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "forged refs: phase unchanged"
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-B01
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T11:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-B01 2>/dev/null)"
assert_eq "blocked:approve:production_backfill" "$out" "forged refs: a human approve is held by the guard"
rc=0; ruby "$FORCE" TASK-B01 "$DIR/status.yaml" 2026-09-30 done done orchestrator x >/dev/null 2>&1 || rc=$?
assert_eq "5" "$rc" "forged refs: force done is refused"
assert_eq "next= terminal=false" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" "$DIR/status.yaml" 2>/dev/null)" "forged refs: the auto loop is not terminal"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "forged refs: nothing wrote done"

# A genuine grant makes the same gate resolve.
write_ledger "$DIR" "$G001"
rm -f "$DIR/decision.yaml"
assert_eq "0" "$(sync_rc "$DIR" TASK-B01)" "with a valid grant the same gate reaches done"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "valid grant -> done"

# Positive controls: with the SAME valid gate + ledger, reconcile applies a held approve ...
DIR="$(new_task TASK-B01P)"
write_status "$DIR" TASK-B01P review "$BOUND_PASS"
write_ledger "$DIR" "$G001"
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-B01P
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T11:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-B01P 2>/dev/null)"
assert_eq "applied:approve:done" "$out" "positive control: reconcile applies the approve under a valid ledger"
# ... and the auto loop decides done on a fresh task.
DIR="$(new_task TASK-B01Q)"
write_status "$DIR" TASK-B01Q review "$BOUND_PASS"
write_ledger "$DIR" "$G001"
write_reviewer_approved "$DIR"
assert_eq "next=done terminal=true" "$(ruby "$DECIDE" reviewer "$DIR/reviewer-output.yaml" "$DIR/status.yaml" 2>/dev/null)" "positive control: decide-next-step is terminal under a valid ledger"

# Wrong action / revoked inside the snapshot / corrupt ledger / lowered through.
DIR="$(new_task TASK-B02)"
write_status "$DIR" TASK-B02 review "$BOUND_PASS"
write_ledger "$DIR" '  - {id: authz-001, type: grant, action: external_side_effect, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
assert_eq "5" "$(sync_rc "$DIR" TASK-B02)" "a grant for a different action does not satisfy the gate (exact match)"

DIR="$(new_task TASK-B03)"
write_status "$DIR" TASK-B03 review "$(printf '%s' "$BOUND_PASS" | sed 's/authorization_through: authz-001/authorization_through: authz-002/')"
write_ledger "$DIR" "$G001
  - {id: authz-002, type: revoke, revokes: authz-001, actor: a, via: cli, reason: r, at: \"2026-09-30T10:01:00Z\"}"
assert_eq "5" "$(sync_rc "$DIR" TASK-B03)" "a revoke inside the snapshot (through authz-002) blocks done"

DIR="$(new_task TASK-B04)"
write_status "$DIR" TASK-B04 review "$BOUND_PASS"      # through authz-001, revoke is authz-002 (later)
write_ledger "$DIR" "$G001
  - {id: authz-002, type: revoke, revokes: authz-001, actor: a, via: cli, reason: r, at: \"2026-09-30T09:00:00Z\"}"
assert_eq "0" "$(sync_rc "$DIR" TASK-B04)" "a later revoke with an EARLIER (skewed) timestamp does not reopen a resolved gate"

DIR="$(new_task TASK-B05)"
write_status "$DIR" TASK-B05 review "$BOUND_PASS"
printf 'authorizations: [unterminated\n' > "$DIR/authorization.yaml"
assert_eq "5" "$(sync_rc "$DIR" TASK-B05)" "a corrupt ledger fails closed for a bound gate"

# Numeric comparison across the width boundary, end to end.
DIR="$(new_task TASK-B06)"
BOUND_1000="$(printf '%s' "$BOUND_PASS" | sed 's/- authz-001/- authz-1000/; s/authorization_through: authz-001/authorization_through: authz-999/')"
write_status "$DIR" TASK-B06 review "$BOUND_1000"
write_ledger "$DIR" '  - {id: authz-999, type: grant, action: production_backfill, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}
  - {id: authz-1000, type: grant, action: production_backfill, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
assert_eq "5" "$(sync_rc "$DIR" TASK-B06)" "ref authz-1000 with through authz-999 is blocked (numeric comparison)"
write_status "$DIR" TASK-B06 review "$(printf '%s' "$BOUND_1000" | sed 's/authorization_through: authz-999/authorization_through: authz-1000/')"
assert_eq "0" "$(sync_rc "$DIR" TASK-B06)" "ref authz-1000 with through authz-1000 reaches done"

# Backward compatibility: an unbound gate never reads the ledger, even a corrupt one.
DIR="$(new_task TASK-B07)"
write_status "$DIR" TASK-B07 review 'completion_gates:
  deployment:
    status: pass
    actor: dev
    reason: deployed
    updated_at: "2026-09-30T10:05:00Z"
    evidence_refs: []'
printf 'not: [valid\n' > "$DIR/authorization.yaml"
assert_eq "0" "$(sync_rc "$DIR" TASK-B07)" "a task with no bound gate behaves exactly as in Phase 1A (the ledger is not read)"
echo "[ok] guard blocks forged/missing/corrupt authorization state through every writer"

# ---------------------------------------------------------------------------
# Task 4 — the gate writer: bound gates, (T, S), preservation
# ---------------------------------------------------------------------------
new_bound_task() {  # <task_id> [<action>] — a review-phase task with one gate bound to <action>
  local dir; dir="$(new_task "$1")"
  write_status "$dir" "$1" review ""
  gate "$1" declare production_backfill --actor pm --requires-authorization "${2:-production_backfill}" >/dev/null
  echo "$dir"
}
grant_bf() {  # <task_id> <NOW> [extra args...]
  local task="$1" now="$2"; shift 2
  AI_OFFICE_NOW="$now" authz "$task" grant --action production_backfill --scope "prod db" --actor alice --via cli --reason ok "$@"
}
gate_state() { yaml_get "$1/status.yaml" completion_gates.production_backfill.status; }

# declare records the requirement; a non-enum value and misuse are refused.
DIR="$(new_bound_task TASK-C01)"
assert_eq "production_backfill" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.requires_authorization)" "declare stores requires_authorization"
assert_eq "pending" "$(gate_state "$DIR")" "declared bound gate is pending"
DIR2="$(new_task TASK-C02)"; write_status "$DIR2" TASK-C02 review ""
rc=0; gate TASK-C02 declare g --actor pm --requires-authorization deploy_prod >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "requires-authorization outside the enum is refused"
gate TASK-C02 declare g --actor pm >/dev/null 2>&1 || fail "C02: the plain declare must succeed before testing the misuse"
rc=0; gate TASK-C02 pass g --actor a --reason r --requires-authorization deploy_production >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "--requires-authorization is only valid with declare"

# pass on a bound gate: refused without refs / with bad refs; gate stays pending.
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C01 pass production_backfill --actor alice --reason ran >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a bound pass without --authorization is refused"
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C01 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a bound pass with no ledger at all is refused"
grant_bf TASK-C01 "$T0" >/dev/null                                   # authz-001
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C01 pass production_backfill --actor alice --reason ran --authorization authz-009 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "an unknown authorization id is refused"
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C01 pass production_backfill --actor alice --reason ran --authorization authz-001,authz-009 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "every listed ref must be valid, not just one"
assert_eq "pending" "$(gate_state "$DIR")" "refused passes leave the gate pending"
assert_eq "1" "$(event_count "$DIR" completion_gate_updated)" "refused passes are not logged as updates"

# A grant for a different action does not satisfy the gate (exact match, no hierarchy).
DIR="$(new_bound_task TASK-C03)"
AI_OFFICE_NOW=$T0 authz TASK-C03 grant --action external_side_effect --scope s --actor a --via cli --reason r >/dev/null
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C03 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "external_side_effect does not satisfy a production_backfill gate"
DIR="$(new_bound_task TASK-C04 production_data_mutation)"
grant_bf TASK-C04 "$T0" >/dev/null
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C04 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a production_backfill grant does not satisfy a production_data_mutation gate"

# Happy path: T and S are captured once; updated_at == T; requires_authorization preserved.
DIR="$(new_bound_task TASK-C05)"
grant_bf TASK-C05 "$T0" >/dev/null
out="$(AI_OFFICE_NOW=$T1 gate TASK-C05 pass production_backfill --actor alice --reason "backfill ran; 1071 rows" --authorization authz-001)"
assert_eq "gate production_backfill: pending -> pass" "$out" "bound pass output"
assert_eq "pass" "$(gate_state "$DIR")" "bound gate passes with a valid grant"
assert_eq "$T1" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.updated_at)" "updated_at is exactly the T used for validity"
assert_eq "authz-001" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.authorization_through)" "authorization_through is the high-water id S"
grep -q -- "- authz-001" "$DIR/status.yaml" || fail "authorization_refs stored"
assert_eq "production_backfill" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.requires_authorization)" "PRESERVATION: requires_authorization survives declare -> pass"
assert_eq "0" "$(sync_rc "$DIR" TASK-C05)" "a genuinely bound-and-passed task reaches done"

# S is the ledger's high-water id at pass time, not the highest cited ref.
DIR="$(new_bound_task TASK-C06)"
grant_bf TASK-C06 "$T0" >/dev/null                                   # authz-001
AI_OFFICE_NOW=$T0 authz TASK-C06 grant --action live_load --scope s --actor a --via cli --reason r >/dev/null   # authz-002
AI_OFFICE_NOW=$T1 gate TASK-C06 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null
assert_eq "authz-002" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.authorization_through)" "S is the ledger high-water id, above the cited ref"
assert_eq "0" "$(sync_rc "$DIR" TASK-C06)" "a ref below S is fine"

# na keeps the requirement and carries no refs/through; it is not a waiver.
DIR="$(new_bound_task TASK-C07)"
out="$(gate TASK-C07 na production_backfill --actor reviewer --reason "backfill was not performed")"
assert_eq "gate production_backfill: pending -> na" "$out" "bound na output"
assert_eq "production_backfill" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.requires_authorization)" "PRESERVATION: requires_authorization survives declare -> na"
assert_eq "" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.authorization_refs)" "na omits authorization_refs"
assert_eq "" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.authorization_through)" "na omits authorization_through"
assert_eq "0" "$(sync_rc "$DIR" TASK-C07)" "na on a bound gate needs no authorization"
DIR="$(new_bound_task TASK-C08)"
rc=0; gate TASK-C08 na production_backfill --actor reviewer --reason r --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "na with --authorization is refused"

# --authorization on an unbound gate is refused.
DIR="$(new_task TASK-C09)"; write_status "$DIR" TASK-C09 review ""
gate TASK-C09 declare deployment --actor pm >/dev/null
grant_bf TASK-C09 "$T0" >/dev/null
rc=0; AI_OFFICE_NOW=$T1 gate TASK-C09 pass deployment --actor dev --reason r --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "an unbound gate cannot carry authorization refs"
gate TASK-C09 pass deployment --actor dev --reason deployed >/dev/null
assert_eq "" "$(yaml_get "$DIR/status.yaml" completion_gates.deployment.requires_authorization)" "an unbound gate never grows requires_authorization"

# Expiry boundary with a controlled clock: expires_at == T is not valid at T.
DIR="$(new_bound_task TASK-C10)"
grant_bf TASK-C10 "$T0" --expires-at "2026-09-30T10:30:00Z" >/dev/null
rc=0; AI_OFFICE_NOW="2026-09-30T10:30:00Z" gate TASK-C10 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a grant whose expires_at equals T is not valid at T"
assert_eq "pending" "$(gate_state "$DIR")" "expired-at-T pass leaves the gate pending"
AI_OFFICE_NOW="2026-09-30T10:29:59Z" gate TASK-C10 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null
assert_eq "2026-09-30T10:29:59Z" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.updated_at)" "updated_at is exactly T (no second clock read)"
assert_eq "0" "$(sync_rc "$DIR" TASK-C10)" "the guard's later re-evaluation agrees with the writer's decision"

# Revoke before the pass -> refused; revoke after the pass -> gate stays resolved.
DIR="$(new_bound_task TASK-C11)"
grant_bf TASK-C11 "$T0" >/dev/null
AI_OFFICE_NOW=$T1 authz TASK-C11 revoke authz-001 --actor a --via cli --reason r >/dev/null
rc=0; AI_OFFICE_NOW="2026-09-30T10:10:00Z" gate TASK-C11 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "grant -> revoke -> pass: refused"
DIR="$(new_bound_task TASK-C12)"
grant_bf TASK-C12 "$T0" >/dev/null
AI_OFFICE_NOW=$T1 gate TASK-C12 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null
AI_OFFICE_NOW="2026-09-30T10:10:00Z" authz TASK-C12 revoke authz-001 --actor a --via cli --reason "later" >/dev/null
assert_eq "pass" "$(gate_state "$DIR")" "grant -> pass -> later revoke: the gate stays resolved"
assert_eq "0" "$(sync_rc "$DIR" TASK-C12)" "and the task can reach done"

# Skewed clock: the later revoke carries an EARLIER timestamp than the pass.
DIR="$(new_bound_task TASK-C13)"
grant_bf TASK-C13 "$T0" >/dev/null
AI_OFFICE_NOW=$T1 gate TASK-C13 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null
AI_OFFICE_NOW="2026-09-30T09:00:00Z" authz TASK-C13 revoke authz-001 --actor a --via cli --reason "skewed clock" >/dev/null
assert_eq "0" "$(sync_rc "$DIR" TASK-C13)" "a revoke appended later with a backward clock does not invalidate the pass"

# Future-dated revoke recorded BEFORE the pass still refuses it (append order).
DIR="$(new_bound_task TASK-C14)"
grant_bf TASK-C14 "$T0" >/dev/null
AI_OFFICE_NOW="2026-09-30T23:00:00Z" authz TASK-C14 revoke authz-001 --actor a --via cli --reason "future dated" >/dev/null
rc=0; AI_OFFICE_NOW="2026-09-30T10:30:00Z" gate TASK-C14 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a revoke already in the ledger revokes the grant even if its timestamp is in the future"

# A grant recorded after S (higher id) cannot rescue a gate whose through is below it.
DIR="$(new_bound_task TASK-C15)"
grant_bf TASK-C15 "$T0" >/dev/null                                   # authz-001
AI_OFFICE_NOW=$T1 gate TASK-C15 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null
grant_bf TASK-C15 "$T1" >/dev/null                                   # authz-002, after S
ruby - "$DIR" <<'RUBY'
require "yaml"
path = File.join(ARGV[0], "status.yaml")
s = YAML.safe_load(File.read(path))
s["completion_gates"]["production_backfill"]["authorization_refs"] = ["authz-002"]   # forged: a grant newer than S
File.write(path, YAML.dump(s))
RUBY
assert_eq "5" "$(sync_rc "$DIR" TASK-C15)" "a cited grant with an id above authorization_through is not valid"

# Bound gate + a ledger that later disappears / corrupts: fail closed.
DIR="$(new_bound_task TASK-C16)"
grant_bf TASK-C16 "$T0" >/dev/null
AI_OFFICE_NOW=$T1 gate TASK-C16 pass production_backfill --actor a --reason r --authorization authz-001 >/dev/null
rm -f "$DIR/authorization.yaml"
assert_eq "5" "$(sync_rc "$DIR" TASK-C16)" "a bound gate whose ledger is gone fails closed"

# The writer refuses on finished tasks and keeps a bad AI_OFFICE_NOW from writing anything.
DIR="$(new_bound_task TASK-C17)"
rc=0; AI_OFFICE_NOW=not-a-time gate TASK-C17 na production_backfill --actor a --reason r >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "a malformed AI_OFFICE_NOW is a usage error and writes nothing"
assert_eq "pending" "$(gate_state "$DIR")" "nothing was written"
echo "[ok] gate writer: bound gates, (T, S), preservation"

# ---------------------------------------------------------------------------
# Task 5 — stored-state validation, ledger validation, shape rules
# ---------------------------------------------------------------------------
expect_valid()   { ruby "$VALIDATOR" "$1" >/dev/null 2>&1 || { ruby "$VALIDATOR" "$1" 2>&1 | head -5; fail "$2 (validation unexpectedly failed)"; }; }
expect_invalid() {  # <task_dir> <message> <substring the errors must mention>
  local out
  out="$(ruby "$VALIDATOR" "$1" 2>&1)" && fail "$2 (validation unexpectedly passed)"
  grep -q -- "$3" <<<"$out" || fail "$2 (expected the errors to mention '$3', got: $out)"
}

# A genuine bound-and-passed task validates, also once done, and under a skewed-clock revoke.
DIR="$(new_bound_task TASK-D-001)"
grant_bf TASK-D-001 "$T0" >/dev/null
AI_OFFICE_NOW=$T1 gate TASK-D-001 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null
expect_valid "$DIR" "a genuine bound pass validates"
AI_OFFICE_NOW="2026-09-30T09:00:00Z" authz TASK-D-001 revoke authz-001 --actor a --via cli --reason skewed >/dev/null
expect_valid "$DIR" "a later revoke with an earlier timestamp does not invalidate the stored state"
assert_eq "0" "$(sync_rc "$DIR" TASK-D-001)" "sync reaches done"
rm -f "$DIR/reviewer-output.yaml"   # the minimal fixture is not a full reviewer output; the validator would (rightly) reject it
expect_valid "$DIR" "a done task with a genuinely bound gate validates"

# done + forged refs / no ledger: invalid, with the guard's own reason.
DIR="$(new_task TASK-D-002)"
write_status "$DIR" TASK-D-002 done "$BOUND_PASS"
expect_invalid "$DIR" "done with forged authorization refs (no ledger) is invalid" "unresolved completion gate"
write_ledger "$DIR" "$G001"
expect_valid "$DIR" "the same done state with a matching grant validates"
write_ledger "$DIR" '  - {id: authz-001, type: grant, action: external_side_effect, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
expect_invalid "$DIR" "a grant for a different action makes the stored state invalid" "not a valid"

# Gate field shape rules.
DIR="$(new_task TASK-D-003)"
write_ledger "$DIR" "$G001"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pending
    requires_authorization: deploy_prod'
expect_invalid "$DIR" "requires_authorization outside the enum is invalid" "requires_authorization"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    authorization_refs:
      - authz-001'
expect_invalid "$DIR" "authorization_refs on a gate that does not require authorization is invalid" "requires_authorization"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: na
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - authz-001'
expect_invalid "$DIR" "na must not carry authorization_refs" "must be absent when status is na"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill'
expect_invalid "$DIR" "a bound pass without refs is invalid" "authorization_refs"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - authz-001'
expect_invalid "$DIR" "a bound pass without authorization_through is invalid" "authorization_through"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - "authz-1"
    authorization_through: authz-001'
expect_invalid "$DIR" "a malformed authorization id is invalid" "must be a list of authz-NNN ids"

# Cross-file checks against the ledger.
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - authz-009
    authorization_through: authz-001'
expect_invalid "$DIR" "a ref beyond authorization_through is invalid" "later than authorization_through"
write_status "$DIR" TASK-D-003 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - authz-001
    authorization_through: authz-009'
expect_invalid "$DIR" "authorization_through must exist in the ledger" "authorization_through"
DIR="$(new_task TASK-D-004)"
write_ledger "$DIR" '  - {id: authz-999, type: grant, action: production_backfill, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}
  - {id: authz-1000, type: grant, action: production_backfill, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
write_status "$DIR" TASK-D-004 review 'completion_gates:
  g:
    status: pass
    actor: a
    reason: r
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    authorization_refs:
      - authz-1000
    authorization_through: authz-999'
expect_invalid "$DIR" "ref authz-1000 with through authz-999 is invalid (numeric comparison)" "authorization_through"

# Ledger integrity is validated when the file exists.
DIR="$(new_task TASK-D-005)"
write_status "$DIR" TASK-D-005 review ""
expect_valid "$DIR" "no ledger is fine"
write_ledger "$DIR" "$G001"
expect_valid "$DIR" "a valid ledger is fine"
write_ledger "$DIR" '  - {id: authz-001, type: revoke, revokes: authz-002, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
expect_invalid "$DIR" "a forward-referencing revoke is invalid" "earlier"
write_ledger "$DIR" "$G001
$G001"
expect_invalid "$DIR" "duplicate ids are invalid" "duplicates"
write_ledger "$DIR" '  - {id: authz-001, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z", expires_at: "2026-09-30T10:00:00Z"}'
expect_invalid "$DIR" "expires_at <= at is invalid" "strictly after"
write_ledger "$DIR" '  - {id: authz-001, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}
  - {id: authz-002, type: revoke, revokes: authz-001, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}
  - {id: authz-003, type: revoke, revokes: authz-001, actor: a, via: cli, reason: r, at: "2026-09-30T10:00:00Z"}'
expect_invalid "$DIR" "a duplicate revoke is invalid" "already revoked"
printf 'authorizations: [unterminated\n' > "$DIR/authorization.yaml"
expect_invalid "$DIR" "a corrupt ledger is invalid" "authorization.yaml"

# Phase 1A behavior is unchanged for tasks without bound gates.
DIR="$(new_task TASK-D-006)"
write_status "$DIR" TASK-D-006 done 'completion_gates:
  deployment:
    status: pass
    actor: dev
    reason: deployed
    updated_at: "2026-09-30T10:05:00Z"
    evidence_refs: []'
expect_valid "$DIR" "an unbound done task validates exactly as in Phase 1A"
echo "[ok] validator: ledger, gate fields, stored-state checks"

# ---------------------------------------------------------------------------
# Final fix wave
# ---------------------------------------------------------------------------

# --- AI_OFFICE_NOW is a test hook: unreachable against the live runs dir ---
ruby - "$ROOT_DIR" "$TMP_RUNS" <<'RUBY'
require File.join(ARGV[0], "scripts", "authorization-ledger")
L = AuthorizationLedger
root, tmp = ARGV
def check(cond, msg)
  abort "[FAIL] clock hook: #{msg}" unless cond
end
def raises?
  yield
  false
rescue AuthorizationLedger::Error
  true
end
live = File.join(root, "runs")
ENV["AI_OFFICE_NOW"] = "2026-01-01T00:30:00Z"
ENV["AI_OFFICE_RUNS_DIR"] = tmp
check L.format_time(L.now_utc) == "2026-01-01T00:30:00Z", "a temp runs dir honors the hook"
ENV.delete("AI_OFFICE_RUNS_DIR")
check raises? { L.now_utc }, "unset AI_OFFICE_RUNS_DIR rejects the hook"
ENV["AI_OFFICE_RUNS_DIR"] = ""
check raises? { L.now_utc }, "empty AI_OFFICE_RUNS_DIR rejects the hook"
ENV["AI_OFFICE_RUNS_DIR"] = live
check raises? { L.now_utc }, "the live runs dir rejects the hook"
ENV["AI_OFFICE_RUNS_DIR"] = live + "/"
check raises? { L.now_utc }, "the live runs dir with a trailing slash rejects the hook"
ENV["AI_OFFICE_RUNS_DIR"] = File.join(live, "..", "runs")
check raises? { L.now_utc }, "an unnormalized path to the live runs dir rejects the hook"
ENV.delete("AI_OFFICE_NOW")
ENV["AI_OFFICE_RUNS_DIR"] = live
check L.now_utc.is_a?(Time), "the real clock path is unchanged against the live dir"
RUBY

# End to end WITHOUT touching the live runs/: a throwaway copy of scripts/ has its
# own "live" runs dir (<fake>/runs), which holds the fixture task.
FAKE="$(mktemp -d)"
mkdir -p "$FAKE/runs/TASK-H01"
cp -R "$ROOT_DIR/scripts" "$FAKE/scripts"
write_status "$FAKE/runs/TASK-H01" TASK-H01 review ""
cat > "$FAKE/runs/TASK-H01/authorization.yaml" <<YAML
task_id: TASK-H01
authorizations:
  - {id: authz-001, type: grant, action: production_backfill, scope: s, actor: a, via: cli, reason: r, at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z"}
YAML
cp "$FAKE/runs/TASK-H01/authorization.yaml" "$FAKE/ledger.before"
cp "$FAKE/runs/TASK-H01/status.yaml" "$FAKE/status.before"
for runs_env in unset "$FAKE/runs" "$FAKE/runs/"; do
  rc=0
  if [[ "$runs_env" == unset ]]; then
    err="$(env -u AI_OFFICE_RUNS_DIR AI_OFFICE_NOW=2026-01-01T00:30:00Z ruby "$FAKE/scripts/update-completion-gate.rb" TASK-H01 declare g --actor pm 2>&1 >/dev/null)" || rc=$?
  else
    err="$(AI_OFFICE_RUNS_DIR="$runs_env" AI_OFFICE_NOW=2026-01-01T00:30:00Z ruby "$FAKE/scripts/update-completion-gate.rb" TASK-H01 declare g --actor pm 2>&1 >/dev/null)" || rc=$?
  fi
  assert_eq "2" "$rc" "gate writer refuses AI_OFFICE_NOW against the live dir ($runs_env)"
  [[ "$err" == *"AI_OFFICE_NOW is a test hook"* ]] || fail "gate writer: expected the test-hook message ($runs_env), got: $err"
done
cmp -s "$FAKE/status.before" "$FAKE/runs/TASK-H01/status.yaml" || fail "a refused hook use must not change status.yaml"
# record-authorization reads the clock after the status read; the fixture has a status.
for runs_env in unset "$FAKE/runs"; do
  rc=0
  if [[ "$runs_env" == unset ]]; then
    err="$(env -u AI_OFFICE_RUNS_DIR AI_OFFICE_NOW=2026-01-01T00:30:00Z ruby "$FAKE/scripts/record-authorization.rb" TASK-H01 grant --action live_load --scope s --actor a --via cli --reason r 2>&1 >/dev/null)" || rc=$?
  else
    err="$(AI_OFFICE_RUNS_DIR="$runs_env" AI_OFFICE_NOW=2026-01-01T00:30:00Z ruby "$FAKE/scripts/record-authorization.rb" TASK-H01 grant --action live_load --scope s --actor a --via cli --reason r 2>&1 >/dev/null)" || rc=$?
  fi
  assert_eq "2" "$rc" "record-authorization refuses AI_OFFICE_NOW against the live dir ($runs_env)"
  [[ "$err" == *"AI_OFFICE_NOW is a test hook"* ]] || fail "record-authorization: expected the test-hook message, got: $err"
done
cmp -s "$FAKE/ledger.before" "$FAKE/runs/TASK-H01/authorization.yaml" || fail "a refused hook use must not change the ledger"
rm -rf "$FAKE"

# The reviewer's reproduction, against a TEMP runs dir, is the documented TEST HOOK
# and still works there. It is unreachable against the live store (see above).
DIR="$(new_bound_task TASK-H02)"
AI_OFFICE_NOW=2026-01-01T00:00:00Z authz TASK-H02 grant --action production_backfill --scope s --actor alice --via cli --reason ok --expires-at 2026-01-01T01:00:00Z >/dev/null
rc=0; gate TASK-H02 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "H02: a real-clock pass after expiry is refused"
AI_OFFICE_NOW=2026-01-01T00:30:00Z gate TASK-H02 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null
assert_eq "pass" "$(gate_state "$DIR")" "H02: the test hook (temp runs dir only) backdates the pass"
echo "[ok] AI_OFFICE_NOW restricted to non-live runs dirs"

# --- Important 2a: concurrent appends ---
DIR="$(new_task TASK-J01)"; write_status "$DIR" TASK-J01 review ""
CONC="$(mktemp -d)"
for i in $(seq 1 12); do
  (
    rc=0
    authz TASK-J01 grant --action live_load --scope "s$i" --actor "a$i" --via cli --reason r >/dev/null 2>&1 || rc=$?
    echo "$rc" > "$CONC/rc-$i"
  ) &
done
wait
for i in $(seq 1 12); do assert_eq "0" "$(cat "$CONC/rc-$i")" "J01: concurrent grant $i exits 0"; done
rm -rf "$CONC"
ruby - "$ROOT_DIR" "$DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "authorization-ledger")
idx = AuthorizationLedger.load(ARGV[1])
ids = idx.entries.map { |e| e["id"] }
want = (1..12).map { |n| AuthorizationLedger.format_id(n) }
abort "[FAIL] J01: ids #{ids.inspect} != #{want.inspect}" unless ids == want
RUBY
assert_eq "12" "$(event_count "$DIR" authorization_recorded)" "J01: one authorization_recorded event per concurrent append"
echo "[ok] concurrent appends"

# --- Important 2b: requires_authorization survives a second transition ---
DIR="$(new_bound_task TASK-J02)"
grant_bf TASK-J02 "$T0" >/dev/null
req() { yaml_get "$DIR/status.yaml" completion_gates.production_backfill.requires_authorization; }
assert_eq "production_backfill" "$(req)" "J02: after declare"
AI_OFFICE_NOW=$T1 gate TASK-J02 pass production_backfill --actor alice --reason ran --authorization authz-001 >/dev/null
assert_eq "production_backfill" "$(req)" "J02: after pass"
gate TASK-J02 na production_backfill --actor reviewer --reason "re-resolved: not performed" >/dev/null
assert_eq "na" "$(gate_state "$DIR")" "J02: gate is na after re-resolution"
assert_eq "production_backfill" "$(req)" "J02: after na"
cp "$DIR/status.yaml" "$DIR/status.before-refused"
rc=0; AI_OFFICE_NOW=$T1 gate TASK-J02 pass production_backfill --actor alice --reason ran >/dev/null 2>&1 || rc=$?
assert_eq "2" "$rc" "J02: a bound pass without --authorization after na is refused"
assert_eq "na" "$(gate_state "$DIR")" "J02: the refused pass leaves the gate as it was"
assert_eq "production_backfill" "$(req)" "J02: requirement intact after the refused pass"
AI_OFFICE_NOW=$T1 gate TASK-J02 pass production_backfill --actor alice --reason ran-again --authorization authz-001 >/dev/null
assert_eq "pass" "$(gate_state "$DIR")" "J02: second pass succeeds"
assert_eq "production_backfill" "$(req)" "J02: after the second pass"
assert_eq "authz-001" "$(yaml_get "$DIR/status.yaml" completion_gates.production_backfill.authorization_through)" "J02: second pass stores through"
grep -q -- "- authz-001" "$DIR/status.yaml" || fail "J02: second pass stores refs"
echo "[ok] preservation across a second transition"

# --- Minor 1: parse_time rejects non-canonical timestamps ---
ruby - "$ROOT_DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "authorization-ledger")
L = AuthorizationLedger
def check(cond, msg)
  abort "[FAIL] parse_time: #{msg}" unless cond
end
check L.parse_time("2026-09-30T10:04:59Z").is_a?(Time), "a canonical timestamp parses"
check L.parse_time("2026-09-30T10:04:60Z").nil?, "second 60 is rejected"
check L.parse_time("2026-09-30T24:00:00Z").nil?, "hour 24 is rejected"
check L.parse_time("2026-02-31T10:00:00Z").nil?, "an impossible date is rejected"
RUBY

# --- Minor 2: record-authorization with a non-map / unreadable status.yaml ---
DIR="$(new_task TASK-J03)"
printf -- '- a\n- b\n' > "$DIR/status.yaml"
rc=0; err="$(authz TASK-J03 grant --action live_load --scope s --actor a --via cli --reason r 2>&1 >/dev/null)" || rc=$?
assert_eq "3" "$rc" "J03: a non-map status.yaml exits 3"
[[ "$err" == *"not a map"* ]] || fail "J03: expected a clear message, got: $err"
[[ ! -e "$DIR/authorization.yaml" ]] || fail "J03: no ledger may be created"
printf 'a: [unterminated\n' > "$DIR/status.yaml"
rc=0; authz TASK-J03 grant --action live_load --scope s --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
assert_eq "3" "$rc" "J03: a syntactically corrupt status.yaml still exits 3"

# --- Minor 3: any ledger load exception fails closed ---
DIR="$(new_task TASK-J04)"
write_status "$DIR" TASK-J04 review "$BOUND_PASS"
printf '\xff\xfe' > "$DIR/authorization.yaml"
assert_eq "5" "$(sync_rc "$DIR" TASK-J04)" "J04: an invalid-UTF-8 ledger blocks a bound gate (sync rc 5)"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "J04: phase unchanged"
ruby - "$ROOT_DIR" "$DIR" <<'RUBY'
require File.join(ARGV[0], "scripts", "authorization-ledger")
begin
  AuthorizationLedger.load(ARGV[1])
  abort "[FAIL] J04: load must raise"
rescue AuthorizationLedger::Error
  nil
end
RUBY
echo "[ok] minors: timestamps, status shape, fail-closed load"

# ---------------------------------------------------------------------------
# PR #32 review fixes
# ---------------------------------------------------------------------------
BOUND_NA='completion_gates:
  production_backfill:
    status: na
    actor: reviewer
    reason: backfill was not performed
    updated_at: "2026-09-30T10:05:00Z"
    requires_authorization: production_backfill
    evidence_refs: []'

# --- Fix 1: a ledger that cannot be loaded leaves even a bound na unresolved ---
DIR="$(new_task TASK-F-001)"
write_status "$DIR" TASK-F-001 review "$BOUND_NA"
printf 'authorizations: [unterminated\n' > "$DIR/authorization.yaml"
assert_eq "5" "$(sync_rc "$DIR" TASK-F-001)" "F1: bound na + corrupt (garbage YAML) ledger is blocked (sync rc 5)"
assert_eq "review" "$(yaml_get "$DIR/status.yaml" phase)" "F1: phase unchanged"
cat > "$DIR/decision.yaml" <<'YAML'
task_id: TASK-F-001
decisions:
  - decision: approve
    actor: alice
    decided_at: "2026-09-30T11:00:00Z"
YAML
out="$(ruby "$RECONCILE" TASK-F-001 2>/dev/null)"
assert_eq "blocked:approve:production_backfill" "$out" "F1: reconcile holds the approve for a bound na with a corrupt ledger"

DIR="$(new_task TASK-F-002)"
write_status "$DIR" TASK-F-002 review "$BOUND_NA"
printf '\xff\xfe' > "$DIR/authorization.yaml"
assert_eq "5" "$(sync_rc "$DIR" TASK-F-002)" "F1: bound na + invalid-UTF-8 ledger is blocked (sync rc 5)"

DIR="$(new_task TASK-F-003)"
write_status "$DIR" TASK-F-003 review "$BOUND_NA"
assert_eq "0" "$(sync_rc "$DIR" TASK-F-003)" "F1: bound na + ABSENT ledger still reaches done"
assert_eq "done" "$(yaml_get "$DIR/status.yaml" phase)" "F1: absent ledger -> done"

# --- Fix 2: the runtime ledger contract matches the schema ---
ruby - "$ROOT_DIR" "$TMP_RUNS" <<'RUBY'
require "fileutils"
require File.join(ARGV[0], "scripts", "authorization-ledger")
L = AuthorizationLedger
def check(cond, msg)
  abort "[FAIL] load-contract: #{msg}" unless cond
end
def dir_with(base, name, body)
  d = File.join(base, name); FileUtils.mkdir_p(d)
  File.write(File.join(d, "authorization.yaml"), body) unless body.nil?
  d
end
raises = lambda do |d|
  begin
    L.load(d); false
  rescue L::Error
    true
  end
end
check L.load(dir_with(ARGV[1], "TASK-F-010", nil)).entries.empty?, "an absent file is an empty Index"
check L.load(dir_with(ARGV[1], "TASK-F-011", "task_id: TASK-F-011\nauthorizations: []\n")).entries.empty?, "matching task_id with empty list is fine"
check raises.(dir_with(ARGV[1], "TASK-F-012", "task_id: TASK-F-012\n")), "missing authorizations raises"
check raises.(dir_with(ARGV[1], "TASK-F-013", "authorizations: []\n")), "missing task_id raises"
check raises.(dir_with(ARGV[1], "TASK-F-014", "task_id: TASK-F-099\nauthorizations: []\n")), "a task_id naming another task raises"
check raises.(dir_with(ARGV[1], "TASK-F-015", "task_id: TASK-F-015\nauthorizations: nope\n")), "non-list authorizations raises"
check raises.(dir_with(ARGV[1], "TASK-F-016", "- a\n- b\n")), "a non-map root raises"
check raises.(dir_with(ARGV[1], "TASK-F-017", "")), "an empty file raises (not a map)"
RUBY

GOOD_G='  - {id: authz-001, type: grant, action: production_backfill, scope: "prod db", actor: alice, via: cli, reason: ok, at: "2026-09-30T10:00:00Z"}'
for variant in missing_authorizations missing_task_id foreign_task_id; do
  case "$variant" in
    missing_authorizations) id=TASK-F-021 ;;
    missing_task_id) id=TASK-F-022 ;;
    foreign_task_id) id=TASK-F-023 ;;
  esac
  DIR="$(new_task "$id")"
  write_status "$DIR" "$id" review "$BOUND_PASS"
  case "$variant" in
    missing_authorizations) printf 'task_id: %s\n' "$id" > "$DIR/authorization.yaml" ;;
    missing_task_id) printf 'authorizations:\n%s\n' "$GOOD_G" > "$DIR/authorization.yaml" ;;
    foreign_task_id) printf 'task_id: TASK-F-099\nauthorizations:\n%s\n' "$GOOD_G" > "$DIR/authorization.yaml" ;;
  esac
  rc=0; authz "$id" grant --action live_load --scope s --actor a --via cli --reason r >/dev/null 2>&1 || rc=$?
  assert_eq "3" "$rc" "F2 $variant: the writer exits 3"
  assert_eq "5" "$(sync_rc "$DIR" "$id")" "F2 $variant: the guard blocks a bound pass (sync rc 5)"
  rc=0; ruby "$VALIDATOR" "$DIR" >/dev/null 2>&1 || rc=$?
  assert_eq "1" "$rc" "F2 $variant: the validator rejects the task directory"
  rc=0; ruby "$VALIDATOR" "$DIR/authorization.yaml" >/dev/null 2>&1 || rc=$?
  assert_eq "1" "$rc" "F2 $variant: the validator rejects the ledger file"
done
DIR="$(new_task TASK-F-024)"
write_status "$DIR" TASK-F-024 review "$BOUND_PASS"
write_ledger "$DIR" "$GOOD_G"
assert_eq "0" "$(sync_rc "$DIR" TASK-F-024)" "F2: a matching ledger still resolves a bound pass"
rc=0; ruby "$VALIDATOR" "$DIR/authorization.yaml" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "F2: a matching ledger validates"

# --- Fix 3: single-file validation agrees with directory validation ---
DIR="$(new_task TASK-F-031)"
write_status "$DIR" TASK-F-031 review "$BOUND_PASS"      # dangling refs: no ledger at all
rc=0; err="$(ruby "$VALIDATOR" "$DIR/status.yaml" 2>&1 >/dev/null)" || rc=$?
assert_eq "1" "$rc" "F3: status.yaml by file is invalid for a forged bound pass"
[[ "$err" == *"is not an entry in authorization.yaml"* ]] || fail "F3: expected the dangling-ref message by file, got: $err"
rc=0; derr="$(ruby "$VALIDATOR" "$DIR" 2>&1 >/dev/null)" || rc=$?
assert_eq "1" "$rc" "F3: the same task by directory is invalid"
[[ "$derr" == *"is not an entry in authorization.yaml"* ]] || fail "F3: expected the same message by directory, got: $derr"
write_ledger "$DIR" "$GOOD_G"
rc=0; ruby "$VALIDATOR" "$DIR/status.yaml" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "F3: a genuine bound pass validates by file"
rc=0; ruby "$VALIDATOR" "$DIR" >/dev/null 2>&1 || rc=$?
assert_eq "0" "$rc" "F3: and by directory"

# status.yaml by file also runs the evidence-ref check (like the directory path).
DIR="$(new_task TASK-F-032)"
write_status "$DIR" TASK-F-032 review 'completion_gates:
  deployment:
    status: pass
    actor: dev
    reason: deployed
    updated_at: "2026-09-30T10:05:00Z"
    evidence_refs:
      - ev-missing'
rc=0; ferr="$(ruby "$VALIDATOR" "$DIR/status.yaml" 2>&1 >/dev/null)" || rc=$?
rc2=0; derr="$(ruby "$VALIDATOR" "$DIR" 2>&1 >/dev/null)" || rc2=$?
assert_eq "$rc2" "$rc" "F3: evidence-ref verdict by file equals the directory verdict"
assert_eq "$(printf '%s' "$derr" | grep -c 'ev-missing' || true)" "$(printf '%s' "$ferr" | grep -c 'ev-missing' || true)" "F3: evidence-ref message by file equals the directory message"

# authorization.yaml by file: its own branch, specific messages.
authz_file_err() {  # <task_id> <ledger body> — echoes the validator's stderr; fails the helper if it validated
  local d; d="$(new_task "$1")"
  printf '%s' "$2" > "$d/authorization.yaml"
  if ruby "$VALIDATOR" "$d/authorization.yaml" 2>&1 >/dev/null; then echo "VALIDATED-UNEXPECTEDLY"; fi
}
err="$(authz_file_err TASK-F-041 "$(printf 'task_id: TASK-F-041\nauthorizations:\n%s\n  - {id: authz-002, type: revoke, revokes: authz-003, actor: a, via: cli, reason: r, at: "2026-09-30T10:01:00Z"}\n  - {id: authz-003, type: grant, action: live_load, scope: s, actor: a, via: cli, reason: r, at: "2026-09-30T10:02:00Z"}\n' "$GOOD_G")" 2>&1)"
[[ "$err" == *"revokes authz-003 must reference an earlier entry"* ]] || fail "F3: forward revoke by file, got: $err"
err="$(authz_file_err TASK-F-042 "$(printf 'task_id: TASK-F-042\nauthorizations:\n%s\n%s\n' "$GOOD_G" "$GOOD_G")" 2>&1)"
[[ "$err" == *"duplicates authz-001"* ]] || fail "F3: duplicate ids by file, got: $err"
err="$(authz_file_err TASK-F-043 "$(printf 'task_id: TASK-F-043\n')" 2>&1)"
[[ "$err" == *"authorizations is required"* ]] || fail "F3: missing authorizations key by file, got: $err"
err="$(authz_file_err TASK-F-044 "$(printf 'authorizations:\n%s\n' "$GOOD_G")" 2>&1)"
[[ "$err" == *"task_id is required"* ]] || fail "F3: missing task_id by file, got: $err"
err="$(authz_file_err TASK-F-045 "$(printf 'task_id: TASK-F-098\nauthorizations:\n%s\n' "$GOOD_G")" 2>&1)"
[[ "$err" == *"does not match its directory"* ]] || fail "F3: task_id mismatch by file, got: $err"
err="$(authz_file_err TASK-F-046 'authorizations: [unterminated
' 2>&1)"
[[ "$err" == *"Validation failed"* && "$err" == *"authorization.yaml:"* ]] || fail "F3: corrupt ledger by file must be a validation error, got: $err"
[[ "$err" != *"output"* ]] || fail "F3: the ledger must not fall through to the output validator, got: $err"
echo "[ok] PR #32 review fixes"

# --- APPEND-NEW-SECTIONS-ABOVE ---
echo "PASS: authorization-ledger"
