#!/usr/bin/env bash
# Task ownership and execution leases (docs/task-ownership.md):
#  O1: exactly one mutable owner — N concurrent acquires, one winner.
#  O2: renewal extends the lease, and only for the holder.
#  O3: an expired lease is reclaimable, and the zombie is archived.
#  O4: release frees the task immediately (no waiting out the lease).
#  O5: THE RACE — a stale owner cannot overwrite a newer owner's status.
#      Proven by interleaving the reclaim and the stale write on the task lock,
#      not by asserting a flag.
#  O6: fail safe — unreadable ownership state and malformed config REFUSE
#      loudly; a task with no ownership record keeps working exactly as before.
#  O7: worktree control — two mutable executions may not share a worktree
#      unless it is explicitly allowed.
#  O8: the per-task .lock contract is untouched (concurrent-status-writes.sh
#      still pins it; here we only pin that the fence lives inside that lock).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OWN="$ROOT/scripts/task-ownership.rb"
DRIVER="$ROOT/run-agent.sh"
ACQUIRERS="${ACQUIRERS:-20}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export AI_DEV_OFFICE_HOME="$ROOT"

ok()   { echo "  ok: $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

# A temp office dir whose only job is to carry a config. The resolver takes the
# office dir as data; scripts/ still resolves from the real repo.
mkoffice() { # <dir> <lease_seconds|raw yaml body>
  mkdir -p "$1"
  cat > "$1/office.config.yaml"
}

SHORT_OFFICE="$WORK/office-short"
mkoffice "$SHORT_OFFICE" <<'Y'
office:
  name: test
  version: "2.0"
ownership:
  enabled: true
  lease_seconds: 1
  worktree_exclusive: true
  allow_shared_worktree: false
Y

# <name> [runs-root] -> task dir. The runs root is a parameter because the
# cross-task worktree scan reads every SIBLING ownership.yaml — so the
# deliberately-corrupt fixtures below live in a runs root of their own, or they
# would (correctly) refuse every later acquire in the suite.
mktask() {
  local d="${2:-$WORK/runs}/$1"
  mkdir -p "$d"
  cat > "$d/status.yaml" <<Y
task_id: $1
phase: assigned
state: assigned
iteration: 1
current_agent: dev
Y
  echo "$d"
}

field() { ruby -ryaml -e 'd=YAML.safe_load(File.read(ARGV[0]))||{}; puts ARGV[1].split(".").reduce(d){|m,k| m.is_a?(Hash) ? m[k] : (m.is_a?(Array) && k.match?(/\A\d+\z/) ? m[k.to_i] : nil)}.inspect' "$1" "$2"; }

# ── O1: exactly one mutable owner under concurrent acquisition ────────────────
T1="$(mktask TASK-OWN-001)"
for i in $(seq 1 "$ACQUIRERS"); do
  (
    rc=0
    AI_DEV_OFFICE_RUN_ID="run-$i" ruby "$OWN" acquire "$T1" TASK-OWN-001 \
      agent=dev "worktree=$WORK/wt-$i" >/dev/null 2>&1 || rc=$?
    echo "$rc" > "$WORK/rc-$i"
  ) &
done
wait
granted=0; refused=0; other=0
for i in $(seq 1 "$ACQUIRERS"); do
  case "$(cat "$WORK/rc-$i")" in
    0) granted=$((granted + 1)) ;;
    9) refused=$((refused + 1)) ;;
    *) other=$((other + 1)) ;;
  esac
done
echo "  acquirers=$ACQUIRERS granted=$granted refused=$refused other=$other"
[[ "$granted" -eq 1 ]] || fail "O1: exactly one acquire must be granted, got $granted"
[[ "$other" -eq 0 ]] || fail "O1: $other acquires failed with an unexpected exit code"
[[ "$(field "$T1/ownership.yaml" epoch)" == "1" ]] || fail "O1: one grant must mean epoch 1"
ok "O1: $ACQUIRERS concurrent acquires -> 1 owner, $refused refused (exit 9), epoch=1"

WINNER="$(ruby -ryaml -e 'puts (YAML.safe_load(File.read(ARGV[0]))||{}).dig("holder","run_id")' "$T1/ownership.yaml")"
[[ -n "$WINNER" ]] || fail "O1: no holder recorded"

# ── O2: renewal extends the lease; a non-holder cannot renew ─────────────────
before="$(field "$T1/ownership.yaml" holder.lease_expires_at)"
sleep 1
AI_DEV_OFFICE_RUN_ID="$WINNER" ruby "$OWN" renew "$T1" >/dev/null || fail "O2: holder renewal must succeed"
after="$(field "$T1/ownership.yaml" holder.lease_expires_at)"
[[ "$after" > "$before" ]] || fail "O2: renewal must push lease_expires_at forward ($before -> $after)"
[[ "$(field "$T1/ownership.yaml" epoch)" == "1" ]] || fail "O2: renewal must not bump the fencing epoch"
rc=0; AI_DEV_OFFICE_RUN_ID="run-not-the-owner" ruby "$OWN" renew "$T1" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O2: a non-holder renewal must be refused with 9, got $rc"
ok "O2: holder renewal extends the lease and keeps the epoch; non-holder renewal refused"

# ── O4: release frees the task immediately ───────────────────────────────────
AI_DEV_OFFICE_RUN_ID="$WINNER" ruby "$OWN" release "$T1" reason=completed >/dev/null
[[ "$(field "$T1/ownership.yaml" holder)" == "nil" ]] || fail "O4: release must clear the holder"
[[ "$(field "$T1/ownership.yaml" history.0.ended_by)" == '"released"' ]] || fail "O4: release must archive the holder"
AI_DEV_OFFICE_RUN_ID="run-next" ruby "$OWN" acquire "$T1" TASK-OWN-001 agent=dev "worktree=$WORK/wt-next" >/dev/null \
  || fail "O4: a released task must be immediately acquirable"
[[ "$(field "$T1/ownership.yaml" epoch)" == "2" ]] || fail "O4: a new grant must bump the epoch"
ok "O4: release clears the holder, archives it, and the task is acquirable at once"

# ── O3: an expired lease is reclaimable and the zombie is archived ────────────
T3="$(mktask TASK-OWN-003)"
AI_DEV_OFFICE_RUN_ID=run-zombie ruby "$OWN" acquire "$T3" TASK-OWN-003 agent=dev \
  "worktree=$WORK/wt-z" "office_dir=$SHORT_OFFICE" >/dev/null
rc=0; AI_DEV_OFFICE_RUN_ID=run-early ruby "$OWN" acquire "$T3" TASK-OWN-003 agent=dev-2 \
  "worktree=$WORK/wt-z2" "office_dir=$SHORT_OFFICE" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O3: a live lease must not be reclaimable, got rc=$rc"
sleep 2
AI_DEV_OFFICE_RUN_ID=run-reclaimer ruby "$OWN" acquire "$T3" TASK-OWN-003 agent=dev-2 \
  "worktree=$WORK/wt-z2" "office_dir=$SHORT_OFFICE" >/dev/null || fail "O3: an expired lease must be reclaimable"
[[ "$(field "$T3/ownership.yaml" holder.run_id)" == '"run-reclaimer"' ]] || fail "O3: reclaimer must be the holder"
[[ "$(field "$T3/ownership.yaml" epoch)" == "2" ]] || fail "O3: reclaim must bump the fencing epoch"
[[ "$(field "$T3/ownership.yaml" history.0.ended_by)" == '"reclaimed"' ]] || fail "O3: the zombie must be archived as reclaimed"
ok "O3: live lease refused, expired lease reclaimed, zombie archived at epoch 2"

# ── O7: two mutable executions may not share a worktree ──────────────────────
T7A="$(mktask TASK-OWN-071)"; T7B="$(mktask TASK-OWN-072)"
SHARED_WT="$WORK/wt-shared"
AI_DEV_OFFICE_RUN_ID=run-7a ruby "$OWN" acquire "$T7A" TASK-OWN-071 agent=dev "worktree=$SHARED_WT" >/dev/null
rc=0; AI_DEV_OFFICE_RUN_ID=run-7b ruby "$OWN" acquire "$T7B" TASK-OWN-072 agent=dev-2 "worktree=$SHARED_WT" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O7: a second exclusive execution in the same worktree must be refused, got rc=$rc"
AI_DEV_OFFICE_RUN_ID=run-7b ruby "$OWN" acquire "$T7B" TASK-OWN-072 agent=dev-2 "worktree=$SHARED_WT" mode=shared >/dev/null \
  || fail "O7: mode=shared must be the explicit opt-in for sharing a worktree"
# A different worktree is never a conflict.
T7C="$(mktask TASK-OWN-073)"
AI_DEV_OFFICE_RUN_ID=run-7c ruby "$OWN" acquire "$T7C" TASK-OWN-073 agent=dev "worktree=$WORK/wt-other" >/dev/null \
  || fail "O7: a distinct worktree must never conflict"
ok "O7: worktree sharing refused by default, allowed only when declared"

# ── O6: fail safe ────────────────────────────────────────────────────────────
# 6a: no ownership record at all -> ungoverned, allowed (backward compatible).
T6="$(mktask TASK-OWN-006)"
[[ ! -f "$T6/ownership.yaml" ]] || fail "O6a: fixture should have no ownership record"
AI_DEV_OFFICE_RUN_ID=run-6 ruby "$OWN" fence "$T6" | grep -q "ungoverned" || fail "O6a: a task with no record must be ungoverned"
ok "O6a: no ownership record -> ungoverned, the write is allowed"

# 6b: an unparseable record REFUSES every operation.
T6B="$(mktask TASK-OWN-006B "$WORK/runs-corrupt")"
printf 'holder: [unterminated\n' > "$T6B/ownership.yaml"
for cmd in fence renew release; do
  rc=0; AI_DEV_OFFICE_RUN_ID=run-6b ruby "$OWN" "$cmd" "$T6B" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 9 ]] || fail "O6b: $cmd on an unparseable record must refuse with 9, got $rc"
done
rc=0; AI_DEV_OFFICE_RUN_ID=run-6b ruby "$OWN" acquire "$T6B" TASK-OWN-006B agent=dev >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O6b: acquire against an unparseable record must refuse with 9, got $rc"
out="$(AI_DEV_OFFICE_RUN_ID=run-6b ruby "$OWN" fence "$T6B" 2>&1 || true)"
grep -q "unparseable" <<<"$out" || fail "O6b: the refusal must be loud about why, got: $out"
ok "O6b: an unparseable ownership record refuses acquire/renew/release/fence, loudly"

# 6c: a structurally-valid-YAML but incoherent record still refuses.
T6C="$(mktask TASK-OWN-006C "$WORK/runs-corrupt")"
cat > "$T6C/ownership.yaml" <<'Y'
task_id: TASK-OWN-006C
epoch: "not-a-number"
holder:
  run_id: run-x
Y
rc=0; AI_DEV_OFFICE_RUN_ID=run-6c ruby "$OWN" fence "$T6C" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O6c: a record with no usable epoch must refuse with 9, got $rc"
ok "O6c: a record with no usable fencing epoch refuses"

# 6d: malformed config refuses instead of silently defaulting the lease.
BAD_OFFICE="$WORK/office-bad"; mkoffice "$BAD_OFFICE" <<'Y'
ownership:
  enabled: true
  lease_seconds: "forever"
Y
T6D="$(mktask TASK-OWN-006D)"
rc=0; out="$(AI_DEV_OFFICE_RUN_ID=run-6d ruby "$OWN" acquire "$T6D" TASK-OWN-006D agent=dev "office_dir=$BAD_OFFICE" 2>&1)" || rc=$?
[[ "$rc" -eq 9 ]] || fail "O6d: a malformed lease_seconds must refuse with 9, got $rc"
grep -q "lease_seconds" <<<"$out" || fail "O6d: the refusal must name the offending key"
[[ ! -f "$T6D/ownership.yaml" ]] || fail "O6d: a refused acquire must not write a record"
# ...and unparseable YAML in the config is the same answer.
CORRUPT_OFFICE="$WORK/office-corrupt"; mkoffice "$CORRUPT_OFFICE" <<'Y'
ownership: [unterminated
Y
rc=0; AI_DEV_OFFICE_RUN_ID=run-6d ruby "$OWN" acquire "$T6D" TASK-OWN-006D agent=dev "office_dir=$CORRUPT_OFFICE" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O6d: an unparseable office config must refuse with 9, got $rc"
ok "O6d: malformed and unparseable config refuse ownership; no record is written"

# 6e: a writer that carries no run id cannot write to an OWNED task.
T6E="$(mktask TASK-OWN-006E)"
AI_DEV_OFFICE_RUN_ID=run-6e ruby "$OWN" acquire "$T6E" TASK-OWN-006E agent=dev "worktree=$WORK/wt-6e" >/dev/null
rc=0; AI_DEV_OFFICE_RUN_ID="" ruby "$OWN" fence "$T6E" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O6e: an unattributed writer must be refused on an owned task, got $rc"
ok "O6e: a writer with no run id cannot write to an owned task"

# ── O5 + O8: the fence lives inside the real status writer ───────────────────
# Pull the REAL sync function out of the driver, exactly as
# resilience-fail-loud.sh does, so we exercise the shipped heredoc.
SFN="$WORK/sync.sh"
awk '/^sync_status_from_output\(\) \{/{f=1} f{print} f && p=="RUBY" && $0=="}"{exit} {p=$0}' "$DRIVER" > "$SFN"
[[ -s "$SFN" ]] || fail "could not extract sync_status_from_output from $DRIVER"
# shellcheck disable=SC1090
source "$SFN"

mkoutput() { cat > "$1" <<'Y'
summary: work done
artifacts:
  - a.txt
blockers: []
next_action:
  agent: reviewer
  reason: ready for review
Y
}

# O8/backward compat: with no ownership record the sync behaves exactly as it
# did before ownership existed.
T5A="$(mktask TASK-OWN-005A)"
mkoutput "$T5A/dev-output.yaml"
sync_status_from_output TASK-OWN-005A dev "$T5A/status.yaml" "$T5A/dev-output.yaml" 2026-01-01 in_review >/dev/null \
  || fail "O8: an ungoverned task must sync exactly as before"
[[ "$(field "$T5A/status.yaml" current_agent)" == '"reviewer"' ]] || fail "O8: the sync must still route"
ok "O8: a task with no ownership record syncs unchanged (additive by construction)"

# O5 (deterministic): stale owner, newer owner, stale write must not land.
T5B="$(mktask TASK-OWN-005B)"
mkoutput "$T5B/dev-output.yaml"
AI_DEV_OFFICE_RUN_ID=run-stale ruby "$OWN" acquire "$T5B" TASK-OWN-005B agent=dev \
  "worktree=$WORK/wt-5b" "office_dir=$SHORT_OFFICE" >/dev/null
sleep 2
AI_DEV_OFFICE_RUN_ID=run-fresh ruby "$OWN" acquire "$T5B" TASK-OWN-005B agent=dev-2 \
  "worktree=$WORK/wt-5b2" "office_dir=$SHORT_OFFICE" >/dev/null || fail "O5: reclaim must succeed"
sha_before="$(shasum "$T5B/status.yaml" | awk '{print $1}')"
rc=0
AI_DEV_OFFICE_RUN_ID=run-stale sync_status_from_output TASK-OWN-005B dev "$T5B/status.yaml" \
  "$T5B/dev-output.yaml" 2026-01-01 in_review >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O5: the stale owner's status write must be refused with 9, got $rc"
[[ "$(shasum "$T5B/status.yaml" | awk '{print $1}')" == "$sha_before" ]] || fail "O5: status.yaml must be byte-identical after a refused write"
ok "O5: after a reclaim, the stale owner's status write is refused and status is untouched"

# O5 (interleaved): the reclaim and the stale write are released onto the task
# lock together. Whichever the kernel grants first, exactly ONE of them may
# succeed — that is the invariant the epoch fence buys.
#
# The interleave: a third process takes runs/<task>/.lock and holds it. The
# stale owner's status write and the new owner's reclaim are both launched and
# both block INSIDE their own critical sections' entry. The holder then lets
# go, and the two proceed back to back with no gap for a check-then-write race.
BOTH_WON=0; STALE_WON=0; RECLAIM_WON=0
for round in 1 2 3 4 5 6; do
  T5C="$(mktask "TASK-OWN-005C$round")"
  mkoutput "$T5C/dev-output.yaml"
  AI_DEV_OFFICE_RUN_ID=run-stale ruby "$OWN" acquire "$T5C" "TASK-OWN-005C$round" agent=dev \
    "worktree=$WORK/wt-5c$round" "office_dir=$SHORT_OFFICE" >/dev/null
  sleep 2   # the stale owner's lease lapses; nobody has taken it yet

  # Gate: hold the task lock until both contenders are queued behind it.
  ruby -e '
    lock = File.open(File.join(ARGV[0], ".lock"), File::RDWR | File::CREAT, 0o644)
    lock.flock(File::LOCK_EX)
    File.write(ARGV[1], "held")
    sleep 5
  ' "$T5C" "$WORK/gate-$round" &
  GATE=$!
  while [[ ! -f "$WORK/gate-$round" ]]; do sleep 0.05; done

  stale_writer() {
    local rc=0
    AI_DEV_OFFICE_RUN_ID=run-stale sync_status_from_output "TASK-OWN-005C$round" dev \
      "$T5C/status.yaml" "$T5C/dev-output.yaml" 2026-01-01 in_review >/dev/null 2>&1 || rc=$?
    echo "$rc" > "$WORK/stale-rc-$round"
  }
  reclaimer() {
    local rc=0
    AI_DEV_OFFICE_RUN_ID=run-fresh ruby "$OWN" acquire "$T5C" "TASK-OWN-005C$round" agent=dev-2 \
      "worktree=$WORK/wt-5cf$round" "office_dir=$SHORT_OFFICE" >/dev/null 2>&1 || rc=$?
    echo "$rc" > "$WORK/reclaim-rc-$round"
  }
  # Alternate which contender queues on the lock first, so BOTH orderings of the
  # interleave are exercised — the invariant has to hold either way.
  if (( round % 2 )); then
    stale_writer & sleep 0.2; reclaimer &
  else
    reclaimer & sleep 0.2; stale_writer &
  fi
  sleep 0.4          # both are now blocked on the lock the gate holds
  kill "$GATE" 2>/dev/null || true
  wait "$GATE" 2>/dev/null || true
  wait

  stale_rc="$(cat "$WORK/stale-rc-$round")"
  reclaim_rc="$(cat "$WORK/reclaim-rc-$round")"
  holder="$(ruby -ryaml -e 'puts((YAML.safe_load(File.read(ARGV[0]))||{}).dig("holder","run_id"))' "$T5C/ownership.yaml")"
  wrote="$(field "$T5C/status.yaml" current_agent)"

  if [[ "$stale_rc" -eq 0 && "$reclaim_rc" -eq 0 ]]; then
    BOTH_WON=$((BOTH_WON + 1))
  elif [[ "$stale_rc" -eq 0 ]]; then
    STALE_WON=$((STALE_WON + 1))
    # The stale owner got the lock first: the fence self-renewed its still-mine
    # lease, so the reclaim MUST have been refused and the owner must be unchanged.
    [[ "$reclaim_rc" -eq 9 ]] || fail "O5-race r$round: stale write landed but reclaim was not refused (rc=$reclaim_rc)"
    [[ "$holder" == "run-stale" ]] || fail "O5-race r$round: stale write landed but holder is $holder"
  elif [[ "$reclaim_rc" -eq 0 ]]; then
    RECLAIM_WON=$((RECLAIM_WON + 1))
    # The reclaim got there first: the stale write MUST have been fenced out and
    # status.yaml must still name the pre-write agent.
    [[ "$stale_rc" -eq 9 ]] || fail "O5-race r$round: reclaim landed but the stale write was not refused (rc=$stale_rc)"
    [[ "$holder" == "run-fresh" ]] || fail "O5-race r$round: reclaim landed but holder is $holder"
    [[ "$wrote" == '"dev"' ]] || fail "O5-race r$round: the stale owner overwrote status.yaml (current_agent=$wrote)"
  else
    fail "O5-race r$round: neither contender made progress (stale=$stale_rc reclaim=$reclaim_rc)"
  fi
done
echo "  race rounds=6 stale_first=$STALE_WON reclaim_first=$RECLAIM_WON both=$BOTH_WON"
[[ "$BOTH_WON" -eq 0 ]] || fail "O5-race: the stale owner and the reclaimer both succeeded in $BOTH_WON round(s)"
ok "O5: under a real interleave, exactly one of {stale write, reclaim} ever wins"

echo "PASS: task ownership — leases acquire/renew/expire/release, fail safe, and fence out stale owners"
