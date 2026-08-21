#!/usr/bin/env ruby
# frozen_string_literal: true

# Standalone extraction of run-agent.sh's `reconcile_blocked_status` Ruby
# heredoc (Phase 2 of issue #23 — see docs/orchestration-boundary.md §6,
# recommendation 1). Behavior is unchanged: same ARGV, same stdout messages,
# same exit codes. run-agent.sh now calls this file instead of embedding the
# logic inline.
#
# Re-evaluates a `blocked` task's `blocked_on` dependencies: escalates to
# free-roam if any upstream ended in a terminal-failed state (aborted /
# validation_failed), unblocks and routes via `assignment.primary` once every
# dependency reached the configured unblock phase, otherwise leaves the task
# blocked.
#
# Usage:
#   ruby scripts/reconcile-blocked-status.rb <TASK_ID> <STATUS_FILE> <RUNS_DIR> <TODAY> <UNBLOCK_PHASE> <REVIEWER_QUEUE_PHASE> <CLEAR_WAITING_FOR> <SET_READY> <ROUTE_FROM_ASSIGNMENT>
#
# Exit: 0 success (including all no-op cases: no status.yaml, not blocked, no
# blocked_on); 9 ownership fence refused (see scripts/task-ownership.rb).

require "yaml"
require "date"
require_relative "task-ownership"

task_id, status_path, runs_dir, today, unblock_phase, reviewer_queue_phase, clear_waiting_for, set_ready, route_from_assignment = ARGV
if [task_id, status_path, runs_dir, today, unblock_phase, reviewer_queue_phase, clear_waiting_for, set_ready, route_from_assignment].any?(&:nil?)
  warn "Usage: reconcile-blocked-status.rb <TASK_ID> <STATUS_FILE> <RUNS_DIR> <TODAY> <UNBLOCK_PHASE> <REVIEWER_QUEUE_PHASE> <CLEAR_WAITING_FOR> <SET_READY> <ROUTE_FROM_ASSIGNMENT>"
  exit 2
end

exit 0 unless File.exist?(status_path)

# M1: per-task lock around the read-modify-write (released on process exit).
__lock = File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

status = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
phase = status["state"].to_s.strip
phase = status["phase"].to_s.strip if phase.empty?
blocked_on = Array(status["blocked_on"]).map(&:to_s).map(&:strip).reject(&:empty?)

exit 0 unless phase == "blocked"
exit 0 if blocked_on.empty?

# I3: ownership fence, ORCHESTRATOR lane — placed AFTER the no-op guards above,
# so it only gates the invocations that are actually going to write. Unblocking
# a dependency-gated task is not a dispatch and holds no lease (it runs BEFORE
# this dispatch acquires, so there is no epoch to present even in principle),
# so it is refused only while a lease is LIVE. See docs/task-ownership.md.
TaskOwnership.fence!(File.dirname(status_path), force_orchestrator: true)

# S6: an upstream that ends in a failed terminal state can never reach the
# unblock phase, so a dependent waiting on it would stay blocked forever.
terminal_failed = %w[aborted validation_failed]
failed_deps = []
pending = blocked_on.each_with_object([]) do |dep_task_id, memo|
  dep_status_path = File.join(runs_dir, dep_task_id, "status.yaml")
  unless File.exist?(dep_status_path)
    memo << dep_task_id
    next
  end

  dep_status = YAML.safe_load(File.read(dep_status_path), permitted_classes: [Date, Time], aliases: true) || {}
  dep_phase = dep_status["state"].to_s.strip
  dep_phase = dep_status["phase"].to_s.strip if dep_phase.empty?
  if terminal_failed.include?(dep_phase)
    failed_deps << dep_task_id
  elsif dep_phase != unblock_phase
    memo << dep_task_id
  end
end

unless failed_deps.empty?
  # S6: route the wedged dependent to free-roam for re-planning instead of
  # leaving it blocked forever on a failed upstream.
  old_phase = status["phase"].to_s.strip
  old_phase = "blocked" if old_phase.empty?
  status["phase"] = "escalated"
  status["state"] = "escalated"
  status["current_agent"] = "free-roam"
  status["ready"] = true
  status["waiting_for"] = [] if clear_waiting_for == "true"
  status["updated_at"] = today
  status["history"] = [] unless status["history"].is_a?(Array)
  status["history"] << {
    "phase" => "#{old_phase} -> escalated",
    "agent" => "orchestrator",
    "reason" => "Upstream dependency failed (#{failed_deps.join(', ')}); cannot unblock by waiting.",
    "at" => Time.now.utc.strftime("%FT%TZ")  # N1
  }
  tmp_path = "#{status_path}.tmp.#{$$}"
  begin
    File.write(tmp_path, YAML.dump(status))
    File.rename(tmp_path, status_path)
  rescue => e
    File.delete(tmp_path) if File.exist?(tmp_path)
    raise e
  end
  puts "Status escalated: upstream dependency failed (#{failed_deps.join(', ')})"
  exit 0
end

if pending.empty?
  old_phase = status["phase"].to_s.strip
  old_phase = "pending" if old_phase.empty?
  primary = status.dig("assignment", "primary").to_s.strip
  route_from_assignment = route_from_assignment == "true"
  new_phase = old_phase

  if route_from_assignment
    new_phase =
      case primary
      when "dev", "dev-2" then "assigned"
      when "reviewer" then reviewer_queue_phase
      else "pending"
      end
  end

  status["phase"] = new_phase
  status["state"] = new_phase
  status["current_agent"] = primary.empty? ? "pm" : primary
  status["ready"] = true if set_ready == "true"
  status["waiting_for"] = [] if clear_waiting_for == "true"
  status["updated_at"] = today
  status["history"] = [] unless status["history"].is_a?(Array)
  status["history"] << {
    "phase" => "#{old_phase} -> #{new_phase}",
    "agent" => "orchestrator",
    "reason" => "Dependencies resolved: #{blocked_on.join(', ')}",
    "at" => Time.now.utc.strftime("%FT%TZ")  # N1
  }

  tmp_path = "#{status_path}.tmp.#{$$}"
  begin
    File.write(tmp_path, YAML.dump(status))
    File.rename(tmp_path, status_path)
  rescue => e
    File.delete(tmp_path) if File.exist?(tmp_path)
    raise e
  end
  puts "Status unblocked: #{old_phase} -> #{new_phase}"
else
  puts "Status remains blocked: waiting on #{pending.join(', ')}"
end
