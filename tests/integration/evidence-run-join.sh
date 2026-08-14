#!/usr/bin/env bash
# Evidence -> run join: "evidence can be traced to a run_id" (issue #13's last
# acceptance criterion). The FK lives on the evidence side only.
#  J1: evidence recorded DURING a dispatch carries that dispatch's run_id.
#  J2: with no AI_DEV_OFFICE_RUN_ID the wrapper still works and records null.
#  J3: a dangling run_id fails validation, as a dangling evidence_ref does.
#  J4: a legacy task with no run-records/ and null run_ids validates unchanged.
#  J5: end to end — from an ev-id, locate the run and read client/role/repo_sha.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECORD="$ROOT/scripts/record-evidence.sh"
RECORD_RUN="$ROOT/scripts/record-run.rb"
VALIDATOR="$ROOT/validate-yaml.rb"

TMP_RUNS="$(mktemp -d)"
export AI_OFFICE_RUNS_DIR="$TMP_RUNS"
TASK="TASK-904"
TASK_DIR="$TMP_RUNS/$TASK"
mkdir -p "$TASK_DIR"

cleanup() { rm -rf "$TMP_RUNS"; }
trap cleanup EXIT

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

assert_eq() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$1' got '$2'"
}

expect_valid() {
  local out
  out="$(ruby "$VALIDATOR" "${2:-$TASK_DIR}" 2>&1)" || fail "$1 (got: $out)"
}

# $1 = message, $2 = substring the failure must mention, $3 = target (optional)
expect_invalid() {
  local out
  out="$(ruby "$VALIDATOR" "${3:-$TASK_DIR}" 2>&1)" && fail "$1 (validation unexpectedly passed)"
  grep -q "$2" <<<"$out" || fail "$1 (expected the error to mention '$2', got: $out)"
}

write_status() {  # <task-dir> <task-id>
  cat > "$1/status.yaml" <<YAML
task_id: $2
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
YAML
}

# <index> <key> [task-dir]
field_of() {
  ruby - "${3:-$TASK_DIR}/evidence.yaml" "$1" "$2" <<'RUBY'
require "yaml"
path, index, key = ARGV
doc = YAML.safe_load(File.read(path)) || {}
puts doc["evidence"][index.to_i][key].inspect
RUBY
}

write_status "$TASK_DIR" "$TASK"

# ── J1: evidence recorded inside a dispatch is attributed to that run ─────────
# Same seam run-agent.sh uses: the run id is exported for the child process.
RUN_ID="$(printf 'assembled prompt' | ruby "$RECORD_RUN" start "$TASK_DIR" "$TASK" reviewer \
  client=codex repo_sha=deadbeefdeadbeef harness_version=2.0)"
[[ -f "$TASK_DIR/run-records/$RUN_ID.yaml" ]] || fail "J1: precondition — no run record for $RUN_ID"

EV1="$(cd "$ROOT" && AI_DEV_OFFICE_RUN_ID="$RUN_ID" "$RECORD" "$TASK" --type test -- echo joined)"
assert_eq "ev-001" "$EV1" "J1: first id follows the ev-NNN grammar"
assert_eq "\"$RUN_ID\"" "$(field_of 0 run_id)" "J1: evidence carries the dispatch run id"
expect_valid "J1: evidence pointing at a real run record must validate"
ok "J1: evidence recorded during a dispatch carries that dispatch's run_id"

# ── J2: outside a dispatch the id is null — never guessed ─────────────────────
EV2="$(cd "$ROOT" && env -u AI_DEV_OFFICE_RUN_ID "$RECORD" "$TASK" -- echo unattributed)"
assert_eq "ev-002" "$EV2" "J2: the wrapper still allocates ids normally"
assert_eq "nil" "$(field_of 1 run_id)" "J2: an unset run id records null"
grep -q "unattributed" "$TASK_DIR/evidence/ev-002.log" || fail "J2: the command did not run normally"
# run-agent.sh exports an EMPTY value when the record writer failed; that is
# still "no run", not a run whose id is the empty string.
EV3="$(cd "$ROOT" && AI_DEV_OFFICE_RUN_ID="" "$RECORD" "$TASK" -- sh -c 'echo nope >&2; exit 7')"
assert_eq "7" "$?" "J2: the command's exit code still propagates"
assert_eq "nil" "$(field_of 2 run_id)" "J2: an empty run id records null"
assert_eq "ev-003" "$EV3" "J2: ids keep advancing"
expect_valid "J2: null run_id must not fail validation"
ok "J2: no ambient run id records null, and the wrapper behaves normally"

# ── J3: a dangling run_id fails, exactly as a dangling evidence_ref does ──────
cp "$TASK_DIR/evidence.yaml" "$TMP_RUNS/evidence.yaml.bak"
ruby - "$TASK_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][1]["run_id"] = "run-20260101T000000Z-TASK-904-dev-zzzzzz"
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_invalid "J3: a run_id with no record must fail" "unknown run id"
# An id belonging to ANOTHER task cannot resolve either: resolution is scoped to
# the citing task's own store.
ruby - "$TASK_DIR/evidence.yaml" "$RUN_ID" <<'RUBY'
require "yaml"
path, run_id = ARGV
doc = YAML.safe_load(File.read(path))
doc["evidence"][1]["run_id"] = run_id.sub("TASK-904", "TASK-905")
File.write(path, YAML.dump(doc))
RUBY
expect_invalid "J3: a foreign task's run id must not resolve" "unknown run id"
# A malformed id is caught on the grammar, not silently treated as missing.
ruby - "$TASK_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][1]["run_id"] = "not-a-run-id"
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_invalid "J3: a malformed run_id must fail on the grammar" "run_id must match"
cp "$TMP_RUNS/evidence.yaml.bak" "$TASK_DIR/evidence.yaml"
expect_valid "J3: restoring the real ids must pass again"
ok "J3: dangling, foreign and malformed run ids all fail validation"

# ── J4: a legacy task predating run records keeps validating ─────────────────
# No run-records/ directory at all, and evidence recorded outside a dispatch.
LEGACY="TASK-906"
LEGACY_DIR="$TMP_RUNS/$LEGACY"
mkdir -p "$LEGACY_DIR"
write_status "$LEGACY_DIR" "$LEGACY"
(cd "$ROOT" && env -u AI_DEV_OFFICE_RUN_ID "$RECORD" "$LEGACY" -- echo legacy) >/dev/null
[[ -d "$LEGACY_DIR/run-records" ]] && fail "J4: precondition — the legacy task must have no record store"
assert_eq "nil" "$(field_of 0 run_id "$LEGACY_DIR")" "J4: legacy evidence records null"
expect_valid "J4: a task with no run-records/ and null run_ids must validate" "$LEGACY_DIR"
# Records written before the join carry no run_id KEY at all — also fine.
ruby - "$LEGACY_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][0].delete("run_id")
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_valid "J4: pre-join evidence with no run_id key must validate" "$LEGACY_DIR"
# ...but pointing into a store that does not exist is still a dangling FK.
ruby - "$LEGACY_DIR/evidence.yaml" <<'RUBY'
require "yaml"
doc = YAML.safe_load(File.read(ARGV[0]))
doc["evidence"][0]["run_id"] = "run-20260101T000000Z-TASK-906-dev-zzzzzz"
File.write(ARGV[0], YAML.dump(doc))
RUBY
expect_invalid "J4: a run_id against a missing store is still dangling" "unknown run id" "$LEGACY_DIR"
ok "J4: legacy tasks validate; a missing store is no excuse for a live id"

# ── J5: end to end — from an ev-id to the run that produced it ────────────────
JOIN="$(ruby - "$TASK_DIR" "$EV1" <<'RUBY'
require "yaml"
task_dir, ev_id = ARGV
ledger = YAML.safe_load(File.read(File.join(task_dir, "evidence.yaml")))
entry = ledger["evidence"].find { |e| e["id"] == ev_id } or abort "no such evidence id: #{ev_id}"
record = YAML.safe_load(File.read(File.join(task_dir, "run-records", "#{entry['run_id']}.yaml")))
puts [record["client"], record["role"], record["repo_sha"]].join(" ")
RUBY
)" || fail "J5: could not join $EV1 to its run record"
echo "  join: $EV1 -> $RUN_ID -> $JOIN"
assert_eq "codex reviewer deadbeefdeadbeef" "$JOIN" "J5: the joined run's client/role/repo_sha"
ok "J5: an ev-id resolves to its run record and its identity fields"

echo "[PASS] evidence-run-join (J1-J5): evidence is traceable to a run_id"
