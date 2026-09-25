#!/usr/bin/env bash
# Issue #26: the knowledge closeout decision is deterministic and lane-neutral.
# Covers skip, capture, librarian, capture+reconcile, and same-scope reuse when
# new evidence arrives after the first pass.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$ROOT_DIR/scripts/knowledge-closeout.rb"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export AI_OFFICE_RUNS_DIR="$TMP_DIR/runs"
export AI_OFFICE_REVIEWS_DIR="$TMP_DIR/knowledge-reviews"
mkdir -p "$AI_OFFICE_RUNS_DIR/TASK-T-001" "$AI_OFFICE_REVIEWS_DIR"

fail() { echo "[FAIL] $*" >&2; exit 1; }

# field <yaml-file> <dotted.path> -> prints the value as JSON
field() {
  ruby -ryaml -rjson -e '
    node = YAML.safe_load(File.read(ARGV[0]))
    ARGV[1].split(".").each { |k| node = node.is_a?(Array) ? node[Integer(k)] : node.fetch(k) }
    puts JSON.generate(node)
  ' "$1" "$2"
}

expect() {
  local actual
  actual="$(field "$1" "$2")"
  [ "$actual" = "$3" ] || fail "$2: expected $3, got $actual ($1)"
}

run() { ruby "$HELPER" "$@"; }

echo "== Scenario 1: no durable delta -> explicit skip, recorded =="
run --scope quiet-session --durable-delta no --existing-impact no \
  --at 2026-09-26T01:00:00Z --record > "$TMP_DIR/skip.out"
SKIP_RECORD="$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T010000Z-quiet-session.yaml"
[ -f "$SKIP_RECORD" ] || fail "skip pass left no closeout record"
expect "$SKIP_RECORD" knowledge_closeout.action '["skip"]'
expect "$SKIP_RECORD" knowledge_closeout.reason '"no_durable_delta"'
expect "$SKIP_RECORD" knowledge_closeout.librarian_dispatch '"none"'
run --validate "$SKIP_RECORD" >/dev/null

echo "== Scenario 2: new durable task knowledge -> capture only =="
run --scope feature-a --task TASK-T-001 --durable-delta yes --existing-impact no \
  --evidence ev-001 --at 2026-09-26T02:00:00Z --record >/dev/null
CAP="$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T020000Z-feature-a.yaml"
expect "$CAP" knowledge_closeout.action '["capture"]'
expect "$CAP" knowledge_closeout.reason '"new_durable_knowledge"'
expect "$CAP" knowledge_closeout.capture.via '"task_run"'
expect "$CAP" knowledge_closeout.capture.step '"create"'
expect "$CAP" knowledge_closeout.capture.artifact '"runs/TASK-T-001/knowledge-capture-output.yaml"'
expect "$CAP" knowledge_closeout.librarian_dispatch '"none"'

echo "== Scenario 2b: capture without a task routes through the librarian capture trigger =="
run --scope feature-z --durable-delta yes --existing-impact no --evidence abc123 \
  --at 2026-09-26T02:30:00Z > "$TMP_DIR/cap-notask.yaml"
expect "$TMP_DIR/cap-notask.yaml" knowledge_closeout.action '["capture"]'
expect "$TMP_DIR/cap-notask.yaml" knowledge_closeout.capture.via '"librarian_capture_trigger"'
expect "$TMP_DIR/cap-notask.yaml" knowledge_closeout.capture.artifact 'null'
expect "$TMP_DIR/cap-notask.yaml" knowledge_closeout.librarian_dispatch '"spawn"'
[ ! -e "$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T023000Z-feature-z.yaml" ] || fail "dry run wrote a record"

echo "== Scenario 3: existing knowledge drift only -> librarian =="
run --scope drift-b --durable-delta no --existing-impact yes --evidence src/a.go \
  --note "Knowledge Base/20 Flows/B.md" --at 2026-09-26T03:00:00Z --record >/dev/null
LIB="$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T030000Z-drift-b.yaml"
expect "$LIB" knowledge_closeout.action '["librarian"]'
expect "$LIB" knowledge_closeout.reason '"existing_knowledge_drift"'
expect "$LIB" knowledge_closeout.librarian_dispatch '"spawn"'
expect "$LIB" knowledge_closeout.capture 'null'
ruby -ryaml -e '
  must = YAML.safe_load(File.read(ARGV[0])).dig("knowledge_closeout", "must_inspect")
  abort "missing Review Queue" unless must.include?("knowledge-base/Knowledge Base/Review Queue.md")
  abort "missing touched note" unless must.include?("knowledge-base/Knowledge Base/20 Flows/B.md")
' "$LIB"

echo "== Scenario 4: new knowledge + existing impact -> capture, then librarian reconcile =="
cat > "$AI_OFFICE_RUNS_DIR/TASK-T-001/knowledge-capture-output.yaml" <<'YAML'
task_id: TASK-T-001
capture_type: flow
target_repo: knowledge-base
target_note: "Knowledge Base/20 Flows/A.md"
summary: "A flow."
sources: ["svc/a.go"]
recommended_action: update_note
requires_human_review: true
note_patch: "x"
YAML
touch "$AI_OFFICE_REVIEWS_DIR/20260925T000000Z-feature-c.yaml"
run --scope feature-c --task TASK-T-001 --durable-delta yes --existing-impact yes \
  --evidence ev-001 --at 2026-09-26T04:00:00Z --record >/dev/null
BOTH="$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T040000Z-feature-c.yaml"
expect "$BOTH" knowledge_closeout.action '["capture","librarian_reconcile"]'
expect "$BOTH" knowledge_closeout.reason '"new_knowledge_with_existing_impact"'
expect "$BOTH" knowledge_closeout.capture.step '"update"'
expect "$BOTH" knowledge_closeout.capture.existing_recommended_action '"update_note"'
expect "$BOTH" knowledge_closeout.librarian_dispatch '"followup"'
ruby -ryaml -e '
  kc = YAML.safe_load(File.read(ARGV[0]))["knowledge_closeout"]
  must = kc["must_inspect"]
  abort "reconcile must inspect the capture proposal" unless must.include?("runs/TASK-T-001/knowledge-capture-output.yaml")
  abort "reconcile must inspect the prior audit" unless must.include?("knowledge-reviews/20260925T000000Z-feature-c.yaml")
  abort "prior audit not listed" unless kc["prior_librarian_audits"] == ["knowledge-reviews/20260925T000000Z-feature-c.yaml"]
' "$BOTH"
run --validate "$BOTH" >/dev/null

echo "== Scenario 5: same scope, no new evidence -> skip as already routed =="
run --scope feature-c --task TASK-T-001 --durable-delta yes --existing-impact yes \
  --evidence ev-001 --at 2026-09-26T05:00:00Z --record >/dev/null
AGAIN="$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T050000Z-feature-c.yaml"
expect "$AGAIN" knowledge_closeout.action '["skip"]'
expect "$AGAIN" knowledge_closeout.reason '"no_new_evidence"'
expect "$AGAIN" knowledge_closeout.prior_closeouts '["knowledge-reviews/closeouts/20260926T040000Z-feature-c.yaml"]'

echo "== Scenario 6: same scope, new evidence -> reuse the librarian with a follow-up =="
run --scope feature-c --task TASK-T-001 --durable-delta no --existing-impact yes \
  --evidence ev-001 --evidence ev-002 --at 2026-09-26T06:00:00Z --record >/dev/null
NEWEV="$AI_OFFICE_REVIEWS_DIR/closeouts/20260926T060000Z-feature-c.yaml"
expect "$NEWEV" knowledge_closeout.action '["librarian"]'
expect "$NEWEV" knowledge_closeout.librarian_dispatch '"followup"'
expect "$NEWEV" signals.new_evidence_refs '["ev-002"]'

echo "== Scenario 7: a claimed delta without evidence is refused =="
if run --scope feature-d --durable-delta yes --existing-impact no >/dev/null 2>&1; then
  fail "delta without evidence was accepted"
fi

echo "== Scenario 8: validator rejects an action that contradicts the signals =="
ruby -ryaml -e '
  d = YAML.safe_load(File.read(ARGV[0]))
  d["knowledge_closeout"]["action"] = ["librarian"]
  File.write(ARGV[1], YAML.dump(d))
' "$SKIP_RECORD" "$TMP_DIR/contradiction.yaml"
if run --validate "$TMP_DIR/contradiction.yaml" >/dev/null 2>&1; then
  fail "validator accepted an action the signals do not produce"
fi

echo "== Scenario 9: the dashboard reader ignores the closeouts/ subdirectory =="
grep -Fq "entry.isFile()" "$ROOT_DIR/dashboard/server/src/services/knowledgeReviews.ts"

echo "Knowledge closeout routing passed"
