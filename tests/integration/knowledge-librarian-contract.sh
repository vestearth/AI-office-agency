#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VALIDATOR="$ROOT_DIR/scripts/validate-knowledge-librarian.rb"
TEMPLATE="$ROOT_DIR/templates/knowledge-librarian-output.yaml"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "== Scenario 0: workflow requires a bounded session-end trigger =="
grep -Fq "end of every non-trivial working session" "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "independent of task \`done\`" "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "before the final response" "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "parent thread plus the coherent" "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "do not spawn another one" "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq '`followup_task`' "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "QA," "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "publish," "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq 'runs/<task-id>/knowledge-capture-output.yaml' "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "reconcile or reference that proposal instead of creating" "$ROOT_DIR/workflows/knowledge-librarian.md"
grep -Fq "does not create a task \`done\` hook" "$ROOT_DIR/workflows/knowledge-librarian.md"

echo "== Scenario 1: shipped template validates =="
ruby "$VALIDATOR" "$TEMPLATE"

echo "== Scenario 1b: canonical JSON mode returns the normalized dashboard model =="
ruby "$VALIDATOR" --json "$TEMPLATE" > "$TMP_DIR/normalized.json"
ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV[0]))
  abort "expected a valid normalized review" unless payload["valid"] == true
  review = payload.fetch("review")
  abort "missing normalized review id" unless review["reviewId"].start_with?("KLR-")
  abort "incorrect normalized counts" unless review["findingsCount"] == 1 && review["changesCount"] == 1
' "$TMP_DIR/normalized.json"

echo "== Scenario 2: proposal-only output cannot claim an applied write =="
ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  data["changes"][0]["disposition"] = "applied"
  File.write(ARGV[1], YAML.dump(data))
' "$TEMPLATE" "$TMP_DIR/invalid-proposal.yaml"
if ruby "$VALIDATOR" "$TMP_DIR/invalid-proposal.yaml" >/dev/null 2>&1; then
  echo "[FAIL] proposal-only output accepted an applied change" >&2
  exit 1
fi

echo "== Scenario 3: policy-authorized auto-write validates =="
ruby -ryaml -rfileutils -e '
  root = ARGV[0]
  FileUtils.mkdir_p(File.join(root, "knowledge-base"))
  policy = {
    "version" => 1,
    "scopes" => {
      "example_scope" => {
        "approved_by" => "human",
        "approved_at" => "2026-07-15",
        "review_mode" => "post_write",
        "write_targets" => [{
          "target_class" => "project_note",
          "path_pattern" => "\\AKnowledge Base/10 Projects/Example Product/.+\\.md\\z",
          "actions" => ["create", "update"]
        }]
      }
    }
  }
  File.write(File.join(root, "knowledge-base/policy.yaml"), YAML.dump(policy))
' "$TMP_DIR/repo"
ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  data["scope"]["product"] = "example_scope"
  data["write_mode"] = "approved_scope_auto_write"
  data["review_mode"] = "post_write"
  data["authorization"] = {
    "approved_scope" => "example_scope",
    "policy_source" => "knowledge-base/policy.yaml",
    "approved_by" => "human",
    "approved_at" => "2026-07-15"
  }
  data["changes"][0]["disposition"] = "applied"
  File.write(ARGV[1], YAML.dump(data))
' "$TEMPLATE" "$TMP_DIR/valid-auto-write.yaml"
AI_OFFICE_REPO_ROOT="$TMP_DIR/repo" ruby "$VALIDATOR" "$TMP_DIR/valid-auto-write.yaml"

echo "== Scenario 4: auto-write rejects a target outside policy =="
ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  data["changes"][0]["note_path"] = "Knowledge Base/40 Lessons/Transaction Locking.md"
  data["changes"][0]["target_class"] = "shared_knowledge"
  File.write(ARGV[1], YAML.dump(data))
' "$TMP_DIR/valid-auto-write.yaml" "$TMP_DIR/invalid-shared-write.yaml"
if AI_OFFICE_REPO_ROOT="$TMP_DIR/repo" ruby "$VALIDATOR" "$TMP_DIR/invalid-shared-write.yaml" >/dev/null 2>&1; then
  echo "[FAIL] auto-write accepted a target outside policy" >&2
  exit 1
fi

echo "== Scenario 5: resolved finding requires confirmed closure evidence =="
ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  data["findings"][0]["evidence_state"] = "partial"
  File.write(ARGV[1], YAML.dump(data))
' "$TEMPLATE" "$TMP_DIR/invalid-resolution.yaml"
if ruby "$VALIDATOR" "$TMP_DIR/invalid-resolution.yaml" >/dev/null 2>&1; then
  echo "[FAIL] resolved finding accepted partial evidence" >&2
  exit 1
fi

echo "== Scenario 6: canonical validator rejects impossible ISO date-time values =="
ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  data["generated_at"] = "2026-02-30T24:00:00Z"
  File.write(ARGV[1], YAML.dump(data))
' "$TEMPLATE" "$TMP_DIR/invalid-date-time.yaml"
if ruby "$VALIDATOR" --json "$TMP_DIR/invalid-date-time.yaml" > "$TMP_DIR/invalid-date-time.json"; then
  echo "[FAIL] canonical validator accepted an impossible date-time" >&2
  exit 1
fi
ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV[0]))
  abort "expected structured validation errors" unless payload["valid"] == false && payload["errors"].any? { |error| error.include?("generated_at") }
' "$TMP_DIR/invalid-date-time.json"

echo "Knowledge Librarian contract smoke passed"
