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

# --- APPEND-NEW-SECTIONS-ABOVE ---
echo "PASS: authorization-ledger"
