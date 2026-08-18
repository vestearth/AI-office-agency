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
  # Background renewal cadence. Comfortably under the lease so a live dispatch
  # is never reclaimable while it is still running (F6).
  DEFAULT_RENEW_SECONDS = 300
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

  # WORKTREE: SUPPLIED, not reliably detectable. `git rev-parse --show-toplevel`
  # answers for the CALLER'S cwd, and the normal invocation is `./run-agent.sh`
  # from the office directory — so autodetection labels every task with the same
  # path (the office checkout), which is NOT the checkout the agent goes on to
  # edit. Enforcing exclusivity on that value serializes the whole office to one
  # task at a time. So: precedence is AI_DEV_OFFICE_WORKTREE (or worktree=), then
  # the cwd probe as an informational fallback, then null. Cross-task worktree
  # exclusivity is OFF by default for exactly this reason — turn it on only when
  # you supply a real per-task worktree. A null worktree never matches another
  # null worktree in the conflict scan: "unknown" is not evidence of sameness.
  def detect_worktree
    supplied = ENV["AI_DEV_OFFICE_WORKTREE"].to_s.strip
    return supplied unless supplied.empty?

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
  # The comparison is on EPOCH, not on the holder. Comparing run_id against a
  # nullable holder leaves the protection window open for exactly as long as
  # someone holds the task: once the new owner releases normally, `holder` goes
  # nil and a stale writer sails through. Epoch is monotonic and never cleared,
  # so "the task has been granted to someone since I got it" stays true forever.
  #
  # Two credential levels, because not every status writer is a dispatch:
  #
  #   OWNER  (caller presents its held epoch, from AI_DEV_OFFICE_OWNERSHIP_EPOCH)
  #     record.epoch >  mine  -> REFUSE: superseded by a later grant, holder or not
  #     record.epoch <  mine  -> REFUSE: the record rolled back; incoherent
  #     record.epoch == mine  -> allow (and self-renew while the holder is me)
  #
  #   ORCHESTRATOR (caller presents no epoch — the dependency unblocker, the
  #     human-decision reconciler, the parent auto runner routing after the
  #     parallel lanes). These are not dispatches and never held a lease, so
  #     there is no epoch to compare. They are refused while a lease is LIVE
  #     (someone is executing right now) and allowed otherwise. Weaker on
  #     purpose, and stated as such in docs/task-ownership.md.
  #
  # Either way: no record at all -> allow (ungoverned, additive by design);
  # unreadable record -> REFUSE.
  def fence(task_dir, run_id:, epoch: nil, lease_seconds: DEFAULT_LEASE_SECONDS)
    record = load_record(task_dir)
    return :ungoverned if record.nil?

    holder = record["holder"]
    record_epoch = record["epoch"].to_i

    if epoch.nil?
      # Orchestrator lane: refuse only while someone is actually executing.
      live = live_holder(record)
      return :free if live.nil?
      return :owner if !run_id.to_s.strip.empty? && live["run_id"].to_s == run_id.to_s

      raise Refusal,
            "Status write refused: #{record['task_id']} is held by run #{live['run_id']} " \
            "(epoch=#{record_epoch}, expires #{live['lease_expires_at']}) and this writer " \
            "holds no lease. Wait for the dispatch to finish, or release it: " \
            "ruby scripts/task-ownership.rb release #{task_dir} force=true reason=<why>"
    end

    mine = epoch.to_i
    if record_epoch > mine
      raise Refusal,
            "Status write refused: run #{run_id} holds epoch #{mine} on #{record['task_id']} " \
            "but the task has since been granted to epoch #{record_epoch} " \
            "(holder=#{holder.is_a?(Hash) ? holder['run_id'] : 'released'}). Refusing to " \
            "overwrite a newer owner's status."
    end
    if record_epoch < mine
      raise Refusal,
            "Status write refused: run #{run_id} holds epoch #{mine} but #{record['task_id']} " \
            "records epoch #{record_epoch}. The ownership record moved backwards; refusing to " \
            "write against an incoherent register."
    end

    # Same epoch. A grant is unique per epoch, so the holder — if there still is
    # one — must be this very run; anything else means the record was tampered
    # with between the grant and now.
    if holder.is_a?(Hash) && !run_id.to_s.strip.empty? && holder["run_id"].to_s != run_id.to_s
      raise Refusal,
            "Status write refused: #{record['task_id']} epoch #{record_epoch} is recorded " \
            "against run #{holder['run_id']}, not #{run_id}. Refusing to write against an " \
            "inconsistent register."
    end

    return :released unless holder.is_a?(Hash)

    # Still mine. Self-renew so a dispatch that outran its own lease cannot be
    # reclaimed out from under itself mid-write.
    at = now
    holder["renewed_at"] = iso(at)
    holder["lease_expires_at"] = iso(at + lease_seconds)
    record["updated_at"] = iso(at)
    write_atomic(path(task_dir), record)
    :owner
  end

  # Fence helper for the ruby heredocs in run-agent.sh and for the helper
  # scripts it spawns: one call, exits 9 with a loud message on refusal, returns
  # quietly otherwise. Credentials come from the environment the driver exports.
  # `force_orchestrator` drops the epoch even when one is present, for writers
  # that are structurally not the dispatch (see the ORCHESTRATOR lane above).
  def fence!(task_dir, run_id = ENV["AI_DEV_OFFICE_RUN_ID"], force_orchestrator: false)
    # The kill switch. `ownership.enabled: false` reaches here because
    # run-agent.sh translates it into this variable at acquire time — the fence
    # runs inside the task lock and cannot spawn a config resolver. Passing
    # through is LOUD whenever it actually waives a live lease, so a disabled
    # office never silently looks like a governed one.
    if ENV["AI_DEV_OFFICE_OWNERSHIP"].to_s.downcase == "off"
      record = begin
        load_record(task_dir)
      rescue Refusal
        warn "[ownership] DISABLED: #{task_dir} has an unreadable ownership record; " \
             "allowing this write unfenced."
        nil
      end
      holder = live_holder(record)
      if holder
        warn "[ownership] DISABLED: #{record['task_id']} is held by run #{holder['run_id']} " \
             "(epoch=#{record['epoch']}, expires #{holder['lease_expires_at']}) — allowing this " \
             "write unfenced. Unset AI_DEV_OFFICE_OWNERSHIP / set ownership.enabled: true to re-arm."
      end
      return
    end

    # UNSET is the designed orchestrator lane (see fence) — a writer that never
    # held a lease. SET-BUT-INVALID is a different thing entirely: a
    # non-numeric, empty or negative epoch is corruption or tampering, and
    # silently downgrading it to the weaker lane would let it through once the
    # newer owner released. Refuse — every other unreadable credential here
    # refuses. (ownership_release UNSETS the variable rather than blanking it,
    # so an empty value is never something this harness produces.)
    raw = ENV["AI_DEV_OFFICE_OWNERSHIP_EPOCH"]
    if !raw.nil? && !raw.match?(/\A\d+\z/)
      warn "[ownership] Status write refused: AI_DEV_OFFICE_OWNERSHIP_EPOCH is set to " \
           "#{raw.inspect}, which is not a non-negative integer. Refusing rather than " \
           "downgrading to an unfenced write."
      exit REFUSED
    end
    epoch = (!force_orchestrator && !raw.nil?) ? raw.to_i : nil
    fence(task_dir, run_id: run_id, epoch: epoch)
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
        "renew_interval_seconds" => resolver.get("ownership.renew_interval_seconds", TaskOwnership::DEFAULT_RENEW_SECONDS).to_s,
        # Default OFF, matching office.config.yaml: the harness cannot tell which
        # checkout an agent will edit, and enforcing exclusivity on the cwd probe
        # serializes the whole office (F3). Opt in with a real per-task worktree.
        "worktree_exclusive" => resolver.get("ownership.worktree_exclusive", "false").to_s,
        "allow_shared_worktree" => resolver.get("ownership.allow_shared_worktree", "false").to_s
      }
    rescue SystemExit, StandardError => e
      die "[ownership] office config is unreadable (#{e.class}); refusing to grant ownership.", TaskOwnership::REFUSED
    end
    %w[lease_seconds renew_interval_seconds].each do |key|
      unless values[key].match?(/\A\d+\z/) && values[key].to_i.positive?
        die "[ownership] ownership.#{key} must be a positive integer, got " \
            "#{values[key].inspect}; refusing to grant ownership.", TaskOwnership::REFUSED
      end
    end
    if values["renew_interval_seconds"].to_i >= values["lease_seconds"].to_i
      die "[ownership] ownership.renew_interval_seconds (#{values['renew_interval_seconds']}) must be " \
          "smaller than ownership.lease_seconds (#{values['lease_seconds']}), or a live dispatch " \
          "becomes reclaimable before it ever renews; refusing to grant ownership.", TaskOwnership::REFUSED
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
      renew_interval_seconds: values["renew_interval_seconds"].to_i,
      worktree_exclusive: %w[true yes on 1].include?(values["worktree_exclusive"].downcase),
      allow_shared_worktree: %w[true yes on 1].include?(values["allow_shared_worktree"].downcase)
    }
  end

  command = ARGV.shift
  task_dir = ARGV.shift
  die "Usage: task-ownership.rb acquire|renew|release|fence|show <task-dir> [k=v ...]" if command.nil? || task_dir.nil?

  task_id_arg = (command == "acquire" ? ARGV.shift : nil)
  opts = pairs(ARGV)
  # Config source, most specific first. AI_DEV_OFFICE_CONFIG_DIR exists so a
  # test (or an operator running an alternate policy) can point ownership at a
  # different office config without relocating the scripts — the same reason
  # enforce-output-contract.rb honours AI_OFFICE_RUNS_DIR.
  office_dir = opts["office_dir"] || ENV["AI_DEV_OFFICE_CONFIG_DIR"] ||
               ENV["AI_DEV_OFFICE_HOME"] || File.expand_path("..", __dir__)
  run_id = opts["run_id"] || ENV["AI_DEV_OFFICE_RUN_ID"].to_s

  cfg = config!(office_dir)
  # The operator escape hatch: with ownership off, the lifecycle commands are
  # no-ops and the fence passes through — but loudly, if a live holder exists.
  off = !cfg[:enabled] || ENV["AI_DEV_OFFICE_OWNERSHIP"].to_s.downcase == "off"

  begin
    unless command == "config" || File.directory?(task_dir)
      die "Task dir not found: #{task_dir}", TaskOwnership::STORE_ERROR
    end

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
      # F8: `fence` self-renews via write_atomic, so the CLI path must hold the
      # task lock exactly as the in-process callers do (they already hold it;
      # the library never locks for itself). Without this the CLI would be the
      # one check-then-write outside the critical section the design rests on.
      fence_epoch = opts["epoch"] || ENV["AI_DEV_OFFICE_OWNERSHIP_EPOCH"].to_s
      fence_epoch = fence_epoch.match?(/\A\d+\z/) ? fence_epoch.to_i : nil
      outcome = TaskOwnership.with_lock(task_dir, ".lock") do
        TaskOwnership.fence(task_dir, run_id: run_id, epoch: fence_epoch, lease_seconds: cfg[:lease_seconds])
      end
      puts "ownership fence: #{outcome}"

    when "config"
      # Resolved, validated values for the bash side (the renewer needs the
      # cadence). Malformed config has already refused above, so anything
      # printed here is safe to use.
      cfg.each { |key, value| puts "#{key}=#{value}" }

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
