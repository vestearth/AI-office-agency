#!/usr/bin/env bash
# Run identity — one canonical record per agent execution (docs/run-records.md):
#  R1: each execution gets a unique, grammar-conformant run id.
#  R2: retries of the SAME task/role get distinct ids and the earlier record
#      survives intact (a run record is history, never overwritten).
#  R3: the record carries task/role/repo_sha and brackets the run with
#      started_at/completed_at.
#  R4: absent runner telemetry is normal — no usage block, workflow unaffected.
#  R5: a malformed run record fails validation.
#  R6: concurrent writers do not corrupt the record store.
#  R7: meta events are attributable to the run via a structured run_id field.
#  R8: on a failed fallback, `client` names the runner that actually ran last
#      (not the one the dispatch started with) — otherwise the repeated-failure
#      query in docs/run-records.md blames the wrong runner.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$ROOT/run-agent.sh"
RECORD="$ROOT/scripts/record-run.rb"
VALIDATOR="$ROOT/validate-yaml.rb"
RUNS_DIR="$ROOT/runs"
WRITERS="${WRITERS:-25}"

WORK="$(mktemp -d)"
# R8 drives the real driver, which only reads runs/ — a dedicated temp task id,
# removed on exit, exactly as runner-fallback.sh does.
FB_TASK="TASK-RIDF-$$"
trap 'rm -rf "$WORK" "$RUNS_DIR/$FB_TASK"' EXIT

TASK="TASK-RID-001"
TASK_DIR="$WORK/$TASK"
RECORDS_DIR="$TASK_DIR/run-records"
mkdir -p "$TASK_DIR"

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

ID_RE='^run-[0-9]{8}T[0-9]{6}Z-TASK-RID-001-(dev|reviewer)-[0-9a-z]{6}$'
field() { ruby -ryaml -e 'd=YAML.safe_load(File.read(ARGV[0]))||{}; puts ARGV[1].split(".").reduce(d){|m,k| m.is_a?(Hash) ? m[k] : nil}.inspect' "$1" "$2"; }

start_run() {  # <role> [k=v ...] -> run id
  local role="$1"; shift
  printf 'assembled prompt for %s' "$role" | ruby "$RECORD" start "$TASK_DIR" "$TASK" "$role" "$@"
}

# ── R1: a run id is unique and matches the documented grammar ─────────────────
RUN_A="$(start_run dev client=codex repo_sha=deadbeef harness_version=2.0)"
[[ "$RUN_A" =~ $ID_RE ]] || fail "R1: run id '$RUN_A' does not match the documented grammar"
[[ -f "$RECORDS_DIR/$RUN_A.yaml" ]] || fail "R1: no record written for $RUN_A"
ok "R1: run id matches the grammar and its record exists"

ruby "$RECORD" finish "$TASK_DIR" "$RUN_A" outcome.status=completed outcome.exit_code=0 >/dev/null

# ── R3: the record carries identity and brackets the run ──────────────────────
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" task_id)" == '"'"$TASK"'"' ]] || fail "R3: record must carry task_id"
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" role)" == '"dev"' ]] || fail "R3: record must carry role"
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" repo_sha)" == '"deadbeef"' ]] || fail "R3: record must carry repo_sha"
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" started_at)" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]] || fail "R3: started_at must be ISO-8601 UTC"
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" completed_at)" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]] || fail "R3: completed_at must be stamped at finish"
# The prompt is hashed, not stored.
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" instruction_sha)" =~ ^\"sha256:[0-9a-f]{64}\"$ ]] || fail "R3: instruction_sha must hash the assembled prompt"
ok "R3: record carries task/role/repo_sha/instruction_sha and both timestamps"

# ── R4: no runner telemetry — usage absent, record still valid ────────────────
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" usage)" == "nil" ]] || fail "R4: usage must be absent when the runner reports nothing"
ruby "$VALIDATOR" "$RECORDS_DIR/$RUN_A.yaml" >/dev/null || fail "R4: a record without usage must validate"
# An explicitly-empty telemetry field is dropped, never written as a measured 0.
RUN_NOUSAGE="$(start_run dev usage.input_tokens= usage.tool_calls=)"
[[ "$(field "$RECORDS_DIR/$RUN_NOUSAGE.yaml" usage)" == "nil" ]] || fail "R4: unreported usage fields must not be written as zero"
ruby "$VALIDATOR" "$RECORDS_DIR/$RUN_NOUSAGE.yaml" >/dev/null || fail "R4: unreported telemetry must not fail validation"
# ...and a runner that DOES report telemetry validates too.
RUN_USAGE="$(start_run dev usage.input_tokens=120 usage.tool_calls=7)"
[[ "$(field "$RECORDS_DIR/$RUN_USAGE.yaml" usage.input_tokens)" == "120" ]] || fail "R4: reported telemetry must be recorded"
ruby "$VALIDATOR" "$RECORDS_DIR/$RUN_USAGE.yaml" >/dev/null || fail "R4: a record with usage must validate"
ok "R4: missing telemetry is a normal run; reported telemetry is recorded"

# ── R2: retry of the same task/role gets a new id, earlier record intact ──────
BEFORE="$(cat "$RECORDS_DIR/$RUN_A.yaml")"
RUN_B="$(start_run dev client=cursor-agent repo_sha=deadbeef)"
[[ "$RUN_B" != "$RUN_A" ]] || fail "R2: a retry must get a distinct run id"
ruby "$RECORD" finish "$TASK_DIR" "$RUN_B" outcome.status=failed outcome.exit_code=1 >/dev/null
[[ "$(cat "$RECORDS_DIR/$RUN_A.yaml")" == "$BEFORE" ]] || fail "R2: the earlier run record was mutated by a retry"
[[ "$(field "$RECORDS_DIR/$RUN_A.yaml" outcome.status)" == '"completed"' ]] || fail "R2: earlier outcome must survive"
[[ "$(field "$RECORDS_DIR/$RUN_B.yaml" outcome.status)" == '"failed"' ]] || fail "R2: retry outcome must be recorded independently"
# Both retries are queryable as separate executions of the same (task, role).
dev_runs="$(ruby -ryaml -e 'puts Dir[File.join(ARGV[0], "*.yaml")].map { |f| YAML.safe_load(File.read(f)) }.count { |r| r["role"] == "dev" }' "$RECORDS_DIR")"
[[ "$dev_runs" -eq 4 ]] || fail "R2: expected 4 dev runs in the store, got $dev_runs"
ok "R2: retries get distinct ids; earlier records stay intact and countable"

# Time-first grammar: the id's own prefix orders runs, no date parsing needed.
# (Ids minted in the same second tie on the prefix and are separated by nonce.)
ts_of() { printf '%s' "${1#run-}" | cut -d- -f1; }
[[ "$(ts_of "$RUN_A")" < "$(ts_of "$RUN_B")" || "$(ts_of "$RUN_A")" == "$(ts_of "$RUN_B")" ]] \
  || fail "R2: run id timestamp prefixes must be non-decreasing over time"
ok "R2: run ids order chronologically by their own prefix"

# ── R5: a malformed run record fails validation ───────────────────────────────
BAD="$RECORDS_DIR/run-20260101T000000Z-TASK-RID-001-dev-bad001.yaml"
cat > "$BAD" <<'YAML'
run_id: run-20260101T000000Z-TASK-RID-001-dev-bad001
task_id: TASK-RID-001
role: dev
client: codex
model_requested:
model_observed:
harness_version: "2.0"
skill_version:
instruction_sha:
repo_sha:
mcp_profile:
started_at: "2026-01-01T00:00:00Z"
completed_at:
outcome:
  status: totally_bogus_status
  exit_code: 0
  validation:
YAML
out="$(ruby "$VALIDATOR" "$BAD" 2>&1)" && fail "R5: validator accepted a malformed run record"
echo "$out" | grep -q "outcome.status" || { echo "$out"; fail "R5: validator should name the offending field"; }
# Grammar violations are caught too: id/role must agree with the record.
sed 's/^role: dev$/role: reviewer/; s/status: totally_bogus_status/status: completed/' "$BAD" > "$BAD.role"
out="$(ruby "$VALIDATOR" "$BAD.role" 2>&1)" && fail "R5: validator accepted a run id that disagrees with role"
echo "$out" | grep -q "must embed role" || { echo "$out"; fail "R5: validator should flag the id/role mismatch"; }
rm -f "$BAD" "$BAD.role"
ok "R5: malformed and self-inconsistent run records fail validation"

# ── R7: meta events carry a structured run_id ─────────────────────────────────
FN="$WORK/log_meta_event.sh"
awk '/^log_meta_event\(\) \{/{f=1} f{print} f && p=="RUBY" && $0=="}"{exit} {p=$0}' "$DRIVER" > "$FN"
[[ -s "$FN" ]] || fail "R7: could not extract log_meta_event from $DRIVER"
# shellcheck disable=SC1090
source "$FN"

META="$TASK_DIR/meta.yaml"
AI_DEV_OFFICE_RUN_ID="$RUN_A" log_meta_event "$TASK" "$META" "prompt_assembly" "dev" "sources=agents/dev.md"
log_meta_event "$TASK" "$META" "context_provider" "dev" "provider=none"
attributed="$(ruby -ryaml -e 'd=YAML.safe_load(File.read(ARGV[0]))||{}; puts d["events"].map { |e| e["run_id"].to_s }.join(",")' "$META")"
[[ "$attributed" == "$RUN_A," ]] || fail "R7: expected the dispatch event attributed to $RUN_A and the other absent, got '$attributed'"
ruby "$VALIDATOR" "$META" >/dev/null || fail "R7: meta.yaml with run_id attribution must validate"
ok "R7: dispatch events carry run_id; events outside a dispatch omit it"

# ── R6: concurrent writers must not corrupt the store ─────────────────────────
CTASK="TASK-RID-002"
CTASK_DIR="$WORK/$CTASK"
mkdir -p "$CTASK_DIR"
for i in $(seq 1 "$WRITERS"); do
  printf 'prompt %s' "$i" | ruby "$RECORD" start "$CTASK_DIR" "$CTASK" reviewer "client=codex" >>"$WORK/ids.txt" 2>/dev/null &
done
wait

total="$(find "$CTASK_DIR/run-records" -name '*.yaml' | wc -l | tr -d ' ')"
uniq_ids="$(sort -u "$WORK/ids.txt" | grep -c .)"
echo "writers=$WRITERS  records=$total  unique_ids=$uniq_ids"
[[ "$total" -eq "$WRITERS" ]] || fail "R6: expected $WRITERS records, found $total (lost or clobbered records)"
[[ "$uniq_ids" -eq "$WRITERS" ]] || fail "R6: expected $WRITERS unique run ids, got $uniq_ids"
# Every record must still be intact YAML and pass the contract.
for record in "$CTASK_DIR/run-records"/*.yaml; do
  ruby "$VALIDATOR" "$record" >/dev/null || fail "R6: torn or invalid record after concurrent writes: $record"
done
ok "R6: $WRITERS concurrent writers produced $WRITERS distinct, intact records"

# ── R8: a failed fallback blames the runner that actually ran last ────────────
# codex fails switchably -> harness switches to cursor-agent -> cursor-agent
# fails non-switchably. $RUNNER is only assigned on success, so the record must
# come from the last ATTEMPTED runner, not the dispatch's starting runner.
STUBS="$WORK/bin"
mkdir -p "$STUBS"
cat > "$STUBS/codex" <<'SH'
#!/usr/bin/env bash
echo "insufficient_quota: Codex quota exhausted" >&2
exit 42
SH
cat > "$STUBS/cursor" <<'SH'
#!/usr/bin/env bash
echo "FATAL: unexpected internal error" >&2
exit 77
SH
chmod +x "$STUBS/codex" "$STUBS/cursor"

mkdir -p "$RUNS_DIR/$FB_TASK"
cat > "$RUNS_DIR/$FB_TASK/status.yaml" <<YAML
task_id: $FB_TASK
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
history: []
YAML

fb_status=0
PATH="$STUBS:$PATH" "$DRIVER" "$FB_TASK" dev codex >"$WORK/fb.log" 2>&1 || fb_status=$?
[[ "$fb_status" -eq 77 ]] || { cat "$WORK/fb.log"; fail "R8: expected the last runner's exit code 77, got $fb_status"; }
grep -q "switching to 'cursor-agent'" "$WORK/fb.log" || { cat "$WORK/fb.log"; fail "R8: harness did not switch to the fallback runner"; }

FB_RECORD="$(find "$RUNS_DIR/$FB_TASK/run-records" -name '*.yaml' | head -1)"
[[ -n "$FB_RECORD" ]] || fail "R8: no run record written for the failed dispatch"
[[ "$(field "$FB_RECORD" client)" == '"cursor-agent"' ]] \
  || fail "R8: client must be the last-attempted runner, got $(field "$FB_RECORD" client)"
[[ "$(field "$FB_RECORD" outcome.status)" == '"failed"' ]] || fail "R8: outcome.status must be failed"
[[ "$(field "$FB_RECORD" outcome.exit_code)" == "77" ]] || fail "R8: exit_code must be the last runner's"
[[ "$(field "$FB_RECORD" completed_at)" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]] || fail "R8: a failed run must still be closed out"
ruby "$VALIDATOR" "$FB_RECORD" >/dev/null || fail "R8: the failed-dispatch record must validate"
ok "R8: failed fallback attributes client/exit_code to the runner that ran last"

echo "[PASS] run-identity (R1-R8)"
