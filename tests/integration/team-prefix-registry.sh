#!/usr/bin/env bash
# Team prefix registry: once office.team.yaml has entries, intake must
# require a registered prefix; while empty, solo/legacy behavior applies.
# Exercises the REAL run-agent.sh intake path in a sandboxed office copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORK="$(mktemp -d)"
# EXIT trap: clean up, keep a failing status, and never let an abort pass as
# success. bash 3.2 can enter this trap with $?=0 after a set -u abort, so
# completion is proven by SUITE_DONE (set just before the final PASS line).
SUITE_DONE=  # an inherited value must never vouch for this run
finish() {
  local rc=$?
  rm -rf "$WORK"
  [[ "$rc" -ne 0 || -n "${SUITE_DONE:-}" ]] || { echo "[FAIL] $(basename "$0") aborted before its final PASS line"; rc=1; }
  exit "$rc"
}
trap finish EXIT

fail() { echo "FAIL: $*"; exit 1; }

OFFICE="$WORK/office"
mkdir -p "$OFFICE/scripts" "$OFFICE/runs" "$OFFICE/tasks" "$OFFICE/agents"
cp "$ROOT/run-agent.sh" "$OFFICE/"
cp "$ROOT/scripts/resolve-office-config.rb" "$OFFICE/scripts/"
cp "$ROOT/scripts/office-git-sync.sh" "$OFFICE/scripts/"
printf 'office:\n  name: Sandbox\n' > "$OFFICE/office.config.yaml"

intake() { (cd "$OFFICE" && ./run-agent.sh intake "test request" 2>&1); }

echo "== Scenario 1: empty registry keeps solo/legacy behavior =="
printf 'prefixes: {}\n' > "$OFFICE/office.team.yaml"
out="$(intake)" || fail "unprefixed intake must pass while registry is empty: $out"
grep -q "Task ID: TASK-001" <<<"$out" || fail "expected TASK-001, got: $out"
out="$(OFFICE_TASK_PREFIX=zz intake)" || fail "prefixed intake must pass while registry is empty: $out"
grep -q "Task ID: TASK-ZZ-001" <<<"$out" || fail "expected TASK-ZZ-001, got: $out"
echo "[OK] solo mode unchanged"

echo "== Scenario 2: active registry rejects unprefixed intake =="
printf 'prefixes:\n  EA: Earth\n' > "$OFFICE/office.team.yaml"
if out="$(intake)"; then
  fail "unprefixed intake must fail once the registry has entries: $out"
fi
grep -q "registry is active" <<<"$out" || fail "missing guidance message: $out"
echo "[OK] unprefixed intake blocked"

echo "== Scenario 3: active registry rejects an unregistered prefix =="
if out="$(OFFICE_TASK_PREFIX=ZZ intake)"; then
  fail "unregistered prefix must fail: $out"
fi
grep -q "not registered in office.team.yaml" <<<"$out" || fail "missing claim guidance: $out"
grep -q "ZZ: <Your Name>" <<<"$out" || fail "message should show the exact line to add: $out"
echo "[OK] unregistered prefix blocked with claim instructions"

echo "== Scenario 4: registered prefix allocates in its namespace and shows owner =="
mkdir -p "$OFFICE/runs/TASK-EA-007"
out="$(OFFICE_TASK_PREFIX=EA intake)" || fail "registered prefix must pass: $out"
grep -q "Task ID: TASK-EA-008" <<<"$out" || fail "expected TASK-EA-008, got: $out"
grep -q "Prefix owner: Earth" <<<"$out" || fail "expected owner line, got: $out"
echo "[OK] registered prefix allocates with owner shown"

echo "== Scenario 5: case-insensitive registry keys and config prefix =="
printf 'prefixes:\n  ea: Earth\n' > "$OFFICE/office.team.yaml"
printf 'office:\n  task_prefix: Ea\n' > "$OFFICE/office.config.local.yaml"
out="$(intake)" || fail "case-mixed prefix/registry must pass: $out"
grep -q "Task ID: TASK-EA-008" <<<"$out" || fail "expected TASK-EA-008 via config, got: $out"
rm "$OFFICE/office.config.local.yaml"
echo "[OK] case normalization consistent"

echo "== Scenario 6: malformed registry fails CLOSED (never silently solo) =="
# Conflict markers — the feature's own collision event sitting unresolved.
printf 'prefixes:\n<<<<<<< HEAD\n  EA: Earth\n=======\n  EA: Bob\n>>>>>>> theirs\n' > "$OFFICE/office.team.yaml"
if out="$(OFFICE_TASK_PREFIX=EA intake)"; then
  fail "conflict-markered registry must halt intake, got: $out"
fi
grep -q "cannot be parsed" <<<"$out" || fail "expected parse error guidance, got: $out"
# Wrong shape: prefixes as an array.
printf 'prefixes:\n  - EA: Earth\n' > "$OFFICE/office.team.yaml"
if out="$(OFFICE_TASK_PREFIX=EA intake)"; then
  fail "array-shaped prefixes must halt intake, got: $out"
fi
grep -q "must be a map" <<<"$out" || fail "expected shape error, got: $out"
# Tab-indented entry (an easy hand-edit slip).
printf 'prefixes:\n\tEA: Earth\n' > "$OFFICE/office.team.yaml"
if out="$(OFFICE_TASK_PREFIX=EA intake)"; then
  fail "tab-indented registry must halt intake, got: $out"
fi
echo "[OK] malformed registry fails closed"

echo "== Scenario 7: genuinely-empty registries stay solo (no false positives) =="
# comments-only -> nil document; prefixes: with no value -> nil; absent file.
printf '# just a comment\n' > "$OFFICE/office.team.yaml"
out="$(intake)" || fail "comments-only registry must stay solo: $out"
grep -q "Task ID: TASK-001" <<<"$out" || fail "comments-only should be solo TASK-001, got: $out"
printf 'prefixes:\n' > "$OFFICE/office.team.yaml"
out="$(intake)" || fail "empty 'prefixes:' must stay solo: $out"
grep -q "Task ID: TASK-001" <<<"$out" || fail "empty prefixes should be solo TASK-001, got: $out"
rm "$OFFICE/office.team.yaml"
out="$(intake)" || fail "absent registry must stay solo: $out"
grep -q "Task ID: TASK-001" <<<"$out" || fail "absent registry should be solo TASK-001, got: $out"
echo "[OK] empty registries stay solo"

echo "== Scenario 8: broken office.config.local.yaml surfaces the YAML error, not 'set your prefix' =="
printf 'prefixes:\n  EA: Earth\n' > "$OFFICE/office.team.yaml"
printf 'office:\n\ttask_prefix: EA\n' > "$OFFICE/office.config.local.yaml"   # tab -> invalid YAML
if out="$(intake)"; then
  fail "broken local config must halt intake, got: $out"
fi
grep -qi "invalid YAML\|could not read office config" <<<"$out" \
  || fail "expected a config YAML error, got the registry guidance instead: $out"
rm "$OFFICE/office.config.local.yaml"
echo "[OK] config error surfaced, not masked as missing prefix"

echo "== Scenario 9: new PM tasks must use the active registered namespace =="
printf 'prefixes:\n  EA: Earth\n  BOB: Bob\n' > "$OFFICE/office.team.yaml"
rm -f "$OFFICE/office.config.local.yaml"
if out="$(cd "$OFFICE" && ./run-agent.sh TASK-EA-001 pm cursor 2>&1)"; then
  fail "new PM task without Dashboard identity must be rejected: $out"
fi
grep -q "set your Dashboard name" <<<"$out" \
  || fail "missing Dashboard identity guidance: $out"
[[ ! -d "$OFFICE/runs/TASK-EA-001" ]] || fail "unset identity must not create a task"

printf 'office:\n  task_prefix: EA\n' > "$OFFICE/office.config.local.yaml"

if out="$(cd "$OFFICE" && ./run-agent.sh TASK-001 pm cursor 2>&1)"; then
  fail "new unprefixed PM task must be rejected: $out"
fi
grep -q "must use active namespace TASK-EA-NNN" <<<"$out" \
  || fail "missing active namespace guidance: $out"
[[ ! -d "$OFFICE/runs/TASK-001" ]] || fail "rejected task directory must not be created"

if out="$(cd "$OFFICE" && ./run-agent.sh TASK-BOB-001 pm cursor 2>&1)"; then
  fail "another user's namespace must be rejected: $out"
fi
[[ ! -d "$OFFICE/runs/TASK-BOB-001" ]] || fail "other-user task directory must not be created"

out="$(cd "$OFFICE" && ./run-agent.sh TASK-EA-001 pm cursor 2>&1 || true)"
grep -q "Creating task directory" <<<"$out" || fail "active namespace should reach PM creation: $out"
[[ -d "$OFFICE/runs/TASK-EA-001" ]] || fail "valid namespaced task directory should be created"

echo "== Scenario 10: existing legacy and special task directories stay runnable =="
mkdir -p "$OFFICE/runs/TASK-009" "$OFFICE/runs/TASK-PKG-001"
out="$(cd "$OFFICE" && ./run-agent.sh TASK-009 pm cursor 2>&1 || true)"
! grep -q "must use active namespace" <<<"$out" || fail "existing legacy task was blocked: $out"
out="$(cd "$OFFICE" && ./run-agent.sh TASK-PKG-001 pm cursor 2>&1 || true)"
! grep -q "must use active namespace" <<<"$out" || fail "existing package task was blocked: $out"
echo "[OK] PM creation gate preserves existing tasks"

echo "== Scenario 11: GW is reserved for the event gateway's minted ids =="
# The registry claims GW so the gateway passes the PM creation gate; intake
# must still refuse it, or an operator (or a gateway-dispatched pm that
# inherits the prefix) allocates TASK-GW-NNN ids beside the gateway's TASK-GW-N.
printf 'prefixes:\n  EA: Earth\n  GW: "Event gateway (reserved)"\n' > "$OFFICE/office.team.yaml"
if out="$(OFFICE_TASK_PREFIX=GW intake)"; then
  fail "intake with the gateway's prefix must be refused: $out"
fi
grep -q "reserved for the event gateway" <<<"$out" || fail "missing GW reservation guidance: $out"
printf 'prefixes: {}\n' > "$OFFICE/office.team.yaml"
if out="$(OFFICE_TASK_PREFIX=gw intake)"; then
  fail "GW must stay reserved in solo mode too: $out"
fi
grep -q "reserved for the event gateway" <<<"$out" || fail "missing GW reservation guidance (solo): $out"
echo "[OK] GW reserved for the event gateway"

echo "== Scenario 12: intake --prefix picks another namespace this machine mints in =="
# office.extra_task_prefixes (per machine) lists the other registered prefixes
# this machine owns, e.g. a solo operator's project codes. Registration alone
# grants nothing, so a team member still cannot allocate in someone else's.
printf 'prefixes:\n  EAR: Earth\n  BOB: Bob\n  KAS: "Casper (project)"\n  VS: "VerifySlip (project)"\n  GW: "Event gateway (reserved)"\n' > "$OFFICE/office.team.yaml"
printf 'office:\n  task_prefix: EAR\n  extra_task_prefixes: [KAS, VS]\n' > "$OFFICE/office.config.local.yaml"
mkdir -p "$OFFICE/runs/TASK-EAR-341" "$OFFICE/runs/TASK-VS-062"
intake_with() { (cd "$OFFICE" && env -u OFFICE_TASK_PREFIX ./run-agent.sh intake "$@" 2>&1); }
out="$(intake_with "test request")" || fail "default intake must pass: $out"
grep -q "Task ID: TASK-EAR-342" <<<"$out" || fail "without --prefix intake must keep office.task_prefix: $out"
out="$(intake_with --prefix VS "test request")" || fail "--prefix VS must pass: $out"
grep -q "Task ID: TASK-VS-063" <<<"$out" || fail "expected TASK-VS-063, got: $out"
grep -q "Prefix owner: VerifySlip (project)" <<<"$out" || fail "expected the VS owner line, got: $out"
grep -qF "./run-agent.sh open TASK-VS-063 " <<<"$out" || fail "the open hint must carry the VS id: $out"
out="$(intake_with "test request" --prefix kas)" || fail "--prefix after the request, lower case, must pass: $out"
grep -q "Task ID: TASK-KAS-001" <<<"$out" || fail "expected TASK-KAS-001, got: $out"
if out="$(intake_with --prefix BOB "test request")"; then
  fail "a registered prefix this machine does not list must be refused: $out"
fi
grep -qF "[ERROR] prefix BOB is registered to Bob, but this machine does not mint in it; if this machine owns BOB, add it to office.extra_task_prefixes in office.config.local.yaml" <<<"$out" \
  || fail "missing extra_task_prefixes guidance: $out"
if out="$(intake_with --prefix ZZ "test request")"; then
  fail "an unregistered --prefix must be refused: $out"
fi
grep -q "ZZ: <Your Name>" <<<"$out" || fail "missing claim guidance for --prefix ZZ: $out"
if out="$(intake_with --prefix GW "test request")"; then
  fail "--prefix GW must be refused: $out"
fi
grep -q "reserved for the event gateway" <<<"$out" || fail "missing GW reservation for --prefix: $out"
if out="$(intake_with --prefix PKG "test request")"; then
  fail "--prefix PKG must be refused: $out"
fi
grep -q "reserved for package tasks" <<<"$out" || fail "missing PKG reservation for --prefix: $out"
if out="$(intake_with "test request" --prefix)"; then
  fail "--prefix without a value must be a usage error: $out"
fi
grep -q "Usage:" <<<"$out" || fail "missing usage for --prefix without a value: $out"
if out="$(cd "$OFFICE" && OFFICE_TASK_PREFIX=EAR ./run-agent.sh intake --prefix VS "test request" 2>&1)"; then
  fail "OFFICE_TASK_PREFIX names exactly one namespace; --prefix VS must be refused under it: $out"
fi
grep -qF "[ERROR] --prefix VS is not OFFICE_TASK_PREFIX=EAR" <<<"$out" || fail "missing env/--prefix guidance: $out"
printf 'prefixes: {}\n' > "$OFFICE/office.team.yaml"
out="$(intake_with --prefix zz "test request")" || fail "solo mode must take any valid --prefix: $out"
grep -q "Task ID: TASK-ZZ-001" <<<"$out" || fail "expected solo TASK-ZZ-001, got: $out"
rm "$OFFICE/office.config.local.yaml"
echo "[OK] intake --prefix allocates only in this machine's registered namespaces"

SUITE_DONE=1
echo "[PASS] team prefix registry scenarios passed"
