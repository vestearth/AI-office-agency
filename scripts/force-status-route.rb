#!/usr/bin/env ruby
# frozen_string_literal: true

# Standalone extraction of run-agent.sh's `force_status_route` Ruby heredoc
# (Phase 2 of issue #23 — see docs/orchestration-boundary.md §6,
# recommendation 1). Behavior is unchanged: same ARGV, same stdout messages,
# same exit codes. run-agent.sh now calls this file instead of embedding the
# logic inline.
#
# Unconditionally sets phase/current_agent/history on status.yaml — used by
# the loop guard, execution-budget guard, the "malformed output" fallback,
# and the parallel-completion path (mark_parallel_dev_complete), all still in
# run-agent.sh.
#
# Usage:
#   ruby scripts/force-status-route.rb <TASK_ID> <STATUS_FILE> <TODAY> <NEXT_AGENT> <NEW_PHASE> <ACTOR_AGENT> <REASON>
#
# Exit: 0 success; 9 ownership fence refused (see scripts/task-ownership.rb). Note:
# unlike the original heredoc, a missing scripts/task-ownership.rb is no
# longer a graceful exit 9 — it now raises an uncaught LoadError, since this
# file requires it unconditionally at load time. In every real distribution
# path task-ownership.rb ships alongside this file, so this has no observed
# behavioral effect (audited #23 Phase 2); flagged here only so a future
# caller reading exit codes doesn't miss the distinction.

require "yaml"
require "date"
require_relative "task-ownership"

task_id, status_path, today, next_agent, new_phase, actor_agent, reason = ARGV
if task_id.nil? || status_path.nil? || today.nil? || next_agent.nil? || new_phase.nil? || actor_agent.nil? || reason.nil?
  warn "Usage: force-status-route.rb <TASK_ID> <STATUS_FILE> <TODAY> <NEXT_AGENT> <NEW_PHASE> <ACTOR_AGENT> <REASON>"
  exit 2
end

# M1: per-task lock around the read-modify-write (released on process exit).
__lock = File.open(File.join(File.dirname(status_path), ".lock"), File::RDWR | File::CREAT, 0o644)
__lock.flock(File::LOCK_EX)

# I3: same ownership fence as sync_status_from_output — a forced route is still
# a status write, so a run that lost its lease must not land one either.
TaskOwnership.fence!(File.dirname(status_path))

status = if File.exist?(status_path)
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
else
  {}
end

old_phase = status["phase"].to_s.strip
old_phase = "pending" if old_phase.empty?

status["task_id"] ||= task_id
status["phase"] = new_phase
status["state"] = new_phase
status["current_agent"] = next_agent
status["updated_at"] = today
status["ready"] = (new_phase != "blocked" && next_agent != "done")
status["handoff"] = {
  "from" => actor_agent,
  "to" => next_agent,
  "artifact" => "forced-route"
}
status["history"] = [] unless status["history"].is_a?(Array)
status["history"] << {
  "phase" => "#{old_phase} -> #{new_phase}",
  "agent" => actor_agent,
  "reason" => reason,
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
puts "Status forced: #{old_phase} -> #{new_phase} (next: #{next_agent})"
