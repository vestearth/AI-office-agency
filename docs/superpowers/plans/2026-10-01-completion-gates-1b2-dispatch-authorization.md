# Phase 1B.2 Dispatch-time Authorization Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `run-agent.sh` dispatches a configured role (default `devops`) for a task with a completion gate that is `pending` and carries `requires_authorization`, check that the task's authorization ledger holds a grant of exactly that action valid now; `warn_only` (shipped) records and warns, `required` refuses.

**Architecture:** A standalone checker (`scripts/authorization-dispatch-check.rb decide`) reads `status.yaml`, the typed merged config and the ledger, and prints one `outcome=… mode=… actions=…` line with exit 0/14. `run-agent.sh` calls it immediately before `record_run_start`, records one `authorization_dispatch_check` meta event per applicable attempt (guarded write, no `run_id`), and, whenever the checker's answer is untrustworthy, records `check_error` and recovers mode and scope itself with an inline Ruby heredoc that reads the resolver's typed `dump` and shares no code with the checker. An agreement test pins the two implementations together.

**Tech Stack:** Bash (`run-agent.sh`, `set -euo pipefail`), Ruby 2.6.10 stdlib (YAML/Psych, no gems, no endless defs), bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-01-completion-gates-1b2-dispatch-authorization-design.md`](../specs/2026-10-01-completion-gates-1b2-dispatch-authorization-design.md) (merged as PR #33, `c2159fab`). Read it before any task; this plan argues from it.

## Global Constraints

- Ruby is 2.6.10: no endless method definitions, no `Hash#except`, no pattern matching. macOS has no `timeout` command.
- Never put backticks inside double-quoted bash strings in tests (they execute).
- The check never writes `status.yaml`, a gate, or `authorization.yaml`; the checker never writes anything.
- The driver must not read `authorization_dispatch` through `config_value` / `config_list_values` / `config_bool` / `config_list_contains` (they call the resolver's lossy `get`/`list`); the recovery reads `ruby "$CONFIG_RESOLVER" dump "$OFFICE_DIR"` and the checker reads `OfficeConfigResolver#merged_config`.
- Only a **wholly absent** `authorization_dispatch` block means the defaults (`warn_only`, `[devops]`); a key missing inside a present block is untrustworthy.
- Concrete roles are exactly the keys of `agents/manifest.yaml`: `pm dev dev-2 reviewer debugger devops free-roam`.
- Checker exit codes: `0` proceed, `14` refuse, `2` usage error; anything else (this plan uses `3` for "task state cannot be judged") is a `check_error` for the driver.
- Events: type `authorization_dispatch_check`, `agent` = the final dispatched role, `details` = `task=<label> mode=<m> outcome=<o> actions=<a,b|none>`, **no `run_id`**.
- Every new test is seen failing before its implementation (the per-task "Run to verify it fails" steps). Never weaken an existing test.
- Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- Work only in the worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-1b2-impl` (branch `feat/issue-28-1b2-dispatch-authorization`). Use absolute paths. Never touch the main checkout (another session owns it).

## Decisions taken while proving this plan (raise in the PR, not design changes)

1. **YAML 1.1 booleans.** Psych reads an unquoted `mode: off` (also `no`, `false`) as the boolean `false`, not the string `"off"`. By the spec's typed rule ("`mode` is trustworthy only if it is a string") that is untrustworthy and fails closed (`config_error`, effective `required`). The plan keeps the spec's rule, writes `"off"` quoted everywhere, documents it, and pins the unquoted form as fail-closed in tests. It does not coerce `false` to `off` (that would turn `mode: no` into a silent kill switch).
2. **Checker exit 3.** The spec lists exits 0/14/2. A `status.yaml` that cannot be read or whose `completion_gates` is malformed cannot be judged by the checker; it exits `3`, which the driver contract already treats as `check_error` (any exit other than a consistent 0/14). Gate state predicate, used identically by both implementations: no `status.yaml` → no pending bound gate; `status.yaml` not a mapping, `completion_gates` present but not a mapping (including `null`), or any gate value not a mapping → malformed (in scope, fail closed).
3. **Event-write failure test.** A corrupt `meta.yaml` cannot reach the new block: the driver's earlier, unguarded `context_provider` event write fails first (pre-existing). The guarded-write tests therefore inject the sink failure into the office copy's driver (replacing the one guarded `log_meta_event` call with `false`), which is the only way to exercise that branch.
4. **Driver tests run against a copy of the office.** The checker and the resolver read their own office dir (`__dir__/..`, which resolves symlinks), so each driver case runs a copied office (`run-agent.sh`, `validate-yaml.rb`, configs, `agents/ scripts/ schemas/ workflows/ templates/ profiles/ runners/`) with `AI_OFFICE_RUNS_DIR` pointing at a temp runs dir, the dependency guard and context provider disabled by env, and a stub `codex`. Dispatch output goes to a file, not `$(...)`: the driver's ownership renewer leaves a `sleep` holding stdout, which would hang a command substitution.
5. **`auto` placement test** uses `roles: [pm]`: the umbrella always launches a concrete `pm` sub-dispatch first, and `pm` output can only route to `dev`/`dev-2`/`free-roam`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/authorization-ledger.rb` | + `Index#any_valid_grant?(action:, at:, through:)` built on `valid_grant?` | 1 |
| `scripts/authorization-dispatch-check.rb` | New. `decide`, normalization, gate-state predicate, outcome/exit contract; require-safe library | 2 |
| `office.config.yaml` | + `authorization_dispatch:` block (`warn_only`, `[devops]`) | 3 |
| `scripts/resolve-office-config.rb` | + `%w[authorization_dispatch]` in `PROTECTED_PATHS` | 3 |
| `run-agent.sh` | + `authorization_dispatch_check` immediately before `record_run_start` (Task 4); + `authorization_dispatch_recover` and the `check_error` recovery branch (Task 5) | 4, 5 |
| `tests/integration/authorization-dispatch.sh` | New suite, grown section by section (L, C, P, D-core, D-recovery + R) | 1–5 |
| `docs/authorization-ledger.md`, `docs/policy-preflight.md`, `docs/task-transition-contract.md` | The check, modes, evidence, limits | 6 |

The suite is one file built in sections. **Every task inserts its section immediately before the final line** `echo "[PASS] authorization-dispatch: dispatch-time authorization check (#28 Phase 1B.2)"`, so the order in the file is header, L, C, P, D-core, D-recovery/R, PASS line. Run it with `bash tests/integration/authorization-dispatch.sh` from the worktree root. The full suite takes about 6 minutes (each driver case is a real dispatch); run it in the background and read the log rather than blocking on it.

---

### Task 1: Ledger `Index#any_valid_grant?` and the suite skeleton

**Files:**
- Create: `tests/integration/authorization-dispatch.sh`
- Modify: `scripts/authorization-ledger.rb` (inside `class Index`, after `valid_grant?`)

**Interfaces:**
- Produces: `AuthorizationLedger::Index#any_valid_grant?(action:, at:, through:) -> true|false`. `at` is a `Time` or a `YYYY-MM-DDTHH:MM:SSZ` string; `through` is an `authz-NNN` id. True iff at least one grant of exactly `action` is valid as of `(at, through)` by `valid_grant?`.
- Produces (test helpers used by every later section): `fail`, `ok`, `assert_eq`, `mk_task <id> [extra-yaml] [current_agent]`, `write_ledger <dir> <entries>`, `grant_yaml <id> <action> [expires_at]`, `revoke_yaml <id> <revokes>`, `set_block <raw yaml|"">`, `check`/`expect_check`, `events`, `event_count`, `meta_count`, `dispatch <task> <role> [VAR=val…]` (sets `D_RC`, `D_OUT`, `D_CALLS`), variables `ROOT_DIR WORK OFFICE RUNS CHECKER PENDING_DEPLOY`.

- [ ] **Step 1: Create the suite skeleton with the header and the L section**

Create `tests/integration/authorization-dispatch.sh` with exactly this content (header, then the L section, then the PASS line):

```bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 1B.2 — dispatch-time authorization check.
#
# run-agent.sh checks, at the final stable role/policy admission point, that a
# dispatch of a configured role (default devops) for a task with a completion
# gate that is `pending` and carries `requires_authorization` has a grant of
# exactly that action valid NOW. warn_only records and warns; required refuses.
# When the checker cannot give a trustworthy answer the driver records
# `check_error` and recovers mode and scope WITHOUT the checker.
#
# Every driver case runs against a COPY of the office (the checker and the
# config resolver read their own office dir), with a temp runs dir and a stub
# codex runner that only counts its invocations.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"' EXIT

unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW OFFICE_PROFILE \
  AI_DEV_OFFICE_INPUT_SOURCE AI_DEV_OFFICE_GIT_SYNCED AI_DEV_OFFICE_CONFIG_DIR
export OFFICE_DEPENDENCY_GUARD_ENABLED=false OFFICE_CONTEXT_PROVIDER_ENABLED=false

OFFICE="$WORK/office"
RUNS="$WORK/runs"
BIN="$WORK/bin"
CALL="$WORK/call"
mkdir -p "$OFFICE" "$RUNS" "$BIN" "$CALL"
export AI_OFFICE_RUNS_DIR="$RUNS"
# A fixed clock for every grant/expiry case (honored: RUNS is not the live runs/).
export AI_OFFICE_NOW="2026-10-01T12:00:00Z"

for f in run-agent.sh validate-yaml.rb office.config.yaml office.team.yaml; do cp "$ROOT_DIR/$f" "$OFFICE/"; done
for d in agents scripts schemas workflows templates profiles runners; do cp -R "$ROOT_DIR/$d" "$OFFICE/"; done
CHECKER="$OFFICE/scripts/authorization-dispatch-check.rb"
cp "$CHECKER" "$WORK/checker.orig.rb" 2>/dev/null || true
cp "$OFFICE/run-agent.sh" "$WORK/driver.orig.sh"
cp "$OFFICE/scripts/resolve-office-config.rb" "$WORK/resolver.orig.rb"

# The shipped config with any authorization_dispatch block removed; each case
# appends its own raw block text (so malformed YAML forms can be written).
ruby -e '
  lines = File.readlines(ARGV[0]); out = []; skip = false
  lines.each do |line|
    if line.start_with?("authorization_dispatch:") then skip = true; next end
    skip = false if skip && !line.start_with?(" ", "\t", "#") && !line.strip.empty?
    out << line unless skip
  end
  File.write(ARGV[1], out.join)' "$OFFICE/office.config.yaml" "$WORK/base-config.yaml"

set_block() {  # <raw block text, empty = the whole block absent>
  { cat "$WORK/base-config.yaml"; printf '\n%s\n' "$1"; } > "$OFFICE/office.config.yaml"
}

printf '#!/usr/bin/env bash\nc="%s/count"; n=0; [[ -f "$c" ]] && n="$(cat "$c")"; echo $((n + 1)) > "$c"\nexit 0\n' "$CALL" > "$BIN/codex"
chmod +x "$BIN/codex"

fail() { echo "[FAIL] $1"; exit 1; }
ok() { echo "  ok: $1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$1' got '$2'"; }

PENDING_DEPLOY='completion_gates:
  prod_deploy:
    status: pending
    requires_authorization: deploy_production'

# mk_task <task_id> [<extra top-level yaml>] [<current_agent>] — echoes the dir
mk_task() {
  local dir="$RUNS/$1" agent="${3:-devops}"
  rm -rf "$dir"; mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: assigned
state: assigned
iteration: 0
current_agent: $agent
assignment:
  primary: $agent
  parallel: false
ready: true
created_at: "2026-10-01"
updated_at: "2026-10-01"
history: []
${2:-}
YAML
  echo "$dir"
}

# write_ledger <task_dir> <entries yaml, indented two spaces>
write_ledger() {
  printf 'task_id: %s\nauthorizations:\n%s\n' "$(basename "$1")" "$2" > "$1/authorization.yaml"
}

# grant_yaml <id> <action> [<expires_at>]
grant_yaml() {
  printf '  - id: %s\n    type: grant\n    action: %s\n    scope: "prod"\n    actor: alice\n    via: chat\n    reason: "approved"\n    at: "2026-09-01T00:00:00Z"\n' "$1" "$2"
  [[ -z "${3:-}" ]] || printf '    expires_at: "%s"\n' "$3"
}

revoke_yaml() {  # <id> <revokes>
  printf '  - id: %s\n    type: revoke\n    revokes: %s\n    actor: alice\n    via: chat\n    reason: "withdrawn"\n    at: "2026-09-02T00:00:00Z"\n' "$1" "$2"
}

# check <task_id> <role> — runs the checker; sets CK_OUT, CK_RC; stderr in $WORK/ck.err
check() {
  CK_RC=0
  CK_OUT="$(ruby "$CHECKER" decide "$1" --role "$2" 2>"$WORK/ck.err")" || CK_RC=$?
}

expect_check() {  # <task_id> <role> <expected line> <expected rc> <label>
  check "$1" "$2"
  assert_eq "$3" "$CK_OUT" "$5 (line)"
  assert_eq "$4" "$CK_RC" "$5 (exit code)"
}

# events <task_dir> — one line per authorization_dispatch_check event:
# "<agent>|<details>|<run_id or ->"
events() {
  ruby - "$1/meta.yaml" <<'RUBY'
require "yaml"; require "date"
path = ARGV[0]
exit 0 unless File.exist?(path)
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
Array(d["events"]).each do |e|
  next unless e.is_a?(Hash) && e["type"] == "authorization_dispatch_check"
  puts [e["agent"], e["details"], e.key?("run_id") ? e["run_id"] : "-"].join("|")
end
RUBY
}

event_count() { events "$1" | grep -c . || true; }

meta_count() {  # <task_dir> <type>
  ruby - "$1/meta.yaml" "$2" <<'RUBY'
require "yaml"; require "date"
path, type = ARGV
unless File.exist?(path)
  puts 0
  exit 0
end
d = YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true) || {}
puts Array(d["events"]).count { |e| e.is_a?(Hash) && e["type"] == type }
RUBY
}

# dispatch <task_id> <role> [VAR=value ...] — runs the office copy's driver;
# sets D_RC, D_OUT, D_CALLS (runner invocations).
dispatch() {
  local task="$1" role="$2"
  shift 2
  rm -f "$CALL/count"
  D_RC=0
  # To a file, not $(...): the driver's ownership renewer leaves a `sleep` that
  # inherits stdout, and a command substitution would wait for it to exit.
  env "$@" PATH="$BIN:$PATH" bash "$OFFICE/run-agent.sh" "$task" "$role" codex >"$WORK/dispatch.log" 2>&1 || D_RC=$?
  D_OUT="$(cat "$WORK/dispatch.log")"
  D_CALLS=0
  [[ -f "$CALL/count" ]] && D_CALLS="$(cat "$CALL/count")"
  return 0
}
echo "== L: ledger Index#any_valid_grant? =="
D="$(mk_task TASK-AD-000 "$PENDING_DEPLOY")"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production 2026-10-01T00:00:00Z; grant_yaml authz-002 deploy_production; revoke_yaml authz-003 authz-002; grant_yaml authz-1000 live_load)"
ruby - "$ROOT_DIR/scripts/authorization-ledger.rb" "$D" <<'RUBY' || fail "L: Index#any_valid_grant?"
require ARGV[0]
index = AuthorizationLedger.load(ARGV[1])
now = Time.utc(2026, 10, 1, 12)
expect = lambda do |label, got, want|
  abort "#{label}: expected #{want}, got #{got.inspect}" unless got == want
end
expect.call("expired + revoked -> none", index.any_valid_grant?(action: "deploy_production", at: now, through: "authz-1000"), false)
expect.call("a grant is valid below its revoke's id", index.any_valid_grant?(action: "deploy_production", at: now, through: "authz-002"), true)
expect.call("numeric snapshot past 999", index.any_valid_grant?(action: "live_load", at: now, through: "authz-1000"), true)
expect.call("a grant above the snapshot", index.any_valid_grant?(action: "live_load", at: now, through: "authz-003"), false)
expect.call("exact action only", index.any_valid_grant?(action: "deploy_staging", at: now, through: "authz-1000"), false)
expect.call("before expiry", index.any_valid_grant?(action: "deploy_production", at: Time.utc(2026, 9, 30), through: "authz-001"), true)
expect.call("timestamp string accepted", index.any_valid_grant?(action: "live_load", at: "2026-10-01T12:00:00Z", through: "authz-1000"), true)
empty = AuthorizationLedger::Index.new([])
expect.call("empty ledger", empty.any_valid_grant?(action: "live_load", at: now, through: "authz-001"), false)
RUBY
ok "L: any_valid_grant? reuses valid_grant? (numeric ids, append-order revoke, expiry, exact action)"
echo "[PASS] authorization-dispatch: dispatch-time authorization check (#28 Phase 1B.2)"
```

Then `chmod +x tests/integration/authorization-dispatch.sh`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/authorization-dispatch.sh`
Expected: FAIL — `[FAIL] L: Index#any_valid_grant?` (the method does not exist; Ruby reports `undefined method 'any_valid_grant?'`).

- [ ] **Step 3: Implement `any_valid_grant?`**

In `scripts/authorization-ledger.rb`, inside `class Index`, immediately after the `valid_grant?` method's closing `end` (before the class's own `end`), add:

```ruby
    # Is there at least one grant of exactly `action` that is valid as of
    # (at, through)? Phase 1B.2 (dispatch-time check) asks this for "now" and
    # the current high-water id; the validity rule is valid_grant?'s, unchanged.
    def any_valid_grant?(action:, at:, through:)
      @by_number.any? do |number, entry|
        entry.is_a?(Hash) && entry["type"] == "grant" &&
          valid_grant?(AuthorizationLedger.format_id(number), action: action, at: at, through: through)
      end
    end
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bash tests/integration/authorization-dispatch.sh`
Expected: `ok: L: …` then `[PASS] authorization-dispatch: …`. Also run `bash tests/integration/authorization-ledger.sh` — expected `[PASS]` (no behavior change for 1B.1).

- [ ] **Step 5: Commit**

```bash
git add scripts/authorization-ledger.rb tests/integration/authorization-dispatch.sh
git commit -m "feat(authz): Index#any_valid_grant? for the dispatch-time check (#28 1B.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The checker `scripts/authorization-dispatch-check.rb`

**Files:**
- Create: `scripts/authorization-dispatch-check.rb`
- Modify: `tests/integration/authorization-dispatch.sh` (insert section C before the PASS line)

**Interfaces:**
- Consumes: `AuthorizationLedger.load(task_dir)`, `AuthorizationLedger.now_utc`, `Index#high_water_id`, `Index#any_valid_grant?` (Task 1); `OfficeConfigResolver.new(office_dir, profile:).merged_config`.
- Produces (module `AuthorizationDispatchCheck`, require-safe; the CLI runs only when the file is the program):
  - constants `MODES`, `DEFAULT_MODE`, `DEFAULT_ROLES`, `CONCRETE_ROLES`, `EXIT_PROCEED = 0`, `EXIT_USAGE = 2`, `EXIT_UNJUDGEABLE = 3`, `EXIT_REFUSE = 14`; class `Unjudgeable < StandardError`.
  - `gate_state(status) -> :none | :bound | :malformed`
  - `normalize(merged_config) -> Config(state: :ok|:off|:error, mode: String, roles: Array|nil)`
  - `decide(status_or_:absent, merged_config, role, task_dir) -> Result(outcome, mode, actions)`; raises `Unjudgeable` for a malformed gate state.
  - `load_status(path) -> Hash | :absent | other parsed value`; raises `Unjudgeable` when unreadable.
  - `exit_code(result)`, `line(result)`, `main(argv)`.
  - CLI: `ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>` → one line `outcome=<o> mode=<m> actions=<a,b>`; `mode=none` when the outcome was decided before the config was read.

- [ ] **Step 1: Add the C section to the suite**

Insert immediately before the PASS line:

```bash
echo "== C: checker decide =="
set_block ""
NA="outcome=not_applicable mode=none actions="

# C1: no pending bound gate -> not_applicable, and the ledger is never read (a
# corrupt ledger that WOULD warn on stderr if loaded stays silent).
D="$(mk_task TASK-AD-001)"; printf 'garbage: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-001 devops "$NA" 0 "C1 no completion_gates"
[[ ! -s "$WORK/ck.err" ]] || fail "C1: the ledger must not be read without a pending bound gate: $(cat "$WORK/ck.err")"
D="$(mk_task TASK-AD-002 'completion_gates:
  smoke:
    status: pending')"; printf 'garbage: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-002 devops "$NA" 0 "C1 only unbound pending gates"
[[ ! -s "$WORK/ck.err" ]] || fail "C1: unbound gates must not read the ledger"
D="$(mk_task TASK-AD-003 'completion_gates:
  prod_deploy:
    status: na
    requires_authorization: deploy_production
    actor: alice
    reason: "not deploying"
    updated_at: "2026-09-30T10:00:00Z"')"; printf 'garbage: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-003 devops "$NA" 0 "C1 only resolved bound gates"
[[ ! -s "$WORK/ck.err" ]] || fail "C1: resolved bound gates must not read the ledger"
mkdir -p "$RUNS/TASK-AD-004"
expect_check TASK-AD-004 devops "$NA" 0 "C1 no status.yaml"
set_block 'authorization_dispatch:
  mode: of'
expect_check TASK-AD-001 devops "$NA" 0 "C1 a config typo without a pending bound gate (condition 3 first)"
set_block ""
ok "C1: no pending bound gate -> not_applicable, ledger unread, config unread"

# C2: grants, as of now (AI_OFFICE_NOW) and the current high-water id.
D="$(mk_task TASK-AD-010 "$PENDING_DEPLOY")"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 absent ledger"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 valid grant"
write_ledger "$D" "$(grant_yaml authz-001 external_side_effect)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 grant for another action"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production 2026-10-01T12:00:00Z)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 expires_at == now is not valid"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production 2026-10-01T12:00:01Z)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 expires one second after now"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production; revoke_yaml authz-002 authz-001)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 revoked before the check"
write_ledger "$D" "$(grant_yaml authz-999 live_load; grant_yaml authz-1000 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 numeric ids past 999"
printf 'task_id: TASK-AD-010\nauthorizations: [\n' > "$D/authorization.yaml"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 corrupt ledger"
grep -q "ledger unavailable" "$WORK/ck.err" || fail "C2: a corrupt ledger must be reported on stderr"
D="$(mk_task TASK-AD-011 'completion_gates:
  prod_deploy:
    status: pending
    requires_authorization: deploy_production
  backfill:
    status: pending
    requires_authorization: production_backfill')"
write_ledger "$D" "$(grant_yaml authz-001 production_backfill)"
expect_check TASK-AD-011 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 two gates, one satisfied"
write_ledger "$D" "$(grant_yaml authz-001 production_backfill; grant_yaml authz-002 deploy_production)"
expect_check TASK-AD-011 devops "outcome=authorized mode=warn_only actions=deploy_production,production_backfill" 0 "C2 two gates, both satisfied"
mk_task TASK-AD-012 'completion_gates:
  moon:
    status: pending
    requires_authorization: deploy_moon' >/dev/null
expect_check TASK-AD-012 devops "outcome=missing_authorization mode=warn_only actions=deploy_moon" 0 "C2 unknown action"
# The check is as of NOW: a revoke appended after an authorized check is seen by the next check.
D="$RUNS/TASK-AD-010"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=warn_only actions=deploy_production" 0 "C2 before the revoke"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production; revoke_yaml authz-002 authz-001)"
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C2 after the revoke"
ok "C2: exact action, expiry (now >= expires_at), append-order revoke, numeric ids, corrupt ledger, multi-gate"

# C3: roles, modes, exit codes.
D="$RUNS/TASK-AD-010"; rm -f "$D/authorization.yaml"
expect_check TASK-AD-010 dev "outcome=not_applicable mode=warn_only actions=" 0 "C3 role outside the default roles"
set_block 'authorization_dispatch:
  mode: "off"
  roles: [devops]'
expect_check TASK-AD-010 devops "outcome=not_applicable mode=off actions=" 0 "C3 mode off"
for role in pm dev dev-2 reviewer debugger devops free-roam; do
  set_block "authorization_dispatch:
  mode: warn_only
  roles: [$role]"
  expect_check TASK-AD-010 "$role" "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "C3 $role configured"
done
set_block 'authorization_dispatch:
  mode: required
  roles: [devops]'
expect_check TASK-AD-010 devops "outcome=missing_authorization mode=required actions=deploy_production" 14 "C3 required refuses missing"
expect_check TASK-AD-010 dev "outcome=not_applicable mode=required actions=" 0 "C3 required, unconfigured role"
write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
expect_check TASK-AD-010 devops "outcome=authorized mode=required actions=deploy_production" 0 "C3 required, authorized"
rm -f "$D/authorization.yaml"
set_block ""
ok "C3: role list, off, every concrete role configurable, exit 0 vs 14"

# C4: normalization (section 4), on a task WITH a pending bound gate.
norm() {  # <raw block> <expected line> <expected rc> <label>
  set_block "$1"
  expect_check TASK-AD-010 devops "$2" "$3" "C4 $4"
}
CE_REQ="outcome=config_error mode=required actions=deploy_production"
norm "" "outcome=missing_authorization mode=warn_only actions=deploy_production" 0 "whole block absent -> defaults"
norm 'authorization_dispatch: 5' "$CE_REQ" 14 "non-mapping block"
norm 'authorization_dispatch:' "$CE_REQ" 14 "null block"
norm 'authorization_dispatch:
  roles: [devops]' "$CE_REQ" 14 "present block, mode missing"
for bad in '[warn_only]' '""' '' '{a: b}' '5' 'true' 'of' 'warn-only'; do
  norm "authorization_dispatch:
  mode: $bad
  roles: [devops]" "$CE_REQ" 14 "mode: $bad"
done
# YAML 1.1: an unquoted off/no/false is a BOOLEAN, not the string "off". It is
# untrustworthy like any non-string, so it fails closed instead of disabling.
for bad in 'off' 'no' 'false'; do
  norm "authorization_dispatch:
  mode: $bad
  roles: [devops]" "$CE_REQ" 14 "unquoted mode: $bad (a YAML boolean)"
done
norm 'authorization_dispatch:
  mode: "off"
  roles: 5' "outcome=not_applicable mode=off actions=" 0 "off with malformed roles"
norm 'authorization_dispatch:
  mode: "off"' "outcome=not_applicable mode=off actions=" 0 "off with roles missing"
for bad in 'devops' '{devops: true}' '' '[devops, 5]' '[devops, nosuchrole]'; do
  norm "authorization_dispatch:
  mode: warn_only
  roles: $bad" "outcome=config_error mode=warn_only actions=deploy_production" 0 "warn_only roles: $bad"
  norm "authorization_dispatch:
  mode: required
  roles: $bad" "$CE_REQ" 14 "required roles: $bad"
done
norm 'authorization_dispatch:
  mode: warn_only' "outcome=config_error mode=warn_only actions=deploy_production" 0 "warn_only, roles missing"
norm 'authorization_dispatch:
  mode: required' "$CE_REQ" 14 "required, roles missing"
norm 'authorization_dispatch:
  mode: required
  roles: []' "outcome=not_applicable mode=required actions=" 0 "empty roles"
set_block ""
ok "C4: normalization table, including partial blocks (only a wholly absent block means defaults)"

# C5: cannot judge -> neither 0 nor 14 (the driver records check_error).
D="$(mk_task TASK-AD-020)"; printf 'phase: [\n' > "$D/status.yaml"
check TASK-AD-020 devops; assert_eq 3 "$CK_RC" "C5 corrupt status.yaml"
mk_task TASK-AD-021 'completion_gates: [prod_deploy]' >/dev/null
check TASK-AD-021 devops; assert_eq 3 "$CK_RC" "C5 completion_gates not a map"
mk_task TASK-AD-022 'completion_gates:
  prod_deploy: pending' >/dev/null
check TASK-AD-022 devops; assert_eq 3 "$CK_RC" "C5 a gate that is not a map"
# AI_OFFICE_NOW is a test hook: against the live runs dir it is refused.
mkdir -p "$OFFICE/runs/TASK-AD-023"; cp "$RUNS/TASK-AD-010/status.yaml" "$OFFICE/runs/TASK-AD-023/status.yaml"
rc=0; AI_OFFICE_RUNS_DIR="$OFFICE/runs" ruby "$CHECKER" decide TASK-AD-023 --role devops >/dev/null 2>"$WORK/ck.err" || rc=$?
assert_eq 3 "$rc" "C5 AI_OFFICE_NOW against the live runs dir"
grep -q "test hook" "$WORK/ck.err" || fail "C5: the refusal must name the test hook"
rm -rf "$OFFICE/runs/TASK-AD-023"
for args in "" "decide" "verify TASK-AD-010 --role devops" "decide TASK-AD-010" "decide ../x --role devops" "decide TASK-AD-010 --role devops extra"; do
  rc=0
  # shellcheck disable=SC2086  # intentional word-split of the argument list
  ruby "$CHECKER" $args >/dev/null 2>&1 || rc=$?
  assert_eq 2 "$rc" "C5 usage: '$args'"
done
ok "C5: unjudgeable state exits 3, usage errors exit 2, AI_OFFICE_NOW refused against live runs"

# C6: the checker never writes.
D="$RUNS/TASK-AD-011"
before="$(cat "$D/status.yaml" "$D/authorization.yaml" | cksum)"
check TASK-AD-011 devops
[[ "$(cat "$D/status.yaml" "$D/authorization.yaml" | cksum)" == "$before" ]] || fail "C6: the checker modified status or ledger"
[[ ! -e "$D/meta.yaml" ]] || fail "C6: the checker must not write meta.yaml (the driver does)"
ok "C6: the checker never writes status.yaml, gates, the ledger or meta.yaml"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/authorization-dispatch.sh`
Expected: L passes, then `[FAIL] C1 no completion_gates (line): expected 'outcome=not_applicable mode=none actions=' got ''` (the checker file does not exist).

- [ ] **Step 3: Write the checker**

Create `scripts/authorization-dispatch-check.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Dispatch-time authorization check (issue #28, Phase 1B.2).
#
#   ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>
#
# Prints exactly one line
#   outcome=<outcome> mode=<mode> actions=<a,b>
# and exits 0 (proceed), 14 (refuse) or 2 (usage error). Any other exit — 3 when
# the task state cannot be judged, 1 on a crash — is not a result: run-agent.sh
# treats it as `check_error` and resolves it WITHOUT this file (see the driver's
# scope recovery, which duplicates gate_state and the roles test on purpose and
# is pinned to this file by the agreement test in
# tests/integration/authorization-dispatch.sh).
#
# The check is inferred from state the Office already holds: a dispatch of a
# configured role, for a task with a gate that is `pending` and carries
# `requires_authorization`, needs a grant of exactly that action that is valid
# NOW (AuthorizationLedger.now_utc) as of the ledger's current high-water id.
# It never writes status.yaml, a gate, or the ledger.
#
# Configuration is read from the TYPED merged config (OfficeConfigResolver
# #merged_config), never from the resolver's `get`/`list`, which flatten lists
# and coerce scalars and would turn malformed config into valid-looking config.

require "yaml"
require "date"
require_relative "authorization-ledger"
require_relative "resolve-office-config"

module AuthorizationDispatchCheck
  MODES = %w[off warn_only required].freeze
  DEFAULT_MODE = "warn_only"
  DEFAULT_ROLES = %w[devops].freeze
  # Mirrors agents/manifest.yaml and the literal in run-agent.sh's scope
  # recovery; tests/integration/authorization-dispatch.sh pins all three.
  CONCRETE_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
  OUTCOMES = %w[not_applicable authorized missing_authorization config_error].freeze
  EXIT_PROCEED = 0
  EXIT_USAGE = 2
  EXIT_UNJUDGEABLE = 3
  EXIT_REFUSE = 14

  class Unjudgeable < StandardError; end

  Config = Struct.new(:state, :mode, :roles) # state: :ok, :off, :error
  Result = Struct.new(:outcome, :mode, :actions)

  module_function

  # :none (no pending bound gate), :bound, or :malformed (cannot be judged).
  # Kept byte-for-byte equivalent to gate_state in run-agent.sh.
  def gate_state(status)
    return :malformed unless status.is_a?(Hash)
    return :none unless status.key?("completion_gates")

    gates = status["completion_gates"]
    return :malformed unless gates.is_a?(Hash) && gates.values.all? { |gate| gate.is_a?(Hash) }

    gates.values.any? { |gate| pending_bound?(gate) } ? :bound : :none
  end

  def pending_bound?(gate)
    gate["status"] == "pending" && gate.key?("requires_authorization")
  end

  # Distinct required actions of the pending bound gates, as printable tokens.
  def required_actions(status)
    status["completion_gates"].values.select { |gate| pending_bound?(gate) }
                              .map { |gate| token(gate["requires_authorization"]) }.uniq
  end

  def token(value)
    text = value.is_a?(String) ? value : value.inspect
    text = text.gsub(/[\s,]/, "_")
    text.empty? ? "(empty)" : text
  end

  def roles_trustworthy?(roles)
    roles.is_a?(Array) && roles.all? { |role| role.is_a?(String) && CONCRETE_ROLES.include?(role) }
  end

  # Section 4 normalization. Only a WHOLLY absent block means the defaults; a
  # key missing inside a present block is untrustworthy.
  def normalize(merged_config)
    return Config.new(:error, "required", nil) unless merged_config.is_a?(Hash)
    return Config.new(:ok, DEFAULT_MODE, DEFAULT_ROLES) unless merged_config.key?("authorization_dispatch")

    block = merged_config["authorization_dispatch"]
    return Config.new(:error, "required", nil) unless block.is_a?(Hash)

    mode = block["mode"]
    return Config.new(:error, "required", nil) unless mode.is_a?(String) && MODES.include?(mode)
    return Config.new(:off, "off", nil) if mode == "off"

    roles = block["roles"]
    return Config.new(:error, mode, nil) unless roles_trustworthy?(roles)

    Config.new(:ok, mode, roles)
  end

  # The decision, given a parsed status (or :absent), the merged config, the
  # final role and the task dir (for the ledger). Raises Unjudgeable when the
  # task state cannot be read.
  def decide(status, merged_config, role, task_dir)
    return Result.new("not_applicable", "none", []) if status == :absent

    case gate_state(status)
    when :malformed then raise Unjudgeable, "status.yaml completion_gates cannot be judged"
    when :none then return Result.new("not_applicable", "none", [])
    end

    actions = required_actions(status)
    config = normalize(merged_config)
    return Result.new("not_applicable", "off", []) if config.state == :off
    return Result.new("config_error", config.mode, actions) if config.state == :error
    return Result.new("not_applicable", config.mode, []) unless config.roles.include?(role)

    index = begin
      AuthorizationLedger.load(task_dir)
    rescue AuthorizationLedger::Error => e
      warn "authorization-dispatch-check: ledger unavailable (#{e.message}); every required action is missing"
      nil
    end
    now = AuthorizationLedger.now_utc
    through = index&.high_water_id
    missing = actions.reject do |action|
      !through.nil? && index.any_valid_grant?(action: action, at: now, through: through)
    end
    return Result.new("authorized", config.mode, actions) if missing.empty?

    Result.new("missing_authorization", config.mode, missing)
  end

  def exit_code(result)
    refusing = %w[missing_authorization config_error].include?(result.outcome) && result.mode == "required"
    refusing ? EXIT_REFUSE : EXIT_PROCEED
  end

  def line(result)
    "outcome=#{result.outcome} mode=#{result.mode} actions=#{result.actions.join(',')}"
  end

  def load_status(path)
    return :absent unless File.exist?(path)

    YAML.safe_load(File.read(path), permitted_classes: [Date, Time], aliases: true)
  rescue StandardError => e
    raise Unjudgeable, "status.yaml cannot be read: #{e.message}"
  end

  def runs_dir
    ENV["AI_OFFICE_RUNS_DIR"].to_s.empty? ? File.expand_path("../runs", __dir__) : ENV["AI_OFFICE_RUNS_DIR"]
  end

  def usage!(message)
    warn "authorization-dispatch-check: #{message}"
    warn "Usage: ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>"
    exit EXIT_USAGE
  end

  def main(argv)
    command, task_id, flag, role, *rest = argv
    usage!("unknown command #{command.inspect}") unless command == "decide"
    usage!("missing --role") unless flag == "--role" && role.is_a?(String) && !role.empty?
    usage!("unexpected arguments #{rest.inspect}") unless rest.empty?
    unless task_id.is_a?(String) && task_id.match?(/\A[A-Za-z0-9][A-Za-z0-9_-]*\z/)
      usage!("invalid task id #{task_id.inspect}")
    end

    task_dir = File.join(runs_dir, task_id)
    status = load_status(File.join(task_dir, "status.yaml"))
    office_dir = File.expand_path("..", __dir__)
    profile = ENV["OFFICE_PROFILE"].to_s.strip
    merged = OfficeConfigResolver.new(office_dir, profile: profile.empty? ? nil : profile).merged_config
    result = decide(status, merged, role, task_dir)
    puts line(result)
    exit exit_code(result)
  rescue Unjudgeable, AuthorizationLedger::Error => e
    warn "authorization-dispatch-check: #{e.message}"
    exit EXIT_UNJUDGEABLE
  end
end

AuthorizationDispatchCheck.main(ARGV) if $PROGRAM_NAME == __FILE__
```

`chmod +x scripts/authorization-dispatch-check.rb`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bash tests/integration/authorization-dispatch.sh`
Expected: `ok: L…`, `ok: C1…` through `ok: C6…`, `[PASS]`.

- [ ] **Step 5: Commit**

```bash
git add scripts/authorization-dispatch-check.rb tests/integration/authorization-dispatch.sh
git commit -m "feat(authz): dispatch-time authorization checker (#28 1B.2)

decide <TASK_ID> --role <ROLE>: not_applicable without a pending bound gate
(ledger and config unread), else normalizes the typed merged config (only a
wholly absent block means defaults) and checks for a grant of exactly each
required action valid now. Exit 0 proceed, 14 refuse, 2 usage, 3 cannot judge.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ship the configuration block and protect it

**Files:**
- Modify: `office.config.yaml` (new block immediately before the `# Multi-user git mode (docs/multi-user-git.md).` comment that precedes `git_sync:`)
- Modify: `scripts/resolve-office-config.rb` (`PROTECTED_PATHS`)
- Modify: `tests/integration/authorization-dispatch.sh` (insert section P before the PASS line)

**Interfaces:**
- Consumes: `AuthorizationDispatchCheck.normalize` (Task 2); `OfficeConfigResolver#protected_path?` (private, called with `send` in the test).
- Produces: the shipped block `authorization_dispatch: {mode: warn_only, roles: [devops]}`, fully protected.

- [ ] **Step 1: Add the P section to the suite**

Insert immediately before the PASS line:

```bash
echo "== P: shipped config =="
# P1: the shipped block is valid, ships warn_only/[devops], and every key is protected.
ruby - "$ROOT_DIR" <<'RUBY' || fail "P1: shipped authorization_dispatch block"
root = ARGV[0]
require File.join(root, "scripts/authorization-dispatch-check.rb")
require "yaml"; require "date"
raw = YAML.safe_load(File.read(File.join(root, "office.config.yaml")), permitted_classes: [Date, Time], aliases: true)
block = raw["authorization_dispatch"]
abort "shipped config has no authorization_dispatch block" unless block.is_a?(Hash)
config = AuthorizationDispatchCheck.normalize(raw)
abort "shipped block must normalize to ok/warn_only/[devops], got #{config.to_a.inspect}" unless config.to_a == [:ok, "warn_only", ["devops"]]
resolver = OfficeConfigResolver.new(root)
block.each_key do |key|
  abort "authorization_dispatch.#{key} is not protected" unless resolver.send(:protected_path?, ["authorization_dispatch", key])
end
abort "the block itself must be protected" unless resolver.send(:protected_path?, ["authorization_dispatch"])
RUBY
# P2: a local overlay setting mode off is ignored by the merged config.
cp "$ROOT_DIR/office.config.yaml" "$WORK/office/office.config.yaml"
printf 'authorization_dispatch:\n  mode: "off"\n' > "$OFFICE/office.config.local.yaml"
merged_mode="$(ruby "$OFFICE/scripts/resolve-office-config.rb" dump "$OFFICE" | ruby -ryaml -rdate -e 'puts YAML.safe_load(STDIN.read, permitted_classes: [Date, Time], aliases: true)["authorization_dispatch"]["mode"]')"
assert_eq "warn_only" "$merged_mode" "P2 local overlay cannot set mode off"
rm -f "$OFFICE/office.config.local.yaml"
ok "P: the shipped block is valid, warn_only/[devops], fully protected; overlays cannot weaken it"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/authorization-dispatch.sh`
Expected: L and C pass, then `[FAIL] P1: shipped authorization_dispatch block` (stderr: `shipped config has no authorization_dispatch block`).

- [ ] **Step 3: Add the block to `office.config.yaml`**

Insert immediately before the line `# Multi-user git mode (docs/multi-user-git.md). When enabled, run-agent.sh`:

```yaml
# Dispatch-time authorization check (issue #28 Phase 1B.2,
# docs/authorization-ledger.md). When run-agent.sh dispatches a role listed in
# `roles` for a task with a completion gate that is `pending` and carries
# `requires_authorization`, it checks that the task's authorization ledger holds
# a grant of exactly that action that is valid NOW. warn_only records and warns,
# never blocks; required refuses the dispatch; off disables the check. Every
# applicable admission attempt is recorded as an authorization_dispatch_check
# meta.yaml event. The WHOLE block is protected (PROTECTED_PATHS): a gitignored
# local overlay cannot change it, so switching modes or roles is a change to
# this tracked file. Only a wholly absent block means the defaults; a present
# block with `mode` missing fails closed (required), and one with `roles`
# missing under warn_only/required is a config_error under that mode.
authorization_dispatch:
  # "off" | warn_only | required. Default warn_only: record and warn, never block.
  # Quote "off": YAML reads a bare off/no/false as a boolean, which is not a
  # string and therefore fails closed (config_error, effective required).
  mode: warn_only
  # Roles whose dispatch is checked. Default [devops], the role preflight already
  # maps to the deploy capability. Values must be roles from agents/manifest.yaml.
  roles:
    - devops
```

- [ ] **Step 4: Protect it in `scripts/resolve-office-config.rb`**

Replace the end of `PROTECTED_PATHS`:

```ruby
    %w[execution_budget max_no_progress_actions],
    %w[execution_budget on_exhausted]
  ].freeze
```

with:

```ruby
    %w[execution_budget max_no_progress_actions],
    %w[execution_budget on_exhausted],
    # #28 Phase 1B.2: the whole dispatch-time authorization block. An overlay
    # that could set `mode: off` or empty `roles` would silently weaken the
    # check with no trace in `git status` (same shape as ownership.enabled), so
    # changing it is a reviewed change to the tracked office.config.yaml.
    %w[authorization_dispatch]
  ].freeze
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bash tests/integration/authorization-dispatch.sh` — expected `ok: P…` and `[PASS]`.
Run: `bash tests/integration/policy-preflight.sh` and `bash tests/integration/profile-merge.sh` — expected `[PASS]` / exit 0 (protection list change must not disturb them).

- [ ] **Step 6: Commit**

```bash
git add office.config.yaml scripts/resolve-office-config.rb tests/integration/authorization-dispatch.sh
git commit -m "feat(authz): ship authorization_dispatch (warn_only, [devops]) as a protected block (#28 1B.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Driver admission check (trusted checker path)

**Files:**
- Modify: `run-agent.sh` (insert a block immediately before the comment line `# Allocate the run id BEFORE the first dispatch event, so prompt_assembly and`, which precedes `record_run_start`)
- Modify: `tests/integration/authorization-dispatch.sh` (insert section D-core before the PASS line)

**Interfaces:**
- Consumes: the checker CLI (Task 2); `log_meta_event`, `TASK_ID`, `TASK_LABEL`, `AGENT`, `META_FILE`, `STATUS_FILE`, `OFFICE_DIR` (existing driver globals).
- Produces: shell function `authorization_dispatch_check` (sets `AUTHZ_OUTCOME`, `AUTHZ_MODE`, `AUTHZ_ACTIONS`), called once at the insertion point; exactly one guarded `if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event … "authorization_dispatch_check"` call (Task 5's tests rely on that exact text to inject a sink failure). In this task an untrustworthy checker result is a `check_error` under effective `required` (fail closed); Task 5 replaces that branch with the independent recovery.

- [ ] **Step 1: Add the D-core section to the suite**

Insert immediately before the PASS line:

```bash
echo "== D: driver =="
WARN_BLOCK='authorization_dispatch:
  mode: warn_only
  roles: [devops]'
REQ_BLOCK='authorization_dispatch:
  mode: required
  roles: [devops]'
OFF_BLOCK='authorization_dispatch:
  mode: "off"
  roles: [devops]'

assert_events() {  # <task_dir> <expected "agent|details|run_id" lines, newline-separated> <label>
  assert_eq "$2" "$(events "$1")" "$3 (events)"
}

# D1: warn_only records and warns, never blocks.
set_block "$WARN_BLOCK"
D="$(mk_task TASK-AD-101 "$PENDING_DEPLOY")"
dispatch TASK-AD-101 devops
assert_eq 1 "$D_CALLS" "D1 warn_only missing grant: the runner runs"
grep -q "Authorization check: deploy_production have no valid grant for TASK-AD-101" <<<"$D_OUT" || fail "D1: warning missing: $D_OUT"
assert_events "$D" "devops|task=TASK-AD-101 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D1 missing"
D="$(mk_task TASK-AD-102 "$PENDING_DEPLOY")"; write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
dispatch TASK-AD-102 devops
assert_eq 1 "$D_CALLS" "D1 authorized: the runner runs"
assert_events "$D" "devops|task=TASK-AD-102 mode=warn_only outcome=authorized actions=deploy_production|-" "D1 authorized"
D="$(mk_task TASK-AD-103 "$PENDING_DEPLOY" dev)"
dispatch TASK-AD-103 dev
assert_eq 1 "$D_CALLS" "D1 dev dispatch runs"
assert_eq 0 "$(event_count "$D")" "D1 an unconfigured role logs nothing"
D="$(mk_task TASK-AD-104 "$PENDING_DEPLOY")"
dispatch TASK-AD-104 devops AI_DEV_OFFICE_RUN_ID=run-leaked-from-a-parent
assert_events "$D" "devops|task=TASK-AD-104 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D1 no run_id even if one leaked"
ruby "$OFFICE/validate-yaml.rb" "$RUNS/TASK-AD-101/meta.yaml" >/dev/null || fail "D1: meta.yaml with the new event must validate"
ok "D1: warn_only proceeds, warns, logs one event without run_id; unconfigured role logs nothing"

# D2: required refuses before any run record, lease or runner exists.
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-111 "$PENDING_DEPLOY")"
before="$(cksum < "$D/status.yaml")"
dispatch TASK-AD-111 devops
assert_eq 1 "$D_RC" "D2 required missing grant: exit 1"
assert_eq 0 "$D_CALLS" "D2 the runner is not invoked"
assert_eq "$before" "$(cksum < "$D/status.yaml")" "D2 status untouched"
[[ ! -e "$D/run-records" ]] || fail "D2: a refusal must leave no run record"
[[ ! -e "$D/ownership.yaml" ]] || fail "D2: a refusal must leave no ownership lease"
grep -q "record-authorization.rb" <<<"$D_OUT" || fail "D2: the refusal must point at record-authorization.rb: $D_OUT"
assert_events "$D" "devops|task=TASK-AD-111 mode=required outcome=missing_authorization actions=deploy_production|-" "D2 missing"
D="$(mk_task TASK-AD-112 "$PENDING_DEPLOY")"; write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
dispatch TASK-AD-112 devops
assert_eq 1 "$D_CALLS" "D2 required with a grant: the runner runs"
assert_events "$D" "devops|task=TASK-AD-112 mode=required outcome=authorized actions=deploy_production|-" "D2 authorized"
set_block 'authorization_dispatch:
  mode: required
  roles: devops'
D="$(mk_task TASK-AD-113 "$PENDING_DEPLOY")"
dispatch TASK-AD-113 devops
assert_eq 1 "$D_RC" "D2 required config_error: exit 1"
assert_eq 0 "$D_CALLS" "D2 config_error: the runner is not invoked"
assert_events "$D" "devops|task=TASK-AD-113 mode=required outcome=config_error actions=deploy_production|-" "D2 config_error"
ok "D2: required refuses missing grants and config errors, with no run record/lease/runner; a grant proceeds"

# D8: the event write is guarded. Corrupting meta.yaml cannot reach this block
# (the driver's earlier, unguarded context_provider event fails first), so the
# sink failure is injected into the office copy's driver.
cp "$WORK/driver.orig.sh" "$OFFICE/run-agent.sh"
ruby -e 'src = File.read(ARGV[0], encoding: "UTF-8"); n = src.scan(%(if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event)).size
  abort "D8: expected exactly one guarded event write, found #{n}" unless n == 1
  File.write(ARGV[0], src.sub(%(if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event), %(if ! AI_DEV_OFFICE_RUN_ID="" false)))' "$OFFICE/run-agent.sh"
set_block "$WARN_BLOCK"
D="$(mk_task TASK-AD-701 "$PENDING_DEPLOY")"
dispatch TASK-AD-701 devops
assert_eq 1 "$D_CALLS" "D8 warn_only: proceeds when the event cannot be written"
grep -q "WARNING: could not record the authorization_dispatch_check event" <<<"$D_OUT" || fail "D8: warn_only must warn: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D8 warn_only: no event written"
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-702 "$PENDING_DEPLOY")"; write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
dispatch TASK-AD-702 devops
assert_eq 1 "$D_RC" "D8 required + authorized: refused when the event cannot be written"
assert_eq 0 "$D_CALLS" "D8 required + authorized: no runner"
D="$(mk_task TASK-AD-703 "$PENDING_DEPLOY")"
dispatch TASK-AD-703 devops
assert_eq 1 "$D_RC" "D8 required + missing: refused"
cp "$WORK/driver.orig.sh" "$OFFICE/run-agent.sh"
ok "D8: an unwritable event warns and proceeds in warn_only, refuses in required"

# D9: admission is not execution — a live lease held by another run refuses
# AFTER the check, so a valid event exists for an attempt that never ran.
set_block "$WARN_BLOCK"
for grant in no yes; do
  D="$(mk_task "TASK-AD-80$([[ $grant == yes ]] && echo 2 || echo 1)" "$PENDING_DEPLOY")"
  T="$(basename "$D")"
  [[ "$grant" == yes ]] && write_ledger "$D" "$(grant_yaml authz-001 deploy_production)"
  AI_DEV_OFFICE_RUN_ID=run-other-owner ruby "$OFFICE/scripts/task-ownership.rb" acquire "$D" "$T" agent=devops \
    "office_dir=$OFFICE" >/dev/null
  dispatch "$T" devops
  assert_eq 9 "$D_RC" "D9 ($grant grant) ownership refuses"
  assert_eq 0 "$D_CALLS" "D9 ($grant grant) no runner"
  assert_eq 1 "$(event_count "$D")" "D9 ($grant grant) exactly one admission-attempt event"
  assert_eq 0 "$(meta_count "$D" ownership_acquired)" "D9 ($grant grant) no ownership_acquired"
done
ok "D9: an ownership refusal after a successful admission leaves one event and no runner (expected)"

# D10: placement.
set_block 'authorization_dispatch:
  mode: warn_only
  roles: [debugger]'
review_task() {  # <task_id> — in review, with a pending request_changes decision
  local dir="$RUNS/$1"
  rm -rf "$dir"; mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: in_review
state: in_review
iteration: 1
current_agent: reviewer
ready: true
created_at: "2026-10-01"
updated_at: "2026-10-01"
history: []
$PENDING_DEPLOY
YAML
  cat > "$dir/decision.yaml" <<YAML
task_id: $1
decisions:
  - decision: request_changes
    actor: alice
    decided_at: "2026-10-01T10:00:00Z"
YAML
  echo "$dir"
}
D="$(review_task TASK-AD-901)"
dispatch TASK-AD-901 reviewer
grep -q "dispatching that instead" <<<"$D_OUT" || fail "D10: precondition — the decision must reroute: $D_OUT"
assert_events "$D" "debugger|task=TASK-AD-901 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D10 the rerouted role is checked"
set_block 'authorization_dispatch:
  mode: warn_only
  roles: [reviewer]'
D="$(review_task TASK-AD-902)"
dispatch TASK-AD-902 reviewer
assert_eq 0 "$(event_count "$D")" "D10 the original (configured) role is not checked after a reroute"
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-903 "$PENDING_DEPLOY")"
ruby -e 'p = ARGV[0]; s = File.read(p).sub("state: assigned", "state: blocked"); File.write(p, s)' "$D/status.yaml"
dispatch TASK-AD-903 devops
grep -q "is blocked" <<<"$D_OUT" || fail "D10: precondition — blocked guard: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 a blocked task never reaches the check"
D="$(mk_task TASK-AD-904 "$PENDING_DEPLOY" dev)"
dispatch TASK-AD-904 devops
grep -q "is currently routed to 'dev'" <<<"$D_OUT" || fail "D10: precondition — route guard: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 a route mismatch never reaches the check"
D="$(mk_task TASK-AD-905 "$PENDING_DEPLOY")"
ruby -e 'p = ARGV[0]; s = File.read(p).sub("iteration: 0", "iteration: 99"); File.write(p, s)' "$D/status.yaml"
dispatch TASK-AD-905 devops
grep -q "Loop guard triggered" <<<"$D_OUT" || fail "D10: precondition — loop guard: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 the loop guard stops before the check"
D="$(mk_task TASK-AD-906 "$PENDING_DEPLOY")"
SHA="$(printf 'same failure' | shasum -a 256 | cut -d' ' -f1)"
cat > "$D/evidence.yaml" <<YAML
task_id: TASK-AD-906
evidence:
  - id: ev-001
    type: command
    command: "make deploy"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-09-30T00:00:00Z"
    artifact_path: evidence/ev-001.log
    artifact_sha256: "$SHA"
  - id: ev-002
    type: command
    command: "make deploy"
    exit_code: 1
    repo: /tmp/x
    repo_origin: null
    repo_sha: unknown
    working_tree_dirty: false
    executed_at: "2026-09-30T00:05:00Z"
    artifact_path: evidence/ev-002.log
    artifact_sha256: "$SHA"
YAML
dispatch TASK-AD-906 devops
grep -q "Execution budget exhausted" <<<"$D_OUT" || fail "D10: precondition — execution budget: $D_OUT"
assert_eq 0 "$(event_count "$D")" "D10 the execution budget stops before the check"
# The auto umbrella always starts with a concrete pm sub-dispatch (a fresh
# run-agent.sh process); with pm configured, that sub-dispatch is checked and
# the umbrella itself (AGENT=auto) is not.
set_block 'authorization_dispatch:
  mode: warn_only
  roles: [pm]'
D="$(mk_task TASK-AD-907 "$PENDING_DEPLOY" pm)"
dispatch TASK-AD-907 auto
grep -q ">>> Running pm" <<<"$D_OUT" || fail "D10: precondition — auto must launch pm: $D_OUT"
assert_events "$D" "pm|task=TASK-AD-907 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D10 auto: only the concrete sub-dispatch is checked"
ok "D10: the rerouted role is checked; guards stop before the check; auto is checked per concrete role"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/authorization-dispatch.sh > /tmp/authz-t4.log 2>&1; tail -5 /tmp/authz-t4.log`
Expected: L, C, P pass, then `[FAIL] D1: warning missing: …` (no check runs in the driver yet).

- [ ] **Step 3: Insert the driver block**

In `run-agent.sh`, insert immediately before the line `# Allocate the run id BEFORE the first dispatch event, so prompt_assembly and`:

```bash
# --- dispatch-time authorization check (issue #28 Phase 1B.2) ------------------
# docs/authorization-ledger.md, "Dispatch-time authorization check". Placed at
# the final stable role/policy admission point: AGENT is final (the human
# decision reroute and the auto umbrella are behind us) and every routing /
# dependency / loop / budget guard has passed, but no run record, lease or
# runner exists yet. Later setup (ownership_acquire, the integrity snapshot) can
# still stop this attempt, so an event here is ADMISSION-ATTEMPT evidence, not
# proof that the runner started; it carries no run_id because none exists yet.
#
# warn_only never breaks a run; required fails closed. When the checker cannot
# give a trustworthy answer the driver records a synthetic `check_error`, and
# decides mode and scope WITHOUT the checker (authorization_dispatch_recover):
# a defect that breaks the checker's `decide` would break any other command in
# that file too.

authorization_dispatch_check() {
  local err out rc=0 expected
  AUTHZ_OUTCOME="" AUTHZ_MODE="" AUTHZ_ACTIONS=""
  err="$(mktemp)"
  out="$(ruby "$OFFICE_DIR/scripts/authorization-dispatch-check.rb" decide "$TASK_ID" --role "$AGENT" 2>"$err")" || rc=$?
  if [[ "$out" =~ ^outcome=(not_applicable|authorized|missing_authorization|config_error)\ mode=(off|warn_only|required|none)\ actions=([^[:space:]]*)$ ]]; then
    AUTHZ_OUTCOME="${BASH_REMATCH[1]}" AUTHZ_MODE="${BASH_REMATCH[2]}" AUTHZ_ACTIONS="${BASH_REMATCH[3]}"
    expected=0
    if [[ "$AUTHZ_MODE" == "required" && ( "$AUTHZ_OUTCOME" == "missing_authorization" || "$AUTHZ_OUTCOME" == "config_error" ) ]]; then
      expected=14
    fi
    [[ "$rc" -eq "$expected" ]] || AUTHZ_OUTCOME=""
  fi
  if [[ -z "$AUTHZ_OUTCOME" ]]; then
    # Untrustworthy checker result. Until the driver can recover mode and scope
    # on its own, fail closed.
    AUTHZ_OUTCOME="check_error" AUTHZ_MODE="required" AUTHZ_ACTIONS=""
    echo "Authorization check could not be completed (checker exit $rc); recorded as check_error, effective mode $AUTHZ_MODE." >&2
    [[ -s "$err" ]] && cat "$err" >&2
  fi
  rm -f "$err"
  [[ "$AUTHZ_OUTCOME" == "not_applicable" ]] && return 0

  local refuse="false"
  if [[ "$AUTHZ_MODE" == "required" && "$AUTHZ_OUTCOME" != "authorized" ]]; then
    refuse="true"
  fi
  # Guarded: under set -e an unguarded failure here would end an advisory
  # dispatch. The events carry no run_id (none exists yet), even if one leaked
  # into the environment.
  if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event "$TASK_ID" "$META_FILE" "authorization_dispatch_check" "$AGENT" \
      "task=$TASK_LABEL mode=$AUTHZ_MODE outcome=$AUTHZ_OUTCOME actions=${AUTHZ_ACTIONS:-none}"; then
    echo "WARNING: could not record the authorization_dispatch_check event in runs/$TASK_ID/meta.yaml (outcome=$AUTHZ_OUTCOME mode=$AUTHZ_MODE)." >&2
    if [[ "$AUTHZ_MODE" == "required" ]]; then
      echo "Authorization check refused this dispatch: an admission decision that cannot be audited is not taken. Fix runs/$TASK_ID/meta.yaml." >&2
      exit 1
    fi
  fi

  case "$AUTHZ_OUTCOME" in
    missing_authorization)
      echo "Authorization check: ${AUTHZ_ACTIONS//,/, } have no valid grant for $TASK_ID" >&2 ;;
    config_error)
      echo "Authorization check: the authorization_dispatch configuration is invalid (config_error, effective mode $AUTHZ_MODE); fix the tracked office.config.yaml." >&2 ;;
  esac
  if [[ "$refuse" == "true" ]]; then
    if [[ "$AUTHZ_OUTCOME" == "missing_authorization" ]]; then
      echo "Authorization check refused this dispatch (mode required). Record a grant with scripts/record-authorization.rb, then re-dispatch." >&2
    else
      echo "Authorization check refused this dispatch (mode required, outcome $AUTHZ_OUTCOME). Fix the authorization_dispatch configuration or the checker, then re-dispatch." >&2
    fi
    exit 1
  fi
  return 0
}

authorization_dispatch_check
# -------------------------------------------------------------------------------
```

Check: `bash -n run-agent.sh` prints nothing; `grep -c 'if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event' run-agent.sh` prints `1`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bash tests/integration/authorization-dispatch.sh > /tmp/authz-t4.log 2>&1; tail -8 /tmp/authz-t4.log`
Expected: `ok: D1`, `ok: D2`, `ok: D8`, `ok: D9`, `ok: D10`, `[PASS]`.
Run the driver regressions: `bash tests/integration/driver-decision-e2e.sh`, `bash tests/integration/task-ownership.sh`, `bash tests/integration/runner-fallback.sh`, `bash tests/integration/execution-budget.sh` — each exits 0 (they have no pending bound gate, so the check is `not_applicable` and silent).

- [ ] **Step 5: Commit**

```bash
git add run-agent.sh tests/integration/authorization-dispatch.sh
git commit -m "feat(authz): dispatch-time authorization check in run-agent.sh (#28 1B.2)

Immediately before record_run_start: one authorization_dispatch_check event
per applicable admission attempt (no run_id), guarded write, warn_only warns
and proceeds, required refuses with no run record, lease or runner.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `check_error` recovery independent of the checker

**Files:**
- Modify: `run-agent.sh` (add `authorization_dispatch_recover` above `authorization_dispatch_check`; replace the untrustworthy-result branch)
- Modify: `tests/integration/authorization-dispatch.sh` (insert section D-recovery/R before the PASS line)

**Interfaces:**
- Consumes: `ruby "$CONFIG_RESOLVER" dump "$OFFICE_DIR"` (existing resolver command); `AuthorizationDispatchCheck.load_status`, `.decide`, `::Unjudgeable`, `::CONCRETE_ROLES` (agreement test only).
- Produces: shell function `authorization_dispatch_recover <status_file> <agent>` printing `not_applicable` or `in_scope <warn_only|required>`; its Ruby lives in a heredoc delimited by `AUTHZ_SCOPE_RUBY` (the test extracts it with `awk '/<<.AUTHZ_SCOPE_RUBY./{f=1; next} /^AUTHZ_SCOPE_RUBY$/{f=0} f'`), contains the line `CONCRETE_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze`, and reads the dump from the env var `AUTHZ_CONFIG_DUMP` (stdin is the heredoc program).

- [ ] **Step 1: Add the D-recovery and R sections to the suite**

Insert immediately before the PASS line:

```bash
# Checker sabotage for the check_error cases. The checker is replaced in the
# office copy only and restored after each case.
break_checker() { printf '%s\n' "$1" > "$CHECKER"; }
restore_checker() { cp "$WORK/checker.orig.rb" "$CHECKER"; }
UNLOADABLE='def ('

# D3: every untrustworthy checker result is a check_error.
VARIANTS=(
  'def ('
  'require_relative "no-such-file"'
  'raise "boom"'
  'exit 2'
  'exit 7'
  'exit 0'
  'puts "outcome=authorized mode=required actions=deploy_production"; exit 14'
  'puts "outcome=missing_authorization mode=required actions=deploy_production"; exit 0'
  'puts "outcome=authorized mode=warn_only actions=deploy_production"; puts "extra"; exit 0'
)
n=200
for variant in "${VARIANTS[@]}"; do
  break_checker "$variant"
  n=$((n + 1)); set_block "$WARN_BLOCK"
  D="$(mk_task "TASK-AD-$n" "$PENDING_DEPLOY")"
  dispatch "TASK-AD-$n" devops
  assert_eq 1 "$D_CALLS" "D3 [$variant] warn_only: the runner runs"
  grep -q "could not be completed" <<<"$D_OUT" || fail "D3 [$variant]: warn_only must warn: $D_OUT"
  assert_events "$D" "devops|task=TASK-AD-$n mode=warn_only outcome=check_error actions=none|-" "D3 [$variant] warn_only"
  n=$((n + 1)); set_block "$REQ_BLOCK"
  D="$(mk_task "TASK-AD-$n" "$PENDING_DEPLOY")"
  dispatch "TASK-AD-$n" devops
  assert_eq 1 "$D_RC" "D3 [$variant] required: exit 1"
  assert_eq 0 "$D_CALLS" "D3 [$variant] required: no runner"
  assert_events "$D" "devops|task=TASK-AD-$n mode=required outcome=check_error actions=none|-" "D3 [$variant] required"
done
set_block "$OFF_BLOCK"
D="$(mk_task TASK-AD-299 "$PENDING_DEPLOY")"
dispatch TASK-AD-299 devops
assert_eq 1 "$D_CALLS" "D3 off: the runner runs"
assert_eq 0 "$(event_count "$D")" "D3 off: nothing recorded"
restore_checker
ok "D3: crash/usage/other exit/no output/disagreeing or extra output -> check_error; warn_only proceeds, required refuses, off records nothing"

# drive_broken <task_id> <status extra> <raw block> <role> <expect: none|warn_only|required> <label>
# With the checker unloadable: none = proceeds with no event and no warning;
# warn_only = proceeds with one check_error event; required = refused with one.
drive_broken() {
  local task="$1" extra="$2" block="$3" role="$4" expect="$5" label="$6" D
  set_block "$block"
  D="$(mk_task "$task" "$extra" "$role")"
  break_checker "$UNLOADABLE"
  dispatch "$task" "$role"
  restore_checker
  case "$expect" in
    none)
      assert_eq 1 "$D_CALLS" "$label: the runner runs"
      assert_eq 0 "$(event_count "$D")" "$label: no event"
      ! grep -q "could not be completed" <<<"$D_OUT" || fail "$label: no warning expected: $D_OUT"
      ;;
    warn_only)
      assert_eq 1 "$D_CALLS" "$label: the runner runs"
      assert_events "$D" "$role|task=$task mode=warn_only outcome=check_error actions=none|-" "$label"
      ;;
    required)
      assert_eq 1 "$D_RC" "$label: exit 1"
      assert_eq 0 "$D_CALLS" "$label: no runner"
      assert_events "$D" "$role|task=$task mode=required outcome=check_error actions=none|-" "$label"
      ;;
  esac
}

RESOLVED_BOUND='completion_gates:
  prod_deploy:
    status: na
    requires_authorization: deploy_production
    actor: alice
    reason: "not deploying"
    updated_at: "2026-09-30T10:00:00Z"'
UNBOUND_PENDING='completion_gates:
  smoke:
    status: pending'

# D4: scope recovery with the checker unloadable, under both enforcing modes.
n=300
for block in "$WARN_BLOCK" "$REQ_BLOCK"; do
  mode="warn_only"; [[ "$block" == "$REQ_BLOCK" ]] && mode="required"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "" "$block" devops none "D4a $mode no completion_gates"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$RESOLVED_BOUND" "$block" devops none "D4a $mode only resolved bound"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$UNBOUND_PENDING" "$block" devops none "D4a $mode only unbound pending"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "$block" dev none "D4b $mode explicit roles, dev dispatch"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "$block" devops "$mode" "D4c $mode in scope"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "authorization_dispatch:
  mode: $mode
  roles: devops" devops "$mode" "D4d $mode scalar roles"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "authorization_dispatch:
  mode: $mode
  roles: [devops, nosuchrole]" devops "$mode" "D4d $mode unknown role"
done
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "" dev none "D4b default roles (block absent), dev dispatch"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "" devops warn_only "D4c block absent, in scope"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  mode: of
  roles: [devops]' devops required "D4f garbage mode with a pending bound gate"
n=$((n + 1)); drive_broken "TASK-AD-$n" "" 'authorization_dispatch:
  mode: of
  roles: [devops]' devops none "D4f garbage mode without a pending bound gate"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "$OFF_BLOCK" devops none "D4g off"
ok "D4: scope recovery: out-of-scope dispatches stay silent, in-scope ones are check_error under the fallback mode"

# D5: the typed seam (checker unloadable, pending bound gate).
n=400
for bad in '[warn_only]' '""' '' '{a: b}' '5' 'true' 'off'; do
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "authorization_dispatch:
  mode: $bad
  roles: [devops]" devops required "D5 mode: $bad"
done
for mode in warn_only required; do
  for bad in 'devops' '{devops: true}' '' '[devops, 5]'; do
    n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "authorization_dispatch:
  mode: $mode
  roles: $bad" devops "$mode" "D5 $mode roles: $bad"
  done
done
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  mode: warn_only
  roles: []' devops none "D5 empty roles"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  mode: warn_only
  roles: [devops, free-roam]' devops warn_only "D5 valid list"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  roles: [devops]' devops required "D5 partial block: mode missing"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  mode: warn_only' devops warn_only "D5 partial block: warn_only, roles missing"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  mode: required' devops required "D5 partial block: required, roles missing"
n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" 'authorization_dispatch:
  mode: "off"' devops none "D5 partial block: off, roles missing"
ok "D5: typed seam: non-string/empty/null modes fail closed; scalar/map/null/mixed roles are in scope; partial blocks match the checker"

# D6: the typed read itself fails.
break_resolver_dump() {  # <ruby statement replacing the dump body>
  ruby -e 'src = File.read(ARGV[0]); File.write(ARGV[0], src.sub("puts YAML.dump(resolver.merged_config)", ARGV[1]))' \
    "$OFFICE/scripts/resolve-office-config.rb" "$1"
}
n=500
for sabotage in 'exit 1' 'raise "boom"' 'puts "- not\n- a map"'; do
  break_resolver_dump "$sabotage"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "$PENDING_DEPLOY" "$WARN_BLOCK" devops required "D6 dump [$sabotage], in scope"
  n=$((n + 1)); drive_broken "TASK-AD-$n" "" "$WARN_BLOCK" devops none "D6 dump [$sabotage], no pending bound gate"
  cp "$WORK/resolver.orig.rb" "$OFFICE/scripts/resolve-office-config.rb"
done
ok "D6: a failed, non-zero or non-mapping typed read is untrustworthy (effective required) only when in scope"

# D7: merge and protection — overlays cannot change the block, for either path.
set_block "$WARN_BLOCK"
printf 'authorization_dispatch:\n  mode: "off"\n  roles: []\n' > "$OFFICE/office.config.local.yaml"
mkdir -p "$OFFICE/profiles"
printf 'authorization_dispatch:\n  mode: "off"\nloop_guard:\n  max_iterations: 97\n' > "$OFFICE/profiles/authz-test.yaml"
D="$(mk_task TASK-AD-601 "$PENDING_DEPLOY")"
dispatch TASK-AD-601 devops OFFICE_PROFILE=authz-test
assert_events "$D" "devops|task=TASK-AD-601 mode=warn_only outcome=missing_authorization actions=deploy_production|-" "D7 checker ignores overlays"
D="$(mk_task TASK-AD-602 "$PENDING_DEPLOY")"
break_checker "$UNLOADABLE"
dispatch TASK-AD-602 devops OFFICE_PROFILE=authz-test
restore_checker
assert_events "$D" "devops|task=TASK-AD-602 mode=warn_only outcome=check_error actions=none|-" "D7 recovery ignores overlays"
OFFICE_PROFILE=authz-test ruby "$OFFICE/scripts/resolve-office-config.rb" dump "$OFFICE" | grep -q "max_iterations: 97" \
  || fail "D7: the merged config both paths read must reflect a non-protected profile override"
rm -f "$OFFICE/office.config.local.yaml" "$OFFICE/profiles/authz-test.yaml"
ok "D7: a local overlay and a profile cannot change authorization_dispatch for the checker or the recovery"

# D8b: the guarded event write, for check_error (sink failure injected as in D8).
cp "$WORK/driver.orig.sh" "$OFFICE/run-agent.sh"
ruby -e 'src = File.read(ARGV[0], encoding: "UTF-8"); n = src.scan(%(if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event)).size
  abort "D8: expected exactly one guarded event write, found #{n}" unless n == 1
  File.write(ARGV[0], src.sub(%(if ! AI_DEV_OFFICE_RUN_ID="" log_meta_event), %(if ! AI_DEV_OFFICE_RUN_ID="" false)))' "$OFFICE/run-agent.sh"
set_block "$REQ_BLOCK"
D="$(mk_task TASK-AD-704 "$PENDING_DEPLOY")"
break_checker "$UNLOADABLE"; dispatch TASK-AD-704 devops; restore_checker
assert_eq 1 "$D_RC" "D8 required + check_error: refused"
set_block "$WARN_BLOCK"
D="$(mk_task TASK-AD-705 "$PENDING_DEPLOY")"
break_checker "$UNLOADABLE"; dispatch TASK-AD-705 devops; restore_checker
assert_eq 1 "$D_CALLS" "D8 warn_only + check_error: proceeds"
cp "$WORK/driver.orig.sh" "$OFFICE/run-agent.sh"
ok "D8b: an unwritable check_error event refuses in required and proceeds in warn_only"


echo "== R: recovery, agreement, pins =="
# The driver's scope recovery, extracted verbatim from the office copy's
# run-agent.sh (the same bytes the driver runs).
awk '/<<.AUTHZ_SCOPE_RUBY./{f=1; next} /^AUTHZ_SCOPE_RUBY$/{f=0} f' "$OFFICE/run-agent.sh" > "$WORK/recover.rb"
[[ -s "$WORK/recover.rb" ]] || fail "R: could not extract the AUTHZ_SCOPE_RUBY heredoc from run-agent.sh"

recover() {  # <status_path> <agent> <dump_rc> <dump text>
  AUTHZ_CONFIG_DUMP="$4" ruby "$WORK/recover.rb" "$1" "$2" "$3"
}

# The checker's answer for the same fixture: "not_applicable",
# "in_scope <effective mode>", or "in_scope ?" when it cannot judge the status.
checker_answer() {  # <status_path> <agent> <config yaml>
  ruby - "$CHECKER" "$1" "$2" "$3" "$WORK/no-ledger-task" <<'RUBY'
require "yaml"; require "date"
checker, status_path, agent, config_text, task_dir = ARGV
require checker
config = YAML.safe_load(config_text, permitted_classes: [Date, Time], aliases: true)
begin
  status = AuthorizationDispatchCheck.load_status(status_path)
  result = AuthorizationDispatchCheck.decide(status, config, agent, task_dir)
  puts result.outcome == "not_applicable" ? "not_applicable" : "in_scope #{result.mode}"
rescue AuthorizationDispatchCheck::Unjudgeable
  puts "in_scope ?"
end
RUBY
}
mkdir -p "$WORK/no-ledger-task"

# Status fixtures.
SF="$WORK/status-fixtures"; mkdir -p "$SF"
printf 'task_id: X\nphase: assigned\n' > "$SF/no_gates.yaml"
printf 'task_id: X\n%s\n' "$UNBOUND_PENDING" > "$SF/unbound_pending.yaml"
printf 'task_id: X\n%s\n' "$PENDING_DEPLOY" > "$SF/pending_bound.yaml"
printf 'task_id: X\n%s\n' "$RESOLVED_BOUND" > "$SF/resolved_bound.yaml"
printf 'task_id: X\ncompletion_gates: [prod_deploy]\n' > "$SF/gates_list.yaml"
printf 'task_id: X\ncompletion_gates:\n  prod_deploy: pending\n' > "$SF/gate_scalar.yaml"
printf 'task_id: X\ncompletion_gates:\n' > "$SF/gates_null.yaml"
printf 'phase: [\n' > "$SF/corrupt.yaml"
printf -- '- a list\n' > "$SF/not_a_map.yaml"

# Merged-config fixtures (the authorization_dispatch part only; the rest of the
# merged config is irrelevant to both predicates).
CONFIGS=(
  '{}'
  'authorization_dispatch: {mode: warn_only, roles: [devops]}'
  'authorization_dispatch: {mode: required, roles: [devops]}'
  'authorization_dispatch: {mode: "off", roles: [devops]}'
  'authorization_dispatch: {mode: warn_only, roles: []}'
  'authorization_dispatch: {mode: warn_only, roles: [dev]}'
  'authorization_dispatch: {mode: required, roles: [pm, devops, free-roam]}'
  'authorization_dispatch: {mode: warn_only, roles: devops}'
  'authorization_dispatch: {mode: required, roles: {devops: true}}'
  'authorization_dispatch: {mode: warn_only, roles: null}'
  'authorization_dispatch: {mode: required, roles: [devops, 5]}'
  'authorization_dispatch: {mode: warn_only, roles: [devops, nosuchrole]}'
  'authorization_dispatch: {mode: [warn_only], roles: [devops]}'
  'authorization_dispatch: {mode: "", roles: [devops]}'
  'authorization_dispatch: {mode: null, roles: [devops]}'
  'authorization_dispatch: {mode: {a: b}, roles: [devops]}'
  'authorization_dispatch: {mode: 5, roles: [devops]}'
  'authorization_dispatch: {mode: true, roles: [devops]}'
  'authorization_dispatch: {mode: off, roles: [devops]}'
  'authorization_dispatch: {mode: of, roles: [devops]}'
  'authorization_dispatch: {roles: [devops]}'
  'authorization_dispatch: {mode: warn_only}'
  'authorization_dispatch: {mode: required}'
  'authorization_dispatch: {mode: "off"}'
  'authorization_dispatch: 5'
  'authorization_dispatch: null'
  '- not a map'
)
checked=0
for status in "$SF"/*.yaml "$SF/absent.yaml"; do
  for config in "${CONFIGS[@]}"; do
    for agent in devops dev pm; do
      driver="$(recover "$status" "$agent" 0 "$config")"
      checker="$(checker_answer "$status" "$agent" "$config")"
      if [[ "$checker" == "in_scope ?" ]]; then
        # The checker exits 3 here and the driver alone decides: a trusted
        # "off" wins (row 1), anything else is in scope (row 3, fail closed).
        if [[ "$config" == *'mode: "off"'* ]]; then
          assert_eq "not_applicable" "$driver" "R unjudgeable status under off: $(basename "$status") / $config / $agent"
        else
          [[ "$driver" == in_scope* ]] || fail "R unjudgeable status: $(basename "$status") / $config / $agent: driver says '$driver'"
        fi
      else
        assert_eq "$checker" "$driver" "R agreement: $(basename "$status") / $config / $agent"
      fi
      checked=$((checked + 1))
    done
  done
done
ok "R1: agreement — driver recovery and checker give the same in-scope answer and effective mode ($checked fixtures)"

# R2: the typed read failing (non-zero dump, or output that is not a mapping).
assert_eq "in_scope required" "$(recover "$SF/pending_bound.yaml" devops 1 '')" "R2 dump exit non-zero, in scope"
assert_eq "in_scope required" "$(recover "$SF/pending_bound.yaml" devops 0 'not: [valid')" "R2 dump unparseable"
assert_eq "in_scope required" "$(recover "$SF/pending_bound.yaml" devops 0 '- a list')" "R2 dump not a mapping"
assert_eq "not_applicable" "$(recover "$SF/no_gates.yaml" devops 1 '')" "R2 dump failed, no pending bound gate"
ok "R2: a failed typed read is untrustworthy (required) only when a pending bound gate exists"

# R3: pins — the three concrete-role lists agree with agents/manifest.yaml.
manifest="$(ruby -ryaml -e 'puts YAML.safe_load(File.read(ARGV[0]))["agents"].keys.sort.join(" ")' "$ROOT_DIR/agents/manifest.yaml")"
checker_roles="$(ruby -e 'require ARGV[0]; puts AuthorizationDispatchCheck::CONCRETE_ROLES.sort.join(" ")' "$ROOT_DIR/scripts/authorization-dispatch-check.rb")"
driver_roles="$(grep -E '^CONCRETE_ROLES = %w\[' "$WORK/recover.rb" | sed -E 's/.*%w\[([^]]*)\].*/\1/' | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')"
assert_eq "$manifest" "$checker_roles" "R3 checker CONCRETE_ROLES == agents/manifest.yaml"
assert_eq "$manifest" "$driver_roles" "R3 driver CONCRETE_ROLES == agents/manifest.yaml"
ok "R3: concrete roles pinned to agents/manifest.yaml in both implementations"

# R4: lint — the lossy get/list helpers never touch this block in the driver,
# and the recovery reads the typed dump.
if grep -nE '(config_value|config_list_values|config_bool|config_list_contains)[^#]*authorization_dispatch' "$ROOT_DIR/run-agent.sh"; then
  fail "R4: run-agent.sh must not read authorization_dispatch through get/list helpers"
fi
grep -q 'ruby "$CONFIG_RESOLVER" dump "$OFFICE_DIR"' "$ROOT_DIR/run-agent.sh" || fail "R4: the recovery must read the typed dump"
if grep -nE '"(get|list|contains)"' "$ROOT_DIR/scripts/authorization-dispatch-check.rb"; then
  fail "R4: the checker must not use the resolver's get/list/contains"
fi
ok "R4: no lossy config helper on this path"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/authorization-dispatch.sh > /tmp/authz-t5.log 2>&1; tail -5 /tmp/authz-t5.log`
Expected: everything through D10 passes, then `[FAIL] D3 [def (] warn_only: the runner runs: expected '1' got '0'` (Task 4 fails every untrustworthy result closed, even under `warn_only`).

- [ ] **Step 3: Add the recovery function**

In `run-agent.sh`, insert immediately above the line `authorization_dispatch_check() {`:

```bash
# Driver-side scope recovery: prints `not_applicable` or `in_scope <mode>`.
# Inline Ruby, YAML stdlib only, sharing no code with the checker. The config is
# read through the resolver's typed `dump`, never config_value/config_list_values
# (`get` flattens lists, `list` coerces scalars: both fail open).
# tests/integration/authorization-dispatch.sh extracts the AUTHZ_SCOPE_RUBY
# heredoc and pins it to the checker (agreement test) and to agents/manifest.yaml.
authorization_dispatch_recover() {  # <status_file> <agent>
  local dump dump_rc=0
  dump="$(ruby "$CONFIG_RESOLVER" dump "$OFFICE_DIR" 2>/dev/null)" || dump_rc=$?
  AUTHZ_CONFIG_DUMP="$dump" ruby - "$1" "$2" "$dump_rc" <<'AUTHZ_SCOPE_RUBY' || echo "in_scope required"
require "yaml"
require "date"

status_path, agent, dump_rc = ARGV
CONCRETE_ROLES = %w[pm dev dev-2 reviewer debugger devops free-roam].freeze
MODES = %w[off warn_only required].freeze

config = nil
if dump_rc == "0"
  begin
    parsed = YAML.safe_load(ENV["AUTHZ_CONFIG_DUMP"].to_s, permitted_classes: [Date, Time], aliases: true)
    config = parsed if parsed.is_a?(Hash)
  rescue StandardError
    config = nil
  end
end

# Mode fallback: only a WHOLLY absent block means the default.
block_absent = false
block = nil
mode = nil
if config
  if config.key?("authorization_dispatch")
    block = config["authorization_dispatch"]
    mode = block["mode"] if block.is_a?(Hash) && block["mode"].is_a?(String) && MODES.include?(block["mode"])
  else
    block_absent = true
    mode = "warn_only"
  end
end

if mode == "off"
  puts "not_applicable"
  exit 0
end

gate_state = begin
  if File.exist?(status_path)
    status = YAML.safe_load(File.read(status_path), permitted_classes: [Date, Time], aliases: true)
    if !status.is_a?(Hash)
      :malformed
    elsif !status.key?("completion_gates")
      :none
    else
      gates = status["completion_gates"]
      if !(gates.is_a?(Hash) && gates.values.all? { |gate| gate.is_a?(Hash) })
        :malformed
      elsif gates.values.any? { |gate| gate["status"] == "pending" && gate.key?("requires_authorization") }
        :bound
      else
        :none
      end
    end
  else
    :none
  end
rescue StandardError
  :malformed
end

if gate_state == :none
  puts "not_applicable"
  exit 0
end

effective = mode || "required"
if gate_state == :malformed || mode.nil?
  puts "in_scope #{effective}"
  exit 0
end

roles = block_absent ? %w[devops] : block["roles"]
roles_trusted = (block_absent || block.key?("roles")) && roles.is_a?(Array) &&
                roles.all? { |role| role.is_a?(String) && CONCRETE_ROLES.include?(role) }
if roles_trusted && !roles.include?(agent)
  puts "not_applicable"
else
  puts "in_scope #{effective}"
end
AUTHZ_SCOPE_RUBY
}
```

- [ ] **Step 4: Replace the untrustworthy-result branch**

In `authorization_dispatch_check`, replace:

```bash
  if [[ -z "$AUTHZ_OUTCOME" ]]; then
    # Untrustworthy checker result. Until the driver can recover mode and scope
    # on its own, fail closed.
    AUTHZ_OUTCOME="check_error" AUTHZ_MODE="required" AUTHZ_ACTIONS=""
    echo "Authorization check could not be completed (checker exit $rc); recorded as check_error, effective mode $AUTHZ_MODE." >&2
    [[ -s "$err" ]] && cat "$err" >&2
  fi
```

with:

```bash
  if [[ -z "$AUTHZ_OUTCOME" ]]; then
    local scope
    scope="$(authorization_dispatch_recover "$STATUS_FILE" "$AGENT")"
    if [[ "$scope" == "not_applicable" ]]; then
      AUTHZ_OUTCOME="not_applicable"
    else
      AUTHZ_OUTCOME="check_error" AUTHZ_MODE="${scope#in_scope }" AUTHZ_ACTIONS=""
      [[ "$AUTHZ_MODE" == "warn_only" || "$AUTHZ_MODE" == "required" ]] || AUTHZ_MODE="required"
      echo "Authorization check could not be completed (checker exit $rc); recorded as check_error, effective mode $AUTHZ_MODE." >&2
      [[ -s "$err" ]] && cat "$err" >&2
    fi
  fi
```

Check: `bash -n run-agent.sh` prints nothing.

- [ ] **Step 5: Run it to verify it passes**

Run: `bash tests/integration/authorization-dispatch.sh > /tmp/authz-t5.log 2>&1; tail -20 /tmp/authz-t5.log`
Expected: `ok: D3` … `ok: D8b`, `ok: R1 … (810 fixtures)`, `ok: R2`, `ok: R3`, `ok: R4`, `[PASS]`.

- [ ] **Step 6: Commit**

```bash
git add run-agent.sh tests/integration/authorization-dispatch.sh
git commit -m "feat(authz): recover check_error scope and mode without the checker (#28 1B.2)

Inline Ruby (YAML stdlib) reads the resolver's typed dump and status.yaml:
off and out-of-scope dispatches stay silent, anything not shown out of scope
is a check_error under the fallback mode (untrustworthy mode -> required).
Agreement test pins it to the checker over 810 fixtures.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation and full regression

**Files:**
- Modify: `docs/authorization-ledger.md`
- Modify: `docs/policy-preflight.md`
- Modify: `docs/task-transition-contract.md`

**Interfaces:**
- Consumes: the behavior of Tasks 1–5. No code changes.

- [ ] **Step 1: Update `docs/authorization-ledger.md`**

(a) In the title line, change `# Authorization Ledger & Completion Binding (Phase 1B.1)` to `# Authorization Ledger, Completion Binding & Dispatch Check (Phase 1B.1–1B.2)`.

(b) In "What it is — and is not", replace the sentence `There is no dispatch-time or action-time enforcement (a possible Phase 1B.2).` with:

```markdown
Phase 1B.2 adds a dispatch-time check (below): the driver records, and in `required` mode refuses, dispatches of configured roles that lack a currently valid grant. There is still no action-time enforcement.
```

(c) In "Documented limits", replace `- No action-time enforcement: nothing here prevents the action itself.` with `- No action-time enforcement: nothing here prevents the action itself. The 1B.2 dispatch check gates only dispatches the Office performs (see below).`

(d) Insert this section immediately before `## Documented limits`:

```markdown
## Dispatch-time authorization check (Phase 1B.2)

Design: [`docs/superpowers/specs/2026-10-01-completion-gates-1b2-dispatch-authorization-design.md`](superpowers/specs/2026-10-01-completion-gates-1b2-dispatch-authorization-design.md).

When `run-agent.sh` dispatches a role listed in `authorization_dispatch.roles` (default `[devops]`) for a task that has a completion gate that is `pending` **and** carries `requires_authorization`, it checks that the ledger holds a grant of exactly that action that is valid **now** (current time, current high-water id; the validity rule above). The check is inferred from state the Office already holds, so a caller cannot skip it by not declaring an action. It is a check on dispatches the Office performs, **not** a sandbox: it does not constrain what the dispatched role does, an operator working by hand, a role outside `roles`, or a task without a pending bound gate.

| Mode (`office.config.yaml`) | `authorized` | `missing_authorization` | `config_error` | `check_error` |
|---|---|---|---|---|
| `"off"` | — | — | — | — |
| `warn_only` (shipped) | log | log + warn, proceed | log + warn, proceed | log + warn, proceed |
| `required` | log | log, **refuse** | log, **refuse** | log, **refuse** |

- **Where:** immediately before `record_run_start`, i.e. after the human-decision reroute, the `auto` umbrella and every routing / dependency / loop / budget guard, but before the run record, the ownership lease and the input-integrity snapshot. A refusal leaves no run record and no lease.
- **Evidence:** every applicable attempt appends one `authorization_dispatch_check` event to `meta.yaml` (`details: task=… mode=… outcome=… actions=…`, `agent` = the dispatched role). The events carry **no `run_id`**: they are **admission-attempt** evidence. Steps after the check (`ownership_acquire`, the integrity snapshot) can still stop the attempt, so an event does not prove the runner started; correlate with `ownership_acquired` / run records for that. The event write is guarded: if it fails, `warn_only` warns on stderr and proceeds, `required` refuses.
- **Configuration:** only a **wholly absent** `authorization_dispatch` block means the defaults (`warn_only`, `[devops]`). A present block with `mode` missing, `null`, not a string, or not `off`/`warn_only`/`required` is a `config_error` under effective mode `required`. Under `warn_only`/`required`, `roles` missing or not a list of concrete roles from `agents/manifest.yaml` is a `config_error` under that mode. Write `"off"` **quoted**: YAML reads an unquoted `off` (and `no`, `false`) as a boolean, which is not a string and therefore fails closed. The whole block is in `PROTECTED_PATHS`: a gitignored local overlay or a profile cannot change it, so switching to `required` is a reviewed change to the tracked `office.config.yaml`.
- **When the checker cannot answer** (crash, load error, usage error, unexpected exit, missing or inconsistent output), the driver records `check_error` and decides mode and scope **itself**, from the resolver's typed `dump` of the merged config and `status.yaml`, without the checker. Out-of-scope dispatches (no pending bound gate, a role outside a trustworthy `roles`, `"off"`) stay silent; anything it cannot show out of scope is in scope. The driver never reads this block through `config_value` / `config_list_values`, which flatten lists and coerce scalars.
- **Reading the evidence before `required`:** count `authorization_dispatch_check` events by `outcome`. The denominator is admission attempts, not executed dispatches. Unexplained `check_error` events, or event-write warnings on stderr, mean the dataset is incomplete.
- **What `required` proves:** a valid grant existed at admission. The task lock is not held through the runner, so a revoke recorded afterwards does not stop an admitted dispatch (TOCTOU). One grant covers every dispatch until it expires or is revoked, and the action is inferred, so a dispatch that does not perform it is still checked.

Checker CLI: `ruby scripts/authorization-dispatch-check.rb decide <TASK_ID> --role <ROLE>` prints `outcome=<o> mode=<m> actions=<a,b>` and exits `0` (proceed), `14` (refuse), `2` (usage) or `3` (task state cannot be judged; the driver treats every exit other than a consistent `0`/`14` as `check_error`). Rollback: a revert, or `mode: "off"`; events already written stay valid `meta.yaml` events.
```

- [ ] **Step 2: Add a pointer to `docs/policy-preflight.md`**

At the end of the "Known boundary: the gate is armed by its caller" section (immediately before `## Scope`), add the paragraph:

```markdown
The dispatch-time authorization check of #28 Phase 1B.2 is the opposite shape: it is **not** armed by its caller. It is inferred from a task's pending authorization-bound completion gates, runs after the human-decision reroute and every dispatch guard, and is configured by the protected `authorization_dispatch` block. See [`authorization-ledger.md`](authorization-ledger.md#dispatch-time-authorization-check-phase-1b2).
```

- [ ] **Step 3: Update `docs/task-transition-contract.md`**

Immediately after the bullet that starts with `` - `authorization.yaml` (issue #28 Phase 1B.1, optional) ``, add:

```markdown
- Dispatch-time authorization check (issue #28 Phase 1B.2) — not a status field: immediately before `record_run_start`, `run-agent.sh` checks a configured role's dispatch against the pending bound gates and the ledger, and appends one `authorization_dispatch_check` event (no `run_id`) to `meta.yaml` per applicable admission attempt. It never writes `status.yaml`. `warn_only` (shipped) proceeds; `required` refuses before any run record or lease exists. See [`authorization-ledger.md`](authorization-ledger.md#dispatch-time-authorization-check-phase-1b2).
```

- [ ] **Step 4: Full regression**

Run every integration suite and record each exit code (run them in the background and collect the log; the new suite alone takes ~6 minutes):

```bash
for t in tests/integration/*.sh; do rc=0; bash "$t" > "/tmp/reg-$(basename "$t").log" 2>&1 || rc=$?; echo "$rc $t"; done | tee /tmp/reg-summary.txt
```

Expected: every suite exits 0. Compare against `main` for any non-zero: run the same suite on a clean `git worktree add --detach /tmp/reg-main origin/main` checkout; a suite that also fails there is pre-existing and must be reported, not fixed here. Known pre-existing noise on `main`: `state-machine-consistency.sh`, `idempotency-and-reentry.sh` and `task-ownership.sh` print `OFFICE_DIR: unbound variable` and still exit 0. `operator-commands.sh` exits 1 at "Scenario 1: intake preview" on unmodified `main` (`c2159fab`) too (seen while proving this plan); report it, do not fix it here. In the proof run every other suite exited 0 with all six tasks applied.

- [ ] **Step 5: Commit**

```bash
git add docs/authorization-ledger.md docs/policy-preflight.md docs/task-transition-contract.md
git commit -m "docs(authz): dispatch-time authorization check (#28 1B.2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
