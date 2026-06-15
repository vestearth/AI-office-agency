#!/usr/bin/env bash
# Team prefix registry: once office.team.yaml has entries, intake must
# require a registered prefix; while empty, solo/legacy behavior applies.
# Exercises the REAL run-agent.sh intake path in a sandboxed office copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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

echo "[PASS] team prefix registry scenarios passed"
