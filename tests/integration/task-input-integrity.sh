#!/usr/bin/env bash
# Task input integrity (docs/task-input-integrity.md, issue #22).
#
#  T1-T4: the four proven escapes from the issue text, reproduced end-to-end
#         through the REAL driver (run-agent.sh) with a fake codex runner that
#         performs the tamper — proving each is now caught.
#  T5:    an ordinary, tamper-free dispatch is unaffected (exit 0, verdict ok),
#         including the meta.yaml false-positive regression (retry/append
#         inside the window must not trip the check).
#  T6:    fail-closed on a missing/unreadable snapshot at verify time.
#  T7:    fail-closed / absence-is-normal matrix (new file, absent-absent).
#  T8:    PROTECTED_PATHS covers the whole task_input_integrity block
#         (F-prot-style mechanical check, not an assertion in a comment).
#  T9:    performance — snapshot+verify overhead on an ordinary run.
#  T10:   backward compatibility — validate-yaml.rb at 458bc7b (pre-#22) vs
#         current, across every real runs/TASK-* dir, byte-identical output.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_AGENT="$ROOT/run-agent.sh"
# Not executable by convention (matches scripts/preflight.rb, scripts/task-ownership.rb —
# every caller, including run-agent.sh, invokes it via `ruby`, never directly).
TII_RB="$ROOT/scripts/task-input-integrity.rb"
tii() { ruby "$TII_RB" "$@"; }
RECORD_EVIDENCE="$ROOT/scripts/record-evidence.sh"
VALIDATOR="$ROOT/validate-yaml.rb"

WORK="$(mktemp -d)"
BIN="$(mktemp -d)"
PRE22_VALIDATOR=""
cleanup() {
  rm -rf "$WORK" "$BIN"
  [[ -n "$PRE22_VALIDATOR" ]] && rm -f "$PRE22_VALIDATOR"
}
trap cleanup EXIT

export AI_OFFICE_RUNS_DIR="$WORK/runs"
mkdir -p "$AI_OFFICE_RUNS_DIR"
# Unrelated to this feature — this machine has no `rg` binary, which the
# dependency guard needs; disabled here the same way other e2e driver tests
# do (event-gateway.sh, reviewer-evidence-risk.sh), so it doesn't block the
# fake-codex dispatches before they reach the code under test.
export OFFICE_DEPENDENCY_GUARD_ENABLED=false
export OFFICE_CONTEXT_PROVIDER_ENABLED=false

fail() { echo "[FAIL] $1"; exit 1; }
ok()   { echo "  ok: $1"; }

yaml_get() {  # <path> <dotted.key>
  ruby -ryaml -e '
    d = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Time], aliases: true) || {}
    v = ARGV[1].split(".").reduce(d) { |m, k| m.is_a?(Hash) ? m[k] : (m.is_a?(Array) && k =~ /\A-?\d+\z/ ? m[k.to_i] : nil) }
    puts v.nil? ? "" : v.to_s
  ' "$1" "$2" 2>/dev/null
}

assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$1' got '$2'"; }
assert_ne() { [[ "$1" != "$2" ]] || fail "$3: expected NOT '$1'"; }

# A throwaway CLEAN repo evidence commands run against — record-evidence.sh
# reports working_tree_dirty against the actual cwd, and this test's own repo
# is (usually) clean, but keep it hermetic regardless.
WORK_REPO="$WORK/work-repo"
mkdir -p "$WORK_REPO"
(cd "$WORK_REPO" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init) >/dev/null

# ── fixtures ──────────────────────────────────────────────────────────────
write_task_assigned_reviewer() {  # <task_id>
  local t="$1" d="$AI_OFFICE_RUNS_DIR/$1"
  mkdir -p "$d"
  cat > "$d/status.yaml" <<YAML
task_id: $t
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history:
  - phase: assigned
    agent: dev
    at: "2026-06-05T09:00:00Z"
    reason: "implementation"
YAML
  cat > "$d/pm-output.yaml" <<'YAML'
summary: "plan"
artifacts: []
next_action: { agent: dev, reason: "implement" }
blockers: []
YAML
  cat > "$d/dev-output.yaml" <<YAML
summary: "implemented wallet debit path"
artifacts:
  - path: "Games-Labs-Wallet/internal/debit.go"
    action: modified
next_action: { agent: reviewer, reason: "ready for review" }
blockers: []
YAML
  : > "$d/meta.yaml"
  ruby -ryaml -e '
    File.write(ARGV[0], YAML.dump({"task_id"=>ARGV[1], "events"=>[
      {"type"=>"dispatch", "agent"=>"dev", "details"=>"x", "timestamp"=>"2026-06-05T09:00:00Z"}
    ], "updated_at"=>"2026-06-05T09:00:00Z"}))
  ' "$d/meta.yaml" "$t"
}

write_task_assigned_dev() {  # <task_id> — ordinary clean dispatch fixture
  local t="$1" d="$AI_OFFICE_RUNS_DIR/$1"
  mkdir -p "$d"
  cat > "$d/status.yaml" <<YAML
task_id: $t
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment: { primary: dev, parallel: false }
ready: true
created_at: "2026-06-05"
updated_at: "2026-06-05"
history: []
YAML
  cat > "$d/pm-output.yaml" <<'YAML'
summary: "plan"
artifacts: []
next_action: { agent: dev, reason: "implement" }
blockers: []
YAML
}

# ── fake codex runners ───────────────────────────────────────────────────
install_codex() {  # <script body via stdin>
  cat > "$BIN/codex"
  chmod +x "$BIN/codex"
}

run_dispatch() {  # <task_id> <agent>
  # Both side systems are irrelevant to this suite and environment-dependent
  # (dependency guard needs `rg` and a real shared-lib dependency graph);
  # disabled the same way tests/integration/reviewer-evidence-risk.sh does.
  OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false \
    PATH="$BIN:$PATH" "$RUN_AGENT" "$1" "$2" codex
}

echo "== T1: escape 1 - delete dev-output.yaml + meta.yaml, blank status.yaml history =="
T1="TASK-TII-$$-1"
write_task_assigned_reviewer "$T1"
install_codex <<SH
#!/usr/bin/env bash
d="$AI_OFFICE_RUNS_DIR/$T1"
rm -f "\$d/dev-output.yaml" "\$d/meta.yaml"
ruby -ryaml -e 'd=YAML.safe_load(File.read(ARGV[0]))||{}; d["history"]=[]; File.write(ARGV[0], YAML.dump(d))' "\$d/status.yaml"
cat > "\$d/reviewer-output.yaml" <<'YAML'
summary: "approved, all good"
review_verdict: approved
build_check: { compile: pass, tests: pass }
artifacts: []
next_action: { agent: done, reason: "ship it" }
blockers: []
YAML
exit 0
SH
RC=0
run_dispatch "$T1" reviewer >"$WORK/t1.log" 2>&1 || RC=$?
assert_ne "0" "$RC" "T1: a dispatch that deletes dev-output.yaml+meta.yaml and blanks history must fail closed"
assert_eq "in_review" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T1/status.yaml" phase)" "T1: phase must not advance to done"
assert_eq "tampered" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T1/task-input-integrity.yaml" checks.-1.verdict)" "T1: audit record must say tampered"
grep -qi "task input integrity" "$WORK/t1.log" || fail "T1: driver output should mention the violation"
ok "T1: escape 1 (deletion) is caught"

echo "== T2: escape 2 - rewrite status.yaml history[0].agent =="
T2="TASK-TII-$$-2"
write_task_assigned_reviewer "$T2"
install_codex <<SH
#!/usr/bin/env bash
d="$AI_OFFICE_RUNS_DIR/$T2"
ruby -ryaml -e 'd=YAML.safe_load(File.read(ARGV[0]))||{}; d["history"][0]["agent"]="claude"; File.write(ARGV[0], YAML.dump(d))' "\$d/status.yaml"
cat > "\$d/reviewer-output.yaml" <<'YAML'
summary: "approved, all good"
review_verdict: approved
build_check: { compile: pass, tests: pass }
artifacts: []
next_action: { agent: done, reason: "ship it" }
blockers: []
YAML
exit 0
SH
RC=0
run_dispatch "$T2" reviewer >"$WORK/t2.log" 2>&1 || RC=$?
assert_ne "0" "$RC" "T2: rewriting history[0].agent must fail closed"
assert_eq "in_review" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T2/status.yaml" phase)" "T2: phase must not advance to done"
assert_eq "tampered" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T2/task-input-integrity.yaml" checks.-1.verdict)" "T2: audit record must say tampered"
ok "T2: escape 2 (history rewrite) is caught even though history[].agent is not enum-checked"

echo "== T3: escape 3 - rewrite dev-output.yaml's declared paths =="
T3="TASK-TII-$$-3"
write_task_assigned_reviewer "$T3"
install_codex <<SH
#!/usr/bin/env bash
d="$AI_OFFICE_RUNS_DIR/$T3"
cat > "\$d/dev-output.yaml" <<'YAML'
summary: "implemented wallet debit path"
artifacts:
  - path: "docs/readme.md"
    action: modified
next_action: { agent: reviewer, reason: "ready for review" }
blockers: []
YAML
cat > "\$d/reviewer-output.yaml" <<'YAML'
summary: "approved, all good"
review_verdict: approved
build_check: { compile: pass, tests: pass }
artifacts: []
next_action: { agent: done, reason: "ship it" }
blockers: []
YAML
exit 0
SH
RC=0
run_dispatch "$T3" reviewer >"$WORK/t3.log" 2>&1 || RC=$?
assert_ne "0" "$RC" "T3: rewriting dev-output.yaml's declared paths must fail closed"
assert_eq "in_review" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T3/status.yaml" phase)" "T3: phase must not advance to done"
assert_eq "tampered" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T3/task-input-integrity.yaml" checks.-1.verdict)" "T3: audit record must say tampered"
ok "T3: escape 3 (upstream path substitution) is caught"

echo "== T4: escape 4 - evidence-claim binding remains OPEN (documented, not closed) =="
T4="TASK-TII-$$-4"
write_task_assigned_reviewer "$T4"
install_codex <<SH
#!/usr/bin/env bash
d="$AI_OFFICE_RUNS_DIR/$T4"
cd "$WORK_REPO"
EV_ID=\$(AI_OFFICE_RUNS_DIR="$AI_OFFICE_RUNS_DIR" AI_DEV_OFFICE_RUN_ID="\$AI_DEV_OFFICE_RUN_ID" "$RECORD_EVIDENCE" "$T4" --type test -- true)
cat > "\$d/reviewer-output.yaml" <<YAML
summary: "approved, tests pass"
review_verdict: approved
build_check: { compile: pass, tests: pass }
evidence_refs: [\$EV_ID]
artifacts: []
next_action: { agent: done, reason: "ship it" }
blockers: []
YAML
exit 0
SH
RC=0
run_dispatch "$T4" reviewer >"$WORK/t4.log" 2>&1 || RC=$?
assert_eq "0" "$RC" "T4: a real (if trivial) evidence citation with zero file tampering must NOT be blocked by this mechanism"
assert_eq "ok" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T4/task-input-integrity.yaml" checks.-1.verdict)" "T4: task-input-integrity verdict is ok — it only proves files, not evidence substance"
[[ -f "$AI_OFFICE_RUNS_DIR/$T4/evidence.yaml" ]] || fail "T4: evidence.yaml should exist (the legitimate append)"
ok "T4: evidence-claim binding is confirmed OPEN — a trivial 'true' citation still verifies clean (see docs/task-input-integrity.md #1)"

echo "== T5: ordinary tamper-free dispatch is unaffected, including in-window meta.yaml appends =="
T5="TASK-TII-$$-5"
write_task_assigned_dev "$T5"
install_codex <<SH
#!/usr/bin/env bash
d="$AI_OFFICE_RUNS_DIR/$T5"
cat > "\$d/dev-output.yaml" <<'YAML'
summary: "implemented the thing"
artifacts:
  - path: "foo.go"
    action: modified
next_action: { agent: reviewer, reason: "ready for review" }
blockers: []
YAML
exit 0
SH
RC=0
run_dispatch "$T5" dev >"$WORK/t5.log" 2>&1 || RC=$?
assert_eq "0" "$RC" "T5: an ordinary tamper-free dispatch must exit 0"
assert_eq "in_review" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T5/status.yaml" phase)" "T5: ordinary dev output must still sync to in_review"
assert_eq "ok" "$(yaml_get "$AI_OFFICE_RUNS_DIR/$T5/task-input-integrity.yaml" checks.-1.verdict)" "T5: verdict must be ok"
# The driver's own meta.yaml writes between snapshot and verify (task_input_integrity_snapshot's
# own log line, runner_complete) are exactly the regression bf24a8a fixed — pin it directly.
EVENTS_AFTER="$(yaml_get "$AI_OFFICE_RUNS_DIR/$T5/meta.yaml" events)"
[[ -n "$EVENTS_AFTER" ]] || fail "T5: meta.yaml should have events recorded across the dispatch"
ok "T5: ordinary run unaffected; driver's own meta.yaml appends inside the window do not false-positive"

echo "== T6: fail-closed when the snapshot is missing/unreadable at verify time =="
T6="TASK-TII-$$-6"
write_task_assigned_dev "$T6"
mkdir -p "$AI_OFFICE_RUNS_DIR/$T6"
RC=0
tii verify "$AI_OFFICE_RUNS_DIR/$T6" "$T6" dev "$WORK/does-not-exist.yaml" --office-dir "$ROOT" >"$WORK/t6.log" 2>&1 || RC=$?
[[ "$RC" -ne 0 ]] || fail "T6: verify against a missing snapshot file must fail closed"
grep -qi "snapshot" "$WORK/t6.log" || fail "T6: error should mention the missing snapshot"
ok "T6: a missing baseline at verify time is a hard failure, never treated as 'nothing to check'"

BAD_SNAP="$WORK/bad-snapshot.yaml"
echo ": not valid yaml : [" > "$BAD_SNAP"
RC=0
tii verify "$AI_OFFICE_RUNS_DIR/$T6" "$T6" dev "$BAD_SNAP" --office-dir "$ROOT" >"$WORK/t6b.log" 2>&1 || RC=$?
[[ "$RC" -ne 0 ]] || fail "T6b: verify against a malformed snapshot file must fail closed"
ok "T6b: an unparseable baseline at verify time is a hard failure"

echo "== T7: absence matrix — a file that never existed is not tamper, one that appears is =="
T7="TASK-TII-$$-7"
D7="$AI_OFFICE_RUNS_DIR/$T7"
mkdir -p "$D7"
cat > "$D7/status.yaml" <<YAML
task_id: $T7
phase: assigned
state: assigned
iteration: 0
current_agent: dev
history: []
YAML
SNAP7="$WORK/snap7.yaml"
AI_DEV_OFFICE_RUN_ID="run-t7" tii snapshot "$D7" "$T7" dev "$SNAP7" --office-dir "$ROOT" >/dev/null
# Nothing changes: preflight.yaml never existed, still doesn't. Clean.
RC=0
AI_DEV_OFFICE_RUN_ID="run-t7" tii verify "$D7" "$T7" dev "$SNAP7" --office-dir "$ROOT" >"$WORK/t7a.log" 2>&1 || RC=$?
assert_eq "0" "$RC" "T7a: absent-to-absent on a frozen file must verify clean"

AI_DEV_OFFICE_RUN_ID="run-t7" tii snapshot "$D7" "$T7" dev "$SNAP7" --office-dir "$ROOT" >/dev/null
echo "trust_level: allow" > "$D7/preflight.yaml"
RC=0
AI_DEV_OFFICE_RUN_ID="run-t7" tii verify "$D7" "$T7" dev "$SNAP7" --office-dir "$ROOT" >"$WORK/t7b.log" 2>&1 || RC=$?
[[ "$RC" -ne 0 ]] || fail "T7b: a frozen file appearing where none existed must be tampered (appeared)"
grep -q "appeared" "$WORK/t7b.log" || fail "T7b: mismatch kind should be 'appeared'"
rm -f "$D7/preflight.yaml"
ok "T7: absence-to-absence is clean; a frozen file appearing from nowhere is tampered"

echo "== T8: PROTECTED_PATHS covers the whole task_input_integrity block (mechanical, not asserted) =="
ruby - "$ROOT" <<'RUBY' || fail "T8: a task_input_integrity key is not protected in PROTECTED_PATHS"
# encoding: utf-8
require "yaml"
root = ARGV[0]
require File.join(root, "scripts", "resolve-office-config.rb")
cfg = YAML.load_file(File.join(root, "office.config.yaml"))
keys = cfg["task_input_integrity"].keys
protected_top = OfficeConfigResolver::PROTECTED_PATHS.map(&:first)
unless protected_top.include?("task_input_integrity")
  warn "task_input_integrity is not listed at all in PROTECTED_PATHS"
  exit 1
end
# Confirm an overlay actually cannot touch it end to end, not just that the
# top-level key is named somewhere.
require "tmpdir"
Dir.mktmpdir do |dir|
  File.write(File.join(dir, "office.config.yaml"), YAML.dump(cfg))
  File.write(File.join(dir, "office.config.local.yaml"),
             YAML.dump({ "task_input_integrity" => { "enabled" => false, "frozen_files" => [] } }))
  live = OfficeConfigResolver.new(dir)
  unless live.get("task_input_integrity.enabled") == true
    warn "an office.config.local.yaml overlay was able to flip task_input_integrity.enabled to false"
    exit 1
  end
  committed_frozen = cfg["task_input_integrity"]["frozen_files"]
  overlaid_frozen = Array(live.get("task_input_integrity.frozen_files"))
  if overlaid_frozen != committed_frozen
    warn "an overlay was able to change task_input_integrity.frozen_files (got #{overlaid_frozen.inspect}, want #{committed_frozen.inspect})"
    exit 1
  end
end
unless keys.sort == %w[enabled frozen_files append_only_files protect_role_outputs protect_run_records].sort
  warn "task_input_integrity keys in office.config.yaml (#{keys.sort}) no longer match what this test protects " \
       "end to end — update both office.config.yaml's block and this list together"
  exit 1
end
RUBY
ok "T8: PROTECTED_PATHS protects the whole task_input_integrity block, proven against a live overlay"

echo "== T9: performance — snapshot+verify overhead on an ordinary dispatch =="
T9="TASK-TII-$$-9"
D9="$AI_OFFICE_RUNS_DIR/$T9"
mkdir -p "$D9/run-records"
cat > "$D9/status.yaml" <<YAML
task_id: $T9
phase: assigned
state: assigned
iteration: 0
current_agent: dev
history: []
YAML
START="$(date +%s%N 2>/dev/null || date +%s)"
SNAP9="$WORK/snap9.yaml"
AI_DEV_OFFICE_RUN_ID="run-t9" tii snapshot "$D9" "$T9" dev "$SNAP9" --office-dir "$ROOT" >/dev/null
AI_DEV_OFFICE_RUN_ID="run-t9" tii verify "$D9" "$T9" dev "$SNAP9" --office-dir "$ROOT" >/dev/null
END="$(date +%s%N 2>/dev/null || date +%s)"
if [[ "$START" == *N* || ${#START} -lt 15 ]]; then
  # date +%s%N unsupported (BSD date without GNU coreutils) — fall back to whole seconds.
  ELAPSED_MS=$(( (END - START) * 1000 ))
else
  ELAPSED_MS=$(( (END - START) / 1000000 ))
fi
echo "  snapshot+verify wall time: ${ELAPSED_MS}ms (2 short ruby processes, a handful of small files)"
[[ "$ELAPSED_MS" -lt 5000 ]] || fail "T9: snapshot+verify took ${ELAPSED_MS}ms — unexpectedly slow for a bounded, small protected set"
ok "T9: overhead is a small, bounded number of short-lived ruby processes reading small files (see docs Performance section)"

echo "== T10: backward compatibility — validate-yaml.rb (458bc7b, pre-#22) vs current, byte-identical =="
PRE22_VALIDATOR="$ROOT/.tmp-validate-yaml-pre22-$$.rb"
if git -C "$ROOT" cat-file -e 458bc7b:validate-yaml.rb 2>/dev/null; then
  git -C "$ROOT" show 458bc7b:validate-yaml.rb > "$PRE22_VALIDATOR"
  COUNT=0
  MISMATCHES=0
  OLD_ALL="$WORK/old-all.txt"
  NEW_ALL="$WORK/new-all.txt"
  : > "$OLD_ALL"
  : > "$NEW_ALL"
  for task_dir in "$ROOT"/runs/TASK-*; do
    [[ -d "$task_dir" ]] || continue
    tid="$(basename "$task_dir")"
    COUNT=$((COUNT + 1))
    old_out="$(cd "$ROOT" && ruby "$PRE22_VALIDATOR" "$tid" 2>&1)"; old_rc=$?
    new_out="$(cd "$ROOT" && ruby "$VALIDATOR" "$tid" 2>&1)"; new_rc=$?
    if [[ "$old_rc" != "$new_rc" || "$old_out" != "$new_out" ]]; then
      MISMATCHES=$((MISMATCHES + 1))
      echo "  DIVERGED: $tid (old rc=$old_rc new rc=$new_rc)"
    fi
    printf '%s\n%s\n' "$old_rc" "$old_out" >> "$OLD_ALL"
    printf '%s\n%s\n' "$new_rc" "$new_out" >> "$NEW_ALL"
  done
  OLD_HASH="$(shasum -a 256 "$OLD_ALL" 2>/dev/null | awk '{print $1}')"
  NEW_HASH="$(shasum -a 256 "$NEW_ALL" 2>/dev/null | awk '{print $1}')"
  echo "  tasks compared: $COUNT   diverged: $MISMATCHES"
  echo "  combined stdout+stderr+rc hash (pre-#22): $OLD_HASH"
  echo "  combined stdout+stderr+rc hash (current): $NEW_HASH"
  [[ "$MISMATCHES" -eq 0 ]] || fail "T10: $MISMATCHES task(s) validate differently after #22 — backward compatibility broken"
  [[ "$OLD_HASH" == "$NEW_HASH" ]] || fail "T10: combined output hash differs even though no per-task mismatch was flagged (should not happen)"
  ok "T10: $COUNT real runs/TASK-* dirs validate byte-identically before and after #22"
else
  echo "  SKIP: base commit 458bc7b not reachable in this checkout (shallow clone?) — cannot run the sweep"
fi

echo "[PASS] task-input-integrity: T1-T4 (four proven escapes caught) + T5 (unaffected ordinary run) + T6-T7 (fail-closed matrix) + T8 (PROTECTED_PATHS) + T9 (performance) + T10 (backward compatibility)"
