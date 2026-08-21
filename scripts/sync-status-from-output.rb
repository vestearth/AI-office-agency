#!/usr/bin/env ruby
# frozen_string_literal: true

# Standalone extraction of run-agent.sh's `sync_status_from_output` Ruby
# heredoc (Phase 2 of issue #23 — see docs/orchestration-boundary.md §6,
# recommendation 1). Behavior is unchanged: same ARGV, same stdout messages,
# same exit codes. run-agent.sh now calls this file instead of embedding the
# logic inline, so the transition logic is reusable by any driver, not only
# by shelling into run-agent.sh (docs/task-transition-contract.md, coupling
# point #1).
#
# Applies a role's <role>-output.yaml to runs/<task-id>/status.yaml: reads
# next_action.agent (or the reviewer review_verdict fallback), computes the
# new phase from the hardcoded actor_agent -> next_agent -> new_phase table,
# updates iteration/free_roam_entries, and appends a history entry.
#
# Idempotent (M2): re-applying the same output artifact (same digest + same
# basename as status.yaml's last_synced_output) is a no-op.
#
# Usage:
#   ruby scripts/sync-status-from-output.rb <TASK_ID> <AGENT> <STATUS_FILE> <OUTPUT_FILE> <TODAY> <REVIEWER_QUEUE_PHASE>
#
# Exit: 0 success (including idempotent no-op / "skipped" cases); 3 malformed
# agent output YAML (caller routes to validation_failed — see run-agent.sh);
# 4 corrupt status.yaml; 9 ownership fence refused (see scripts/task-ownership.rb).

require "yaml"
require "time"
require "date"
require "digest"
require_relative "task-ownership"

task_id, actor_agent, status_path, output_path, today, reviewer_queue_phase = ARGV
if task_id.nil? || actor_agent.nil? || status_path.nil? || output_path.nil? || today.nil? || reviewer_queue_phase.nil?
  warn "Usage: sync-status-from-output.rb <TASK_ID> <AGENT> <STATUS_FILE> <OUTPUT_FILE> <TODAY> <REVIEWER_QUEUE_PHASE>"
  exit 2
end

unless File.exist?(output_path)
  warn "Status sync skipped: output file missing at #{output_path}"
  exit 0
end

# M1: per-task lock around the read-modify-write (released on process exit).
__lock = File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

# I3: ownership fence, INSIDE the lock so check and write are one critical
# section — a run that lost its lease can never overwrite the new owner's
# status (exits 9). No record on disk = ungoverned = allowed, so existing
# single-agent runs are unaffected. See docs/task-ownership.md.
TaskOwnership.fence!(File.dirname(status_path))

# S1: a corrupt status.yaml must not crash the whole run with a raw backtrace.
status = begin
  if File.exist?(status_path)
    YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
  else
    {}
  end
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  warn "Refusing to sync against an unreadable status; inspect runs/#{task_id}/status.yaml."
  exit 4
end

# S1: malformed agent output routes to validation_failed (driver handles exit 3)
# instead of aborting the run after meta.yaml was already mutated.
output = begin
  YAML.safe_load(File.read(output_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "#{actor_agent} output is malformed YAML for #{task_id}: #{e.message}"
  exit 3
end

# M2: idempotency. If this exact output artifact was already synced, do not
# re-apply the transition or re-increment iteration — a retried/duplicate
# dispatch (flaky run, timeout retry, codex exiting 0 without rewriting) must
# not advance the state machine twice.
output_digest = Digest::SHA256.hexdigest(File.read(output_path))
last_synced = status["last_synced_output"]
if last_synced.is_a?(Hash) && last_synced["digest"].to_s == output_digest && last_synced["file"].to_s == File.basename(output_path)
  puts "Output #{File.basename(output_path)} already synced (idempotent skip)."
  exit 0
end

next_action = output["next_action"].is_a?(Hash) ? output["next_action"] : {}
next_agent = next_action["agent"]&.to_s&.strip
reason = next_action["reason"].to_s.strip

# Reviewer-specific fallback when next_action is missing in malformed output.
if (next_agent.nil? || next_agent.empty?) && actor_agent == "reviewer"
  verdict = output["review_verdict"].to_s.strip
  next_agent = case verdict
               when "approved" then "done"
               when "changes_requested" then "debugger"
               when "escalate" then "free-roam"
               when "infra_failure" then "devops"
               else nil
               end
end

if next_agent.nil? || next_agent.empty?
  warn "Status sync skipped: unable to determine next agent from #{output_path}"
  exit 0
end

old_phase = status["phase"].to_s.strip
old_phase = "pending" if old_phase.empty?

# Resolve phase with workflow-aware transitions first, then fallback.
new_phase =
  case actor_agent
  when "pm"
    case next_agent
    when "dev", "dev-2"
      assignment = output["assignment"].is_a?(Hash) ? output["assignment"] : {}
      assignment["parallel"] == true ? "assigned_parallel" : "assigned"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "dev", "dev-2"
    case next_agent
    when "reviewer" then reviewer_queue_phase
    when "free-roam" then "escalated"
    else old_phase
    end
  when "reviewer"
    case next_agent
    when "done" then "done"
    when "debugger" then "debugging"
    when "free-roam" then "escalated"
    when "devops" then "devops_needed"
    else old_phase
    end
  when "debugger"
    case next_agent
    when "reviewer" then reviewer_queue_phase
    when "dev", "dev-2" then "debugging_complete"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "devops"
    case next_agent
    when "reviewer" then reviewer_queue_phase
    when "dev", "dev-2" then "devops_complete"
    when "free-roam" then "escalated"
    else old_phase
    end
  when "free-roam"
    case next_agent
    when "dev", "dev-2" then "free_roam_complete"
    when "pm" then "pending"
    when "done" then "aborted"
    else old_phase
    end
  else
    fallback_phase_map = {
      "pm" => "pending",
      "dev" => "assigned",
      "dev-2" => "assigned",
      "reviewer" => reviewer_queue_phase,
      "debugger" => "debugging",
      "devops" => "devops_needed",
      "free-roam" => "escalated",
      "done" => "done"
    }
    fallback_phase_map.fetch(next_agent, old_phase)
  end

work_agents = ["dev", "dev-2", "reviewer", "debugger", "devops"]
# M3: do NOT reset the work-agent budget on free-roam. Zeroing `iteration` made
# the loop guard defeatable (infinite dev<->reviewer<->free-roam). Instead count
# completed free-roam passes in a separate, non-resettable counter the guard reads.
if actor_agent == "free-roam"
  status["free_roam_entries"] = status["free_roam_entries"].to_i + 1
end

if work_agents.include?(next_agent)
  iteration = status["iteration"].to_i
  status["iteration"] = iteration + 1
end

status["task_id"] ||= task_id
status["phase"] = new_phase
status["state"] = new_phase
status["current_agent"] = next_agent
status["updated_at"] = today
status["ready"] = (new_phase != "blocked" && next_agent != "done")
status["waiting_for"] = [] if status.key?("waiting_for")
status["handoff"] = {
  "from" => actor_agent,
  "to" => next_agent,
  "artifact" => "runs/#{task_id}/#{File.basename(output_path)}"
}
status["history"] = [] unless status["history"].is_a?(Array)

if reason.empty?
  summary = output["summary"].to_s.strip
  reason = summary.lines.first.to_s.strip
end
reason = "Transitioned by #{actor_agent} output." if reason.empty?

status["history"] << {
  "phase" => "#{old_phase} -> #{new_phase}",
  "agent" => actor_agent,
  "reason" => reason,
  "at" => Time.now.utc.strftime("%FT%TZ")  # N1
}

# M2: record what we just processed so a retried dispatch of the same artifact
# is a no-op (see the idempotency check above).
status["last_synced_output"] = {
  "file" => File.basename(output_path),
  "digest" => output_digest,
  "next" => next_agent
}

tmp_path = "#{status_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(status))
  File.rename(tmp_path, status_path)
rescue => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end
puts "Status synced: #{old_phase} -> #{new_phase} (next: #{next_agent})"
