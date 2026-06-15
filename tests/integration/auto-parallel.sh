#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS_DIR="$ROOT_DIR/runs"
RUN_AGENT="$ROOT_DIR/run-agent.sh"

SUFFIX="$(date +%s)$$"
VALID_TASK="TASK-${SUFFIX}1"
CONFLICT_TASK="TASK-${SUFFIX}2"
SHARED_TASK="TASK-${SUFFIX}3"
SEQUENTIAL_TASK="TASK-${SUFFIX}4"
MISSING_TASK="TASK-${SUFFIX}9"
FAKE_BIN="$(mktemp -d)"
FAKE_WORKSPACE="$(mktemp -d)"

cleanup() {
  rm -rf \
    "$RUNS_DIR/$VALID_TASK" \
    "$RUNS_DIR/$CONFLICT_TASK" \
    "$RUNS_DIR/$SHARED_TASK" \
    "$RUNS_DIR/$SEQUENTIAL_TASK" \
    "$RUNS_DIR/$MISSING_TASK" \
    "$FAKE_BIN" \
    "$FAKE_WORKSPACE"
}
trap cleanup EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  local message="$3"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "[FAIL] $message: expected '$expected' in $file"
    echo "----- $file -----"
    cat "$file"
    exit 1
  fi
}

assert_file() {
  local file="$1"
  local message="$2"
  if [[ ! -f "$file" ]]; then
    echo "[FAIL] $message: missing $file"
    exit 1
  fi
}

create_guard_workspace() {
  mkdir -p "$FAKE_WORKSPACE/Games-Labs-Example"
  cat > "$FAKE_WORKSPACE/Games-Labs-Example/go.mod" <<'MOD'
module github.com/SparqLab/Games-Labs-Example

require github.com/SparqLab/shared-lib v0.0.1
MOD
  cat > "$FAKE_WORKSPACE/Games-Labs-Example/Dockerfile" <<'DOCKER'
FROM golang:1.22
WORKDIR /app
COPY . .
RUN go build -mod=readonly ./cmd
DOCKER
}

create_fake_codex() {
  cat > "$FAKE_BIN/codex" <<'RUBY'
#!/usr/bin/env ruby
require "yaml"

# codex is invoked with the prompt as the trailing positional arg
# (`codex ... exec --skip-git-repo-check "$PROMPT"`); older/cursor-agent
# invocations pass it via `-p`. Accept either form.
prompt = (ARGV.each_cons(2).find { |flag, _| flag == "-p" }&.last || ARGV.last).to_s
task_id = prompt[/task_id:\s*"?([^"\n]+)"?/, 1] || prompt[%r{runs/(TASK-[0-9]+)/}, 1] || "TASK-000"
task_dir = File.join(Dir.pwd, "runs", task_id)

def write_yaml(path, payload)
  File.write(path, YAML.dump(payload).sub(/\A---\s*\n/, ""))
end

context_sources = {
  "github" => {"branch" => "", "pr" => ""},
  "socraticode" => {"status" => "skipped", "queries" => [], "relevant_symbols" => [], "notes" => "integration fake"}
}

if prompt.include?("# PMAgent")
  subtasks =
    case task_id
    when /2$/
      [
        {"order" => 1, "id" => "api", "description" => "API work", "agent" => "dev", "owned_files" => ["service/shared.go"], "parallel_safe" => true},
        {"order" => 2, "id" => "docs", "description" => "Docs work", "agent" => "dev-2", "owned_files" => ["service/shared.go"], "parallel_safe" => true}
      ]
    when /3$/
      [
        {"order" => 1, "id" => "mod-a", "description" => "Module work", "agent" => "dev", "owned_files" => ["Games-Labs-Auth/go.mod"], "parallel_safe" => true},
        {"order" => 2, "id" => "mod-b", "description" => "Other module work", "agent" => "dev-2", "owned_files" => ["Games-Labs-Game/go.mod"], "parallel_safe" => true}
      ]
    when /4$/
      [
        {"order" => 1, "id" => "single", "description" => "Single lane work", "agent" => "dev", "owned_files" => ["service/single.go"], "parallel_safe" => false}
      ]
    else
      [
        {"order" => 1, "id" => "api", "description" => "API work", "agent" => "dev", "owned_files" => ["service/api.go"], "parallel_safe" => true},
        {"order" => 2, "id" => "docs", "description" => "Docs work", "agent" => "dev-2", "owned_files" => ["docs/api.md"], "parallel_safe" => true}
      ]
    end

  parallel = !task_id.end_with?("4")
  write_yaml(File.join(task_dir, "pm-output.yaml"), {
    "task" => {"id" => task_id, "title" => "Parallel test", "short_name" => "parallel-test", "type" => "feature", "priority" => "medium", "created_at" => "2026-05-13"},
    "scope" => {"target_services" => [{"service" => "ai-dev-office", "reason" => "integration test"}], "affected_files" => subtasks.flat_map { |s| s["owned_files"].map { |path| {"path" => path, "action" => "modify", "description" => s["description"]} } }},
    "description" => "Integration test task",
    "acceptance_criteria" => [{"criterion" => "Auto pipeline routes correctly"}],
    "plan" => {"approach" => "Use fake outputs", "subtasks" => subtasks, "risks" => [], "estimated_complexity" => "medium"},
    "assignment" => {"primary" => "dev", "parallel" => parallel, "reason" => parallel ? "Independent ownership" : "Sequential task"},
    "summary" => "Prepared task",
    "artifacts" => [{"path" => "runs/#{task_id}/task.md", "action" => "created"}, {"path" => "runs/#{task_id}/status.yaml", "action" => "created"}],
    "next_action" => {"agent" => "dev", "reason" => "Ready for implementation"},
    "context_sources" => context_sources,
    "blockers" => []
  })
elsif prompt.include?("# Dev-2 Agent")
  write_yaml(File.join(task_dir, "dev-2-output.yaml"), {
    "summary" => "Dev-2 lane completed",
    "artifacts" => [{"path" => "docs/api.md", "action" => "modified"}],
    "next_action" => {"agent" => "reviewer", "reason" => "Dev-2 lane ready"},
    "context_sources" => context_sources,
    "blockers" => []
  })
elsif prompt.include?("# Dev Agent")
  write_yaml(File.join(task_dir, "dev-output.yaml"), {
    "summary" => "Dev lane completed",
    "artifacts" => [{"path" => "service/api.go", "action" => "modified"}],
    "next_action" => {"agent" => "reviewer", "reason" => "Dev lane ready"},
    "context_sources" => context_sources,
    "blockers" => []
  })
elsif prompt.include?("# ReviewerAgent")
  write_yaml(File.join(task_dir, "reviewer-output.yaml"), {
    "summary" => "Approved fake work",
    "review_verdict" => "approved",
    "build_check" => {"compile" => "skipped", "tests" => "skipped", "details" => "integration fake"},
    "artifacts" => [{"path" => "service/api.go", "issues" => []}, {"path" => "docs/api.md", "issues" => []}],
    "next_action" => {"agent" => "done", "reason" => "Approved"},
    "context_sources" => context_sources,
    "transition" => {"from_phase" => "review", "to_phase" => "done"},
    "blockers" => []
  })
end

puts "fake codex wrote output for #{task_id}"
RUBY
  chmod +x "$FAKE_BIN/codex"

  cat > "$FAKE_BIN/go" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "fake go $*" >&2
exit 0
SH
  chmod +x "$FAKE_BIN/go"
}

create_task() {
  local task_id="$1"
  mkdir -p "$RUNS_DIR/$task_id"
  cat > "$RUNS_DIR/$task_id/task.md" <<MD
# Parallel Test

task_id: $task_id
MD
  cat > "$RUNS_DIR/$task_id/status.yaml" <<YAML
task_id: $task_id
phase: pending
state: pending
iteration: 0
current_agent: pm
assignment:
  primary: pm
  parallel: false
ready: true
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
}

create_guard_workspace
create_fake_codex
create_task "$VALID_TASK"
create_task "$CONFLICT_TASK"
create_task "$SHARED_TASK"
create_task "$SEQUENTIAL_TASK"

export PATH="$FAKE_BIN:$PATH"
export GUARD_WORKSPACE_ROOT="$FAKE_WORKSPACE"
export AI_DEV_OFFICE_PARALLEL_DELAY_SECONDS=0

echo "== Scenario 1: valid parallel auto run =="
"$RUN_AGENT" "$VALID_TASK" auto codex >/tmp/office-auto-parallel-valid.log 2>&1
assert_contains /tmp/office-auto-parallel-valid.log "Running parallel dev agents: dev dev-2" "valid parallel run should announce lanes"
assert_contains /tmp/office-auto-parallel-valid.log "Parallel agent dev completed successfully" "valid parallel run should summarize dev success"
assert_contains /tmp/office-auto-parallel-valid.log "Parallel agent dev-2 completed successfully" "valid parallel run should summarize dev-2 success"
assert_contains "$RUNS_DIR/$VALID_TASK/status.yaml" "current_agent: done" "valid parallel run should complete through reviewer"
assert_file "$RUNS_DIR/$VALID_TASK/dev-parallel.log" "valid parallel run should write dev log"
assert_file "$RUNS_DIR/$VALID_TASK/dev-2-parallel.log" "valid parallel run should write dev-2 log"
ruby "$ROOT_DIR/validate-yaml.rb" "$VALID_TASK" >/tmp/office-auto-parallel-validate.log 2>&1

echo "== Scenario 2: duplicate owned file fails =="
if "$RUN_AGENT" "$CONFLICT_TASK" auto codex >/tmp/office-auto-parallel-conflict.log 2>&1; then
  echo "[FAIL] duplicate owned file should fail"
  exit 1
fi
assert_contains /tmp/office-auto-parallel-conflict.log "Parallel plan invalid" "duplicate owned file should report invalid parallel plan"
assert_contains /tmp/office-auto-parallel-conflict.log "owned file assigned to multiple parallel subtasks: service/shared.go" "duplicate owned file should identify path"

echo "== Scenario 3: shared file parallel conflict fails =="
if "$RUN_AGENT" "$SHARED_TASK" auto codex >/tmp/office-auto-parallel-shared.log 2>&1; then
  echo "[FAIL] shared file parallel conflict should fail"
  exit 1
fi
assert_contains /tmp/office-auto-parallel-shared.log "shared file cannot be modified by multiple parallel agents" "shared file conflict should identify policy"

echo "== Scenario 4: sequential task keeps existing auto path =="
"$RUN_AGENT" "$SEQUENTIAL_TASK" auto codex >/tmp/office-auto-parallel-sequential.log 2>&1
assert_contains /tmp/office-auto-parallel-sequential.log ">>> Running dev ..." "sequential run should use normal dev step"
if grep -Fq "Running parallel dev agents" /tmp/office-auto-parallel-sequential.log; then
  echo "[FAIL] sequential run should not enter parallel mode"
  cat /tmp/office-auto-parallel-sequential.log
  exit 1
fi

echo "[PASS] auto parallel integration scenarios passed"
