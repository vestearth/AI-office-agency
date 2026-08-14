#!/usr/bin/env ruby
# frozen_string_literal: true

# Task ownership and execution leases.
#
# The per-task `.lock` (flock) makes one read-modify-write atomic. It says
# nothing about WHO owns a task across a whole execution: two dispatches can
# take that lock in turn and both write, each perfectly atomically, and the
# later one silently overwrites the earlier one's routing. This file adds the
# missing layer — a task-scoped mutual-exclusion register, fenced by a
# monotonic epoch, tied to the ambient run_id (docs/run-records.md).
#
# Storage: runs/<task-id>/ownership.yaml — one mapping per task.
# Not status.yaml (that is the workflow source of truth, and the file the fence
# has to decide about — ownership must stay readable when status is corrupt),
# not meta.yaml (append-only log; a renewal would rewrite the whole log), not
# run-records/ (append-only per-run history; ownership must be findable without
# already knowing who holds it). See docs/task-ownership.md.
#
# Usage:
#   ruby scripts/task-ownership.rb acquire <task-dir> <task-id> [k=v ...]
#   ruby scripts/task-ownership.rb renew   <task-dir> [k=v ...]
#   ruby scripts/task-ownership.rb release <task-dir> [k=v ...]
#   ruby scripts/task-ownership.rb fence   <task-dir> [k=v ...]
#   ruby scripts/task-ownership.rb show    <task-dir>
#
# k=v: run_id= agent= worktree= mode=exclusive|shared reason= force=true
# run_id defaults to $AI_DEV_OFFICE_RUN_ID, worktree to the detected git
# worktree root (see WORKTREE DETECTION below).
#
# Exit: 0 granted / allowed; 2 usage error; 3 store error; 9 REFUSED (a
# conflicting owner, an unreadable ownership record, or unreadable config).
# 9 is the "someone else owns this" code the driver and the fence both key off.

require "yaml"
require "date"
require "time"
require "digest"

module TaskOwnership
  FILENAME = "ownership.yaml"
  REPO_LOCK = ".ownership.lock"
  MODES = %w[exclusive shared].freeze
  END_REASONS = %w[released reclaimed superseded].freeze
  # Conservative defaults. Every one of these is also the value used when the
  # config is silent; a config that is PRESENT but malformed refuses instead
  # (see config!), because a bad lease length is indistinguishable from no
  # mutual exclusion at all.
  DEFAULT_LEASE_SECONDS = 1800
  REFUSED = 9
  STORE_ERROR = 3

  module_function

  def path(task_dir)
    File.join(task_dir, FILENAME)
  end

  def now
    Time.now.utc
  end

  def iso(time)
    time.utc.strftime("%Y-%m-%dT%H:%M:%SZ")
  end

  # Unparseable timestamps are a corrupt record, never "long ago" — a lenient
  # parse would silently hand the task to the next caller.
  def parse_time(value)
    Time.iso8601(value.to_s).utc
  rescue ArgumentError, TypeError
    nil
  end

  # WORKTREE DETECTION: `git rev-parse --show-toplevel` from the working
  # directory, which resolves to the checkout of a linked worktree exactly as
  # it does for a primary checkout. It is recorded, not trusted: a caller may
  # override it with worktree=, and when detection fails (no git, or not a
  # working tree) the field is null. A null worktree never matches another
  # null worktree in the conflict scan — "unknown" is not evidence of sameness.
  def detect_worktree
    out = `git rev-parse --show-toplevel 2>/dev/null`.to_s.strip
    out.empty? ? nil : out
  end

  # Advisory lock, same file every other writer in the task dir takes.
  def with_lock(dir, name)
    lock = File.open(File.join(dir, name), File::RDWR | File::CREAT, 0o644)
    lock.flock(File::LOCK_EX)
    yield
  ensure
    lock&.close
  end

  def write_atomic(path, data)
    tmp = "#{path}.tmp.#{$$}"
    File.write(tmp, YAML.dump(data))
    File.rename(tmp, path)
  rescue StandardError
    File.delete(tmp) if tmp && File.exist?(tmp)
    raise
  end

  Refusal = Class.new(StandardError)
  StoreError = Class.new(StandardError)

  # Reading the record is where fail-safe lives. Three outcomes only:
  #   nil            -> no record on disk; the task was never governed (legacy)
  #   Hash           -> a structurally valid record
  #   raise Refusal  -> present but unreadable/malformed; callers must refuse
  # There is deliberately no "treat garbage as free" branch.
  def load_record(task_dir)
    file = path(task_dir)
    return nil unless File.exist?(file)

    raw = begin
      YAML.safe_load(File.read(file), permitted_classes: [Date, Time], aliases: true)
    rescue Psych::SyntaxError => e
      raise Refusal, "ownership.yaml is unparseable (#{e.message}); refusing to act on it."
    end
    raise Refusal, "ownership.yaml is not a mapping; refusing to act on it." unless raw.is_a?(Hash)
    unless raw["epoch"].is_a?(Integer) && raw["epoch"] >= 0
      raise Refusal, "ownership.yaml has no usable integer epoch; refusing to act on it."
    end

    holder = raw["holder"]
    if holder && !holder.is_a?(Hash)
      raise Refusal, "ownership.yaml holder is not a mapping; refusing to act on it."
    end
    if holder
      %w[run_id acquired_at lease_expires_at].each do |key|
        if holder[key].to_s.strip.empty?
          raise Refusal, "ownership.yaml holder is missing #{key}; refusing to act on it."
        end
      end
      if parse_time(holder["lease_expires_at"]).nil?
        raise Refusal, "ownership.yaml holder.lease_expires_at is not ISO-8601 UTC; refusing to act on it."
      end
      unless MODES.include?(holder["mode"].to_s)
        raise Refusal, "ownership.yaml holder.mode must be one of: #{MODES.join(', ')}; refusing to act on it."
      end
    end
    raw
  end

  def expired?(holder, at = now)
    deadline = parse_time(holder["lease_expires_at"])
    deadline.nil? || deadline <= at
  end

  # "Live" = a holder exists and its lease has not lapsed. A released record
  # has holder nil, so a release frees the task immediately rather than making
  # the next run wait out the lease.
  def live_holder(record, at = now)
    return nil unless record.is_a?(Hash)

    holder = record["holder"]
    return nil unless holder.is_a?(Hash)
    return nil if expired?(holder, at)

    holder
  end

  def empty_record(task_id)
    { "task_id" => task_id, "epoch" => 0, "holder" => nil, "released_at" => nil,
      "release_reason" => nil, "history" => [], "updated_at" => nil }
  end

  def archive(record, holder, ended_by, reason, at)
    record["history"] = [] unless record["history"].is_a?(Array)
    record["history"] << {
      "epoch" => record["epoch"],
      "run_id" => holder["run_id"],
      "agent" => holder["agent"],
      "worktree" => holder["worktree"],
      "acquired_at" => holder["acquired_at"],
      "ended_at" => iso(at),
      "ended_by" => ended_by,
      "reason" => reason
    }
  end

  # Cross-task worktree control. Task leases are per-task, so nothing in a
  # single task's record can stop TASK-A and TASK-B from mutating the same
  # checkout at once. The scan below closes that: it reads every sibling task's
  # ownership.yaml and refuses when another LIVE exclusive holder names the
  # same worktree. Runs under the repo-scope lock (acquire takes repo lock ->
  # task lock, in that order, and nothing else takes the repo lock, so the
  # ordering cannot invert).
  def worktree_conflict(runs_dir, task_dir, worktree, at)
    return nil if worktree.to_s.strip.empty?

    Dir.glob(File.join(runs_dir, "*", FILENAME)).sort.each do |sibling|
      next if File.expand_path(File.dirname(sibling)) == File.expand_path(task_dir)

      record = begin
        load_record(File.dirname(sibling))
      rescue Refusal
        # A sibling we cannot read is not evidence that the worktree is free.
        raise Refusal, "#{sibling} is unreadable; refusing to grant a worktree-exclusive lease."
      end
      holder = live_holder(record, at)
      next if holder.nil?
      next unless holder["mode"] == "exclusive"
      next unless holder["worktree"].to_s == worktree.to_s

      return { "task_id" => record["task_id"], "run_id" => holder["run_id"], "file" => sibling }
    end
    nil
  end

  # ── The five rules ──────────────────────────────────────────────────────────
  #
  # ACQUIRE   grant when there is no record, no holder, the lease has lapsed
  #           (= RECLAIM), or the holder is this very run (idempotent). Every
  #           grant bumps `epoch` monotonically — the fencing token.
  # RENEW     extend only while the holder is still this run. A run that lost
  #           the lease is told so and exits 9; it never silently re-takes it.
  # REFUSE    any other live holder, or an unreadable record/config.
  # RECLAIM   is acquire against a lapsed lease; the displaced holder is
  #           archived with ended_by: reclaimed, so a zombie is auditable.
  # RELEASE   holder-only (or force=true for an operator), clears the holder.
  def acquire(task_dir, task_id, run_id:, agent: nil, worktree: nil, mode: "exclusive",
              lease_seconds: DEFAULT_LEASE_SECONDS, reason: nil, worktree_exclusive: true)
    raise Refusal, "acquire needs a run_id (set AI_DEV_OFFICE_RUN_ID or pass run_id=)." if run_id.to_s.strip.empty?
    raise Refusal, "mode must be one of: #{MODES.join(', ')}" unless MODES.include?(mode.to_s)

    runs_dir = File.dirname(File.expand_path(task_dir))
    at = now
    result = nil

    with_lock(runs_dir, REPO_LOCK) do
      with_lock(task_dir, ".lock") do
        record = load_record(task_dir) || empty_record(task_id)
        record["task_id"] ||= task_id
        holder = live_holder(record, at)

        if holder && holder["run_id"].to_s != run_id.to_s
          raise Refusal,
                "TASK ownership refused: #{record['task_id']} is held by run #{holder['run_id']} " \
                "(agent=#{holder['agent']}, epoch=#{record['epoch']}, expires #{holder['lease_expires_at']}). " \
                "Wait for the lease to lapse, or release it: " \
                "ruby scripts/task-ownership.rb release #{task_dir} force=true reason=<why>"
        end

        if worktree_exclusive && mode.to_s == "exclusive"
          clash = worktree_conflict(runs_dir, task_dir, worktree, at)
          if clash
            raise Refusal,
                  "TASK ownership refused: worktree #{worktree} is already held exclusively by " \
                  "#{clash['task_id']} (run #{clash['run_id']}). Run in a separate worktree, or " \
                  "declare the sharing explicitly with mode=shared / ownership.allow_shared_worktree."
          end
        end

        stale = record["holder"]
        if holder.nil? && stale.is_a?(Hash) && stale["run_id"].to_s != run_id.to_s
          archive(record, stale, "reclaimed", reason || "lease expired at #{stale['lease_expires_at']}", at)
          result = :reclaimed
        end
        result ||= (holder && holder["run_id"].to_s == run_id.to_s) ? :renewed : :acquired

        record["epoch"] = record["epoch"].to_i + 1
        record["holder"] = {
          "run_id" => run_id.to_s,
          "agent" => agent.to_s.strip.empty? ? nil : agent.to_s,
          "worktree" => worktree.to_s.strip.empty? ? nil : worktree.to_s,
          "mode" => mode.to_s,
          "acquired_at" => iso(at),
          "renewed_at" => iso(at),
          "lease_expires_at" => iso(at + lease_seconds)
        }
        record["released_at"] = nil
        record["release_reason"] = nil
        record["updated_at"] = iso(at)
        write_atomic(path(task_dir), record)
        result = [result, record]
      end
    end
    result
  end

  def renew(task_dir, run_id:, lease_seconds: DEFAULT_LEASE_SECONDS)
    raise Refusal, "renew needs a run_id (set AI_DEV_OFFICE_RUN_ID or pass run_id=)." if run_id.to_s.strip.empty?

    at = now
    with_lock(task_dir, ".lock") do
      record = load_record(task_dir)
      raise Refusal, "no ownership record to renew in #{task_dir}." if record.nil?

      holder = record["holder"]
      unless holder.is_a?(Hash) && holder["run_id"].to_s == run_id.to_s
        raise Refusal,
              "Lease lost: run #{run_id} is not the holder of #{record['task_id']} " \
              "(holder=#{holder.is_a?(Hash) ? holder['run_id'] : 'none'}, epoch=#{record['epoch']}). " \
              "Refusing to renew."
      end

      holder["renewed_at"] = iso(at)
      holder["lease_expires_at"] = iso(at + lease_seconds)
      record["updated_at"] = iso(at)
      write_atomic(path(task_dir), record)
      record
    end
  end

  def release(task_dir, run_id:, reason: nil, force: false)
    at = now
    with_lock(task_dir, ".lock") do
      record = load_record(task_dir)
      return nil if record.nil?

      holder = record["holder"]
      return record unless holder.is_a?(Hash)

      unless force || holder["run_id"].to_s == run_id.to_s
        raise Refusal,
              "Release refused: run #{run_id} is not the holder of #{record['task_id']} " \
              "(holder=#{holder['run_id']}). Pass force=true to release another run's lease."
      end

      ended_by = holder["run_id"].to_s == run_id.to_s ? "released" : "superseded"
      archive(record, holder, ended_by, reason || "released", at)
      record["holder"] = nil
      record["released_at"] = iso(at)
      record["release_reason"] = reason
      record["updated_at"] = iso(at)
      write_atomic(path(task_dir), record)
      record
    end
  end

  # ── The fence ───────────────────────────────────────────────────────────────
  #
  # Called from INSIDE a status writer that already holds the task `.lock`, so
  # it does not lock again (a second flock on the same file from the same
  # process would self-deadlock). Check and write therefore share one critical
  # section: between the fence saying yes and the rename landing, no reclaim can
  # interleave — that is what makes "a stale owner cannot overwrite a newer
  # owner" a property rather than a hope.
  #
  #   no record            -> allow  (task was never governed; additive by design)
  #   no live holder       -> allow  (released, or never held)
  #   holder is me         -> allow, and renew in place (a slow run keeps its own
  #                           task; nobody has taken it, and this is atomic)
  #   holder is someone else -> REFUSE
  #   record unreadable    -> REFUSE
  #   holder but no run_id -> REFUSE (an unattributed writer cannot prove it is
  #                           the owner; loud, with the release command)
  def fence(task_dir, run_id:, lease_seconds: DEFAULT_LEASE_SECONDS)
    record = load_record(task_dir)
    return :ungoverned if record.nil?

    holder = record["holder"]
    return :free unless holder.is_a?(Hash)

    if run_id.to_s.strip.empty?
      raise Refusal,
            "Status write refused: #{record['task_id']} is owned by run #{holder['run_id']} " \
            "(epoch=#{record['epoch']}) and this writer carries no run id. Dispatch through " \
            "run-agent.sh, or release the lease: " \
            "ruby scripts/task-ownership.rb release #{task_dir} force=true reason=<why>"
    end

    if holder["run_id"].to_s != run_id.to_s
      raise Refusal,
            "Status write refused: run #{run_id} lost the lease on #{record['task_id']} to " \
            "run #{holder['run_id']} (epoch=#{record['epoch']}). Refusing to overwrite the " \
            "current owner's status."
    end

    # Still mine. Self-renew so a dispatch that outran its own lease cannot be
    # reclaimed out from under itself mid-write.
    at = now
    holder["renewed_at"] = iso(at)
    holder["lease_expires_at"] = iso(at + lease_seconds)
    record["updated_at"] = iso(at)
    write_atomic(path(task_dir), record)
    :owner
  end

  # Fence helper for the ruby heredocs in run-agent.sh: one call, exits 9 with
  # a loud message on refusal, returns quietly otherwise. `enabled` is read from
  # the environment only (the config resolver is a subprocess and this runs
  # inside the task lock).
  def fence!(task_dir, run_id = ENV["AI_DEV_OFFICE_RUN_ID"])
    return if ENV["AI_DEV_OFFICE_OWNERSHIP"].to_s.downcase == "off"

    fence(task_dir, run_id: run_id)
  rescue Refusal => e
    warn "[ownership] #{e.message}"
    exit REFUSED
  end
end

# ── CLI ──────────────────────────────────────────────────────────────────────

if $PROGRAM_NAME == __FILE__
  def die(message, code = 2)
    warn message
    exit code
  end

  def pairs(args)
    args.each_with_object({}) do |arg, memo|
      key, value = arg.split("=", 2)
      die "Bad key=value argument: #{arg}" if value.nil? || key.to_s.strip.empty?
      memo[key] = value
    end
  end

  # Config is read through the normal resolver so profiles and local overrides
  # apply. A config that is present but unreadable or nonsensical REFUSES (9)
  # instead of falling back to a default: a silently-defaulted lease is a
  # silently-disabled mutual exclusion.
  def config!(office_dir)
    require_relative "resolve-office-config"
    resolver = begin
      OfficeConfigResolver.new(office_dir, profile: ENV["OFFICE_PROFILE"])
    rescue StandardError => e
      die "[ownership] office config is unreadable (#{e.message}); refusing to grant ownership.", TaskOwnership::REFUSED
    end
    values = begin
      {
        "enabled" => resolver.get("ownership.enabled", "true").to_s,
        "lease_seconds" => resolver.get("ownership.lease_seconds", TaskOwnership::DEFAULT_LEASE_SECONDS).to_s,
        "worktree_exclusive" => resolver.get("ownership.worktree_exclusive", "true").to_s,
        "allow_shared_worktree" => resolver.get("ownership.allow_shared_worktree", "false").to_s
      }
    rescue SystemExit, StandardError => e
      die "[ownership] office config is unreadable (#{e.class}); refusing to grant ownership.", TaskOwnership::REFUSED
    end
    unless values["lease_seconds"].match?(/\A\d+\z/) && values["lease_seconds"].to_i.positive?
      die "[ownership] ownership.lease_seconds must be a positive integer, got " \
          "#{values['lease_seconds'].inspect}; refusing to grant ownership.", TaskOwnership::REFUSED
    end
    %w[enabled worktree_exclusive allow_shared_worktree].each do |key|
      unless %w[true false yes no on off 1 0].include?(values[key].downcase)
        die "[ownership] ownership.#{key} must be a boolean, got #{values[key].inspect}; " \
            "refusing to grant ownership.", TaskOwnership::REFUSED
      end
    end
    {
      enabled: %w[true yes on 1].include?(values["enabled"].downcase),
      lease_seconds: values["lease_seconds"].to_i,
      worktree_exclusive: %w[true yes on 1].include?(values["worktree_exclusive"].downcase),
      allow_shared_worktree: %w[true yes on 1].include?(values["allow_shared_worktree"].downcase)
    }
  end

  command = ARGV.shift
  task_dir = ARGV.shift
  die "Usage: task-ownership.rb acquire|renew|release|fence|show <task-dir> [k=v ...]" if command.nil? || task_dir.nil?

  task_id_arg = (command == "acquire" ? ARGV.shift : nil)
  opts = pairs(ARGV)
  office_dir = opts["office_dir"] || ENV["AI_DEV_OFFICE_HOME"] || File.expand_path("..", __dir__)
  run_id = opts["run_id"] || ENV["AI_DEV_OFFICE_RUN_ID"].to_s

  cfg = config!(office_dir)
  # The operator escape hatch: with ownership off, the lifecycle commands are
  # no-ops and the fence passes through — but loudly, if a live holder exists.
  off = !cfg[:enabled] || ENV["AI_DEV_OFFICE_OWNERSHIP"].to_s.downcase == "off"

  begin
    die "Task dir not found: #{task_dir}", TaskOwnership::STORE_ERROR unless File.directory?(task_dir)

    case command
    when "acquire"
      die "Usage: task-ownership.rb acquire <task-dir> <task-id> [k=v ...]" if task_id_arg.nil?
      if off
        puts "ownership disabled: acquire skipped for #{task_id_arg}"
        exit 0
      end
      mode = opts["mode"] || (cfg[:allow_shared_worktree] ? "shared" : "exclusive")
      worktree = opts.key?("worktree") ? opts["worktree"] : TaskOwnership.detect_worktree
      outcome, record = TaskOwnership.acquire(
        task_dir, task_id_arg,
        run_id: run_id, agent: opts["agent"], worktree: worktree, mode: mode,
        lease_seconds: cfg[:lease_seconds], reason: opts["reason"],
        worktree_exclusive: cfg[:worktree_exclusive] && !cfg[:allow_shared_worktree]
      )
      puts "ownership #{outcome}: #{record['task_id']} epoch=#{record['epoch']} " \
           "run=#{record['holder']['run_id']} expires=#{record['holder']['lease_expires_at']}"

    when "renew"
      if off
        puts "ownership disabled: renew skipped"
        exit 0
      end
      record = TaskOwnership.renew(task_dir, run_id: run_id, lease_seconds: cfg[:lease_seconds])
      puts "ownership renewed: #{record['task_id']} epoch=#{record['epoch']} " \
           "expires=#{record['holder']['lease_expires_at']}"

    when "release"
      if off
        puts "ownership disabled: release skipped"
        exit 0
      end
      record = TaskOwnership.release(task_dir, run_id: run_id, reason: opts["reason"],
                                                force: %w[true yes on 1].include?(opts["force"].to_s.downcase))
      puts record.nil? ? "ownership: nothing to release" : "ownership released: #{record['task_id']} epoch=#{record['epoch']}"

    when "fence"
      if off
        record = begin
          TaskOwnership.load_record(task_dir)
        rescue TaskOwnership::Refusal
          nil
        end
        holder = TaskOwnership.live_holder(record)
        warn "[ownership] DISABLED while #{record['task_id']} is held by #{holder['run_id']}" if holder
        puts "ownership disabled: fence passed through"
        exit 0
      end
      puts "ownership fence: #{TaskOwnership.fence(task_dir, run_id: run_id, lease_seconds: cfg[:lease_seconds])}"

    when "show"
      record = TaskOwnership.load_record(task_dir)
      puts record.nil? ? "ownership: none" : YAML.dump(record)

    else
      die "Unknown command: #{command}"
    end
  rescue TaskOwnership::Refusal => e
    warn "[ownership] #{e.message}"
    exit TaskOwnership::REFUSED
  rescue TaskOwnership::StoreError, Errno::ENOENT, Errno::EACCES => e
    warn "[ownership] store error: #{e.message}"
    exit TaskOwnership::STORE_ERROR
  end
end
