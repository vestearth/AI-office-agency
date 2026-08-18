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
  lease_seconds: 2
  renew_interval_seconds: 1
  # Matches the shipped default; O7 opts exclusivity in explicitly.
  worktree_exclusive: false
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
sleep 3
AI_DEV_OFFICE_RUN_ID=run-reclaimer ruby "$OWN" acquire "$T3" TASK-OWN-003 agent=dev-2 \
  "worktree=$WORK/wt-z2" "office_dir=$SHORT_OFFICE" >/dev/null || fail "O3: an expired lease must be reclaimable"
[[ "$(field "$T3/ownership.yaml" holder.run_id)" == '"run-reclaimer"' ]] || fail "O3: reclaimer must be the holder"
[[ "$(field "$T3/ownership.yaml" epoch)" == "2" ]] || fail "O3: reclaim must bump the fencing epoch"
[[ "$(field "$T3/ownership.yaml" history.0.ended_by)" == '"reclaimed"' ]] || fail "O3: the zombie must be archived as reclaimed"
ok "O3: live lease refused, expired lease reclaimed, zombie archived at epoch 2"

# ── O7: two mutable executions may not share a worktree ──────────────────────
# Worktree exclusivity ships OFF (see O12), so this section opts it in.
WT_OFFICE="$WORK/office-wt"
mkoffice "$WT_OFFICE" <<'Y'
ownership:
  enabled: true
  lease_seconds: 1800
  renew_interval_seconds: 300
  worktree_exclusive: true
  allow_shared_worktree: false
Y
T7A="$(mktask TASK-OWN-071)"; T7B="$(mktask TASK-OWN-072)"
SHARED_WT="$WORK/wt-shared"
AI_DEV_OFFICE_RUN_ID=run-7a ruby "$OWN" acquire "$T7A" TASK-OWN-071 agent=dev "worktree=$SHARED_WT" "office_dir=$WT_OFFICE" >/dev/null
rc=0; AI_DEV_OFFICE_RUN_ID=run-7b ruby "$OWN" acquire "$T7B" TASK-OWN-072 agent=dev-2 "worktree=$SHARED_WT" "office_dir=$WT_OFFICE" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O7: a second exclusive execution in the same worktree must be refused, got rc=$rc"
AI_DEV_OFFICE_RUN_ID=run-7b ruby "$OWN" acquire "$T7B" TASK-OWN-072 agent=dev-2 "worktree=$SHARED_WT" mode=shared "office_dir=$WT_OFFICE" >/dev/null \
  || fail "O7: mode=shared must be the explicit opt-in for sharing a worktree"
# A different worktree is never a conflict.
T7C="$(mktask TASK-OWN-073)"
AI_DEV_OFFICE_RUN_ID=run-7c ruby "$OWN" acquire "$T7C" TASK-OWN-073 agent=dev "worktree=$WORK/wt-other" "office_dir=$WT_OFFICE" >/dev/null \
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
sleep 3
AI_DEV_OFFICE_RUN_ID=run-fresh ruby "$OWN" acquire "$T5B" TASK-OWN-005B agent=dev-2 \
  "worktree=$WORK/wt-5b2" "office_dir=$SHORT_OFFICE" >/dev/null || fail "O5: reclaim must succeed"
sha_before="$(shasum "$T5B/status.yaml" | awk '{print $1}')"
rc=0
AI_DEV_OFFICE_RUN_ID=run-stale AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 sync_status_from_output TASK-OWN-005B dev "$T5B/status.yaml" \
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
  sleep 3   # the stale owner's lease lapses; nobody has taken it yet

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
    AI_DEV_OFFICE_RUN_ID=run-stale AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 sync_status_from_output "TASK-OWN-005C$round" dev \
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

# ── O9: the validator knows the record ───────────────────────────────────────
ruby "$ROOT/validate-yaml.rb" "$T3/ownership.yaml" >/dev/null || fail "O9: a real ownership record must validate"
BADREC="$WORK/bad-ownership.yaml"
cat > "$BADREC" <<'Y'
task_id: TASK-OWN-999
epoch: -1
holder:
  run_id: ""
  mode: whatever
  acquired_at: yesterday
  renewed_at: yesterday
  lease_expires_at: yesterday
history:
  - run_id: r
    ended_by: vanished
Y
rc=0; ruby "$ROOT/validate-yaml.rb" "$BADREC" >/dev/null 2>&1 || rc=$?
[[ "$rc" -ne 0 ]] || fail "O9: a malformed ownership record must fail validation"
ok "O9: validate-yaml.rb accepts a real ownership record and rejects a malformed one"

# ── O10: the driver really acquires and releases ─────────────────────────────
# End to end through run-agent.sh with a stub runner, in a dedicated temp task
# under the real runs/ (removed on exit), exactly as runner-fallback.sh does.
RUNS_DIR="$ROOT/runs"
E2E_TASK="TASK-OWNE$$"
E2E_DIR="$RUNS_DIR/$E2E_TASK"
BIN_DIR="$WORK/bin"; mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK" "$E2E_DIR"' EXIT
mkdir -p "$E2E_DIR"
cat > "$E2E_DIR/status.yaml" <<YAML
task_id: $E2E_TASK
phase: assigned
state: assigned
iteration: 0
current_agent: dev
assignment:
  primary: dev
  parallel: false
ready: true
created_at: "2026-05-13"
updated_at: "2026-05-13"
history: []
YAML
printf '#!/usr/bin/env bash\nsleep 6\nexit 0\n' > "$BIN_DIR/codex"
chmod +x "$BIN_DIR/codex"

( PATH="$BIN_DIR:$PATH" "$ROOT/run-agent.sh" "$E2E_TASK" dev >"$WORK/e2e-1.log" 2>&1; echo "$?" > "$WORK/e2e-1.rc" ) &
E2E_PID=$!
for _ in $(seq 1 100); do
  [[ -f "$E2E_DIR/ownership.yaml" ]] && [[ "$(field "$E2E_DIR/ownership.yaml" holder.run_id)" != "nil" ]] && break
  sleep 0.2
done
[[ "$(field "$E2E_DIR/ownership.yaml" holder.run_id)" != "nil" ]] || fail "O10: the driver must acquire a lease at dispatch"
[[ "$(field "$E2E_DIR/ownership.yaml" holder.agent)" == '"dev"' ]] || fail "O10: the lease must record the dispatched agent"
[[ "$(field "$E2E_DIR/ownership.yaml" holder.worktree)" != "nil" ]] || fail "O10: the driver must detect and record its worktree"

rc=0; out="$(PATH="$BIN_DIR:$PATH" "$ROOT/run-agent.sh" "$E2E_TASK" dev 2>&1)" || rc=$?
[[ "$rc" -eq 9 ]] || fail "O10: a second concurrent dispatch must be refused with 9, got $rc"
grep -qE "ownership refused|is held by run" <<<"$out" || fail "O10: the second dispatch must say why it was refused: $out"

wait "$E2E_PID" || true
[[ "$(field "$E2E_DIR/ownership.yaml" holder)" == "nil" ]] || fail "O10: the driver must release the lease when the dispatch ends"
grep -q "ownership_acquired" "$E2E_DIR/meta.yaml" || fail "O10: acquisition must be logged as a meta event"
ok "O10: run-agent.sh acquires at dispatch, refuses a concurrent dispatch, and releases at the end"

# ── O11: the parallel dev/dev-2 lanes are sub-executions, not rival owners ───
# They are one deliberate concurrent execution of a single task and already
# skip status writes, so they must NOT take the lease — if they did, lane 2
# would refuse lane 1 and auto-parallel.sh would break.
P_TASK="TASK-OWNP$$"
P_DIR="$RUNS_DIR/$P_TASK"
trap 'rm -rf "$WORK" "$E2E_DIR" "$P_DIR"' EXIT
mkdir -p "$P_DIR"
sed "s/$E2E_TASK/$P_TASK/" "$E2E_DIR/status.yaml" > "$P_DIR/status.yaml"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN_DIR/codex"
PATH="$BIN_DIR:$PATH" AI_DEV_OFFICE_PARALLEL_AUTO=true AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true \
  "$ROOT/run-agent.sh" "$P_TASK" dev >"$WORK/e2e-2.log" 2>&1 || fail "O11: a parallel lane must run: $(tail -5 "$WORK/e2e-2.log")"
[[ ! -f "$P_DIR/ownership.yaml" ]] || fail "O11: a parallel-auto lane must not take the task lease"
ok "O11: parallel dev/dev-2 lanes do not take the lease (they never write status)"

# ── O12: the shipped defaults do not serialize the office ────────────────────
# Autodetected worktree = the CALLER'S cwd = the office dir for every task, so
# a default-on cross-task worktree scan would refuse every second task. Two
# UNRELATED tasks, dispatched the ordinary way (no explicit worktree=), must
# both get their leases.
T12A="$(mktask TASK-OWN-121)"; T12B="$(mktask TASK-OWN-122)"
AI_DEV_OFFICE_RUN_ID=run-12a ruby "$OWN" acquire "$T12A" TASK-OWN-121 agent=dev >/dev/null \
  || fail "O12: the first ordinary task must acquire"
rc=0; out="$(AI_DEV_OFFICE_RUN_ID=run-12b ruby "$OWN" acquire "$T12B" TASK-OWN-122 agent=dev 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "O12: a SECOND, UNRELATED task must not be refused by the shipped defaults (rc=$rc): $out"
[[ "$(field "$T12A/ownership.yaml" holder.run_id)" == '"run-12a"' ]] || fail "O12: task A must still hold its lease"
[[ "$(field "$T12B/ownership.yaml" holder.run_id)" == '"run-12b"' ]] || fail "O12: task B must hold its own lease"
# Same again through a config that OMITS the worktree keys, so the code's own
# fallback is pinned too — not just the value that happens to be in
# office.config.yaml.
BARE_OFFICE="$WORK/office-bare"; mkoffice "$BARE_OFFICE" <<'Y'
ownership:
  enabled: true
  lease_seconds: 1800
  renew_interval_seconds: 300
Y
T12C="$(mktask TASK-OWN-123)"; T12D="$(mktask TASK-OWN-124)"
AI_DEV_OFFICE_RUN_ID=run-12c ruby "$OWN" acquire "$T12C" TASK-OWN-123 agent=dev "office_dir=$BARE_OFFICE" >/dev/null \
  || fail "O12: the first task must acquire under a config that omits the worktree keys"
rc=0; out="$(AI_DEV_OFFICE_RUN_ID=run-12d ruby "$OWN" acquire "$T12D" TASK-OWN-124 agent=dev "office_dir=$BARE_OFFICE" 2>&1)" || rc=$?
[[ "$rc" -eq 0 ]] || fail "O12: the CODE default for worktree_exclusive must not serialize the office either (rc=$rc): $out"
ok "O12: two unrelated tasks both acquire under the shipped defaults (no office-wide serialization)"

# ── O13 (F2): the epoch is COMPARED, not merely written ──────────────────────
# The hole a run_id-vs-holder check leaves open: the protection ends the moment
# the new owner releases normally. A epoch1 -> lapses -> B reclaims epoch2 ->
# B releases (holder now nil) -> A writes. Epoch is monotonic and never
# cleared, so it still refuses.
T13="$(mktask TASK-OWN-013)"
mkoutput "$T13/dev-output.yaml"
AI_DEV_OFFICE_RUN_ID=run-a ruby "$OWN" acquire "$T13" TASK-OWN-013 agent=dev "office_dir=$SHORT_OFFICE" >/dev/null
sleep 3
AI_DEV_OFFICE_RUN_ID=run-b ruby "$OWN" acquire "$T13" TASK-OWN-013 agent=dev-2 "office_dir=$SHORT_OFFICE" >/dev/null
[[ "$(field "$T13/ownership.yaml" epoch)" == "2" ]] || fail "O13: the reclaim must be epoch 2"
AI_DEV_OFFICE_RUN_ID=run-b AI_DEV_OFFICE_OWNERSHIP_EPOCH=2 ruby "$OWN" release "$T13" reason=completed "office_dir=$SHORT_OFFICE" >/dev/null
[[ "$(field "$T13/ownership.yaml" holder)" == "nil" ]] || fail "O13: B must have released (holder nil)"
sha_before="$(shasum "$T13/status.yaml" | awk '{print $1}')"
rc=0
AI_DEV_OFFICE_RUN_ID=run-a AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 sync_status_from_output TASK-OWN-013 dev \
  "$T13/status.yaml" "$T13/dev-output.yaml" 2026-01-01 in_review >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O13: a stale epoch must be refused even after the newer owner released, got $rc"
[[ "$(shasum "$T13/status.yaml" | awk '{print $1}')" == "$sha_before" ]] || fail "O13: status.yaml must be untouched"
# The holder of that epoch may still write after its own release (nobody took it).
rc=0
AI_DEV_OFFICE_RUN_ID=run-b AI_DEV_OFFICE_OWNERSHIP_EPOCH=2 sync_status_from_output TASK-OWN-013 dev \
  "$T13/status.yaml" "$T13/dev-output.yaml" 2026-01-01 in_review >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 0 ]] || fail "O13: the current epoch holder must still be able to write after its own release, got $rc"
ok "O13: epoch is compared — a stale owner is refused even once the newer owner has released"

# ── O14 (F1): every status writer is fenced, not just the two obvious ones ───
# The contract enforcer writes phase/state/current_agent on the NORMAL failure
# path. Unfenced, a stale run reaches the forbidden scenario through plain
# validation failure.
T14="$(mktask TASK-OWN-014)"
printf 'summary: bad\nnext_action: {}\n' > "$T14/dev-output.yaml"
AI_DEV_OFFICE_RUN_ID=run-b2 ruby "$OWN" acquire "$T14" TASK-OWN-014 agent=dev-2 >/dev/null
sha_before="$(shasum "$T14/status.yaml" | awk '{print $1}')"
rc=0
out="$(AI_OFFICE_RUNS_DIR="$(dirname "$T14")" AI_DEV_OFFICE_RUN_ID=run-a2 AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 \
  ruby "$ROOT/scripts/enforce-output-contract.rb" TASK-OWN-014 dev 2>&1)" || rc=$?
[[ "$rc" -eq 9 ]] || fail "O14: the contract enforcer must refuse a stale owner's status write, got $rc: $out"
[[ "$(shasum "$T14/status.yaml" | awk '{print $1}')" == "$sha_before" ]] || fail "O14: status.yaml must be untouched by a fenced-out enforcer"
grep -q "phase: assigned" "$T14/status.yaml" || fail "O14: phase must NOT have moved to validation_failed"
# The real owner is still allowed through the same path.
rc=0
AI_OFFICE_RUNS_DIR="$(dirname "$T14")" AI_DEV_OFFICE_RUN_ID=run-b2 AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 \
  ruby "$ROOT/scripts/enforce-output-contract.rb" TASK-OWN-014 dev >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 1 ]] || fail "O14: the true owner must still reach validation_failed (rc=1), got $rc"
grep -q "phase: validation_failed" "$T14/status.yaml" || fail "O14: the owner's enforcement must land"
ok "O14: scripts/enforce-output-contract.rb is fenced — stale refused, owner allowed"

# ── O15 (F1, orchestrator lane): the human-decision reconciler ───────────────
# Not a dispatch and never holds a lease, so it is refused only while one is
# LIVE — landing a phase change under a running agent races that dispatch.
T15="$(mktask TASK-OWN-015)"
cat > "$T15/decision.yaml" <<'Y'
decisions:
  - decision: approve
    actor: operator
    decided_at: "2026-01-01T00:00:00Z"
Y
AI_DEV_OFFICE_RUN_ID=run-live ruby "$OWN" acquire "$T15" TASK-OWN-015 agent=dev >/dev/null
rc=0; out="$(AI_OFFICE_RUNS_DIR="$(dirname "$T15")" ruby "$ROOT/scripts/reconcile-decision.rb" TASK-OWN-015 2>&1)" || rc=$?
[[ "$rc" -eq 9 ]] || fail "O15: a human decision must not land under a LIVE dispatch, got $rc: $out"
grep -q "phase: assigned" "$T15/status.yaml" || fail "O15: status must be untouched while the lease is live"
AI_DEV_OFFICE_RUN_ID=run-live AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 ruby "$OWN" release "$T15" reason=done >/dev/null
rc=0; AI_OFFICE_RUNS_DIR="$(dirname "$T15")" ruby "$ROOT/scripts/reconcile-decision.rb" TASK-OWN-015 >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 0 ]] || fail "O15: once released, the decision must apply normally, got $rc"
grep -q "phase: done" "$T15/status.yaml" || fail "O15: the approved decision must land after release"
ok "O15: reconcile-decision.rb is fenced on the orchestrator lane — blocked while live, applies once released"

# ── O16 (F1, orchestrator lane): the dependency unblocker ────────────────────
UFN="$WORK/unblock.sh"
awk '/^reconcile_blocked_status\(\) \{/{f=1} f{print} f && p=="RUBY" && $0=="}"{exit} {p=$0}' "$DRIVER" > "$UFN"
[[ -s "$UFN" ]] || fail "could not extract reconcile_blocked_status from $DRIVER"
# shellcheck disable=SC1090
source "$UFN"
U_ROOT="$WORK/runs-unblock"
T16="$(mktask TASK-OWN-016 "$U_ROOT")"; T16UP="$(mktask TASK-OWN-016U "$U_ROOT")"
cat > "$T16/status.yaml" <<'Y'
task_id: TASK-OWN-016
phase: blocked
state: blocked
iteration: 1
current_agent: dev
blocked_on:
  - TASK-OWN-016U
assignment:
  primary: dev
Y
sed -i.bak 's/phase: assigned/phase: done/; s/state: assigned/state: done/' "$T16UP/status.yaml" && rm -f "$T16UP/status.yaml.bak"
AI_DEV_OFFICE_RUN_ID=run-live2 ruby "$OWN" acquire "$T16" TASK-OWN-016 agent=dev >/dev/null
rc=0; reconcile_blocked_status TASK-OWN-016 "$T16/status.yaml" "$U_ROOT" 2026-01-01 done in_review true true true >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O16: the unblocker must not rewrite a task under a LIVE dispatch, got $rc"
grep -q "phase: blocked" "$T16/status.yaml" || fail "O16: status must still be blocked"
AI_DEV_OFFICE_RUN_ID=run-live2 AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 ruby "$OWN" release "$T16" reason=done >/dev/null
rc=0; reconcile_blocked_status TASK-OWN-016 "$T16/status.yaml" "$U_ROOT" 2026-01-01 done in_review true true true >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 0 ]] || fail "O16: once released, the unblocker must run normally, got $rc"
grep -q "phase: assigned" "$T16/status.yaml" || fail "O16: the task must unblock after release"
ok "O16: the dependency unblocker is fenced on the orchestrator lane"

# ── O17 (F4): the parallel-lane exemption is NARROW ──────────────────────────
# It is keyed on env vars, which are forgeable, so every condition of the real
# lane must hold together. Setting the parallel marker alone must not buy a
# free pass past a live owner.
T17="$(mktask TASK-OWN-017)"
AI_DEV_OFFICE_RUN_ID=run-owner17 ruby "$OWN" acquire "$T17" TASK-OWN-017 agent=dev >/dev/null
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN_DIR/codex"
attempt() {  # <env assignments...> -> rc of an ordinary dispatch against the live owner
  local rc=0
  env "$@" PATH="$BIN_DIR:$PATH" "$ROOT/run-agent.sh" "$(basename "$T17")" dev >/dev/null 2>&1 || rc=$?
  echo "$rc"
}
# The fixtures above live in $WORK, but the driver only reads the real runs/, so
# mirror this one task in there for the driver-level checks.
D17="$RUNS_DIR/TASK-OWNQ$$"
mkdir -p "$D17"; trap 'rm -rf "$WORK" "$E2E_DIR" "$P_DIR" "$D17"' EXIT
sed "s/TASK-OWN-017/$(basename "$D17")/" "$T17/status.yaml" > "$D17/status.yaml"
cp "$T17/ownership.yaml" "$D17/ownership.yaml"
ruby -ryaml -e 'd=YAML.safe_load(File.read(ARGV[0])); d["task_id"]=ARGV[1]; File.write(ARGV[0], YAML.dump(d))' \
  "$D17/ownership.yaml" "$(basename "$D17")"
drive() {  # <env assignments...>
  local rc=0
  env "$@" PATH="$BIN_DIR:$PATH" "$ROOT/run-agent.sh" "$(basename "$D17")" "${DRIVE_AGENT:-dev}" >/dev/null 2>&1 || rc=$?
  echo "$rc"
}
[[ "$(drive X=1)" -eq 9 ]] || fail "O17: an ordinary dispatch against a live owner must be refused"
[[ "$(drive AI_DEV_OFFICE_PARALLEL_AUTO=true)" -eq 9 ]] \
  || fail "O17: the parallel marker ALONE must not exempt a dispatch from the lease"
# The agent condition is asserted against the real predicate: a reviewer
# dispatch would be rejected by the route guard for unrelated reasons, which
# would make a driver-level check prove nothing about the exemption.
PFN="$WORK/parallel_lane.sh"
awk '/^ownership_parallel_lane\(\) \{/{f=1} f{print} f && $0=="}"{exit}' "$DRIVER" > "$PFN"
[[ -s "$PFN" ]] || fail "could not extract ownership_parallel_lane from $DRIVER"
# shellcheck disable=SC1090
source "$PFN"
AI_DEV_OFFICE_PARALLEL_AUTO=true AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true ownership_parallel_lane dev \
  || fail "O17: dev with both markers is the genuine lane"
AI_DEV_OFFICE_PARALLEL_AUTO=true AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true ownership_parallel_lane dev-2 \
  || fail "O17: dev-2 with both markers is the genuine lane"
for forged in reviewer debugger devops free-roam pm auto; do
  ! AI_DEV_OFFICE_PARALLEL_AUTO=true AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true ownership_parallel_lane "$forged" \
    || fail "O17: '$forged' must not qualify as a parallel dev lane"
done
! AI_DEV_OFFICE_PARALLEL_AUTO=true ownership_parallel_lane dev || fail "O17: the parallel marker alone must not qualify"
! AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true ownership_parallel_lane dev || fail "O17: the skip-status marker alone must not qualify"
[[ "$(drive AI_DEV_OFFICE_PARALLEL_AUTO=true AI_DEV_OFFICE_PARALLEL_AUTO_SKIP_STATUS=true)" -eq 0 ]] \
  || fail "O17: the genuine parallel lane (dev + both markers) must still be exempt"
ok "O17: the exemption needs both markers AND a dev/dev-2 agent; each condition alone still refuses"

# ── O18 (F5): an interrupted dispatch releases its lease ─────────────────────
# Without a release in the EXIT trap, a SIGTERM'd run wedges the task for the
# whole lease_seconds.
T18="$RUNS_DIR/TASK-OWNI$$"
mkdir -p "$T18"; trap 'rm -rf "$WORK" "$E2E_DIR" "$P_DIR" "$D17" "$T18"' EXIT
sed "s/$(basename "$D17")/$(basename "$T18")/" "$D17/status.yaml" > "$T18/status.yaml"
printf '#!/usr/bin/env bash\nsleep 30\n' > "$BIN_DIR/codex"
PATH="$BIN_DIR:$PATH" "$ROOT/run-agent.sh" "$(basename "$T18")" dev >/dev/null 2>&1 &
KILL_PID=$!
for _ in $(seq 1 100); do
  [[ -f "$T18/ownership.yaml" ]] && [[ "$(field "$T18/ownership.yaml" holder.run_id)" != "nil" ]] && break
  sleep 0.2
done
[[ "$(field "$T18/ownership.yaml" holder.run_id)" != "nil" ]] || fail "O18: the dispatch must hold a lease before we interrupt it"
kill -TERM "$KILL_PID" 2>/dev/null || true
wait "$KILL_PID" 2>/dev/null || true
for _ in $(seq 1 50); do
  [[ "$(field "$T18/ownership.yaml" holder)" == "nil" ]] && break
  sleep 0.2
done
[[ "$(field "$T18/ownership.yaml" holder)" == "nil" ]] \
  || fail "O18: a SIGTERM'd dispatch must release its lease, not wedge the task for the whole lease"
ok "O18: an interrupted dispatch releases its lease on the way out"

# ── O19 (F6): the lease is renewed DURING a dispatch, not only at its end ────
# The only in-dispatch status write is the last one, so a fence-time self-renew
# leaves a long run unrenewed for its whole life. A background renewer must push
# lease_expires_at forward while the runner is still working.
RENEW_OFFICE="$WORK/office-renew"
mkoffice "$RENEW_OFFICE" <<'Y'
office:
  name: test
  version: "2.0"
ownership:
  enabled: true
  lease_seconds: 4
  renew_interval_seconds: 1
Y
# Drive the REAL dispatch: a runner that outlives the lease, and a lease short
# enough to expire during it. Without the driver's background renewer the lease
# lapses mid-run and the task becomes reclaimable while the agent is still
# working — which is the bug. AI_DEV_OFFICE_CONFIG_DIR points ownership at the
# short-lease config without relocating the scripts.
T19="$RUNS_DIR/TASK-OWNR$$"
mkdir -p "$T19"; trap 'rm -rf "$WORK" "$E2E_DIR" "$P_DIR" "$D17" "$T18" "$T19"' EXIT
sed "s/$(basename "$T18")/$(basename "$T19")/" "$T18/status.yaml" > "$T19/status.yaml"
printf '#!/usr/bin/env bash\nsleep 9\n' > "$BIN_DIR/codex"
( PATH="$BIN_DIR:$PATH" AI_DEV_OFFICE_CONFIG_DIR="$RENEW_OFFICE" "$ROOT/run-agent.sh" "$(basename "$T19")" dev \
    >"$WORK/e2e-3.log" 2>&1 ) &
R19_PID=$!
for _ in $(seq 1 100); do
  [[ -f "$T19/ownership.yaml" ]] && [[ "$(field "$T19/ownership.yaml" holder.run_id)" != "nil" ]] && break
  sleep 0.2
done
[[ "$(field "$T19/ownership.yaml" holder.run_id)" != "nil" ]] || fail "O19: the dispatch must take a lease"
acq="$(field "$T19/ownership.yaml" holder.acquired_at)"
sleep 6   # well past lease_seconds=4, while the runner is still going
renew1="$(field "$T19/ownership.yaml" holder.renewed_at)"
[[ "$renew1" > "$acq" ]] \
  || fail "O19: the driver must renew DURING the dispatch (acquired=$acq renewed=$renew1)"
# The decisive assertion: mid-dispatch, another run must NOT be able to reclaim.
rc=0; AI_DEV_OFFICE_RUN_ID=run-thief19 AI_DEV_OFFICE_CONFIG_DIR="$RENEW_OFFICE" \
  ruby "$OWN" acquire "$T19" "$(basename "$T19")" agent=dev-2 >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O19: a live dispatch past its original lease must not be reclaimable, got rc=$rc"
wait "$R19_PID" 2>/dev/null || true
ok "O19: renewal keeps a long-running dispatch un-reclaimable past its original lease"

# ── O20 (F6 config): a renew interval at or above the lease refuses ──────────
SLOW_OFFICE="$WORK/office-slow"; mkoffice "$SLOW_OFFICE" <<'Y'
ownership:
  enabled: true
  lease_seconds: 60
  renew_interval_seconds: 60
Y
T20="$(mktask TASK-OWN-020)"
rc=0; out="$(AI_DEV_OFFICE_RUN_ID=run-20 ruby "$OWN" acquire "$T20" TASK-OWN-020 agent=dev "office_dir=$SLOW_OFFICE" 2>&1)" || rc=$?
[[ "$rc" -eq 9 ]] || fail "O20: renew_interval >= lease must refuse, got $rc"
grep -q "renew_interval_seconds" <<<"$out" || fail "O20: the refusal must name the offending key"
ok "O20: a renew interval that cannot keep a lease alive refuses instead of shipping a dead renewer"

# ── O21 (F2): a register that moved BACKWARDS refuses ────────────────────────
# The mirror of the stale-owner case: a caller presenting a higher epoch than
# the register means the register was rolled back or replaced under it. There is
# no safe interpretation, so it refuses rather than picking one.
T21="$(mktask TASK-OWN-021)"
mkoutput "$T21/dev-output.yaml"
AI_DEV_OFFICE_RUN_ID=run-21 ruby "$OWN" acquire "$T21" TASK-OWN-021 agent=dev >/dev/null
sha_before="$(shasum "$T21/status.yaml" | awk '{print $1}')"
rc=0
AI_DEV_OFFICE_RUN_ID=run-21 AI_DEV_OFFICE_OWNERSHIP_EPOCH=5 sync_status_from_output TASK-OWN-021 dev \
  "$T21/status.yaml" "$T21/dev-output.yaml" 2026-01-01 in_review >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 9 ]] || fail "O21: an epoch ahead of the register must refuse (rolled-back register), got $rc"
[[ "$(shasum "$T21/status.yaml" | awk '{print $1}')" == "$sha_before" ]] || fail "O21: status must be untouched"
ok "O21: a register that moved backwards refuses instead of guessing"

# ── O22 (F8): the fence CLI takes the lock it needs ──────────────────────────
# `fence` self-renews, so it is a read-modify-write. The in-process callers
# already hold the task lock; the CLI has to take it itself, or it is the one
# check-then-write outside the critical section the design rests on.
T22="$(mktask TASK-OWN-022)"
AI_DEV_OFFICE_RUN_ID=run-22 ruby "$OWN" acquire "$T22" TASK-OWN-022 agent=dev >/dev/null
ruby -e '
  lock = File.open(File.join(ARGV[0], ".lock"), File::RDWR | File::CREAT, 0o644)
  lock.flock(File::LOCK_EX)
  File.write(ARGV[1], "held")
  sleep 4
' "$T22" "$WORK/gate-22" &
GATE22=$!
while [[ ! -f "$WORK/gate-22" ]]; do sleep 0.05; done
( AI_DEV_OFFICE_RUN_ID=run-22 AI_DEV_OFFICE_OWNERSHIP_EPOCH=1 ruby "$OWN" fence "$T22" >/dev/null 2>&1; echo done > "$WORK/fence-22" ) &
FPID=$!
sleep 1.5
[[ ! -f "$WORK/fence-22" ]] || fail "O22: the fence CLI returned while the task lock was held — it is writing outside the critical section"
kill "$GATE22" 2>/dev/null || true; wait "$GATE22" 2>/dev/null || true
wait "$FPID" 2>/dev/null || true
[[ -f "$WORK/fence-22" ]] || fail "O22: the fence CLI must complete once the lock is released"
ok "O22: the fence CLI blocks on the task lock like every other read-modify-write"

echo "PASS: task ownership — leases acquire/renew/expire/release, fail safe, and fence out stale owners"
