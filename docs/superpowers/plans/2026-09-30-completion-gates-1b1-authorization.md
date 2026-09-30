# Authorization Ledger & Completion Binding (Phase 1B.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an append-only per-task authorization ledger and let a completion gate require an authorization, so a task cannot reach `done` on a missing, mismatched, expired or already-revoked grant — enforced by the completion guard itself, not only by the validator.

**Architecture:** A new runtime-independent library (`scripts/authorization-ledger.rb`) owns ledger semantics (numeric ids, integrity rules, validity as of a time `T` and an append-order snapshot `S`). A new governed writer (`scripts/record-authorization.rb`) appends grants/revokes. `CompletionGuard` stays a pure function but accepts the ledger index as input; a small wrapper loads the ledger only when a gate requires authorization, and all five guard callers switch to it. The 1A gate writer gains `--requires-authorization` / `--authorization`, reads the clock and the ledger high-water id exactly once under the task lock, and records `authorization_through`.

**Tech Stack:** Ruby (stdlib `yaml`, `date`, `time`), bash integration tests under `tests/integration/`, existing `validate-yaml.rb`, `schemas/*.schema.yaml`, `tests/integration/schema-validator-parity.sh`.

**Spec:** `docs/superpowers/specs/2026-09-30-completion-gates-1b1-authorization-design.md` (merged in PR #31, `d4181599`; read it — this plan implements it and argues from it). Builds on Phase 1A (PR #29).

## Global Constraints

Copied from the spec; every task inherits these.

- Slice name: **Authorization Ledger & Completion Binding** (Phase 1B.1). No action-time / dispatch-time enforcement. Do not claim privileged actions are blocked.
- New file `runs/<task>/authorization.yaml`, append-only. Entry fields: common `id`, `type`, `actor`, `via`, `reason`, `at`; grant-only `action`, `scope`, optional `expires_at`; revoke-only `revokes`.
- Actions are a closed enum matched **exactly** (no inheritance, no wildcard): `deploy_staging`, `deploy_production`, `production_data_mutation`, `production_backfill`, `live_load`, `external_side_effect`. The list lives in one Ruby constant, `AuthorizationLedger::ACTIONS`.
- `scope` is descriptive / audit-only; it is never compared.
- **All `authz-NNN` ordering and comparison is by numeric suffix**, never string order (`authz-999 < authz-1000`); uniqueness is by numeric value; only `AuthorizationLedger` compares ids.
- **Revocation is decided by append order, never by wall-clock.** A grant is valid as of `(T, S)` iff `id <= S`, `at <= T`, (`expires_at` absent or `T < expires_at`), and no revoke of it with `id <= S`. Timestamps are used only for a grant's start and expiry.
- The gate records `authorization_through` (the ledger high-water id `S` at pass time). `T`, `S`, the validity check, `gate.updated_at` and `gate.authorization_through` come from **one clock read and one ledger read under the per-task lock**.
- The guard evaluates as of the gate's recorded `(updated_at, authorization_through)`, never "now" and never the ledger's current tail. A later revoke (higher id) never reopens a resolved gate.
- `requires_authorization` is set only at `declare`, is immutable, and **must be preserved** on every `pass`/`na` (the 1A writer rebuilds the whole record; forgetting it silently downgrades the gate).
- `na` on a bound gate is not a waiver: it carries no `authorization_refs` and no `authorization_through`.
- A missing or corrupt ledger, or `authorizations: nil`, makes any bound gate unresolved (fail closed). Tasks and gates without `requires_authorization` behave exactly as in Phase 1A and **never read the ledger**.
- `record-authorization.rb` takes the per-task `.lock` and `TaskOwnership.fence!` (deliberately, unlike `record-evidence.sh`). `at` is written by the writer, never supplied by the caller. It never refuses an append because the clock stepped backwards.
- Scripts must not use Ruby endless-method definitions (the local Ruby does not support them) and must not use the macOS-absent `timeout` command.
- No new field may exist in only one of: `schemas/*.schema.yaml`, `validate-yaml.rb`, parity coverage, docs, the runtime writers.
- No DB, no migration (YAML contract only). Meta/tooling repo: no `TASK-` run required. No secrets in the repo. Do not push.
- Not in scope: dispatch-time enforcement, `preflight`/`decision.yaml`/`approve -> done` changes, identity verification, structured scope, single-use grants, dashboard UI, PM auto-declaration, Phase 1C/1D.

## Decisions this plan makes (the spec leaves them open)

1. **Test clock hook.** `AuthorizationLedger.now_utc` returns the current UTC time floored to whole seconds; if the environment variable `AI_OFFICE_NOW` is set it must be `YYYY-MM-DDTHH:MM:SSZ` and is returned instead. It is a test hook in the same spirit as `AI_OFFICE_RUNS_DIR`. Flooring makes the `T` used for the validity check exactly equal to the stored, second-resolution `gate.updated_at`.
2. **Ledger load contract.** `AuthorizationLedger.load(task_dir)` returns an empty `Index` when the file is absent, and raises `AuthorizationLedger::Error` when it is unreadable, not a map, or violates any integrity rule. Callers that must fail closed rescue it and treat the ledger as `nil`.
3. **Guard wrapper.** `CompletionGuard.can_transition_to_done_in(status, task_dir)` loads the ledger only if some gate carries the `requires_authorization` key. A gate that has the key with an unknown value is bound-and-unsatisfiable (fail closed).
4. **Validator plumbing.** `validate_status` gains an optional `task_dir:` keyword so the stored-state `done` check can use the wrapper; both existing call sites pass it.
5. **Unbound gates with stray fields.** A gate without `requires_authorization` that carries `authorization_refs` / `authorization_through` is a *validator* error and is refused by the writer; the guard ignores those fields (it stays Phase 1A for unbound gates).
6. **Exit codes for the two writers** follow the spec: `0` ok, `2` usage/invalid transition, `3` unreadable status/ledger or unknown state, `9` ownership fence refused.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/authorization-ledger.rb` | Create | Library `AuthorizationLedger`: constants, numeric id parser/comparator, timestamp helpers + clock hook, `validate_entries`, `load`, `Index` (`entry?`, `high_water_id`, `valid_grant?`). No CLI. |
| `scripts/record-authorization.rb` | Create | CLI writer: `grant` / `revoke`. Lock + fence, id allocation, atomic write, meta event. |
| `scripts/completion-guard.rb` | Modify (full replacement given) | `authorizations:` input, bound-gate rules, `can_transition_to_done_in`, message hint. |
| `scripts/update-completion-gate.rb` | Modify (full replacement given) | `--requires-authorization` (declare), `--authorization` (pass), `(T, S)` under the lock, preservation of `requires_authorization`. |
| `scripts/sync-status-from-output.rb`, `reconcile-decision.rb`, `force-status-route.rb`, `decide-next-step.rb` | Modify | Call `can_transition_to_done_in`. |
| `validate-yaml.rb` | Modify | Ledger validation, three new gate fields, stored-state `done` check via the wrapper, cross-file gate/ledger checks. |
| `schemas/authorization.schema.yaml` | Create | Documentation schema for the ledger. |
| `schemas/status.schema.yaml` | Modify | `requires_authorization`, `authorization_refs`, `authorization_through` on the gate record. |
| `tests/integration/schema-validator-parity.sh` | Modify | New parity rows. |
| `tests/integration/authorization-ledger.sh` | Create | The Phase 1B.1 suite (grows across tasks). |
| `docs/authorization-ledger.md` | Create | The contract and its limits. |
| `docs/completion-gates.md`, `docs/task-transition-contract.md` | Modify | Bound gates, wrapper, new fields. |

All paths are relative to the `ai-dev-office/` repo root. Run every command from the worktree root that contains this plan.

## Preflight (do once, before Task 1)

- [ ] **Step 1: Confirm the workspace and record the baseline**

```bash
pwd && git branch --show-current && git rev-parse --short HEAD && git status --short
for t in completion-gates schema-validator-parity decision-reconcile state-machine-consistency \
         concurrent-status-writes idempotency-and-reentry validation-failed-bounded \
         output-contract dependency-policy dependency-guard evidence-contract \
         auto-parallel task-ownership driver-decision-e2e; do
  if bash "tests/integration/$t.sh" >"/tmp/1b1-baseline-$t.log" 2>&1; then echo "PASS $t"; else echo "FAIL $t"; fi
done
```

Expected: a clean tree on the feature branch (the plan file itself may show as untracked or committed). All 14 suites PASS. If any already FAILs, note it — only new failures after your change count. (macOS has no `timeout`; do not use it.)

---

### Task 1: The `AuthorizationLedger` library

**Files:**
- Create: `scripts/authorization-ledger.rb`
- Create: `tests/integration/authorization-ledger.sh`

**Interfaces:**
- Produces (all later tasks rely on these exact names):
  - `AuthorizationLedger::Error < StandardError`
  - `AuthorizationLedger::FILENAME` → `"authorization.yaml"`
  - `AuthorizationLedger::ACTIONS` → the six actions, in the order listed in Global Constraints
  - `AuthorizationLedger::TYPES` → `%w[grant revoke]`
  - `AuthorizationLedger::ID_PATTERN` → `/\Aauthz-\d{3,}\z/`
  - `AuthorizationLedger::TIMESTAMP_PATTERN` → `/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z/`
  - `AuthorizationLedger::COMMON_REQUIRED_KEYS` → `%w[id type actor via reason at]`
  - `AuthorizationLedger.id_number(id)` → `Integer` or `nil`
  - `AuthorizationLedger.format_id(number)` → `"authz-%03d"` string
  - `AuthorizationLedger.parse_time(string)` → `Time` (UTC) or `nil`
  - `AuthorizationLedger.format_time(time)` → `"YYYY-MM-DDTHH:MM:SSZ"`
  - `AuthorizationLedger.now_utc` → `Time` floored to seconds, honoring `AI_OFFICE_NOW`; raises `Error` on a malformed override
  - `AuthorizationLedger.validate_entries(entries)` → `Array<String>` of error messages (empty when valid)
  - `AuthorizationLedger.load(task_dir)` → `Index` (empty when the file is absent); raises `Error` on unreadable/invalid
  - `AuthorizationLedger::Index.new(entries)` with `#entries`, `#entry?(id)`, `#high_water_id` (`String` or `nil`), `#valid_grant?(id, action:, at:, through:)` (`at` is a `Time` or a timestamp string; `through` is an id string)

- [ ] **Step 1: Write the failing test file**

Create `tests/integration/authorization-ledger.sh` with exactly this content. Later tasks append sections above the final `echo` line (marked `# --- APPEND-NEW-SECTIONS-ABOVE ---`).

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: FAIL with a Ruby `LoadError` — `cannot load such file … scripts/authorization-ledger`.

- [ ] **Step 3: Write the library**

Create `scripts/authorization-ledger.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Authorization ledger (issue #28, Phase 1B.1) — semantics for
# runs/<task>/authorization.yaml, an append-only record of grants and revokes.
#
# Two rules are load-bearing and are why this is a library and not inline code:
#
#  * Ids are compared by their NUMERIC suffix, never as strings
#    (authz-999 < authz-1000). Nothing outside this file compares id strings.
#  * Revocation is decided by APPEND ORDER, never by wall-clock. A grant is valid
#    as of (T, S) iff
#        id <= S  AND  at <= T  AND  (no expires_at OR T < expires_at)
#        AND no revoke of it with id <= S
#    where S is a snapshot boundary (an authorization id). Timestamps decide only
#    a grant's start and expiry. A later revoke has a higher id, so it can never
#    reopen a historical pass, even if a skewed clock gives it an earlier `at`.
#
# `scope` is descriptive / audit-only in this slice and is never compared.
#
# This file is a library: it has no CLI and is safe to `require`.

require "yaml"
require "date"
require "time"

module AuthorizationLedger
  class Error < StandardError; end

  FILENAME = "authorization.yaml"
  ACTIONS = %w[
    deploy_staging deploy_production production_data_mutation
    production_backfill live_load external_side_effect
  ].freeze
  TYPES = %w[grant revoke].freeze
  ID_PATTERN = /\Aauthz-\d{3,}\z/.freeze
  TIMESTAMP_PATTERN = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z/.freeze
  COMMON_REQUIRED_KEYS = %w[id type actor via reason at].freeze

  # An indexed, read-only view of a ledger's entries.
  class Index
    attr_reader :entries

    def initialize(entries)
      @entries = entries
      @by_number = {}
      @revokes_of = Hash.new { |hash, key| hash[key] = [] }
      entries.each do |entry|
        number = AuthorizationLedger.id_number(entry["id"])
        next if number.nil?

        @by_number[number] = entry
        next unless entry["type"] == "revoke"

        target = AuthorizationLedger.id_number(entry["revokes"])
        @revokes_of[target] << number unless target.nil?
      end
    end

    def entry?(id)
      number = AuthorizationLedger.id_number(id)
      !number.nil? && @by_number.key?(number)
    end

    # The highest id in the ledger as a canonical string, or nil when empty.
    def high_water_id
      return nil if @by_number.empty?

      AuthorizationLedger.format_id(@by_number.keys.max)
    end

    # Is the grant `id` valid for `action` as of time `at` and snapshot `through`?
    # See the header comment. `at` is a Time or a timestamp string.
    def valid_grant?(id, action:, at:, through:)
      number = AuthorizationLedger.id_number(id)
      snapshot = AuthorizationLedger.id_number(through)
      return false if number.nil? || snapshot.nil? || number > snapshot

      grant = @by_number[number]
      return false unless grant.is_a?(Hash) && grant["type"] == "grant" && grant["action"] == action

      moment = at.is_a?(Time) ? at : AuthorizationLedger.parse_time(at)
      started = AuthorizationLedger.parse_time(grant["at"])
      return false if moment.nil? || started.nil? || started > moment

      if grant.key?("expires_at")
        expires = AuthorizationLedger.parse_time(grant["expires_at"])
        return false if expires.nil? || moment >= expires
      end

      @revokes_of[number].none? { |revoke_number| revoke_number <= snapshot }
    end
  end

  module_function

  # The numeric part of an authz-NNN id, or nil when `id` is not one.
  def id_number(id)
    return nil unless id.is_a?(String) && id.match?(ID_PATTERN)

    Integer(id.delete_prefix("authz-"), 10)
  end

  # Canonical id for a number: three digits minimum, growing past 999.
  def format_id(number)
    format("authz-%03d", number)
  end

  def parse_time(value)
    return nil unless value.is_a?(String) && value.match?(TIMESTAMP_PATTERN)

    Time.iso8601(value).utc
  rescue ArgumentError
    nil
  end

  def format_time(time)
    time.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
  end

  # The current UTC time floored to whole seconds, so the value used for a
  # validity check is exactly the value stored at second resolution. The
  # AI_OFFICE_NOW override is a test hook (like AI_OFFICE_RUNS_DIR).
  def now_utc
    override = ENV["AI_OFFICE_NOW"].to_s
    return Time.at(Time.now.to_i).utc if override.empty?

    parsed = parse_time(override)
    raise Error, "AI_OFFICE_NOW must be YYYY-MM-DDTHH:MM:SSZ, got #{override.inspect}" if parsed.nil?

    parsed
  end

  # Returns an Array of human-readable error strings; empty when the entries
  # satisfy every integrity rule (see docs/authorization-ledger.md).
  def validate_entries(entries)
    return ["authorizations must be a list"] unless entries.is_a?(Array)

    errors = []
    seen = {}
    last_number = 0
    grants = {}
    revoked = {}

    entries.each_with_index do |entry, index|
      label = "authorizations[#{index}]"
      unless entry.is_a?(Hash)
        errors << "#{label} must be a map"
        next
      end

      number = id_number(entry["id"])
      if number.nil?
        errors << "#{label}.id must match #{ID_PATTERN.inspect}"
      else
        if seen.key?(number)
          errors << "#{label}.id #{entry['id']} duplicates #{entries[seen[number]]['id']} (ids are unique by numeric value)"
        elsif number <= last_number
          errors << "#{label}.id #{entry['id']} must be greater than the previous id (ids increase in file order)"
        end
        seen[number] ||= index
        last_number = number if number > last_number
      end

      %w[actor via reason].each do |key|
        errors << "#{label}.#{key} must be a non-empty string" unless entry[key].is_a?(String) && !entry[key].strip.empty?
      end
      unless parse_time(entry["at"])
        errors << "#{label}.at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
      end

      type = entry["type"]
      unless TYPES.include?(type)
        errors << "#{label}.type must be one of #{TYPES.join(', ')}"
        next
      end

      if type == "grant"
        errors << "#{label}.action must be one of #{ACTIONS.join(', ')}" unless ACTIONS.include?(entry["action"])
        errors << "#{label}.scope must be a non-empty string" unless entry["scope"].is_a?(String) && !entry["scope"].strip.empty?
        errors << "#{label}.revokes is only valid on a revoke" if entry.key?("revokes")
        if entry.key?("expires_at")
          expires = parse_time(entry["expires_at"])
          started = parse_time(entry["at"])
          if expires.nil?
            errors << "#{label}.expires_at must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
          elsif started && expires <= started
            errors << "#{label}.expires_at must be strictly after at"
          end
        end
        grants[number] = entry unless number.nil?
      else
        %w[action scope expires_at].each do |key|
          errors << "#{label}.#{key} is only valid on a grant" if entry.key?(key)
        end
        target = id_number(entry["revokes"])
        if target.nil?
          errors << "#{label}.revokes must be an authz-NNN id"
        elsif !number.nil? && target >= number
          errors << "#{label}.revokes #{entry['revokes']} must reference an earlier entry"
        elsif !grants.key?(target)
          errors << "#{label}.revokes #{entry['revokes']} must reference an earlier grant"
        elsif revoked.key?(target)
          errors << "#{label}.revokes #{entry['revokes']} is already revoked by #{format_id(revoked[target])}"
        elsif !number.nil?
          revoked[target] = number
        end
      end
    end
    errors
  end

  # Loads runs/<task>/authorization.yaml. An absent file is an empty ledger.
  # Anything unreadable, not a map, or violating an integrity rule raises Error:
  # callers that must fail closed rescue it and treat the ledger as unavailable.
  def load(task_dir)
    path = File.join(task_dir, FILENAME)
    return Index.new([]) unless File.exist?(path)

    doc = begin
      YAML.safe_load(File.read(path), permitted_classes: [], aliases: false)
    rescue Psych::Exception, SystemCallError => e
      raise Error, "#{path}: #{e.message}"
    end
    raise Error, "#{path}: must be a map with an authorizations list" unless doc.is_a?(Hash)

    entries = doc.key?("authorizations") ? doc["authorizations"] : []
    errors = validate_entries(entries)
    raise Error, "#{path}: #{errors.join('; ')}" unless errors.empty?

    Index.new(entries)
  end
end
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: `[ok] authorization-ledger unit checks` then `PASS: authorization-ledger`. If a `check` fails, fix the library (not the assertion) unless the assertion contradicts the spec's `(T, S)` rule.

- [ ] **Step 5: Commit**

```bash
git add scripts/authorization-ledger.rb tests/integration/authorization-ledger.sh
git commit -m "feat(authorization): add the authorization ledger library (#28 Phase 1B.1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `record-authorization.rb` writer

**Files:**
- Create: `scripts/record-authorization.rb`
- Modify: `tests/integration/authorization-ledger.sh`

**Interfaces:**
- Consumes: `AuthorizationLedger` (Task 1), `CompletionGuard.event_agent` and `.append_meta_event!` (existing), `TaskOwnership.fence!` (existing).
- Produces the CLI:

```
ruby scripts/record-authorization.rb <TASK_ID> grant  --action A --scope S --actor X --via V --reason R [--expires-at TS]
ruby scripts/record-authorization.rb <TASK_ID> revoke <authz-NNN> --actor X --via V --reason R
```

  Prints `authz-NNN grant` or `authz-NNN revoke`. Exit `0` ok; `2` usage / invalid append; `3` unreadable status or ledger; `9` ownership fence refused. Records an `authorization_recorded` event in `meta.yaml`.

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
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
```

> The fence test copies the invocation used by `tests/integration/task-ownership.sh` (`AI_DEV_OFFICE_HOME`, `acquire <dir> <task> agent=… worktree=…`). If `acquire` needs different arguments in this repo, read the first 90 lines of that suite and mirror them exactly — the assertion (exit `9`, no ledger created) must stay.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: FAIL — `record-authorization.rb` does not exist (`ruby: No such file or directory` from the first `authz` call).

- [ ] **Step 3: Write the writer**

Create `scripts/record-authorization.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# The governed writer for the authorization ledger (issue #28, Phase 1B.1):
# runs/<task>/authorization.yaml, append-only.
#
#   ruby scripts/record-authorization.rb <TASK_ID> grant  --action A --scope S --actor X --via V --reason R [--expires-at TS]
#   ruby scripts/record-authorization.rb <TASK_ID> revoke <authz-NNN> --actor X --via V --reason R
#
# Takes the per-task .lock and allocates the next id under it (the same
# `max + 1` pattern as record-evidence.sh). UNLIKE record-evidence.sh it also
# calls TaskOwnership.fence!: a stale, superseded owner must not be able to
# append an authorization. `at` is written by this script, never supplied.
# The script never refuses an append because the local clock stepped backwards:
# revocation is decided by append order (see scripts/authorization-ledger.rb).
#
# `actor` / `via` are unverified free text (Phase 1A limits carry over): an agent
# can technically record a grant for itself. The ledger makes that auditable,
# not impossible. This records authorization; it does not enforce it at action
# time.
#
# Exit: 0 ok; 2 usage error or invalid append; 3 unreadable status.yaml or
# ledger; 9 ownership fence refused (raised by TaskOwnership.fence!).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "authorization-ledger"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
FINISHED_PHASES = %w[done aborted].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: record-authorization.rb <TASK_ID> grant --action A --scope S --actor X --via V --reason R [--expires-at TS]"
  warn "       record-authorization.rb <TASK_ID> revoke <authz-NNN> --actor X --via V --reason R"
  exit 2
end

args = ARGV.dup
task_id = args.shift
type = args.shift
usage! if task_id.nil? || type.nil?
usage!("unknown subcommand '#{type}' (expected grant or revoke)") unless AuthorizationLedger::TYPES.include?(type)

target_id = nil
if type == "revoke"
  target_id = args.shift
  usage!("revoke needs the authz-NNN id to revoke") if target_id.nil? || target_id.start_with?("--")
  usage!("'#{target_id}' is not an authz-NNN id") if AuthorizationLedger.id_number(target_id).nil?
end

opts = {}
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--action" then opts[:action] = value.strip
  when "--scope" then opts[:scope] = value.strip
  when "--actor" then opts[:actor] = value.strip
  when "--via" then opts[:via] = value.strip
  when "--reason" then opts[:reason] = value.strip
  when "--expires-at" then opts[:expires_at] = value.strip
  else usage!("unknown flag #{flag}")
  end
end

%i[actor via reason].each do |key|
  usage!("--#{key} is required") if opts[key].to_s.empty?
end
if type == "grant"
  usage!("--action is required for grant") if opts[:action].to_s.empty?
  usage!("--action must be one of #{AuthorizationLedger::ACTIONS.join(', ')}") unless AuthorizationLedger::ACTIONS.include?(opts[:action])
  usage!("--scope is required for grant") if opts[:scope].to_s.empty?
  if opts.key?(:expires_at) && AuthorizationLedger.parse_time(opts[:expires_at]).nil?
    usage!("--expires-at must be YYYY-MM-DDTHH:MM:SSZ")
  end
else
  %i[action scope expires_at].each { |key| usage!("--#{key.to_s.tr('_', '-')} is only valid with grant") if opts.key?(key) }
end

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
unless File.exist?(status_path)
  warn "No status.yaml for #{task_id} at #{status_path}"
  exit 3
end

# Same critical section as every other governed writer: per-task lock, then the
# ownership fence inside it.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  exit 3
end
phase = status["phase"].to_s.strip
if type == "grant" && FINISHED_PHASES.include?(phase)
  warn "Refusing to record a grant: #{task_id} is #{phase}."
  exit 2
end

ledger_path = File.join(task_dir, AuthorizationLedger::FILENAME)
begin
  AuthorizationLedger.load(task_dir) # unreadable or integrity-violating ledgers stop here
rescue AuthorizationLedger::Error => e
  warn e.message
  exit 3
end
doc = File.exist?(ledger_path) ? YAML.safe_load(File.read(ledger_path), permitted_classes: [], aliases: false) : {}
doc["task_id"] ||= task_id
doc["authorizations"] = [] unless doc["authorizations"].is_a?(Array)
entries = doc["authorizations"]

used = entries.map { |entry| AuthorizationLedger.id_number(entry["id"]) }.compact
next_id = AuthorizationLedger.format_id(used.max.to_i + 1)
now = begin
  AuthorizationLedger.now_utc
rescue AuthorizationLedger::Error => e
  usage!(e.message)
end
at = AuthorizationLedger.format_time(now)

entry = {
  "id" => next_id,
  "type" => type,
  "actor" => opts[:actor],
  "via" => opts[:via],
  "reason" => opts[:reason],
  "at" => at
}
if type == "grant"
  entry["action"] = opts[:action]
  entry["scope"] = opts[:scope]
  entry["expires_at"] = opts[:expires_at] if opts.key?(:expires_at)
else
  entry["revokes"] = AuthorizationLedger.format_id(AuthorizationLedger.id_number(target_id))
end

# Belt and braces: every integrity rule is re-checked on the would-be ledger.
errors = AuthorizationLedger.validate_entries(entries + [entry])
unless errors.empty?
  usage!("refused: #{errors.join('; ')}")
end

doc["authorizations"] = entries + [entry]
tmp_path = "#{ledger_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(doc))
  File.rename(tmp_path, ledger_path)
rescue StandardError => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

CompletionGuard.append_meta_event!(
  task_dir,
  type: "authorization_recorded",
  agent: CompletionGuard.event_agent(opts[:actor]),
  details: "#{next_id} #{type}#{type == 'grant' ? " action=#{opts[:action]}" : " revokes=#{entry['revokes']}"} actor=#{opts[:actor]}"
)

puts "#{next_id} #{type}"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: `[ok] authorization-ledger unit checks`, `[ok] record-authorization writer`, `PASS: authorization-ledger`.

- [ ] **Step 5: Commit**

```bash
git add scripts/record-authorization.rb tests/integration/authorization-ledger.sh
git commit -m "feat(authorization): add the record-authorization writer (#28 Phase 1B.1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The guard validates authorization truth; callers use the wrapper

**Files:**
- Modify (full replacement): `scripts/completion-guard.rb`
- Modify: `scripts/sync-status-from-output.rb`, `scripts/reconcile-decision.rb`, `scripts/force-status-route.rb`, `scripts/decide-next-step.rb`
- Modify: `tests/integration/authorization-ledger.sh`

**Interfaces:**
- Consumes: `AuthorizationLedger` (Task 1).
- Produces:
  - `CompletionGuard.can_transition_to_done(status, authorizations: nil)` → `Verdict` (existing struct). `authorizations` is an `AuthorizationLedger::Index` or `nil`. Behavior for gates without `requires_authorization` is unchanged.
  - `CompletionGuard.can_transition_to_done_in(status, task_dir)` → `Verdict`; loads the ledger only when some gate has the `requires_authorization` key; a load error is reported on stderr and treated as `authorizations: nil`.
  - Bound-gate rule (for a gate that has the key `requires_authorization`): the Phase 1A metadata rules AND the value is in `AuthorizationLedger::ACTIONS` AND — `na`: carries neither `authorization_refs` nor `authorization_through`; `pass`: `authorizations` is not nil, `authorization_refs` is a non-empty Array of Strings, `authorization_through` is an id present in the ledger, `updated_at` parses as a UTC timestamp, and every ref has a number `<=` the through number and satisfies `index.valid_grant?(ref, action: requires_authorization, at: updated_at, through: authorization_through)`.

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
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
check G.can_transition_to_done(status.(na_ok), authorizations: nil).allowed, "na does not even need the ledger"
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: FAIL at the pure guard block — `ArgumentError: unknown keyword: :authorizations` (the current `can_transition_to_done` takes only `status`).

- [ ] **Step 3: Replace `scripts/completion-guard.rb`**

Overwrite the file with exactly this content (it keeps every Phase 1A behavior and constant, adds the bound-gate rules and the wrapper):

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Completion gates (issue #28, Phase 1A + 1B.1) — the one place that answers
# "may this task transition to `done` now?".
#
# A task opts in by declaring `completion_gates` in status.yaml. A gate that is
# present is REQUIRED (there is no `required:` flag). A gate is resolved only
# when its status is `pass` or `na` (with actor, reason and updated_at);
# `pending` — and anything the guard cannot read — blocks `done`. Tasks with no
# `completion_gates` key are unaffected.
#
# Phase 1B.1: a gate that carries the key `requires_authorization` is BOUND to
# an authorization. Such a gate is resolved only when
#   * `pass`: it cites `authorization_refs` that are grants in the task's
#     authorization ledger, matching the required action EXACTLY, and valid as
#     of the gate's own recorded (updated_at, authorization_through) — never
#     "now" and never the ledger's current tail (see
#     scripts/authorization-ledger.rb); or
#   * `na`: it carries no authorization refs (`na` is not a waiver).
# A missing or corrupt ledger makes a bound gate unresolved (fail closed).
# Unbound gates never read the ledger.
#
# Every writer that can produce `done` calls can_transition_to_done_in, and the
# stored-state validator calls it too (defense in depth). Do not copy this
# logic into a writer.
#
# This file is a library: it has no CLI and is safe to `require`.

require "yaml"
require "date"
require "time"
require_relative "authorization-ledger"

module CompletionGuard
  GATE_STATUSES = %w[pending pass na].freeze
  GATE_NAME_PATTERN = /\A[a-z][a-z0-9_]*\z/.freeze
  RESOLVED_STATUSES = %w[pass na].freeze
  # A pass/na gate must carry these (non-empty strings) to count as resolved.
  # validate-yaml.rb reads the same constant; schemas/status.schema.yaml pins it.
  RESOLUTION_METADATA_KEYS = %w[actor reason updated_at].freeze
  # Exit code a status writer uses when the guard refuses `done`. Distinct from
  # 3 (malformed output -> validation_failed) on purpose: a legitimate wait for
  # runtime acceptance is not a validation defect.
  COMPLETION_BLOCKED = 5
  # Mirrors validate-yaml.rb STATUS_ACTORS (meta.yaml event `agent` enum).
  STATUS_ACTORS = %w[pm dev dev-2 reviewer debugger devops free-roam done orchestrator].freeze

  Verdict = Struct.new(:allowed, :unresolved)

  module_function

  # status is the parsed status.yaml Hash; `authorizations` is an
  # AuthorizationLedger::Index or nil. Returns a Verdict; `unresolved` is a
  # sorted Array of gate names (or ["completion_gates"] when the key itself is
  # malformed — fail closed). With no bound gate, `authorizations` is ignored.
  def can_transition_to_done(status, authorizations: nil)
    return Verdict.new(true, []) unless status.is_a?(Hash) && status.key?("completion_gates")

    gates = status["completion_gates"]
    return Verdict.new(false, ["completion_gates"]) unless gates.is_a?(Hash)

    unresolved = gates.reject { |_name, gate| gate_resolved?(gate, authorizations) }.keys.map(&:to_s).sort
    Verdict.new(unresolved.empty?, unresolved)
  end

  # The wrapper every writer and the validator use: loads the task's ledger only
  # when some gate is bound to an authorization, so tasks that do not use the
  # feature never read authorization.yaml. A load failure is reported on stderr
  # and treated as "no ledger" (bound gates then fail closed).
  def can_transition_to_done_in(status, task_dir)
    index = nil
    if ledger_needed?(status)
      begin
        index = AuthorizationLedger.load(task_dir)
      rescue AuthorizationLedger::Error => e
        warn "completion-guard: #{e.message}"
      end
    end
    can_transition_to_done(status, authorizations: index)
  end

  def ledger_needed?(status)
    return false unless status.is_a?(Hash) && status["completion_gates"].is_a?(Hash)

    status["completion_gates"].values.any? { |gate| gate.is_a?(Hash) && gate.key?("requires_authorization") }
  end

  # Phase 1A metadata rules only (status pass/na with non-empty actor, reason,
  # updated_at). Bound gates additionally need authorization_satisfied?.
  def resolved?(gate)
    return false unless gate.is_a?(Hash) && RESOLVED_STATUSES.include?(gate["status"].to_s)

    RESOLUTION_METADATA_KEYS.all? { |key| gate[key].is_a?(String) && !gate[key].strip.empty? }
  end

  def gate_resolved?(gate, authorizations)
    return false unless resolved?(gate)
    return true unless gate.key?("requires_authorization")

    authorization_satisfied?(gate, authorizations)
  end

  # A bound gate. Every comparison of authz ids is numeric (AuthorizationLedger).
  def authorization_satisfied?(gate, index)
    required = gate["requires_authorization"]
    return false unless AuthorizationLedger::ACTIONS.include?(required)

    if gate["status"] == "na"
      return !gate.key?("authorization_refs") && !gate.key?("authorization_through")
    end

    return false if index.nil?

    refs = gate["authorization_refs"]
    return false unless refs.is_a?(Array) && !refs.empty? && refs.all? { |ref| ref.is_a?(String) }

    through = gate["authorization_through"]
    through_number = AuthorizationLedger.id_number(through)
    return false if through_number.nil? || !index.entry?(through)

    at = AuthorizationLedger.parse_time(gate["updated_at"])
    return false if at.nil?

    refs.all? do |ref|
      ref_number = AuthorizationLedger.id_number(ref)
      !ref_number.nil? && ref_number <= through_number &&
        index.valid_grant?(ref, action: required, at: at, through: through)
    end
  end

  def blocked_message(unresolved)
    "Completion blocked: unresolved completion gate(s): #{unresolved.join(', ')}. " \
      "Resolve each with scripts/update-completion-gate.rb (pass|na) before the task can be marked done. " \
      "A pass/na gate must also carry actor, reason and updated_at. " \
      "A gate bound to an authorization also needs authorization_refs to valid grants in authorization.yaml."
  end

  # meta.yaml event `agent` must be a STATUS_ACTORS value. `actor` on a gate is
  # free text (Phase 1A does not verify identity), so anything else is recorded
  # as `orchestrator` on the event and kept verbatim in `details`.
  def event_agent(actor)
    STATUS_ACTORS.include?(actor.to_s) ? actor.to_s : "orchestrator"
  end

  # Appends one event to runs/<task>/meta.yaml. The CALLER MUST ALREADY HOLD the
  # task `.lock` — status writers do; this method deliberately does not lock
  # (a second flock on the same file from the same process would deadlock).
  # Observability must never turn a refusal into a crash, so I/O and YAML
  # problems are reported on stderr and swallowed.
  def append_meta_event!(task_dir, type:, agent:, details:, dedupe: false)
    meta_path = File.join(task_dir, "meta.yaml")
    meta = if File.exist?(meta_path)
             YAML.safe_load(File.read(meta_path), permitted_classes: [Date, Time], aliases: true) || {}
           else
             {}
           end
    meta["task_id"] ||= File.basename(task_dir)
    meta["events"] = [] unless meta["events"].is_a?(Array)

    if dedupe
      last = meta["events"].last
      return false if last.is_a?(Hash) && last["type"] == type && last["agent"] == agent && last["details"] == details
    end

    timestamp = Time.now.utc.strftime("%FT%TZ")
    event = { "type" => type, "agent" => agent, "details" => details, "timestamp" => timestamp }
    run_id = ENV["AI_DEV_OFFICE_RUN_ID"].to_s
    event["run_id"] = run_id unless run_id.empty?
    meta["events"] << event
    meta["updated_at"] = timestamp

    tmp_path = "#{meta_path}.tmp.#{$$}"
    begin
      File.write(tmp_path, YAML.dump(meta))
      File.rename(tmp_path, meta_path)
    rescue StandardError
      File.delete(tmp_path) if File.exist?(tmp_path)
      raise
    end
    true
  rescue StandardError => e
    warn "completion-guard: could not record #{type} event in #{meta_path}: #{e.message}"
    false
  end

  # The event written whenever the guard refuses a transition to done.
  def record_blocked!(task_dir, attempted:, actor:, unresolved:)
    append_meta_event!(
      task_dir,
      type: "completion_blocked",
      agent: event_agent(actor),
      details: "attempted=#{attempted} unresolved=#{unresolved.join(',')}",
      dedupe: true
    )
  end
end
```

- [ ] **Step 4: Switch the four script callers to the wrapper**

In each file replace the one call shown, using the directory that holds that task's `status.yaml`:

`scripts/sync-status-from-output.rb` (line ~184):

```ruby
  verdict = CompletionGuard.can_transition_to_done_in(status, File.dirname(status_path))
```

`scripts/force-status-route.rb` (line ~57):

```ruby
  verdict = CompletionGuard.can_transition_to_done_in(status, File.dirname(status_path))
```

`scripts/reconcile-decision.rb` (line ~106; `task_dir` is already defined earlier in the file):

```ruby
  verdict = CompletionGuard.can_transition_to_done_in(status, task_dir)
```

`scripts/decide-next-step.rb` (line ~78, inside the `begin` block):

```ruby
    verdict = CompletionGuard.can_transition_to_done_in(status, File.dirname(status_path))
```

The stored-state validator is switched in Task 5.

- [ ] **Step 5: Run the new and the existing gate suites**

```bash
bash tests/integration/authorization-ledger.sh
bash tests/integration/completion-gates.sh
```

Expected: `[ok] guard authorization rules (pure)`, `[ok] guard blocks forged/missing/corrupt authorization state through every writer`, `PASS: authorization-ledger`, and the whole Phase 1A suite still `PASS: completion-gates`.

- [ ] **Step 6: Commit**

```bash
git add scripts/completion-guard.rb scripts/sync-status-from-output.rb scripts/reconcile-decision.rb scripts/force-status-route.rb scripts/decide-next-step.rb tests/integration/authorization-ledger.sh
git commit -m "feat(authorization): guard validates authorization truth via a ledger-aware wrapper (#28 Phase 1B.1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The gate writer — `--requires-authorization`, `--authorization`, `(T, S)`, preservation

**Files:**
- Modify (full replacement): `scripts/update-completion-gate.rb`
- Modify: `tests/integration/authorization-ledger.sh`

**Interfaces:**
- Consumes: `AuthorizationLedger` (Task 1), `CompletionGuard.event_agent` / `.append_meta_event!` (existing).
- Produces the extended CLI:

```
ruby scripts/update-completion-gate.rb <TASK> declare <GATE> --actor A [--reason R] [--requires-authorization <action>]
ruby scripts/update-completion-gate.rb <TASK> pass    <GATE> --actor A --reason R [--evidence ev-001,…] [--authorization authz-NNN[,authz-NNN…]]
ruby scripts/update-completion-gate.rb <TASK> na      <GATE> --actor A --reason R
```

  A bound gate's stored record gains `requires_authorization` (from declare; immutable; preserved on every transition) and, after a bound `pass`, `authorization_refs` and `authorization_through`. `updated_at` and `authorization_through` come from one clock read and one ledger read under the lock. Exit codes as before (`0/2/3/9`).

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
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
rc=0; gate TASK-C02 declare g --actor pm >/dev/null 2>&1 && gate TASK-C02 pass g --actor a --reason r --requires-authorization deploy_production >/dev/null 2>&1 || rc=$?
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: FAIL at the first `--requires-authorization` call — `unknown flag --requires-authorization` (exit 2 where the test expects `declare` to succeed).

- [ ] **Step 3: Replace `scripts/update-completion-gate.rb`**

Overwrite the file with exactly this content (it keeps every Phase 1A behavior, adds the two flags, the `(T, S)` capture, and the preservation of `requires_authorization`):

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# The one governed writer for completion gates (issue #28, Phase 1A + 1B.1).
#
# Agents and operators must not hand-edit `completion_gates` in status.yaml:
# every declaration and every resolution goes through here so it is locked,
# ownership-fenced, validated, and recorded in status history AND meta.yaml.
# This is not a general authority system. `actor` is free text; identity and
# independence are not verified (see docs/completion-gates.md).
#
# Phase 1B.1: a gate may be BOUND to an authorization at declare time
# (`--requires-authorization <action>`). The requirement is immutable and is
# carried forward on every transition — this script rebuilds the whole gate
# record each time, so forgetting it would silently downgrade the gate to
# Phase 1A semantics. Passing a bound gate needs `--authorization authz-NNN,…`:
# each must be a grant of this task, for exactly the required action, valid as
# of (T, S) where T is the pass time and S the ledger's high-water id. T and S
# are read ONCE under the task lock and are the values stored as `updated_at`
# and `authorization_through`, so the writer's decision and the guard's later
# re-evaluation always agree (see scripts/authorization-ledger.rb).
#
# Usage:
#   ruby scripts/update-completion-gate.rb <TASK_ID> declare <GATE> --actor <A> [--reason <R>] [--requires-authorization <action>]
#   ruby scripts/update-completion-gate.rb <TASK_ID> pass    <GATE> --actor <A> --reason <R> [--evidence ev-001,ev-002] [--authorization authz-001,authz-002]
#   ruby scripts/update-completion-gate.rb <TASK_ID> na      <GATE> --actor <A> --reason <R>
#
# Exit: 0 ok; 2 usage error or invalid transition; 3 unreadable or missing
# status.yaml / authorization ledger, non-map completion_gates, unknown
# evidence id; 9 ownership fence refused (raised by TaskOwnership.fence!, see
# docs/task-ownership.md).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "authorization-ledger"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
EVIDENCE_ID_PATTERN = /\Aev-\d{3,}\z/.freeze
TRANSITIONS = { "declare" => "pending", "pass" => "pass", "na" => "na" }.freeze
FINISHED_PHASES = %w[done aborted].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: update-completion-gate.rb <TASK_ID> <declare|pass|na> <GATE> --actor <A> [--reason <R>] " \
       "[--evidence ev-001,ev-002] [--requires-authorization <action>] [--authorization authz-001,authz-002]"
  exit 2
end

args = ARGV.dup
task_id = args.shift
action = args.shift
gate_name = args.shift
usage! if task_id.nil? || action.nil? || gate_name.nil?
usage!("unknown action '#{action}' (expected declare, pass or na)") unless TRANSITIONS.key?(action)
usage!("gate name '#{gate_name}' must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}") unless gate_name.match?(CompletionGuard::GATE_NAME_PATTERN)

opts = {}
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--actor" then opts[:actor] = value.strip
  when "--reason" then opts[:reason] = value.strip
  when "--evidence" then opts[:evidence] = value.split(",").map(&:strip).reject(&:empty?)
  when "--requires-authorization" then opts[:requires_authorization] = value.strip
  when "--authorization" then opts[:authorization] = value.split(",").map(&:strip).reject(&:empty?).uniq
  else usage!("unknown flag #{flag}")
  end
end

usage!("--actor is required") if opts[:actor].to_s.empty?
usage!("--reason is required for #{action}") if %w[pass na].include?(action) && opts[:reason].to_s.empty?
usage!("--evidence is only valid with pass") if opts.key?(:evidence) && action != "pass"
Array(opts[:evidence]).each do |ref|
  usage!("evidence id '#{ref}' must match ev-NNN") unless ref.match?(EVIDENCE_ID_PATTERN)
end
usage!("--requires-authorization is only valid with declare") if opts.key?(:requires_authorization) && action != "declare"
if opts.key?(:requires_authorization) && !AuthorizationLedger::ACTIONS.include?(opts[:requires_authorization])
  usage!("--requires-authorization must be one of #{AuthorizationLedger::ACTIONS.join(', ')}")
end
usage!("--authorization is only valid with pass") if opts.key?(:authorization) && action != "pass"
Array(opts[:authorization]).each do |ref|
  usage!("authorization id '#{ref}' must match authz-NNN") if AuthorizationLedger.id_number(ref).nil?
end

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
unless File.exist?(status_path)
  warn "No status.yaml for #{task_id} at #{status_path}"
  exit 3
end

# Same critical section as every other status writer: per-task lock, then the
# ownership fence inside it.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

# ONE clock read for the whole critical section. T is used for the validity
# check AND stored as updated_at / the history timestamp: never read the clock
# twice (an expiry boundary could make the two disagree).
pass_time = begin
  AuthorizationLedger.now_utc
rescue AuthorizationLedger::Error => e
  usage!(e.message)
end
now = AuthorizationLedger.format_time(pass_time)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  exit 3
end

phase = status["phase"].to_s.strip
if FINISHED_PHASES.include?(phase)
  warn "Refusing to edit completion gates: #{task_id} is #{phase}."
  exit 2
end

if status.key?("completion_gates") && !status["completion_gates"].is_a?(Hash)
  warn "status.yaml completion_gates is not a map; fix it by hand before using this helper."
  exit 3
end
gates = (status["completion_gates"] ||= {})
existing = gates[gate_name]
new_status = TRANSITIONS.fetch(action)

if action == "declare"
  usage!("gate '#{gate_name}' is already declared; resolve it with pass or na") unless existing.nil?
else
  usage!("gate '#{gate_name}' is not declared for #{task_id}; declare it first") unless existing.is_a?(Hash)
end

# The requirement declared with the gate. Immutable: taken from the declare
# flag, or carried forward from the existing record on every later transition.
bound_action = action == "declare" ? opts[:requires_authorization] : (existing.is_a?(Hash) ? existing["requires_authorization"] : nil)
if action != "declare" && existing.is_a?(Hash) && existing.key?("requires_authorization") &&
   !AuthorizationLedger::ACTIONS.include?(bound_action)
  warn "gate '#{gate_name}' has an unknown requires_authorization #{bound_action.inspect}; fix it by hand before using this helper."
  exit 3
end

authorization_refs = nil
authorization_through = nil
if action == "pass"
  if bound_action
    usage!("gate '#{gate_name}' requires authorization '#{bound_action}': pass it with --authorization authz-NNN[,…]") if Array(opts[:authorization]).empty?
    index = begin
      AuthorizationLedger.load(task_dir)
    rescue AuthorizationLedger::Error => e
      warn e.message
      exit 3
    end
    authorization_through = index.high_water_id # S: read once, under the lock
    usage!("no authorization is recorded for #{task_id}; record a grant with scripts/record-authorization.rb first") if authorization_through.nil?
    invalid = opts[:authorization].reject do |ref|
      index.valid_grant?(ref, action: bound_action, at: pass_time, through: authorization_through)
    end
    unless invalid.empty?
      usage!("not a valid '#{bound_action}' grant as of #{now} (unknown id, wrong action, expired, revoked, or not yet granted): #{invalid.join(', ')}")
    end
    authorization_refs = opts[:authorization]
  elsif opts.key?(:authorization)
    usage!("gate '#{gate_name}' does not declare requires_authorization; --authorization is not valid for it")
  end
end

if action == "pass" && !Array(opts[:evidence]).empty?
  ledger_path = File.join(task_dir, "evidence.yaml")
  known = if File.exist?(ledger_path)
            ledger = YAML.safe_load(File.read(ledger_path), permitted_classes: [Date, Time], aliases: true)
            Array(ledger.is_a?(Hash) ? ledger["evidence"] : nil).map { |e| e["id"] if e.is_a?(Hash) }.compact
          else
            []
          end
  unknown = opts[:evidence] - known
  unless unknown.empty?
    warn "Unknown evidence id(s) for #{task_id}: #{unknown.join(', ')} (not in evidence.yaml)"
    exit 3
  end
end

old_status = existing.is_a?(Hash) ? existing["status"].to_s : "absent"

record = { "status" => new_status, "actor" => opts[:actor] }
record["reason"] = opts[:reason] unless opts[:reason].to_s.empty?
record["updated_at"] = now
record["evidence_refs"] = Array(opts[:evidence])
record["requires_authorization"] = bound_action unless bound_action.nil?
unless authorization_refs.nil?
  record["authorization_refs"] = authorization_refs
  record["authorization_through"] = authorization_through
end
gates[gate_name] = record

status["updated_at"] = Date.today.to_s
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "gate #{gate_name}: #{old_status} -> #{new_status}",
  "agent" => CompletionGuard.event_agent(opts[:actor]),
  "reason" => opts[:reason].to_s.empty? ? "completion gate declared" : opts[:reason],
  "at" => now
}

tmp_path = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)
rescue StandardError => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

CompletionGuard.append_meta_event!(
  task_dir,
  type: "completion_gate_updated",
  agent: CompletionGuard.event_agent(opts[:actor]),
  details: "gate=#{gate_name} #{old_status}->#{new_status} actor=#{opts[:actor]}"
)

puts "gate #{gate_name}: #{old_status} -> #{new_status}"
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bash tests/integration/authorization-ledger.sh
bash tests/integration/completion-gates.sh
```

Expected: `[ok] gate writer: bound gates, (T, S), preservation`, `PASS: authorization-ledger`, and the Phase 1A suite still passes. (This task's tests never call `validate-yaml.rb`; the validator's view of these same states is covered in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add scripts/update-completion-gate.rb tests/integration/authorization-ledger.sh
git commit -m "feat(authorization): bind gates to authorizations with a one-shot (T, S) capture (#28 Phase 1B.1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Validator, schemas and parity

**Files:**
- Modify: `validate-yaml.rb`
- Create: `schemas/authorization.schema.yaml`
- Modify: `schemas/status.schema.yaml`
- Modify: `tests/integration/schema-validator-parity.sh`
- Modify: `tests/integration/authorization-ledger.sh`

**Interfaces:**
- Consumes: `AuthorizationLedger` (Task 1), `CompletionGuard.can_transition_to_done_in` (Task 3).
- Produces: `validate-yaml.rb` errors for (a) an invalid `authorization.yaml` (every integrity rule), (b) the three new gate fields (shape, `na` carries none, refs/through only on a gate that declares `requires_authorization`, a bound `pass` needs non-empty refs and a `through`), (c) a bound gate whose refs do not resolve / mismatch the action / are not valid as of `(updated_at, authorization_through)` / exceed `through`, (d) `done` with an authorization-bound gate the guard rejects. `validate_status` gains the keyword `task_dir:`.

- [ ] **Step 1: Append the failing tests**

Insert above the `# --- APPEND-NEW-SECTIONS-ABOVE ---` line:

```bash
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
expect_invalid "$DIR" "a grant for a different action makes the stored state invalid" "authorization"

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
expect_invalid "$DIR" "na must not carry authorization_refs" "na"
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
expect_invalid "$DIR" "a malformed authorization id is invalid" "authz"

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
expect_invalid "$DIR" "an unknown ref is invalid" "authz-009"
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
expect_invalid "$DIR" "a forward-referencing revoke is invalid" "authorization.yaml"
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/integration/authorization-ledger.sh
```

Expected: FAIL at `done with forged authorization refs (no ledger) is invalid` — today's validator ignores the new fields and calls the guard without a ledger.

- [ ] **Step 3: Extend `validate-yaml.rb`**

(a) Directly under the existing `require_relative "scripts/completion-guard"` add:

```ruby
require_relative "scripts/authorization-ledger"
```

(b) Replace the whole `validate_completion_gates` function (currently `def validate_completion_gates(data, label, errors)` … through its closing `end`) with this version, which takes the task directory:

```ruby
def validate_completion_gates(data, label, errors, task_dir = nil)
  if data.key?("completion_gates")
    gates = data["completion_gates"]
    if gates.is_a?(Hash)
      gates.each do |name, gate|
        glabel = "#{label}.completion_gates.#{name}"
        unless name.to_s.match?(CompletionGuard::GATE_NAME_PATTERN)
          errors << "#{glabel}: gate name must match #{CompletionGuard::GATE_NAME_PATTERN.inspect}"
        end
        unless gate.is_a?(Hash)
          errors << "#{glabel} must be a map"
          next
        end
        expect_enum(gate["status"], CompletionGuard::GATE_STATUSES, "#{glabel}.status", errors)
        if CompletionGuard::RESOLVED_STATUSES.include?(gate["status"])
          CompletionGuard::RESOLUTION_METADATA_KEYS.each do |key|
            unless gate[key].is_a?(String) && !gate[key].strip.empty?
              errors << "#{glabel}.#{key} is required (non-empty) when status is #{gate['status']}"
            end
          end
        end
        validate_evidence_ref_shape(gate["evidence_refs"], "#{glabel}.evidence_refs", errors) if gate.key?("evidence_refs")
        validate_gate_authorization_fields(gate, glabel, errors)
      end
    else
      errors << "#{label}.completion_gates must be a map of gate name -> gate record"
    end
  end

  # Defense in depth for the transition guard: an already-stored impossible
  # state (done while a declared gate is unresolved) is a validation error. With
  # a task directory the guard also checks authorization-bound gates against the
  # task's ledger; without one, bound gates are (correctly) unresolved.
  if [data["phase"], data["state"]].include?("done")
    verdict = task_dir ? CompletionGuard.can_transition_to_done_in(data, task_dir) : CompletionGuard.can_transition_to_done(data)
    unless verdict.allowed
      errors << "#{label}: phase/state 'done' with unresolved completion gate(s): #{verdict.unresolved.join(', ')} " \
                "(resolve each gate to pass or na through scripts/update-completion-gate.rb; a gate bound to an " \
                "authorization also needs valid authorization_refs)"
    end
  end
end

# Shape rules for the Phase 1B.1 gate fields (issue #28). Cross-file checks
# against authorization.yaml are in validate_completion_gate_authorizations.
def validate_gate_authorization_fields(gate, glabel, errors)
  bound = gate.key?("requires_authorization")
  if bound
    unless AuthorizationLedger::ACTIONS.include?(gate["requires_authorization"])
      errors << "#{glabel}.requires_authorization must be one of #{AuthorizationLedger::ACTIONS.join(', ')}"
    end
  end

  if gate.key?("authorization_refs")
    refs = gate["authorization_refs"]
    unless refs.is_a?(Array) && refs.all? { |ref| AuthorizationLedger.id_number(ref) }
      errors << "#{glabel}.authorization_refs must be a list of authz-NNN ids"
    end
  end
  if gate.key?("authorization_through") && AuthorizationLedger.id_number(gate["authorization_through"]).nil?
    errors << "#{glabel}.authorization_through must be an authz-NNN id"
  end

  unless bound
    %w[authorization_refs authorization_through].each do |key|
      errors << "#{glabel}.#{key} is only valid on a gate that declares requires_authorization" if gate.key?(key)
    end
    return
  end

  case gate["status"]
  when "na"
    %w[authorization_refs authorization_through].each do |key|
      errors << "#{glabel}.#{key} must be absent when status is na (na is not an authorization waiver)" if gate.key?(key)
    end
  when "pass"
    unless gate["authorization_refs"].is_a?(Array) && !gate["authorization_refs"].empty?
      errors << "#{glabel}.authorization_refs is required (non-empty) when a gate that requires authorization is pass"
    end
    errors << "#{glabel}.authorization_through is required when a gate that requires authorization is pass" unless gate.key?("authorization_through")
  end
end

# Every authorization ref on a bound `pass` gate must resolve in THIS task's
# ledger, match the required action exactly, sit at or below authorization_through
# (numerically), and be valid as of (updated_at, authorization_through).
def validate_completion_gate_authorizations(status, task_dir, errors)
  return unless status.is_a?(Hash) && status["completion_gates"].is_a?(Hash)

  bound = status["completion_gates"].select do |_name, gate|
    gate.is_a?(Hash) && gate.key?("requires_authorization") && gate["status"] == "pass" &&
      AuthorizationLedger::ACTIONS.include?(gate["requires_authorization"]) &&
      gate["authorization_refs"].is_a?(Array) && gate.key?("authorization_through")
  end
  return if bound.empty?

  index = begin
    AuthorizationLedger.load(task_dir)
  rescue AuthorizationLedger::Error => e
    errors << "status.yaml.completion_gates: cannot check authorization refs: #{e.message}"
    return
  end

  bound.each do |name, gate|
    label = "status.yaml.completion_gates.#{name}"
    through = gate["authorization_through"]
    through_number = AuthorizationLedger.id_number(through)
    unless through_number && index.entry?(through)
      errors << "#{label}.authorization_through #{through.inspect} is not an entry in authorization.yaml"
      next
    end
    at = AuthorizationLedger.parse_time(gate["updated_at"])
    gate["authorization_refs"].each do |ref|
      ref_number = AuthorizationLedger.id_number(ref)
      next if ref_number.nil? # shape error already reported

      if ref_number > through_number
        errors << "#{label}.authorization_refs: #{ref} is later than authorization_through #{through}"
      elsif !index.entry?(ref)
        errors << "#{label}.authorization_refs: unknown authorization id '#{ref}' (not in authorization.yaml)"
      elsif at.nil? || !index.valid_grant?(ref, action: gate["requires_authorization"], at: at, through: through)
        errors << "#{label}.authorization_refs: #{ref} is not a valid '#{gate['requires_authorization']}' grant as of " \
                  "#{gate['updated_at']} / #{through} (wrong action, expired, revoked in the snapshot, or not yet granted)"
      end
    end
  end
end

# runs/<task>/authorization.yaml — every integrity rule lives in
# AuthorizationLedger.validate_entries; this only adapts it to the validator.
def validate_authorization(data, label, errors)
  unless data.is_a?(Hash)
    errors << "#{label} must be a map"
    return
  end
  if data.key?("task_id") && !(data["task_id"].is_a?(String) && data["task_id"].match?(TASK_ID_PATTERN))
    errors << "#{label}.task_id must match #{TASK_ID_HINT}"
  end
  AuthorizationLedger.validate_entries(data.key?("authorizations") ? data["authorizations"] : []).each do |message|
    errors << "#{label}: #{message}"
  end
end
```

(c) Change the `validate_status` signature and its call to `validate_completion_gates`:

```ruby
def validate_status(data, label, errors, task_dir: nil)
```

and replace the existing line `validate_completion_gates(data, label, errors)` inside it with:

```ruby
  validate_completion_gates(data, label, errors, task_dir)
```

(d) In `validate_task_dir`, replace the two lines

```ruby
    validate_status(status_data, "status.yaml", errors)
    validate_completion_gate_evidence(status_data, task_dir, errors)
```

with

```ruby
    validate_status(status_data, "status.yaml", errors, task_dir: task_dir)
    validate_completion_gate_evidence(status_data, task_dir, errors)
    validate_completion_gate_authorizations(status_data, task_dir, errors)
```

and, next to the existing `evidence_file` block in the same function, add (a corrupt file must become a validation error, not a crash, like the evidence ledger):

```ruby
  authorization_file = File.join(task_dir, AuthorizationLedger::FILENAME)
  if File.exist?(authorization_file)
    begin
      validate_authorization(load_yaml(authorization_file), "authorization.yaml", errors)
    rescue StandardError => e
      errors << "authorization.yaml: #{e.message}"
    end
  end
```

(e) In the single-file dispatcher, replace the `status.yaml` branch call

```ruby
    validate_status(load_yaml(target_path), basename, errors)
```

with

```ruby
    validate_status(load_yaml(target_path), basename, errors, task_dir: File.dirname(target_path))
```

- [ ] **Step 4: Add the schemas**

Create `schemas/authorization.schema.yaml`:

```yaml
# NOT loaded at runtime. The canonical runtime validator is validate-yaml.rb
# (rules live in scripts/authorization-ledger.rb); this schema is
# documentation/tooling only. tests/integration/schema-validator-parity.sh keeps
# the constants in sync. Ids are compared NUMERICALLY (authz-999 < authz-1000);
# revocation is decided by append order, never by timestamp — JSON Schema cannot
# express those two rules, so read docs/authorization-ledger.md.
$schema: "https://json-schema.org/draft/2020-12/schema"
$id: "https://sparqlab.local/ai-dev-office/schemas/authorization.schema.yaml"
title: AI Dev Office Authorization Ledger
description: >
  Validation schema for `runs/<task-id>/authorization.yaml` (issue #28,
  Phase 1B.1). An append-only record of grants and revokes. `scope` is
  descriptive / audit-only; only `action` is matched, exactly. `actor` and `via`
  are unverified free text. This records authorization; it does not enforce it at
  action time.
type: object
additionalProperties: true
required:
  - task_id
  - authorizations
properties:
  task_id:
    type: string
    pattern: "^TASK(?:-[A-Z][A-Z0-9]*)?-[0-9]+$"
  authorizations:
    type: array
    items:
      type: object
      required:
        - id
        - type
        - actor
        - via
        - reason
        - at
      properties:
        id:
          type: string
          pattern: "^authz-[0-9]{3,}$"
        type:
          type: string
          enum:
            - grant
            - revoke
        actor:
          type: string
          minLength: 1
        via:
          type: string
          minLength: 1
        reason:
          type: string
          minLength: 1
        at:
          type: string
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
        action:
          type: string
          enum:
            - deploy_staging
            - deploy_production
            - production_data_mutation
            - production_backfill
            - live_load
            - external_side_effect
        scope:
          type: string
          minLength: 1
        expires_at:
          type: string
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
        revokes:
          type: string
          pattern: "^authz-[0-9]{3,}$"
      allOf:
        - if:
            required:
              - type
            properties:
              type:
                const: grant
          then:
            required:
              - action
              - scope
            not:
              required:
                - revokes
        - if:
            required:
              - type
            properties:
              type:
                const: revoke
          then:
            required:
              - revokes
            not:
              anyOf:
                - required:
                    - action
                - required:
                    - scope
                - required:
                    - expires_at
```

In `schemas/status.schema.yaml`, inside `completion_gates` → `additionalProperties` → `properties`, directly after `evidence_refs:` (and its `items`), add:

```yaml
        requires_authorization:
          type: string
          enum:
            - deploy_staging
            - deploy_production
            - production_data_mutation
            - production_backfill
            - live_load
            - external_side_effect
          description: >
            Set only at declare; immutable; preserved on every transition. Binds
            the gate to an authorization (issue #28, Phase 1B.1).
        authorization_refs:
          type: array
          items:
            type: string
            pattern: "^authz-[0-9]{3,}$"
        authorization_through:
          type: string
          pattern: "^authz-[0-9]{3,}$"
          description: >
            The authorization ledger's high-water id observed when the gate was
            passed (append-order snapshot). Absent on na.
```

- [ ] **Step 5: Add the parity rows**

In `tests/integration/schema-validator-parity.sh`, add next to the existing `require File.join(Dir.pwd, "scripts", "completion-guard")` line:

```ruby
require File.join(Dir.pwd, "scripts", "authorization-ledger")
```

and, inside the "completion gates" block (just before the `# --- end completion gates block` line), add:

```ruby
# --- authorization ledger (issue #28, Phase 1B.1) ------------------------------
auth_schema = YAML.load_file("schemas/authorization.schema.yaml")
auth_item = auth_schema["properties"]["authorizations"]["items"]
checks << ["authorization.grant.action (AuthorizationLedger::ACTIONS)", AuthorizationLedger::ACTIONS.sort,
           auth_item["properties"]["action"]["enum"].sort]
checks << ["authorization.type", AuthorizationLedger::TYPES.sort, auth_item["properties"]["type"]["enum"].sort]
checks << ["authorization common required keys", AuthorizationLedger::COMMON_REQUIRED_KEYS.sort, auth_item["required"].sort]
gate_props = YAML.load_file("schemas/status.schema.yaml")["properties"]["completion_gates"]["additionalProperties"]["properties"]
checks << ["status.completion_gates.requires_authorization (ACTIONS)", AuthorizationLedger::ACTIONS.sort,
           gate_props["requires_authorization"]["enum"].sort]
authz_samples = %w[authz-001 authz-999 authz-1000 authz-01 authz-abc AUTHZ-001 authz-0001 authz-]
authz_validator = authz_samples.map { |s| AuthorizationLedger::ID_PATTERN.match?(s) }
checks << ["authorization.id grammar", authz_validator,
           authz_samples.map { |s| Regexp.new(auth_item["properties"]["id"]["pattern"]).match?(s) }]
checks << ["authorization.revokes grammar", authz_validator,
           authz_samples.map { |s| Regexp.new(auth_item["properties"]["revokes"]["pattern"]).match?(s) }]
checks << ["status gate authorization_refs grammar", authz_validator,
           authz_samples.map { |s| Regexp.new(gate_props["authorization_refs"]["items"]["pattern"]).match?(s) }]
checks << ["status gate authorization_through grammar", authz_validator,
           authz_samples.map { |s| Regexp.new(gate_props["authorization_through"]["pattern"]).match?(s) }]
ts_samples = ["2026-09-30T10:00:00Z", "2026-09-30 10:00:00", "2026-09-30T10:00:00+07:00", "2026-09-30T10:00Z", ""]
ts_validator = ts_samples.map { |s| AuthorizationLedger::TIMESTAMP_PATTERN.match?(s) }
checks << ["authorization.at grammar", ts_validator,
           ts_samples.map { |s| Regexp.new(auth_item["properties"]["at"]["pattern"]).match?(s) }]
checks << ["authorization.expires_at grammar", ts_validator,
           ts_samples.map { |s| Regexp.new(auth_item["properties"]["expires_at"]["pattern"]).match?(s) }]
# --- end authorization ledger block ---------------------------------------------
```

- [ ] **Step 6: Run the suites**

```bash
bash tests/integration/authorization-ledger.sh
bash tests/integration/schema-validator-parity.sh
bash tests/integration/completion-gates.sh
bash tests/integration/evidence-contract.sh
```

Expected: `[ok] validator: ledger, gate fields, stored-state checks`, `PASS: authorization-ledger`, `[PASS] schema-validator-parity`, and both older suites pass. The TASK-C13 assertion in Task 4 (`the validator must also accept the skewed-clock state`) now passes; if you moved it to this task instead, it passes here.

- [ ] **Step 7: Validate the real runs still pass**

They carry no gates, so nothing may change:

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do
  ruby validate-yaml.rb "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"
done
```

Expected: identical to the same loop on `origin/main` (compare against a second checkout if a run fails). A newly failing run means the validator changed behavior for tasks without bound gates — stop and fix.

- [ ] **Step 8: Commit**

```bash
git add validate-yaml.rb schemas/authorization.schema.yaml schemas/status.schema.yaml tests/integration/schema-validator-parity.sh tests/integration/authorization-ledger.sh
git commit -m "feat(authorization): validate the ledger and bound gates, add schema and parity (#28 Phase 1B.1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Create: `docs/authorization-ledger.md`
- Modify: `docs/completion-gates.md`, `docs/task-transition-contract.md`

- [ ] **Step 1: Write `docs/authorization-ledger.md`**

````markdown
# Authorization Ledger & Completion Binding (Phase 1B.1)

Issue: vestearth/AI-office-agency#28. Design: [`docs/superpowers/specs/2026-09-30-completion-gates-1b1-authorization-design.md`](superpowers/specs/2026-09-30-completion-gates-1b1-authorization-design.md). Opt-in; builds on [completion gates](completion-gates.md).

## What it is — and is not

An append-only, per-task record of who authorized which action (`runs/<task>/authorization.yaml`), and a way for a completion gate to **require** such an authorization. A task cannot reach `done` on a missing, mismatched, expired or already-revoked grant.

It does **not** stop anyone from performing a privileged action before a grant exists. There is no dispatch-time or action-time enforcement (a possible Phase 1B.2). What this slice provides is an auditable record and a completion binding that refuses to call the task done without it.

| Concept | Question | Where |
|---|---|---|
| Decision | What should we do? | `decision.yaml` (unchanged; `approve → done` untouched) |
| Authorization | May this declared action be accepted as authorized? | `authorization.yaml` |
| Completion | Is the task objectively complete? | `completion_gates` in `status.yaml` |

A grant never changes a task's phase.

## The ledger

```yaml
task_id: TASK-VS-011
authorizations:
  - id: authz-001
    type: grant
    action: production_backfill
    scope: "rolling-window correction on prod slip-api DB"   # descriptive only
    actor: alice
    via: cli
    reason: "operator approved the residual-window correction in chat"
    at: "2026-09-30T00:30:00Z"
    expires_at: "2026-09-30T06:30:00Z"                       # optional
  - id: authz-002
    type: revoke
    revokes: authz-001
    actor: alice
    via: cli
    reason: "plan changed"
    at: "2026-09-30T02:00:00Z"
```

- Common fields: `id`, `type`, `actor`, `via`, `reason`, `at`. Grant: `action`, `scope`, optional `expires_at`. Revoke: `revokes`.
- `action` is a closed enum matched **exactly**: `deploy_staging`, `deploy_production`, `production_data_mutation`, `production_backfill`, `live_load`, `external_side_effect`. There is no hierarchy: `external_side_effect` does not imply `deploy_production`.
- `scope` is **descriptive and audit-only**. Only `action` is compared, so `scope: wallet-service` does not stop a grant being cited for a different service.
- Ids are compared by their **numeric suffix** (`authz-999 < authz-1000`); uniqueness is by numeric value. Only `scripts/authorization-ledger.rb` compares ids.
- `at` values are informational for ordering and need not be monotonic; **revocation is decided by append order, never by the clock.** The writer never refuses an append because the local clock moved backwards.
- A revoke may reference only an earlier grant; a grant may be revoked once; `expires_at` must be after `at`.

Write it only with `scripts/record-authorization.rb`:

```bash
ruby scripts/record-authorization.rb <TASK> grant  --action A --scope S --actor X --via V --reason R [--expires-at TS]
ruby scripts/record-authorization.rb <TASK> revoke <authz-NNN> --actor X --via V --reason R
```

It takes the task lock and the ownership fence, writes `at` itself, refuses a grant on a `done`/`aborted` task (a revoke is always allowed), and records an `authorization_recorded` event. Exit `0` ok, `2` usage/invalid append, `3` unreadable status or ledger, `9` fence refused.

## Validity: `(T, S)`

A grant is valid as of time `T` and snapshot `S` (an authorization id) iff `id <= S`, `at <= T`, (`expires_at` absent or `T < expires_at`), and no revoke of it with `id <= S`. Timestamps decide only a grant's start and expiry.

For a gate, `T` is the pass time (`updated_at`) and `S` the ledger's highest id at that moment (`authorization_through`). A revoke recorded later has a higher id and never reopens the gate, even if a skewed clock gives it an earlier `at`.

## Binding a gate

```bash
ruby scripts/update-completion-gate.rb <TASK> declare <GATE> --actor A --requires-authorization <action>
ruby scripts/update-completion-gate.rb <TASK> pass    <GATE> --actor A --reason R --authorization authz-NNN[,…]
ruby scripts/update-completion-gate.rb <TASK> na      <GATE> --actor A --reason R
```

- `requires_authorization` is set only at declare and is immutable; the writer carries it forward on every transition.
- A bound `pass` needs `--authorization`: every ref must be a grant of this task for exactly the required action and valid as of `(T, S)`. The writer reads the clock and the ledger high-water id **once**, under the task lock, and stores them as `updated_at` and `authorization_through`. `record-authorization.rb` takes the same lock, so a revoke cannot interleave between the check and the write.
- `na` on a bound gate means the protected action was not applicable / not performed. It is **not** an authorization waiver: it carries no `authorization_refs` or `authorization_through`.

## Enforcement

`CompletionGuard.can_transition_to_done_in(status, task_dir)` loads the ledger only when a gate carries `requires_authorization`, and evaluates each bound gate **as of its recorded `(updated_at, authorization_through)`**. A forged or hand-edited `authorization_refs` is therefore blocked by the guard itself — through `sync-status-from-output.rb`, human `approve` in `reconcile-decision.rb`, `force-status-route.rb` and `decide-next-step.rb` — not only by `validate-yaml.rb`. A missing or corrupt ledger fails closed. Gates without `requires_authorization` never read the ledger.

## Documented limits

- No action-time enforcement: nothing here prevents the action itself.
- `actor` / `via` are unverified free text; an agent can record a grant for itself.
- `scope` is not compared.
- A revoke after a `pass` is kept for audit and does not reopen the gate (there is no reopen). This rests on append order, so it holds under clock skew.
- A hand-edited gate that stays internally consistent is undetectable. The hostile edit is **lowering** `authorization_through` to before an already-present revoke while keeping it at or above every cited ref (grant `authz-001`, revoke `authz-002`, forged `authorization_through: authz-001` hides the revoke). It cannot be told apart from a genuine pass that preceded a later revoke. Raising the value only makes more revokes visible and is more restrictive. Hand-appending a grant is likewise undetectable. The same goes for removing `requires_authorization` from a gate by hand.
- `na` is an audited assertion, not a verified fact.

## Rollback

Code rollback is a revert, but it is **not semantics-preserving while authorization-bound gates are active.** After a revert, `authorization.yaml` is inert and a gate that still carries `requires_authorization` is judged by the Phase 1A guard (metadata only). Resolving the gates is not a safe boundary: a task with a bound gate already `pass` but not yet `done` still depends on this guard for its later transition. For every task with an authorization-bound gate (including one still `pending`), before reverting either let the task reach its terminal state (`done` or `aborted`) under 1B.1, or freeze/abort it and carry out an explicitly logged data migration recorded in its history and `meta.yaml`. Reverting first and cleaning up afterwards is not supported.

## Test hook

`AI_OFFICE_NOW=YYYY-MM-DDTHH:MM:SSZ` overrides the clock for `record-authorization.rb` and `update-completion-gate.rb`. It exists for tests, like `AI_OFFICE_RUNS_DIR`.
````

- [ ] **Step 2: Update `docs/completion-gates.md`**

Add this section after the existing "Enforcement" section (and before "Compatibility"):

```markdown
## Gates bound to an authorization (Phase 1B.1)

A gate can declare `requires_authorization: <action>` at declare time. Such a gate resolves only with valid `authorization_refs` (and `authorization_through`) — see [authorization-ledger.md](authorization-ledger.md). `na` on a bound gate is not an authorization waiver. The guard entry point for writers and the validator is `CompletionGuard.can_transition_to_done_in(status, task_dir)`; the pure `can_transition_to_done(status, authorizations:)` remains. Gates without `requires_authorization` never read the ledger and behave exactly as described above.
```

and add one sentence to the "Who writes gates" section: `` `declare` accepts `--requires-authorization <action>` and `pass` accepts `--authorization authz-NNN[,…]` for bound gates (see authorization-ledger.md). ``

- [ ] **Step 3: Update `docs/task-transition-contract.md`**

Directly after the existing `completion_gates` bullet in the "Not required but load-bearing" list, add:

```markdown
- `authorization.yaml` (issue #28 Phase 1B.1, optional) — an append-only ledger of grants/revokes per task. A gate that declares `requires_authorization` is checked against it by the guard (`can_transition_to_done_in`), as of the gate's own `(updated_at, authorization_through)`. See [`authorization-ledger.md`](authorization-ledger.md).
```

- [ ] **Step 4: Sanity-check the docs against the code**

```bash
grep -n "record-authorization\|update-completion-gate\|can_transition_to_done_in\|AI_OFFICE_NOW\|authorization_through" docs/authorization-ledger.md docs/completion-gates.md docs/task-transition-contract.md | head -20
ls scripts/authorization-ledger.rb scripts/record-authorization.rb scripts/update-completion-gate.rb schemas/authorization.schema.yaml
grep -n "requires_authorization" scripts/update-completion-gate.rb | head -3
```

Expected: every file the docs name exists, and every flag/constant they describe appears in the code.

- [ ] **Step 5: Commit**

```bash
git add docs/authorization-ledger.md docs/completion-gates.md docs/task-transition-contract.md
git commit -m "docs(authorization): document the ledger, the completion binding and its limits (#28 Phase 1B.1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification (no new code)

**Files:** none.

- [ ] **Step 1: Run the new suite and every Phase 1A/baseline suite**

```bash
bash tests/integration/authorization-ledger.sh | tail -3
for t in completion-gates schema-validator-parity decision-reconcile state-machine-consistency \
         concurrent-status-writes idempotency-and-reentry validation-failed-bounded \
         output-contract dependency-policy dependency-guard evidence-contract \
         auto-parallel task-ownership driver-decision-e2e; do
  if bash "tests/integration/$t.sh" >"/tmp/1b1-final-$t.log" 2>&1; then echo "PASS $t"; else echo "FAIL $t"; fi
done
bash -n run-agent.sh && echo syntax-ok
```

Expected: `PASS: authorization-ledger` and all 14 baseline suites PASS. A suite that flipped from PASS to FAIL is a regression: read `/tmp/1b1-final-<suite>.log`, fix, re-run.

- [ ] **Step 2: Prove the key tests would have caught the defects**

Test integrity: show each behavior test fails without its fix. Do each, then restore with `git checkout`:

```bash
# (a) the guard must validate authorization truth (forged refs blocked by the guard itself)
sed -i.orig 's/return false if index.nil?$/return true if index.nil?/' scripts/completion-guard.rb
bash tests/integration/authorization-ledger.sh >/tmp/1b1-red-a.log 2>&1; echo "exit=$?"; tail -2 /tmp/1b1-red-a.log
git checkout -- scripts/completion-guard.rb && rm -f scripts/completion-guard.rb.orig

# (b) preservation: drop the carry-forward of requires_authorization
sed -i.orig '/record\["requires_authorization"\] = bound_action unless bound_action.nil?/d' scripts/update-completion-gate.rb
bash tests/integration/authorization-ledger.sh >/tmp/1b1-red-b.log 2>&1; echo "exit=$?"; tail -2 /tmp/1b1-red-b.log
git checkout -- scripts/update-completion-gate.rb && rm -f scripts/update-completion-gate.rb.orig

# (c) numeric ids: compare the id strings instead of their numbers in valid_grant?
sed -i.orig 's/number > snapshot/id > through/' scripts/authorization-ledger.rb
bash tests/integration/authorization-ledger.sh >/tmp/1b1-red-c.log 2>&1; echo "exit=$?"; tail -2 /tmp/1b1-red-c.log
git checkout -- scripts/authorization-ledger.rb && rm -f scripts/authorization-ledger.rb.orig
git status --short
```

Expected: each run prints `exit=1` and a `[FAIL] …` line; the final `git status --short` shows a clean tree (nothing modified). Do not skip the restores.

- [ ] **Step 3: Replay the real-world case on a scratch copy**

Use a scratch runs dir, never the live `runs/`:

```bash
export AI_OFFICE_RUNS_DIR="$(mktemp -d)"
mkdir -p "$AI_OFFICE_RUNS_DIR/TASK-VS-010"
cp /path/to/checkout/runs/TASK-VS-010/status.yaml "$AI_OFFICE_RUNS_DIR/TASK-VS-010/status.yaml" 2>/dev/null \
  || printf 'task_id: TASK-VS-010\nphase: review\nstate: review\niteration: 1\ncurrent_agent: reviewer\n' > "$AI_OFFICE_RUNS_DIR/TASK-VS-010/status.yaml"
ruby scripts/update-completion-gate.rb TASK-VS-010 declare production_backfill --actor pm --requires-authorization production_backfill
printf 'review_verdict: approved\nnext_action:\n  agent: done\n  reason: approved\n' > "$AI_OFFICE_RUNS_DIR/TASK-VS-010/reviewer-output.yaml"
ruby scripts/sync-status-from-output.rb TASK-VS-010 reviewer "$AI_OFFICE_RUNS_DIR/TASK-VS-010/status.yaml" "$AI_OFFICE_RUNS_DIR/TASK-VS-010/reviewer-output.yaml" 2026-09-30 in_review; echo "sync rc=$? (expect 5: gate pending)"
ruby scripts/record-authorization.rb TASK-VS-010 grant --action production_backfill --scope "rolling-window correction" --actor alice --via cli --reason "operator approved"
ruby scripts/update-completion-gate.rb TASK-VS-010 pass production_backfill --actor alice --reason "correction ran" --authorization authz-001
ruby scripts/sync-status-from-output.rb TASK-VS-010 reviewer "$AI_OFFICE_RUNS_DIR/TASK-VS-010/status.yaml" "$AI_OFFICE_RUNS_DIR/TASK-VS-010/reviewer-output.yaml" 2026-09-30 in_review; echo "sync rc=$? (expect 0)"
unset AI_OFFICE_RUNS_DIR
git status --short runs/
```

Expected: the first sync exits `5`, the second `0`, and `git status --short runs/` prints nothing (the live run store was not touched).

- [ ] **Step 4: Validate the real runs and leave the branch unpushed**

```bash
for t in TASK-VS-003 TASK-VS-004 TASK-VS-006 TASK-VS-008 TASK-VS-010; do
  ruby validate-yaml.rb "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "FAIL $t"
done
git status --short && git log --oneline -8
```

Expected: the five runs validate as they did before; a clean tree with the six implementation commits from Tasks 1–6. Do not push or open a PR without being asked; report results to the operator.

---

## Self-Review

**1. Spec coverage** (spec section → task):

| Spec requirement | Task |
|---|---|
| Ledger file, common/grant/revoke fields, closed action enum, exact match | 1, 2 |
| Integrity rules (id grammar, uniqueness, increasing order, earlier-grant revoke, single revoke, `expires_at > at`) | 1 (`validate_entries`), 2 (writer re-check), 5 (validator) |
| Numeric id ordering; `AuthorizationLedger` owns the comparator; boundary tests | 1, 2, 3, 4, 5 (999/1000 in every layer) |
| `(T, S)` validity; revocation by append order; timestamps only for start/expiry | 1 (`valid_grant?`), 3, 4 |
| Writer: lock + fence, `max + 1`, `at` by writer, done/aborted rule, meta event, exit codes | 2 |
| Writer never refuses on a backward clock | 2 (test), header comment |
| Gate `requires_authorization` (declare-only, immutable, **preserved**) | 4 (writer + preservation tests) |
| `pass` needs refs valid as of `(T, S)`; every ref; exact action; refusal leaves gate untouched | 4 |
| One clock read + one ledger read under the lock; `updated_at == T`, `authorization_through == S` | 4 (writer + expiry-boundary test) |
| `na` is not a waiver; carries no refs/through | 3 (guard), 4 (writer), 5 (validator) |
| Guard validates authorization truth (pure function + ledger input), fail closed, evaluated as of the recorded snapshot | 3 |
| Wrapper `can_transition_to_done_in`; all five callers switched | 3 (four scripts), 5 (validator) |
| Validator: ledger, gate fields, `authorization_through` integrity, `done` invariant, cross-file refs | 5 |
| Schemas + parity (actions both places, id grammar, common keys, timestamp grammar) | 5 |
| Backward compatibility (unbound gates never read the ledger; Phase 1A suite unchanged) | 3 (`TASK-B07`), 5 (`TASK-D-006`), 7 |
| Skewed-clock revoke after pass; future-dated revoke before pass; through integrity | 3, 4, 5 |
| Tampering limit (lowering `authorization_through`) and rollback boundary documented | 6 |
| Test hook for the clock | 1 (`now_utc`), decisions list |

Gap noted: the spec's "concurrent writers never collide on an id" test is not written as a parallel-process test — the writer reuses the `record-evidence.sh` under-lock pattern and the existing `concurrent-status-writes.sh` / `task-ownership.sh` suites cover the lock. If the operator wants a dedicated concurrency test, add N background `record-authorization.rb` grants to `TASK-A0x` and assert N unique ids; it is a cheap addition.

**2. Placeholder scan:** every code step shows the code. One deliberate directed note remains: the Task 2 fence test points at the exact `acquire` invocation used by `tests/integration/task-ownership.sh`, to be mirrored if this repo's arguments differ (the assertion — exit `9`, no ledger created — stays).

**3. Type consistency:** `AuthorizationLedger::Index#valid_grant?(id, action:, at:, through:)` is called with the same keywords in Tasks 3, 4 and 5; `high_water_id` returns a canonical string used as `authorization_through` in Task 4 and compared numerically everywhere; `CompletionGuard.can_transition_to_done(status, authorizations:)` and `can_transition_to_done_in(status, task_dir)` are used identically in Tasks 3 and 5; `AuthorizationLedger.now_utc` returns a floored `Time` used as both `pass_time` and (formatted) `updated_at` in Task 4.

**Known risks the implementer should watch:**
- The parity script compares grammar by behavior over sample strings, so the schema `pattern` and the Ruby regex must agree on every sample (including `authz-0001`, which both accept; uniqueness by numeric value is enforced by `validate_entries`, not the pattern).
- `validate_status`'s new `task_dir:` keyword must be passed at both call sites, or the stored-state `done` check silently falls back to the fail-closed no-ledger path for bound gates.
- The local Ruby lacks endless-method definitions; use classic `def … end` everywhere.
- The `sed` edits in Task 7 Step 2 use BSD `sed -i.orig`; on GNU sed the `.orig` suffix syntax still works but the cleanup `rm -f *.orig` must run.

## Verification of this plan

Before it was committed, the code and test blocks of Tasks 1–5 were extracted and applied to a scratch checkout of `origin/main` (`d4181599`, Ruby 2.6.10, macOS) and executed: the new `tests/integration/authorization-ledger.sh` passes end to end, all 14 baseline suites still pass, the five real `TASK-VS-*` runs still validate, and the three red-check `sed` edits in Task 7 Step 2 each change the code and each make the suite fail. That run found and fixed four defects in the plan itself: `yaml_get` could not index lists, one assertion message used backticks inside double quotes (which bash executes as a command), the Task 5 fixtures used task ids that do not match the task-id pattern, and a leftover reviewer-output fixture made the validator reject an otherwise valid `done` task. Tasks 6 (docs) and 7 (verification steps) were not executed. Nothing in the scratch run touched the live `runs/` store.
