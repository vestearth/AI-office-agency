#!/usr/bin/env ruby
# frozen_string_literal: true

# Derives the task-level wait and block from optional status.yaml branches.
# Call under the task lock after a status writer chooses its normal transition.
module BranchProjection
  WAIT_PREFIX = "branch:"
  UPDATABLE_PHASES = %w[
    pending blocked assigned assigned_parallel review in_review debugging
    debugging_complete devops_needed devops_complete escalated
    free_roam_complete validation_failed
  ].freeze
  # Recovery and terminal phases have their own workflow; keep their route
  # while retaining branch waits for inspection and later governed updates.
  OVERRIDE_PHASES = %w[done aborted escalated validation_failed].freeze

  module_function

  def declared?(status)
    status.is_a?(Hash) && status["branches"].is_a?(Hash) && !status["branches"].empty?
  end

  def global_waits(status)
    Array(status["waiting_for"]).reject { |wait| wait.is_a?(String) && wait.start_with?(WAIT_PREFIX) }
  end

  def branch_waits(status)
    status.fetch("branches", {}).each_with_object([]) do |(name, branch), waits|
      next unless branch.is_a?(Hash) && branch["state"] == "blocked"

      waits << "#{WAIT_PREFIX}#{name} #{Array(branch['waiting_for']).join('; ')}"
    end
  end

  def only_blocked?(status)
    return false unless declared?(status)

    states = status["branches"].values.map { |branch| branch["state"] if branch.is_a?(Hash) }.compact
    !states.include?("ready") && states.include?("blocked")
  end

  def can_resume?(status)
    global_waits(status).empty? && Array(status["blocked_on"]).empty?
  end

  def apply!(status)
    return false unless declared?(status)

    globals = global_waits(status)
    status["waiting_for"] = globals + branch_waits(status)
    return true if OVERRIDE_PHASES.include?(status["phase"])

    if only_blocked?(status)
      status["phase"] = status["state"] = "blocked"
      status["ready"] = false
    elsif status["phase"] == "blocked" && can_resume?(status)
      status["phase"] = status["state"] = "assigned"
      assignment = status["assignment"]
      status["current_agent"] = (assignment.is_a?(Hash) ? assignment["primary"] : nil) || status["current_agent"]
      status["ready"] = true
    end
    true
  end
end
