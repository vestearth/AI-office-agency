#!/usr/bin/env ruby
# frozen_string_literal: true

# The governed writer for the authorization ledger (issue #28, Phase 1B.1):
# runs/<task>/authorization.yaml, append-only.
#
#   ruby scripts/record-authorization.rb <TASK_ID> grant  --action A --scope S --actor X --via V --reason R [--expires-at TS]
#   ruby scripts/record-authorization.rb <TASK_ID> revoke <authz-NNN> --actor X --via V --reason R
#
# Takes the per-task .lock and allocates the next id under it (the same
# `max + 1` pattern as record-evidence.sh). UNLIKE record-evidence.sh it also
# calls TaskOwnership.fence!: a stale, superseded owner must not be able to
# append an authorization. `at` is written by this script, never supplied.
# The script never refuses an append because the local clock stepped backwards:
# revocation is decided by append order (see scripts/authorization-ledger.rb).
#
# `actor` / `via` are unverified free text (Phase 1A limits carry over): an agent
# can technically record a grant for itself. The ledger makes that auditable,
# not impossible. This records authorization; it does not enforce it at action
# time.
#
# Exit: 0 ok; 2 usage error or invalid append; 3 unreadable status.yaml or
# ledger; 9 ownership fence refused (raised by TaskOwnership.fence!).

require "yaml"
require "date"
require "time"
require_relative "task-ownership"
require_relative "completion-guard"
require_relative "authorization-ledger"

OFFICE_DIR = File.expand_path(File.join(__dir__, ".."))
# Overridable so tests can point at a temp dir instead of the live runs/.
RUNS_DIR = ENV.fetch("AI_OFFICE_RUNS_DIR", File.join(OFFICE_DIR, "runs"))
FINISHED_PHASES = %w[done aborted].freeze

def usage!(message = nil)
  warn message if message
  warn "Usage: record-authorization.rb <TASK_ID> grant --action A --scope S --actor X --via V --reason R [--expires-at TS]"
  warn "       record-authorization.rb <TASK_ID> revoke <authz-NNN> --actor X --via V --reason R"
  exit 2
end

args = ARGV.dup
task_id = args.shift
type = args.shift
usage! if task_id.nil? || type.nil?
usage!("unknown subcommand '#{type}' (expected grant or revoke)") unless AuthorizationLedger::TYPES.include?(type)

target_id = nil
if type == "revoke"
  target_id = args.shift
  usage!("revoke needs the authz-NNN id to revoke") if target_id.nil? || target_id.start_with?("--")
  usage!("'#{target_id}' is not an authz-NNN id") if AuthorizationLedger.id_number(target_id).nil?
end

opts = {}
until args.empty?
  flag = args.shift
  value = args.shift
  usage!("flag #{flag} needs a value") if value.nil?
  case flag
  when "--action" then opts[:action] = value.strip
  when "--scope" then opts[:scope] = value.strip
  when "--actor" then opts[:actor] = value.strip
  when "--via" then opts[:via] = value.strip
  when "--reason" then opts[:reason] = value.strip
  when "--expires-at" then opts[:expires_at] = value.strip
  else usage!("unknown flag #{flag}")
  end
end

%i[actor via reason].each do |key|
  usage!("--#{key} is required") if opts[key].to_s.empty?
end
if type == "grant"
  usage!("--action is required for grant") if opts[:action].to_s.empty?
  usage!("--action must be one of #{AuthorizationLedger::ACTIONS.join(', ')}") unless AuthorizationLedger::ACTIONS.include?(opts[:action])
  usage!("--scope is required for grant") if opts[:scope].to_s.empty?
  if opts.key?(:expires_at) && AuthorizationLedger.parse_time(opts[:expires_at]).nil?
    usage!("--expires-at must be YYYY-MM-DDTHH:MM:SSZ")
  end
else
  %i[action scope expires_at].each { |key| usage!("--#{key.to_s.tr('_', '-')} is only valid with grant") if opts.key?(key) }
end

task_dir = File.join(RUNS_DIR, task_id)
status_path = File.join(task_dir, "status.yaml")
unless File.exist?(status_path)
  warn "No status.yaml for #{task_id} at #{status_path}"
  exit 3
end

# Same critical section as every other governed writer: per-task lock, then the
# ownership fence inside it.
lock = File.open(File.join(task_dir, ".lock"), File::RDWR | File::CREAT, 0o644)
lock.flock(File::LOCK_EX)
TaskOwnership.fence!(task_dir)

status = begin
  YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true) || {}
rescue Psych::SyntaxError => e
  warn "status.yaml is corrupt for #{task_id}: #{e.message}"
  exit 3
end
phase = status["phase"].to_s.strip
if type == "grant" && FINISHED_PHASES.include?(phase)
  warn "Refusing to record a grant: #{task_id} is #{phase}."
  exit 2
end

ledger_path = File.join(task_dir, AuthorizationLedger::FILENAME)
begin
  AuthorizationLedger.load(task_dir) # unreadable or integrity-violating ledgers stop here
rescue AuthorizationLedger::Error => e
  warn e.message
  exit 3
end
doc = File.exist?(ledger_path) ? YAML.safe_load(File.read(ledger_path), permitted_classes: [], aliases: false) : {}
doc["task_id"] ||= task_id
doc["authorizations"] = [] unless doc["authorizations"].is_a?(Array)
entries = doc["authorizations"]

used = entries.map { |entry| AuthorizationLedger.id_number(entry["id"]) }.compact
next_id = AuthorizationLedger.format_id(used.max.to_i + 1)
now = begin
  AuthorizationLedger.now_utc
rescue AuthorizationLedger::Error => e
  usage!(e.message)
end
at = AuthorizationLedger.format_time(now)

entry = {
  "id" => next_id,
  "type" => type,
  "actor" => opts[:actor],
  "via" => opts[:via],
  "reason" => opts[:reason],
  "at" => at
}
if type == "grant"
  entry["action"] = opts[:action]
  entry["scope"] = opts[:scope]
  entry["expires_at"] = opts[:expires_at] if opts.key?(:expires_at)
else
  entry["revokes"] = AuthorizationLedger.format_id(AuthorizationLedger.id_number(target_id))
end

# Belt and braces: every integrity rule is re-checked on the would-be ledger.
errors = AuthorizationLedger.validate_entries(entries + [entry])
unless errors.empty?
  usage!("refused: #{errors.join('; ')}")
end

doc["authorizations"] = entries + [entry]
tmp_path = "#{ledger_path}.tmp.#{$$}"
begin
  File.write(tmp_path, YAML.dump(doc))
  File.rename(tmp_path, ledger_path)
rescue StandardError => e
  File.delete(tmp_path) if File.exist?(tmp_path)
  raise e
end

CompletionGuard.append_meta_event!(
  task_dir,
  type: "authorization_recorded",
  agent: CompletionGuard.event_agent(opts[:actor]),
  details: "#{next_id} #{type}#{type == 'grant' ? " action=#{opts[:action]}" : " revokes=#{entry['revokes']}"} actor=#{opts[:actor]}"
)

puts "#{next_id} #{type}"
