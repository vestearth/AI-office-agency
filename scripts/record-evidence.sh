#!/usr/bin/env bash
# Execution-evidence wrapper (issue #11, producer lane).
#
# Runs a verification command for real, captures its combined output to
# runs/<TASK_ID>/evidence/<ev-id>.log, and appends a provenance record to
# runs/<TASK_ID>/evidence.yaml under the per-task .lock. The evidence id is
# printed on stdout; the wrapper exits with the COMMAND's exit code so a failing
# check still fails the caller (the failure is recorded, not swallowed).
#
# Usage: scripts/record-evidence.sh <TASK_ID> [--type command|test|build|static_check|artifact] -- <command...>
# Exit:  <command exit code>, or 2 on usage/config error.
#
# Contract: docs/evidence-contract.md  Schema: schemas/evidence.schema.yaml
set -uo pipefail

OFFICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR="${AI_OFFICE_RUNS_DIR:-$OFFICE_DIR/runs}"
EVIDENCE_TYPES="command test build static_check artifact"

die() {
  echo "record-evidence: $1" >&2
  exit 2
}

TASK_ID="${1:-}"
[[ -n "$TASK_ID" ]] || die "usage: record-evidence.sh <TASK_ID> [--type TYPE] -- <command...>"
shift

TYPE="command"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      TYPE="${2:-}"
      [[ -n "$TYPE" ]] || die "--type needs a value"
      shift 2
      ;;
    --type=*)
      TYPE="${1#--type=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      die "unexpected argument '$1' (commands go after --)"
      ;;
  esac
done

[[ " $EVIDENCE_TYPES " == *" $TYPE "* ]] || die "unknown --type '$TYPE' (one of: $EVIDENCE_TYPES)"
[[ $# -gt 0 ]] || die "no command given (usage: ... -- <command...>)"

TASK_DIR="$RUNS_DIR/$TASK_ID"
[[ -d "$TASK_DIR" ]] || die "task dir not found: $TASK_DIR"
mkdir -p "$TASK_DIR/evidence"

# Repo provenance is taken from the CURRENT working directory — evidence is about
# the tree the command actually ran against, not about the office repo.
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REPO_ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
REPO_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ "$REPO_SHA" == "unknown" ]] || [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
  DIRTY="false"
else
  DIRTY="true"
fi
EXECUTED_AT="$(date -u +%FT%TZ)"
# Run attribution (docs/run-records.md). run-agent.sh exports this for the whole
# dispatch; it is empty when the wrapper is invoked by hand outside one — and is
# then recorded as null rather than guessed.
RUN_ID="${AI_DEV_OFFICE_RUN_ID:-}"

TMP_LOG="$TASK_DIR/evidence/.pending.$$.log"
"$@" >"$TMP_LOG" 2>&1
CMD_EXIT=$?

ruby - "$TASK_DIR" "$TMP_LOG" "$TYPE" "$REPO" "$REPO_ORIGIN_URL" "$REPO_SHA" "$DIRTY" "$EXECUTED_AT" "$RUN_ID" "$CMD_EXIT" "$@" <<'RUBY'
require "yaml"
require "date"
require "digest"
require "shellwords"

task_dir, tmp_log, type, repo, origin_url, repo_sha, dirty, executed_at, run_id, exit_code, *command = ARGV
evidence_path = File.join(task_dir, "evidence.yaml")

# Portable repository IDENTITY (owner/repo) from the origin remote — the local
# path in `repo` is operator-specific and cannot be compared across machines.
# Takes the remote path after the host, so GitLab subgroups survive intact.
# Anything without a network host (plain filesystem remote, file://) has no
# identity to record and yields nil.
def normalize_origin(url)
  url = url.to_s.strip
  path =
    if url.match?(%r{\Afile://}i)
      nil
    elsif url.match?(%r{\A[a-zA-Z][a-zA-Z0-9+.\-]*://})
      url.sub(%r{\A[a-zA-Z][a-zA-Z0-9+.\-]*://}, "").split("/", 2)[1]
    elsif url.match?(%r{\A[^/]+@[^/:]+:})
      url.split(":", 2)[1]
    end
  return nil if path.nil?

  segments = path.sub(/\.git\z/, "").split("/").reject(&:empty?)
  segments.size < 2 ? nil : segments.join("/")
end

# Same per-task advisory flock the driver uses for status/meta writes: the id
# allocation and the append must be one critical section or parallel lanes
# collide on ev-NNN. Released when this short-lived process exits.
__lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

doc = if File.exist?(evidence_path)
  YAML.safe_load(File.read(evidence_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end
doc["task_id"] ||= File.basename(task_dir)
doc["evidence"] = [] unless doc["evidence"].is_a?(Array)

used = doc["evidence"].map { |e| e.is_a?(Hash) ? e["id"].to_s[/\Aev-(\d+)\z/, 1].to_i : 0 }
ev_id = format("ev-%03d", used.max.to_i + 1)

# The log is hashed AFTER its final rename so the recorded digest is the digest
# of the file the record points at.
log_rel = File.join("evidence", "#{ev_id}.log")
File.rename(tmp_log, File.join(task_dir, log_rel))

doc["evidence"] << {
  "id" => ev_id,
  "run_id" => (run_id.to_s.empty? ? nil : run_id),
  "type" => type,
  "command" => command.shelljoin,
  "exit_code" => exit_code.to_i,
  "repo" => repo,
  "repo_origin" => normalize_origin(origin_url),
  "repo_sha" => repo_sha,
  "working_tree_dirty" => dirty == "true",
  "executed_at" => executed_at,
  "artifact_path" => log_rel,
  "artifact_sha256" => Digest::SHA256.file(File.join(task_dir, log_rel)).hexdigest
}
doc["updated_at"] = executed_at

tmp_path = "#{evidence_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(doc))
  File.rename(tmp_path, evidence_path)
rescue => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

puts ev_id
RUBY
RUBY_EXIT=$?

if [[ $RUBY_EXIT -ne 0 ]]; then
  rm -f "$TMP_LOG"
  die "failed to append evidence record (ruby exit $RUBY_EXIT)"
fi

exit "$CMD_EXIT"
