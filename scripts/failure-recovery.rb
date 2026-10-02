#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 1D keeps the judgment about what failed explicit. Once classified,
# these are the allowed recovery routes through the existing role/phase model.
module FailureRecovery
  ROUTES = {
    "implementation_defect" => { "action" => "debug_fix", "agents" => { "debugger" => "debugging", "dev" => "assigned" } },
    "invalid_assumption" => { "action" => "replan", "agents" => { "pm" => "pending", "dev" => "assigned" } },
    "environment_runtime" => { "action" => "diagnose", "agents" => { "devops" => "devops_needed" } },
    "missing_data" => { "action" => "investigate", "agents" => { "debugger" => "debugging" } },
    "permission_authority" => { "action" => "escalate", "agents" => { "pm" => "blocked" } }
  }.freeze
  CLASSES = ROUTES.keys.freeze
  ACTIONS = ROUTES.values.map { |route| route["action"] }.freeze

  module_function

  def route(classification, agent = nil)
    definition = ROUTES[classification]
    return nil unless definition

    agent ||= definition["agents"].keys.first
    phase = definition["agents"][agent]
    return nil unless phase

    { "action" => definition["action"], "phase" => phase, "agent" => agent }
  end
end
