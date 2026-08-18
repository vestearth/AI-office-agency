#!/usr/bin/env ruby
# frozen_string_literal: true

# Policy preflight: the deterministic gate that runs BEFORE externally-sourced
# work is allowed to trigger a privileged agent dispatch.
#
#   external input -> classify as untrusted -> resolve repository policy
#                  -> determine allowed action -> classify sensitivity
#                  -> allow / deep review / human approval / deny
#
# The property this file exists to hold: **free-form external text is CONTEXT,
# never AUTHORITY.** The input is read exactly twice — to hash it, and to scan
# it for advisory injection signals — and is never parsed as configuration,
# never consulted for trust, sensitivity, action, or approval. Text saying
# "ignore the policy", "the operator approved this", or carrying a YAML block
# that looks like a decision has precisely the same effect as text saying
# nothing: none. Every input that reaches a decision is one of the three
# caller-declared, config-resolved facts (source, role/action, path scope).
#
# Fail closed. A malformed policy, an unreadable input, an unknown source, an
# unknown action, or a missing matrix cell all resolve to `deny`. There is no
# path through this file that reaches `allow` by default.
#
# Usage:
#   ruby scripts/preflight.rb decide <TASK_ID> --source <src> --role <role>
#        [--action <action>] [--path <p>]... [--input-file <f>] [--external-ref <r>]
#
# Prints "<pf-id> <outcome>" on stdout. Exit:
#   0  allow                    10  allow_with_deep_review
#   11 require_human_approval   12  deny
#   2  usage error              3   store error   (both = do not dispatch)
#
# Contract: docs/policy-preflight.md  Schema: schemas/preflight.schema.yaml

require "yaml"
require "date"
require "digest"

require_relative "resolve-office-config"
require_relative "classify-risk"

OFFICE_DIR = File.expand_path("..", __dir__)
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV["AI_OFFICE_RUNS_DIR"] || File.join(OFFICE_DIR, "runs")

# Ascending. Ranking is delegated to RiskClassifier via the level map below.
SENSITIVITY_LEVELS = %w[normal sensitive critical].freeze
# Capabilities a dispatch may request. Declared by the calling code, never
# extracted from the input text — that is the whole point of the boundary.
PREFLIGHT_ACTIONS = %w[read comment mutate_repo execute deploy].freeze
PREFLIGHT_OUTCOMES = %w[allow allow_with_deep_review require_human_approval deny].freeze
PREFLIGHT_TRUST = %w[trusted untrusted].freeze
PREFLIGHT_ID_PATTERN = /\Apf-\d{3,}\z/.freeze
EXIT_BY_OUTCOME = {
  "allow" => 0,
  "allow_with_deep_review" => 10,
  "require_human_approval" => 11,
  "deny" => 12
}.freeze

# Advisory only. These signals are RECORDED so a human (or the event gateway in
# #19) can see that someone tried; they deliberately do NOT feed the decision.
# Making them change the outcome would reintroduce exactly the coupling this
# gate removes: input text influencing policy.
INJECTION_SIGNALS = {
  "override_policy" => [
    /ignore\s+(?:the\s+|all\s+)?(?:previous\s+|above\s+|prior\s+)?(?:instructions|policy|policies|rules)/i,
    /disregard\s+(?:the\s+)?(?:policy|instructions|rules|preflight)/i,
    /override\s+(?:the\s+)?(?:polic|preflight|gate)/i,
    /bypass\s+(?:the\s+)?(?:polic|preflight|approval|review)/i
  ],
  "forged_approval" => [
    /(?:operator|admin|owner|maintainer|human)\s+(?:has\s+)?(?:already\s+)?(?:approved|authorized|authorised|signed off)/i,
    /pre-?(?:approved|authorized|authorised)/i,
    /no\s+(?:approval|review)\s+(?:is\s+)?(?:needed|required)/i
  ],
  "authority_claim" => [
    /you\s+are\s+(?:now\s+)?in\s+(?:test|debug|admin|god|maintenance)\s+mode/i,
    /(?:system|developer)\s+(?:prompt|message|instruction)s?\s*[::]/i,
    /as\s+(?:an?\s+)?(?:admin|administrator|operator|anthropic)\b/i
  ],
  "embedded_policy" => [
    /^\s*(?:preflight|decision_matrix|trusted_sources|sensitivity_rules|role_actions)\s*:/,
    /^\s*outcome\s*:\s*(?:allow|approved)/i,
    /"outcome"\s*:\s*"allow/i
  ]
}.freeze

def die(message, code = 2)
  warn "preflight: #{message}"
  exit code
end

def now_iso
  Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
end

# Same advisory flock every other writer in the task dir takes (meta.yaml,
# status.yaml, evidence.yaml, run-records). Released when this short-lived
# process exits.
def with_task_lock(task_dir)
  lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
  lock.flock(File::LOCK_EX)
  yield
ensure
  lock&.close
end

FLAG_KEYS = {
  "--source" => "source", "--role" => "role", "--action" => "action",
  "--input-file" => "input_file", "--external-ref" => "external_ref"
}.freeze

def parse_args(argv)
  request = { "paths" => [] }
  until argv.empty?
    flag = argv.shift
    die "unknown argument '#{flag}'" unless flag == "--path" || FLAG_KEYS.key?(flag)

    value = argv.shift
    die "#{flag} needs a value" if value.nil?
    flag == "--path" ? request["paths"] << value : request[FLAG_KEYS[flag]] = value
  end
  request
end

# Structural checks on the policy block. Every failure here is a DENY reason,
# not an exception: a repository whose safety policy does not parse must not be
# able to run externally-sourced work, and must say why in the record.
def policy_faults(policy)
  return ["preflight policy block is missing or is not a mapping"] unless policy.is_a?(Hash)

  faults = []
  faults << "preflight.enabled is not true" unless policy["enabled"] == true
  if policy.key?("trusted_sources") && !(policy["trusted_sources"].is_a?(Array) &&
                                          policy["trusted_sources"].all? { |s| s.is_a?(String) })
    faults << "preflight.trusted_sources must be a list of strings"
  end
  faults << "preflight.role_actions must be a mapping" unless policy["role_actions"].is_a?(Hash)
  unless SENSITIVITY_LEVELS.include?(policy["default_sensitivity"])
    faults << "preflight.default_sensitivity must be one of: #{SENSITIVITY_LEVELS.join(', ')}"
  end
  if policy.key?("undeclared_scope_sensitivity") &&
     !SENSITIVITY_LEVELS.include?(policy["undeclared_scope_sensitivity"])
    faults << "preflight.undeclared_scope_sensitivity must be one of: #{SENSITIVITY_LEVELS.join(', ')}"
  end

  rules = policy["sensitivity_rules"]
  if rules.nil?
    faults << "preflight.sensitivity_rules is required"
  elsif !rules.is_a?(Array)
    faults << "preflight.sensitivity_rules must be a list"
  else
    rules.each_with_index do |rule, i|
      unless rule.is_a?(Hash)
        faults << "preflight.sensitivity_rules[#{i}] must be a mapping"
        next
      end
      unless SENSITIVITY_LEVELS.include?(rule["level"])
        faults << "preflight.sensitivity_rules[#{i}].level '#{rule['level']}' is not one of: #{SENSITIVITY_LEVELS.join(', ')}"
      end
      unless rule["paths"].is_a?(Array) && rule["paths"].all? { |p| p.is_a?(String) && !p.strip.empty? }
        faults << "preflight.sensitivity_rules[#{i}].paths must be a non-empty list of glob strings"
      end
    end
  end

  matrix = policy["decision_matrix"]
  if !matrix.is_a?(Hash)
    faults << "preflight.decision_matrix must be a mapping"
  else
    PREFLIGHT_TRUST.each do |trust|
      unless matrix[trust].is_a?(Hash)
        faults << "preflight.decision_matrix.#{trust} must be a mapping"
        next
      end
      matrix[trust].each do |action, row|
        unless PREFLIGHT_ACTIONS.include?(action)
          faults << "preflight.decision_matrix.#{trust}.#{action} is not a known action (#{PREFLIGHT_ACTIONS.join(', ')})"
          next
        end
        unless row.is_a?(Hash)
          faults << "preflight.decision_matrix.#{trust}.#{action} must be a mapping of level -> outcome"
          next
        end
        row.each do |level, outcome|
          faults << "preflight.decision_matrix.#{trust}.#{action}.#{level} is not a known sensitivity level" unless SENSITIVITY_LEVELS.include?(level)
          faults << "preflight.decision_matrix.#{trust}.#{action}.#{level} '#{outcome}' is not a known outcome (#{PREFLIGHT_OUTCOMES.join(', ')})" unless PREFLIGHT_OUTCOMES.include?(outcome)
        end
      end
    end
  end
  faults
end

# Path matching is delegated to #12's RiskClassifier — there is ONE path
# classifier in this repo and this is not a second one. It brings the two things
# a hand-rolled fnmatch got wrong: `normalize`, which resolves `.`, `..` and a
# leading `/` lexically, and FNM_DOTMATCH|FNM_CASEFOLD. Without them the gate was
# defeated by spelling alone — `./internal/auth/x.go`, `internal/AUTH/x.go` and
# `internal/auth/../auth/x.go` are the same file and used to classify `normal`.
#
# Only the level VOCABULARY is translated: this gate reasons about how sensitive
# a surface is (normal/sensitive/critical), the reviewer about how deep a review
# must be (low/medium/high). Same ranking, different question — see
# docs/policy-preflight.md.
SENSITIVITY_TO_RISK = { "normal" => "low", "sensitive" => "medium", "critical" => "high" }.freeze
RISK_TO_SENSITIVITY = SENSITIVITY_TO_RISK.invert.freeze

def classify_paths(policy, paths)
  rules = {
    "default_level" => SENSITIVITY_TO_RISK[policy["default_sensitivity"]],
    "triggers" => Array(policy["sensitivity_rules"]).map do |rule|
      # A malformed rule is already faulted into a deny; drop it here rather
      # than hand the classifier something it would have to coerce.
      next unless rule.is_a?(Hash) && SENSITIVITY_LEVELS.include?(rule["level"])

      {
        "label" => rule["description"].to_s,
        "level" => SENSITIVITY_TO_RISK[rule["level"]],
        "patterns" => Array(rule["paths"]).select { |glob| glob.is_a?(String) }
      }
    end.compact
  }

  result = RiskClassifier.classify(rules, paths)
  top = result["matches"].max_by { |match| RiskClassifier.rank(match["level"]) }
  {
    "level" => RISK_TO_SENSITIVITY.fetch(result["level"], policy["default_sensitivity"]),
    "matched_rule" => top && top["pattern"],
    # The NORMALIZED form — what was actually compared. `request.paths` keeps the
    # caller's original spelling, so a reader can see both.
    "matched_path" => top && top["path"]
  }
end

def scan_injection_signals(text)
  INJECTION_SIGNALS.each_with_object([]) do |(name, patterns), found|
    found << name if patterns.any? { |pattern| pattern.match?(text) }
  end
end

def resolved_policy
  profile = ENV["OFFICE_PROFILE"].to_s.strip
  OfficeConfigResolver.new(OFFICE_DIR, profile: profile.empty? ? nil : profile).get("preflight")
end

# The whole decision, start to finish. Kept as ONE function so the caller can
# wrap it in a total rescue: an unexpected failure anywhere in here must still
# produce a RECORDED deny, never an unhandled crash that exits with a code the
# contract does not define and leaves no audit trail behind.
def build_decision(request, policy)
  # ── 1. the external input: hashed and marked, never interpreted ─────────────
  input_sha = nil
  input_bytes = nil
  signals = []
  faults = []
  if request.key?("input_file")
    begin
      raw = File.binread(request["input_file"])
      input_sha = "sha256:#{Digest::SHA256.hexdigest(raw)}"
      input_bytes = raw.bytesize
      # scrub so undecodable bytes can never raise out of the advisory scan.
      signals = scan_injection_signals(raw.force_encoding("UTF-8").scrub("?"))
    rescue SystemCallError, IOError => e
      # An input we could not even read is not an input we may act on.
      faults << "external input is unreadable: #{e.message}"
    end
  end

  # ── 2. repository policy (resolved by the caller, before any mutation) ──────
  faults.concat(policy_faults(policy))
  policy = {} unless policy.is_a?(Hash)

  # ── 3. trust of the ORIGIN, then the requested capability, then sensitivity ─
  trust = Array(policy["trusted_sources"]).include?(request["source"]) ? "trusted" : "untrusted"

  action = request["action"] || (policy["role_actions"].is_a?(Hash) ? policy["role_actions"][request["role"]] : nil)
  if action.nil?
    faults << "role '#{request['role']}' has no capability in preflight.role_actions"
  elsif !PREFLIGHT_ACTIONS.include?(action)
    faults << "requested action '#{action}' is not a known capability (#{PREFLIGHT_ACTIONS.join(', ')})"
    # The record's `action` is the RESOLVED capability, so it stays an enum (or
    # null); the rejected literal is kept in the free-text fault above. Same
    # split the rest of the office uses between machine fields and free text.
    action = nil
  end

  paths = request["paths"].reject { |p| p.to_s.strip.empty? }
  scope_declared = !paths.empty?
  undeclared = policy["undeclared_scope_sensitivity"]
  undeclared = "critical" unless SENSITIVITY_LEVELS.include?(undeclared)
  sensitivity =
    if !SENSITIVITY_LEVELS.include?(policy["default_sensitivity"])
      # No trustworthy scale to classify against; the top of the scale is the
      # only safe assumption, and the fault above already forces a deny.
      { "level" => "critical", "matched_rule" => nil, "matched_path" => nil }
    elsif scope_declared
      classify_paths(policy, paths)
    elsif trust == "untrusted"
      { "level" => undeclared, "matched_rule" => nil, "matched_path" => nil }
    else
      { "level" => policy["default_sensitivity"], "matched_rule" => nil, "matched_path" => nil }
    end

  # ── 4. the outcome, read out of the written-down matrix ─────────────────────
  # Every step is guarded: a matrix that is the wrong shape at any level yields
  # no cell, and no cell is a deny.
  cell = [trust, action, sensitivity["level"]].reduce(policy["decision_matrix"]) do |node, key|
    node.is_a?(Hash) ? node[key] : nil
  end
  outcome, rationale =
    if !faults.empty?
      ["deny", "preflight could not resolve a trustworthy decision: #{faults.join('; ')}"]
    elsif !PREFLIGHT_OUTCOMES.include?(cell)
      ["deny", "no decision_matrix entry for #{trust} x #{action} x #{sensitivity['level']} — an undecidable request is denied"]
    else
      [cell, "#{trust} input x #{sensitivity['level']} path sensitivity x #{action} -> #{cell} (preflight.decision_matrix)"]
    end

  # An operator approval comes from the operator's own shell, one dispatch at a
  # time — the one channel external text provably cannot reach. It can release a
  # require_human_approval outcome; it can never soften a deny.
  approver = ENV["AI_DEV_OFFICE_PREFLIGHT_APPROVED_BY"].to_s.strip
  granted_by = nil
  if outcome == "require_human_approval" && !approver.empty?
    granted_by = approver
    outcome = "allow_with_deep_review"
    rationale += "; released by operator approval (#{approver}), still requires high-depth review"
  end

  base_record(request, policy).merge(
    "input" => {
      "source" => request["source"],
      "trust" => trust,
      "external_ref" => request["external_ref"],
      "sha256" => input_sha,
      "bytes" => input_bytes,
      # Advisory. Recorded for the reader; deliberately not an input to `outcome`.
      "injection_signals" => signals
    },
    "request" => {
      "role" => request["role"],
      "action" => action,
      # The caller's ORIGINAL spelling, for forensics. What was actually matched
      # is the normalized form in sensitivity.matched_path.
      "paths" => paths,
      "scope_declared" => scope_declared
    },
    "sensitivity" => sensitivity,
    "outcome" => outcome,
    "rationale" => rationale,
    "faults" => faults,
    "approval" => { "required" => outcome == "require_human_approval", "granted_by" => granted_by }
  )
end

def base_record(request, policy)
  {
    "id" => nil,
    "decided_at" => now_iso,
    # FK into this task's run-records/, exactly as evidence.yaml carries one.
    "run_id" => (ENV["AI_DEV_OFFICE_RUN_ID"].to_s.empty? ? nil : ENV["AI_DEV_OFFICE_RUN_ID"]),
    # PROVENANCE, not enforcement — see docs/policy-preflight.md. It identifies
    # which policy produced this decision so it can be replayed or diffed; it is
    # never recomputed at validation time, because the policy legitimately
    # changes after a decision is taken.
    "policy_sha256" => "sha256:#{Digest::SHA256.hexdigest(YAML.dump(policy))}"
  }
end

# The last line of defence: a decision the gate could not compute at all.
def crash_record(request, policy, message)
  base_record(request, policy).merge(
    "input" => {
      "source" => request["source"], "trust" => "untrusted",
      "external_ref" => request["external_ref"], "sha256" => nil, "bytes" => nil,
      "injection_signals" => []
    },
    "request" => { "role" => request["role"], "action" => nil, "paths" => [], "scope_declared" => false },
    "sensitivity" => { "level" => "critical", "matched_rule" => nil, "matched_path" => nil },
    "outcome" => "deny",
    "rationale" => "preflight could not resolve a trustworthy decision: #{message}",
    "faults" => [message],
    "approval" => { "required" => false, "granted_by" => nil }
  )
end

# CLI lane. Loaded as a library (require_relative), the decision functions above
# are usable directly — which is how the tests drive a malformed policy without
# a config-override bypass that would itself be an attack surface.
if $PROGRAM_NAME == __FILE__
  command = ARGV.shift
  task_id = ARGV.shift
  die "usage: preflight.rb decide <TASK_ID> --source <src> --role <role> [...]" if command.nil? || task_id.nil?
  die "unknown command '#{command}' (only 'decide')" unless command == "decide"

  request = parse_args(ARGV)
  die "--source is required" if request["source"].to_s.strip.empty?
  die "--role is required" if request["role"].to_s.strip.empty?

  task_dir = File.join(RUNS_DIR, task_id)
  die "task dir not found: #{task_dir}", 3 unless File.directory?(task_dir)

  policy = begin
    resolved_policy
  rescue StandardError => e
    # A policy we cannot even load is not a policy we may proceed under.
    e
  end
  record =
    if policy.is_a?(StandardError)
      crash_record(request, {}, "preflight policy could not be loaded: #{policy.class}: #{policy.message}")
    else
      begin
        build_decision(request, policy)
      rescue StandardError, ScriptError => e
        # Fail closed on the unanticipated too. Without this, a bug in
        # classification exits 1 with no record — an undocumented exit code and an
        # audit gap. A crash is a denial that says so.
        crash_record(request, policy, "preflight raised #{e.class}: #{e.message}")
      end
    end
  outcome = record["outcome"]

  path = File.join(task_dir, "preflight.yaml")
  begin
    with_task_lock(task_dir) do
      doc = File.exist?(path) ? (YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}) : {}
      doc["task_id"] ||= task_id
      doc["preflight"] = [] unless doc["preflight"].is_a?(Array)
      used = doc["preflight"].map { |e| e.is_a?(Hash) ? e["id"].to_s[/\Apf-(\d+)\z/, 1].to_i : 0 }
      record["id"] = format("pf-%03d", used.max.to_i + 1)
      doc["preflight"] << record
      doc["updated_at"] = record["decided_at"]

      tmp = "#{path}.tmp.#{$$}"
      begin
        File.write(tmp, YAML.dump(doc))
        File.rename(tmp, path)
      rescue StandardError
        File.delete(tmp) if File.exist?(tmp)
        raise
      end
    end
  rescue StandardError => e
    # Unrecordable is undecidable: no record, no dispatch.
    die "could not write the decision record: #{e.message}", 3
  end

  warn "preflight: #{record['rationale']}" unless outcome == "allow"
  puts "#{record['id']} #{outcome}"
  exit EXIT_BY_OUTCOME.fetch(outcome, 12)
end
