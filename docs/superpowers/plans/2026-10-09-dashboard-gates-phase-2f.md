# Phase 2F Dashboard Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show completion gates and the human authority boundary in the dashboard: three new Action Center kinds and a Completion Gates card in Monitor, fed by the guard's own gate view.

**Architecture:** Five tasks, each building on the previous:
1. **`scripts/gate-view-json.rb`** (new, read-only, always exits 0) prints `CompletionGuard.gate_view` as JSON. Each gate also gets its CLI text as `detail`.
2. **`dashboard/server/src/services/gateView.ts`** runs the script with `execFile` and parses its output strictly. Every failure becomes an unreadable view. The shared types gain `GateEntry`, `GateView` and the three kinds.
3. **The Action Center:**
   - `reviewModel.ts` classifies `gates_unreadable` → `authorization_required` → `completion_held` right after `decision_pending`, for gated tasks only;
   - the route counts and sorts the new kinds;
   - `ReviewView.tsx` shows them;
   - the read-model doc and schema are updated.
4. **The run detail and Monitor card:** `RunScanner.getRunDetail` adds `gates`, and `GatesCard.tsx` renders it with the helpers in `gateDisplay.ts`.
5. **Docs, the full suite, and a real-browser check.**

**Tech Stack:**
- Ruby 2.6.10 stdlib;
- the dashboard server: TypeScript, Express, `node --test` through ts-node;
- the dashboard client: React, Vite, vitest;
- bash integration tests.

**Spec:** [`docs/superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md`](../specs/2026-10-08-dashboard-gates-phase-2f-design.md) (PR #51). Read it before any task; this plan argues from it.

**Base:** `main` at 8b945e4b (1A–1D, 2A–2E and the gate-writer UTF-8 fix #50 merged), plus the spec and plan commits from PR #51. Nothing else needs to merge first.

## Global Constraints

- **Ruby 2.6.10:** no endless method definitions, no `Hash#except`, no pattern matching, no numbered block params.
- **Locale.** Ruby run with `-e` or from stdin reads its source as US-ASCII when `LANG` is unset. Keep such snippets ASCII-only: the tests build the em dash with `[0x2014].pack("U")`. Patch scripts are run as files, which Ruby reads as UTF-8.
- **ts-node does not resolve the `@shared/*` alias at runtime.** Server code may import from `@shared/types` with `import type` only.
- **Bash tests:** never pipe into `grep -q` under `set -o pipefail`; read from a file or a here-string instead.
- **The gate rules stay in Ruby.**
  - The dashboard never re-derives resolved / waits_on / grant / passable. It renders `CompletionGuard.gate_view` through `scripts/gate-view-json.rb`.
  - Any failure to get the view is `readable: false`, never an empty all-clear.
- **Tasks without `completion_gates` are unchanged.**
  - They never spawn Ruby.
  - Their Action Center result and per-task JSON keep the same keys and values, with no `gates` key.
  - Existing tests pass unmodified.
- **Read-only.** The dashboard shows the grant command and never writes `status.yaml`, `authorization.yaml` or any run file.
- **Tests.** Every new test is seen failing before its implementation. Never weaken, skip or delete an existing test.
- **Commits.** Commits end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the conductor pushes.
- **Workspace.**
  - Work only in the implementation worktree `/Users/earth/Documents/GitHub/ai-dev-office/.claude/worktrees/issue-28-2f-impl` (branch `feat/issue-28-2f-dashboard-gates`). Use absolute paths.
  - Never touch the main checkout or another session's worktree.
  - Stage files by explicit path, never `git add -A`, because the `node_modules` symlinks below are untracked.
- **Dependencies.** The worktree has no `node_modules`. Before Task 2, link the main checkout's, after checking the lockfiles match:
  - `git diff --quiet 8b945e4b -- dashboard/package-lock.json dashboard/server/package-lock.json dashboard/client/package-lock.json`;
  - then `ln -s /Users/earth/Documents/GitHub/ai-dev-office/dashboard/node_modules dashboard/node_modules`, and the same for `dashboard/server` and `dashboard/client`.
- **Known pre-existing failure.** `dashboard/client/src/navigation.test.ts` "restores every current top-level section, including intake" fails on unmodified 8b945e4b. Every client run below therefore expects exactly that one failure; any other failure is a regression.

## Review Focus

1. **A grant recorded, or expiring, while the dashboard is open.** The next read must reflect it, because nothing is cached. Pinned in Task 3: "a grant recorded between two reads changes the kind: nothing is cached" (real writers, real script).
2. **An approved task whose gates have all resolved** must leave `completion_held`. Pinned in Task 3: "all gates resolved after an approval is no longer completion_held".
3. **Hand-written gates like TASK-EAR-385's** (pending, no `actor` / `updated_at`) must still read and render. Pinned in Task 1, G8.
4. **Many gated tasks read in one refresh** (parallel `execFile`) must all come back readable. Pinned in Task 3: "25 gated tasks read at once all come back readable".
5. **A narrow viewport (375 px):** the Action Center rows and the Monitor card stay readable, with no horizontal page scroll. Pinned in Task 5, Step 4 (browser).

## Decisions taken while proving this plan (raise them in the PR; none changes the design)

1. **`completion_held` wording.** Each open gate reads `<name>: <detail>`, joined with `; `. The spec's `<name> (<detail>)` nested parentheses with the CLI text, e.g. `smoke (can pass now (needs --ran-by …))`.
2. **The response-level counts change.**
   - `ReviewModelResponse.actionCounts` is a `Record<ActionKind, number>`, so it gains the three keys (0 when no task has gates).
   - The route's sort puts the gate kinds first, in classification order; the existing kinds keep their relative order.
   - The per-task JSON of a task without gates is unchanged, as the spec requires.
3. **Three more Action Center cards.** `ACTION_ORDER` lists the gate kinds first, so the summary grid always shows their cards, with a count of 0 when unused, like the existing kinds.
4. **Injection.** `ReviewModelService(runsDir, gateViews)` and `RunScanner(gateViews)` take an optional `GateViewService`, defaulting to the shared `globalGateViews`. Existing callers and tests are unchanged.
5. **`getRunDetail` test.** It follows the existing `runScanner.test.ts` pattern: a uniquely named task in the worktree's real `runs/`, removed in `finally`. `RunScanner` reads `config.runsDir` directly.
6. **Failure wording.** The problem text is one of:
   - `gate view unavailable: ruby exited <code>`;
   - `timed out after <ms> ms`;
   - `ruby not found`;
   - `output too large`;
   - `unexpected output (<reason>)`.

   A missing script surfaces as `ruby exited 1` (Ruby's LoadError).
7. **The browser check uses two launch entries**, one for the server and one for the client. `dashboard/scripts/dev.js` forwards client arguments without `--`, so `npm run dev -- --port N` starts Vite with `N` as its root. That is pre-existing and not fixed here.
8. **Proof.**
   - On 2026-10-08/09 every block here was applied, task by task, to a scratch worktree at 8b945e4b. Each "verify it fails" step failed as written, and each "passes" step passed.
   - The patch scripts were generated from that proof's diff (one exact, must-match-once replacement per hunk). Re-applying them to a fresh worktree at 8b945e4b reproduced the proof tree byte for byte. Every RED and GREEN step was checked again on the way.
   - That re-application caught one plan defect: adding the three kinds to `ActionKind` in Task 2 broke `tsc` until Task 3 updated its consumers. The union change moved to Task 3 (`2f-actionkind-patch.rb`).
   - **Mutations:** thirteen were each caught by the named suite:
     - the dash left in `detail`;
     - no rescue in the script;
     - a failure returned as an all-clear;
     - a grant flagged while `waitsOn` is non-empty;
     - a finished task flagged;
     - an unreadable ledger ignored;
     - a kind missing from the route priority (caught by `tsc`);
     - `getRunDetail` always loading;
     - any URL linked;
     - any grant value parsed;
     - a `gates` key on a gateless summary;
     - a cached gate view;
     - pending gates rejected.
   - **Regression:** on the proof tree: server `ℹ pass 152` (149 before the Review Focus tests were added, then 152 in the re-application), client `Tests  1 failed | 43 passed (44)` (the known `navigation.test.ts` case), and 53 of 55 integration suites. The two failures, `event-gateway.sh` M3 and `task-input-integrity.sh` T10, fail at the same assertions on unmodified 8b945e4b.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/gate-view-json.rb` (new) | `CompletionGuard.gate_view` + per-gate CLI `detail` as JSON; read-only; always exit 0 |
| `tests/integration/gate-view-json.sh` (new) | G1–G8: fields, CLI parity, ledger, unreadable, finished, garbage, read-only, hand-written gates |
| `dashboard/shared/types.ts` | `GateEntry`, `GateView`, optional `ReviewSummary.gates` / `RunDetail.gates` (Task 2); `ActionKind` + 3 kinds (Task 3) |
| `dashboard/server/src/services/gateView.ts` (new) | `GateViewService.load`, `parseGateView`, `hasCompletionGates`, `unreadableGateView`, `globalGateViews` |
| `dashboard/server/src/services/gateView.test.ts` (new) | parsing, the real script, every failure mode |
| `dashboard/server/src/services/reviewModel.ts` | `classifyGateAction`, sixth `buildReviewSummary` parameter, gate views per gated task |
| `dashboard/server/src/services/reviewModel.test.ts` | the three kinds, precedence, Review Focus 1, 2, 4 |
| `dashboard/server/src/routes/review.ts` | sort priority and `actionCounts` for the new kinds |
| `dashboard/client/src/views/ReviewView.tsx` | badges, filter cards, action brief |
| `docs/run-summary-read-model.md`, `schemas/run-summary.schema.yaml` | precedence list, `gates` field |
| `dashboard/server/src/services/runScanner.ts` / `.test.ts` | `RunDetail.gates` for gated tasks only |
| `dashboard/client/src/views/gateDisplay.ts` (new) + `dashboard/client/tests/gateDisplay.test.ts` (new) | `gateTone`, `safeRunUrl` |
| `dashboard/client/src/views/GatesCard.tsx` (new), `MonitorView.tsx`, `styles/globals.css` | the Monitor card |
| `docs/completion-gates.md`, `dashboard/README.md` | "Gates in the dashboard (Phase 2F)" |

---

### Task 1: The gate view as JSON (`scripts/gate-view-json.rb`)

**Files:**
- Create: `scripts/gate-view-json.rb`
- Test: `tests/integration/gate-view-json.sh` (new)

**Interfaces:**
- Consumes: `CompletionGuard.gate_view(status, task_dir)` (2D) and `GateStatusText.suffix(gate, finished_phase)` (`scripts/gate-status-text.rb`, 2D/2E).
- Produces: `ruby scripts/gate-view-json.rb <task_dir>` prints one JSON object with the keys `readable`, `problem`, `finished_phase`, `summary {total, resolved, passable, by_status}` and `gates[]`.
  - Each gate has `name`, `status`, `resolved`, `waits_on`, `requires_authorization`, `grant`, `requires_record`, `ran`, `passable`, `unresolved_reason` and `detail`.
  - The script always exits 0.

- [ ] **Step 1: Write the failing suite**

Create `tests/integration/gate-view-json.sh` with this content, then run `chmod +x tests/integration/gate-view-json.sh`:

````bash
#!/usr/bin/env bash
set -euo pipefail

# Issue #28 Phase 2F — the gate view as JSON, for the dashboard.
#
# scripts/gate-view-json.rb <task_dir> prints CompletionGuard.gate_view plus each
# gate's CLI text ("detail"), read-only, and always exits 0: a view it cannot
# build is readable=false with the problem, never an empty "all clear".
# Sections: G1 fields, G2 parity with the CLI text, G3 unreadable ledger,
# G4 unreadable view, G5 finished task, G6 garbage input, G7 read-only,
# G8 hand-written gates.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNS="$(mktemp -d)"
trap 'rm -rf "$RUNS"' EXIT
export AI_OFFICE_RUNS_DIR="$RUNS"
unset AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID AI_OFFICE_NOW
GATE="$ROOT/scripts/update-completion-gate.rb"
VIEW_JSON="$ROOT/scripts/gate-view-json.rb"
TEXT="$ROOT/scripts/gate-status-text.rb"

fail() { echo "[FAIL] $1"; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
# task <TASK_ID> [phase] — a minimal governed task.
task() {
  local dir="$RUNS/$1" phase="${2:-assigned}"
  mkdir -p "$dir"
  cat > "$dir/status.yaml" <<YAML
task_id: $1
phase: $phase
state: $phase
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-01'
history: []
YAML
  printf '# %s\n' "$1" > "$dir/task.md"
  echo "$dir"
}
gate() { ruby "$GATE" "$@"; }
# set_gate <status.yaml> <gate> <ruby hash literal> — hand-edit one gate record (stored-state cases).
set_gate() {
  ruby -ryaml -rdate -e 'p = ARGV[0]; s = YAML.safe_load(File.read(p), permitted_classes: [Date, Time])
    (s["completion_gates"] ||= {})[ARGV[1]] = eval(ARGV[2]); File.write(p, YAML.dump(s))' "$1" "$2" "$3"
}
# run_json <dir> — runs the script; fails unless it exits 0 with one JSON object on stdout.
run_json() {
  local rc=0
  ruby "$VIEW_JSON" "$1" >"$RUNS/out.json" 2>"$RUNS/err.txt" || rc=$?
  assert_eq "$rc" "0" "exit code for $1 ($(cat "$RUNS/err.txt"))"
  ruby -rjson -e 'v = JSON.parse(File.read(ARGV[0])); exit(v.is_a?(Hash) ? 0 : 1)' "$RUNS/out.json" || fail "not a JSON object for $1: $(cat "$RUNS/out.json")"
}
# jv <dir> <ruby expression over j (the JSON) and g.(name)> — prints the result (JSON for non-strings).
jv() {
  run_json "$1"
  ruby -rjson - "$RUNS/out.json" "$2" <<'RUBY'
j = JSON.parse(File.read(ARGV[0]))
g = ->(name) { j["gates"].find { |x| x["name"] == name } }
r = eval(ARGV[1])
puts(r.is_a?(String) ? r : JSON.generate(r))
RUBY
}
# parity <dir> — every gate's "  name: status — detail" equals the CLI line, in order.
parity() {
  run_json "$1"
  ruby -rjson -e 'j = JSON.parse(File.read(ARGV[0]))
    j["gates"].each { |x| puts "  #{x["name"]}: #{x["status"]}#{x["detail"].empty? ? "" : " #{[0x2014].pack("U")} #{x["detail"]}"}" }' "$RUNS/out.json" > "$RUNS/p-json.txt"
  ruby "$TEXT" "$1" | grep '^  ' > "$RUNS/p-cli.txt" || true
  diff -u "$RUNS/p-cli.txt" "$RUNS/p-json.txt" || fail "G2 parity for $1"
}
PASSED='"status" => "pass", "actor" => "x", "reason" => "hand", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []'

# --- G1: every field of the view, plus the CLI detail ---
D="$(task TASK-1501)"
gate TASK-1501 declare a --actor pm --reason a >/dev/null
gate TASK-1501 declare b --actor pm --reason b --after a >/dev/null
gate TASK-1501 declare c --actor pm --reason c --requires-authorization deploy_staging >/dev/null
gate TASK-1501 declare d --actor pm --reason d --requires-record >/dev/null
gate TASK-1501 declare e --actor pm --reason e >/dev/null
gate TASK-1501 pass e --actor dev-2 --reason merged --ran-by operator --ran-ref 05fae97f >/dev/null
set_gate "$D/status.yaml" f "{$PASSED, \"requires_record\" => true}"
gate TASK-1501 declare u --actor pm --reason u >/dev/null
gate TASK-1501 pass u --actor devops --reason deployed --ran-by operator --ran-url https://example.test/run/1 >/dev/null
assert_eq "$(jv "$D" 'j.keys.sort')" '["finished_phase","gates","problem","readable","summary"]' "G1 top-level keys"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem", "finished_phase")')" '[true,null,null]' "G1 readable"
assert_eq "$(jv "$D" 'j["gates"].map { |x| x["name"] }.join(",")')" "a,b,c,d,e,f,u" "G1 stored order"
assert_eq "$(jv "$D" 'g.("a").keys.sort')" '["detail","grant","name","passable","ran","requires_authorization","requires_record","resolved","status","unresolved_reason","waits_on"]' "G1 gate keys"
assert_eq "$(jv "$D" 'g.("a").values_at("status", "resolved", "passable", "waits_on", "detail")')" '["pending",false,true,[],"can pass now"]' "G1 passable"
assert_eq "$(jv "$D" 'g.("b").values_at("passable", "waits_on", "detail")')" '[false,["a (pending)"],"waits on a (pending)"]' "G1 waits on"
assert_eq "$(jv "$D" 'g.("c").values_at("requires_authorization", "grant", "passable", "detail")')" '["deploy_staging","missing",false,"waits for a deploy_staging grant"]' "G1 bound without a grant"
assert_eq "$(jv "$D" 'g.("d").values_at("requires_record", "detail")')" '[true,"can pass now (needs --ran-by and --ran-ref/--ran-url)"]' "G1 needs a record"
assert_eq "$(jv "$D" 'g.("e").values_at("resolved", "ran", "detail")')" '[true,{"by":"operator","ref":"05fae97f"},"ran: operator 05fae97f"]' "G1 recorded pass"
assert_eq "$(jv "$D" 'g.("f").values_at("resolved", "unresolved_reason", "detail")')" '[false,"missing ran record","NOT resolved: missing ran record"]' "G1 pass missing its record"
assert_eq "$(jv "$D" 'g.("u").values_at("ran", "detail")')" '[{"by":"operator","url":"https://example.test/run/1"},"ran: operator https://example.test/run/1"]' "G1 run url"
assert_eq "$(jv "$D" 'j["summary"]')" '{"total":7,"resolved":2,"passable":2,"by_status":{"pending":4,"pass":3}}' "G1 summary"

# --- G2: the detail is the CLI text, line for line ---
parity "$D"

# --- G3: an unreadable ledger is grant "unknown", and the view stays readable ---
D="$(task TASK-1503)"
gate TASK-1503 declare deploy --actor pm --reason d --requires-authorization deploy_staging >/dev/null
printf 'authorizations: [\n' > "$D/authorization.yaml"
assert_eq "$(jv "$D" '[j["readable"], g.("deploy")["grant"], g.("deploy")["detail"]]')" '[true,"unknown","waits for a deploy_staging grant (authorization ledger unreadable)"]' "G3 unreadable ledger"
parity "$D"

# --- G4: a view gate_view cannot build is readable=false, with no gates ---
D="$(task TASK-1504)"
printf 'completion_gates: oops\n' >> "$D/status.yaml"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem", "finished_phase", "gates", "summary")')" '[false,"completion_gates is not a map",null,[],{"total":0,"resolved":0,"passable":0,"by_status":{}}]' "G4 non-map gates"

# --- G5: a finished task: nothing is passable, and the detail says why ---
D="$(task TASK-1505 aborted)"
set_gate "$D/status.yaml" smoke '{"status" => "pending", "actor" => "pm", "reason" => "s", "updated_at" => "2026-10-08T01:00:00Z", "evidence_refs" => []}'
assert_eq "$(jv "$D" '[j["finished_phase"], g.("smoke")["passable"], g.("smoke")["detail"]]')" '["aborted",false,"task is aborted"]' "G5 finished task"
parity "$D"

# --- G6: garbage input still prints a readable=false object and exits 0 ---
assert_eq "$(jv "$RUNS/TASK-1599" 'j.values_at("readable", "problem", "gates")')" '[false,"gate view failed: Errno::ENOENT",[]]' "G6 missing task dir"
D="$(task TASK-1506)"
printf 'phase: [\n' > "$D/status.yaml"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem")')" '[false,"gate view failed: Psych::SyntaxError"]' "G6 unparseable status.yaml"
printf 'just a string\n' > "$D/status.yaml"
assert_eq "$(jv "$D" 'j.values_at("readable", "problem")')" '[false,"status.yaml is not a map"]' "G6 non-map status"
assert_eq "$(jv "$D" 'j.keys.sort')" '["finished_phase","gates","problem","readable","summary"]' "G6 keeps every top-level key"
# Non-ASCII text survives without a locale (the dashboard may spawn ruby with LANG unset).
D="$(task TASK-1507)"
gate TASK-1507 declare smoke --actor pm --reason "ทดสอบ" >/dev/null
gate TASK-1507 pass smoke --actor devops --reason "ผ่าน" --ran-by "ผู้ทดสอบ" --ran-ref abc >/dev/null
env -u LANG -u LC_ALL -u LC_CTYPE ruby "$VIEW_JSON" "$D" > "$RUNS/thai.json"
assert_eq "$(ruby -rjson -e 'j = JSON.parse(File.read(ARGV[0], encoding: "UTF-8")); print j["gates"][0]["ran"]["by"]' "$RUNS/thai.json")" "ผู้ทดสอบ" "G6 non-ASCII text with LANG unset"

# --- G8: hand-written gates (the TASK-EAR-385 shape: no actor, no updated_at) still read ---
D="$(task TASK-1508 in_review)"
set_gate "$D/status.yaml" persistence '{"status" => "pending", "reason" => "reviewer sign-off pending"}'
set_gate "$D/status.yaml" staging '{"status" => "pending", "reason" => "partial smoke"}'
assert_eq "$(jv "$D" '[j["readable"], j["gates"].map { |x| [x["name"], x["passable"], x["detail"]] }]')" '[true,[["persistence",true,"can pass now"],["staging",true,"can pass now"]]]' "G8 hand-written pending gates"
parity "$D"

# --- G7: read-only ---
D="$RUNS/TASK-1501"
before="$(find "$D" -type f -exec shasum {} + | sort)"
run_json "$D"
after="$(find "$D" -type f -exec shasum {} + | sort)"
assert_eq "$after" "$before" "G7 the task directory is unchanged"

echo "[PASS] gate-view-json: the gate view as JSON (#28 Phase 2F)"
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/integration/gate-view-json.sh`
Expected: FAIL at `G1 top-level keys`, with `No such file or directory -- …/scripts/gate-view-json.rb (LoadError)` in the message.

- [ ] **Step 3: Write the script**

Create `scripts/gate-view-json.rb`:

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

# Phase 2F (issue #28): the gate view as JSON, for the dashboard. Prints
# CompletionGuard.gate_view for one task, adding to each gate its CLI text
# ("detail", from GateStatusText.suffix), so the dashboard shows the same words
# as `run-agent.sh status` and the prompt's COMPLETION GATES block.
#
# Usage: ruby scripts/gate-view-json.rb <task_dir>
#
# Read-only, and always exits 0. A view that cannot be built prints
# readable=false with the problem and no gates, never an empty "all clear".

require "json"
require "yaml"
require "date"
require_relative "completion-guard"
require_relative "gate-status-text"

module GateViewJson
  module_function

  def unreadable(problem)
    {
      "readable" => false, "problem" => problem, "finished_phase" => nil,
      "summary" => { "total" => 0, "resolved" => 0, "passable" => 0, "by_status" => {} },
      "gates" => []
    }
  end

  def view(task_dir)
    status = YAML.safe_load(File.read(File.join(task_dir, "status.yaml")), permitted_classes: [Date, Time], aliases: true)
    view = CompletionGuard.gate_view(status, task_dir)
    return unreadable(view["problem"]) unless view["readable"]

    finished = view["finished_phase"]
    gates = view["gates"].map { |gate| gate.merge("detail" => GateStatusText.suffix(gate, finished).sub(/\A — /, "")) }
    { "readable" => true, "problem" => nil, "finished_phase" => finished, "summary" => view["summary"], "gates" => gates }
  end
end

if $PROGRAM_NAME == __FILE__
  output = begin
    JSON.generate(GateViewJson.view(ARGV[0].to_s))
  rescue StandardError => e
    JSON.generate(GateViewJson.unreadable("gate view failed: #{e.class}"))
  end
  puts output
  exit 0
end
```

- [ ] **Step 4: Run the suite, with and without a locale, plus the suite that owns the CLI text**

Run: `bash tests/integration/gate-view-json.sh && LANG=en_US.UTF-8 bash tests/integration/gate-view-json.sh && bash tests/integration/gate-status.sh`
Expected:
- `[PASS] gate-view-json: the gate view as JSON (#28 Phase 2F)`, twice;
- then the gate-status PASS line.

- [ ] **Step 5: Prove the parity check bites**

Temporarily delete `.sub(/\A — /, "")` from `scripts/gate-view-json.rb` and run `bash tests/integration/gate-view-json.sh`. Expected: FAIL at `G1 passable`. Restore the line and re-run the suite: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/gate-view-json.rb tests/integration/gate-view-json.sh
git commit -m "feat(office): gate view as JSON for the dashboard (#28 Phase 2F)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Types and the server gate view service

**Files:**
- Modify: `dashboard/shared/types.ts`
- Create: `dashboard/server/src/services/gateView.ts`
- Test: `dashboard/server/src/services/gateView.test.ts` (new)

**Interfaces:**
- Consumes: `scripts/gate-view-json.rb` (Task 1), `config.aiOfficeRoot` (`dashboard/server/src/config.ts`).
- Produces:
  - Types: `interface GateEntry`; `interface GateView { readable; problem; finishedPhase; summary {total, resolved, passable, byStatus}; gates }`; `ReviewSummary.gates?: { readable; total; resolved; passable }`; `RunDetail.gates?: GateView`.
  - Functions: `hasCompletionGates(statusData: Record<string, unknown>): boolean`, `unreadableGateView(problem: string): GateView` and `parseGateView(stdout: string): GateView` (throws on any undocumented shape).
  - The service: `class GateViewService { constructor(scriptPath = <aiOfficeRoot>/scripts/gate-view-json.rb, timeoutMs = 5_000); load(taskDir: string): Promise<GateView> }`. `load` never rejects.
  - `const globalGateViews: GateViewService`.

- [ ] **Step 1: Link the dependencies**

From the worktree root:

```bash
git diff --quiet 8b945e4b -- dashboard/package-lock.json dashboard/server/package-lock.json dashboard/client/package-lock.json && echo lockfiles-match
for d in dashboard dashboard/server dashboard/client; do ln -s "/Users/earth/Documents/GitHub/ai-dev-office/$d/node_modules" "$d/node_modules"; done
```

Expected: `lockfiles-match`. If it does not print, stop and run `npm ci` in each of the three directories instead of linking.

- [ ] **Step 2: Write the failing test**

Create `dashboard/server/src/services/gateView.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { GateViewService, hasCompletionGates, parseGateView } from './gateView';

const OFFICE_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb');

const GATE = {
  name: 'deploy', status: 'pending', resolved: false, waits_on: [], requires_authorization: 'deploy_staging',
  grant: 'missing', requires_record: false, ran: null, passable: false, unresolved_reason: null,
  detail: 'waits for a deploy_staging grant',
};
const VIEW = {
  readable: true, problem: null, finished_phase: null,
  summary: { total: 1, resolved: 0, passable: 0, by_status: { pending: 1 } },
  gates: [GATE],
};

async function taskDir(status: Record<string, unknown>): Promise<string> {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-view-')), 'TASK-001');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.yaml'), yaml.dump(status));
  return dir;
}

async function stubScript(body: string): Promise<string> {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-view-stub-')), 'stub.rb');
  await fs.writeFile(file, body);
  return file;
}

test('parseGateView maps the script JSON to the camelCase GateView', () => {
  const view = parseGateView(JSON.stringify(VIEW));
  assert.deepEqual(view, {
    readable: true, problem: null, finishedPhase: null,
    summary: { total: 1, resolved: 0, passable: 0, byStatus: { pending: 1 } },
    gates: [{
      name: 'deploy', status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: 'deploy_staging',
      grant: 'missing', requiresRecord: false, ran: null, passable: false, unresolvedReason: null,
      detail: 'waits for a deploy_staging grant',
    }],
  });
});

test('parseGateView rejects a wrong shape instead of guessing', () => {
  const bad: unknown[] = [
    { ...VIEW, readable: 'yes' },
    { ...VIEW, gates: undefined },
    { ...VIEW, summary: { total: 1, resolved: 0, by_status: {} } },
    { ...VIEW, gates: [{ ...GATE, grant: 'maybe' }] },
    { ...VIEW, gates: [{ ...GATE, waits_on: 'a' }] },
    { ...VIEW, gates: [{ ...GATE, ran: { by: 1 } }] },
    { ...VIEW, gates: [{ ...GATE, detail: undefined }] },
    [VIEW],
  ];
  for (const value of bad) {
    assert.throws(() => parseGateView(JSON.stringify(value)), Error, JSON.stringify(value));
  }
  assert.throws(() => parseGateView('not json'));
});

test('hasCompletionGates is true for any completion_gates value, so a broken one is still reported', () => {
  assert.equal(hasCompletionGates({ phase: 'assigned' }), false);
  assert.equal(hasCompletionGates({ completion_gates: {} }), true);
  assert.equal(hasCompletionGates({ completion_gates: 'oops' }), true);
  assert.equal(hasCompletionGates({ completion_gates: null }), true);
});

test('load runs the real script and returns the CLI text per gate', async () => {
  const dir = await taskDir({
    task_id: 'TASK-001', phase: 'assigned',
    completion_gates: { smoke: { status: 'pending', actor: 'pm', reason: 's', updated_at: '2026-10-08T01:00:00Z' } },
  });
  const view = await new GateViewService(SCRIPT).load(dir);
  assert.equal(view.readable, true, view.problem ?? '');
  assert.deepEqual(view.summary, { total: 1, resolved: 0, passable: 1, byStatus: { pending: 1 } });
  assert.equal(view.gates[0].name, 'smoke');
  assert.equal(view.gates[0].passable, true);
  assert.equal(view.gates[0].detail, 'can pass now');
});

test('load passes through a view the script reports as unreadable', async () => {
  const dir = await taskDir({ task_id: 'TASK-001', phase: 'assigned', completion_gates: 'oops' });
  const view = await new GateViewService(SCRIPT).load(dir);
  assert.equal(view.readable, false);
  assert.equal(view.problem, 'completion_gates is not a map');
  assert.deepEqual(view.gates, []);
});

test('load fails closed: every failure is an unreadable view, never a rejection or an empty all-clear', async () => {
  const dir = await taskDir({ task_id: 'TASK-001', phase: 'assigned', completion_gates: {} });
  const cases: Array<[string, GateViewService, RegExp]> = [
    ['missing script', new GateViewService(path.join(os.tmpdir(), 'no-such-gate-view.rb')), /^gate view unavailable: ruby exited 1$/],
    ['non-JSON output', new GateViewService(await stubScript('puts "not json"\n')), /^gate view unavailable: unexpected output/],
    ['wrong shape', new GateViewService(await stubScript('puts \'{"readable":true}\'\n')), /^gate view unavailable: unexpected output/],
    ['non-zero exit', new GateViewService(await stubScript('exit 1\n')), /^gate view unavailable: ruby exited 1$/],
    ['timeout', new GateViewService(await stubScript('sleep 5\n'), 200), /^gate view unavailable: timed out after 200 ms$/],
  ];
  for (const [label, service, problem] of cases) {
    const view = await service.load(dir);
    assert.equal(view.readable, false, label);
    assert.match(view.problem ?? '', problem, label);
    assert.deepEqual(view.gates, [], label);
    assert.deepEqual(view.summary, { total: 0, resolved: 0, passable: 0, byStatus: {} }, label);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/services/gateView.test.ts`
Expected: FAIL with `error TS2307: Cannot find module './gateView'`.

- [ ] **Step 4: Add the types and the service**

Save as `2f-types-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2f-types-patch.rb dashboard/shared/types.ts`:

```ruby
# encoding: utf-8
# Phase 2F: gate types (GateEntry, GateView) and the optional gates fields.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
  | 'workflow_exception'
  | 'artifact_drift';

/**
 * Read-only Review read model. Every field is a projection of a contracted
 * producer field — the dashboard renders these, it never infers them from prose.
OLD
  | 'workflow_exception'
  | 'artifact_drift';

/**
 * Issue #28 Phase 2F: one completion gate as CompletionGuard.gate_view derives it
 * (scripts/gate-view-json.rb). The dashboard renders it; it never re-derives it.
 */
export interface GateEntry {
  name: string;
  /** As stored: pending | pass | na. */
  status: string;
  /** The done guard's rule (bound gates need a valid grant; records when required). */
  resolved: boolean;
  /** Unresolved gates named in `after`, with their state, e.g. "a (pending)". */
  waitsOn: string[];
  requiresAuthorization: string | null;
  /** Pending bound gates only; unknown = the authorization ledger cannot be read. */
  grant: 'available' | 'missing' | 'unknown' | null;
  requiresRecord: boolean;
  /** The 2C run record of a pass gate (by, ref, url); null otherwise. */
  ran: Record<string, string> | null;
  /** Can pass now: pending, nothing to wait on, grant available when bound, task not finished. */
  passable: boolean;
  unresolvedReason: string | null;
  /** The CLI text after "name: status — "; "" when the CLI adds nothing. */
  detail: string;
}

/** Issue #28 Phase 2F: a task's gates. readable=false means the state cannot be trusted. */
export interface GateView {
  readable: boolean;
  problem: string | null;
  finishedPhase: string | null;
  summary: { total: number; resolved: number; passable: number; byStatus: Record<string, number> };
  gates: GateEntry[];
}

/**
 * Read-only Review read model. Every field is a projection of a contracted
 * producer field — the dashboard renders these, it never infers them from prose.
NEW

rep!(s, <<'OLD', <<'NEW')
  riskLevel: RiskLevel;
  /** Provenance: latest entry in decision.yaml `decisions[]` (human input); null if none. */
  latestDecision: DecisionRecord | null;
}

export interface ReviewModelResponse {
OLD
  riskLevel: RiskLevel;
  /** Provenance: latest entry in decision.yaml `decisions[]` (human input); null if none. */
  latestDecision: DecisionRecord | null;
  /** Phase 2F: gate counts; absent for a task without status.yaml `completion_gates`. */
  gates?: { readable: boolean; total: number; resolved: number; passable: number };
}

export interface ReviewModelResponse {
NEW

rep!(s, <<'OLD', <<'NEW')
  artifacts: RunArtifact[];
  timeline: AgentTimelineEvent[];
  reviewIssues?: ReviewIssue[];
}

export interface RunFileResponse {
OLD
  artifacts: RunArtifact[];
  timeline: AgentTimelineEvent[];
  reviewIssues?: ReviewIssue[];
  /** Phase 2F: absent for a task without status.yaml `completion_gates`. */
  gates?: GateView;
}

export interface RunFileResponse {
NEW
File.write(path, s)
```

Create `dashboard/server/src/services/gateView.ts`:

```ts
import { execFile } from 'node:child_process';
import path from 'path';
import { promisify } from 'node:util';
import { config } from '../config';
import type { GateEntry, GateView } from '@shared/types';

const execFileAsync = promisify(execFile);
const GRANTS: ReadonlyArray<GateEntry['grant']> = ['available', 'missing', 'unknown', null];

/**
 * Issue #28 Phase 2F: completion gates for the dashboard. The gate rules stay in
 * Ruby (CompletionGuard.gate_view, via scripts/gate-view-json.rb); this only runs
 * the script and checks its output. A drifting TypeScript copy of a safety rule
 * would be worse than a conservative signal (see reviewModel.ts deriveRiskLevel).
 */

/** True when status.yaml has the key at all: a broken value must still be reported. */
export function hasCompletionGates(statusData: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(statusData, 'completion_gates');
}

export function unreadableGateView(problem: string): GateView {
  return {
    readable: false,
    problem,
    finishedPhase: null,
    summary: { total: 0, resolved: 0, passable: 0, byStatus: {} },
    gates: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} is not an object`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} is not a boolean`);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} is not a number`);
  return value;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is not a string`);
  return value;
}

function strOrNull(value: unknown, field: string): string | null {
  return value === null ? null : str(value, field);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} is not a list`);
  return value.map((item, i) => str(item, `${field}[${i}]`));
}

function stringMap(value: unknown, field: string): Record<string, string> {
  const source = record(value, field);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, str(item, `${field}.${key}`)]));
}

function parseGateEntry(value: unknown, i: number): GateEntry {
  const gate = record(value, `gates[${i}]`);
  const field = (name: string) => `gates[${i}].${name}`;
  const grant = gate.grant as GateEntry['grant'];
  if (!GRANTS.includes(grant)) throw new Error(`${field('grant')} is not a known grant state`);
  return {
    name: str(gate.name, field('name')),
    status: str(gate.status, field('status')),
    resolved: bool(gate.resolved, field('resolved')),
    waitsOn: stringList(gate.waits_on, field('waits_on')),
    requiresAuthorization: strOrNull(gate.requires_authorization, field('requires_authorization')),
    grant,
    requiresRecord: bool(gate.requires_record, field('requires_record')),
    ran: gate.ran === null ? null : stringMap(gate.ran, field('ran')),
    passable: bool(gate.passable, field('passable')),
    unresolvedReason: strOrNull(gate.unresolved_reason, field('unresolved_reason')),
    detail: str(gate.detail, field('detail')),
  };
}

/** Parses scripts/gate-view-json.rb output; throws on any shape it does not document. */
export function parseGateView(stdout: string): GateView {
  const data = record(JSON.parse(stdout), 'output');
  const summary = record(data.summary, 'summary');
  const byStatus = record(summary.by_status, 'summary.by_status');
  if (!Array.isArray(data.gates)) throw new Error('gates is not a list');
  return {
    readable: bool(data.readable, 'readable'),
    problem: strOrNull(data.problem, 'problem'),
    finishedPhase: strOrNull(data.finished_phase, 'finished_phase'),
    summary: {
      total: num(summary.total, 'summary.total'),
      resolved: num(summary.resolved, 'summary.resolved'),
      passable: num(summary.passable, 'summary.passable'),
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([key, count]) => [key, num(count, `summary.by_status.${key}`)])),
    },
    gates: data.gates.map(parseGateEntry),
  };
}

function failureReason(error: unknown, timeoutMs: number): string {
  const e = error as { code?: unknown; killed?: boolean; signal?: string | null };
  if (e.killed || e.signal === 'SIGTERM') return `timed out after ${timeoutMs} ms`;
  if (e.code === 'ENOENT') return 'ruby not found';
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output too large';
  if (typeof e.code === 'number') return `ruby exited ${e.code}`;
  return 'ruby failed';
}

export class GateViewService {
  constructor(
    private readonly scriptPath: string = path.join(config.aiOfficeRoot, 'scripts', 'gate-view-json.rb'),
    private readonly timeoutMs: number = 5_000,
  ) {}

  /** Never rejects: any failure is an unreadable view, never an empty all-clear. */
  async load(taskDir: string): Promise<GateView> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('ruby', [this.scriptPath, taskDir], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: this.timeoutMs,
      }));
    } catch (error) {
      return unreadableGateView(`gate view unavailable: ${failureReason(error, this.timeoutMs)}`);
    }
    try {
      return parseGateView(stdout);
    } catch (error) {
      return unreadableGateView(`gate view unavailable: unexpected output (${error instanceof Error ? error.message : 'parse error'})`);
    }
  }
}

export const globalGateViews = new GateViewService();
```

- [ ] **Step 5: Run the test and type-check both packages**

Run: `cd dashboard/server && node --require ts-node/register --test src/services/gateView.test.ts && npx tsc --noEmit -p . && cd ../client && npx tsc --noEmit -p .`
Expected: `ℹ pass 6`, `ℹ fail 0`, and both `tsc` runs print nothing (exit 0). The timeout case takes about 0.2 s.

- [ ] **Step 6: Commit**

```bash
git add dashboard/shared/types.ts dashboard/server/src/services/gateView.ts dashboard/server/src/services/gateView.test.ts
git commit -m "feat(dashboard): gate view service and types (#28 Phase 2F)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Gate kinds in the Action Center

**Files:**
- Modify: `dashboard/server/src/services/reviewModel.ts`, `dashboard/server/src/routes/review.ts`, `dashboard/client/src/views/ReviewView.tsx`, `docs/run-summary-read-model.md`, `schemas/run-summary.schema.yaml`
- Test: `dashboard/server/src/services/reviewModel.test.ts`

**Interfaces:**
- Consumes: `GateView`, `GateEntry`, `GateViewService`, `globalGateViews`, `hasCompletionGates` (Task 2).
- Produces:
  - `type ActionKind` gains `'gates_unreadable' | 'authorization_required' | 'completion_held'`. This lands here, not in Task 2: `ReviewModelResponse.actionCounts` and `ReviewView`'s `ACTION_META` are `Record<ActionKind, …>`, so the union and its consumers must change together for `tsc` to stay clean;
  - `buildReviewSummary(taskId, statusData, reviewerData, debuggerData = null, latestDecision = null, gateView: GateView | null = null): ReviewSummary`;
  - `new ReviewModelService(runsDir = config.runsDir, gateViews: GateViewService = globalGateViews)`;
  - the three kinds, with the exact reasons and commands in the tests below.

- [ ] **Step 1: Write the failing tests**

This covers each kind, the precedence, and Review Focus 1, 2 and 4. Save as `2f-reviewmodel-test-patch.rb` in the scratchpad, then run `ruby <scratchpad>/2f-reviewmodel-test-patch.rb dashboard/server/src/services/reviewModel.test.ts`:

```ruby
# encoding: utf-8
# Phase 2F: Action Center gate tests.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { buildReviewSummary, ReviewModelService } from './reviewModel';

test('approved + done: not in queue, no attention, not needsReview', () => {
  const r = buildReviewSummary('TASK-001', { phase: 'done', updated_at: '2026-06-01' }, { review_verdict: 'approved' });
OLD
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { buildReviewSummary, ReviewModelService } from './reviewModel';
import { GateViewService } from './gateView';
import type { GateEntry, GateView } from '@shared/types';

test('approved + done: not in queue, no attention, not needsReview', () => {
  const r = buildReviewSummary('TASK-001', { phase: 'done', updated_at: '2026-06-01' }, { review_verdict: 'approved' });
NEW

rep!(s, <<'OLD', <<'NEW')
  const ids = summaries.map((s) => s.taskId).sort();
  assert.deepEqual(ids, ['TASK-001', 'TASK-PKG-002']); // loose "TASK*" dirs excluded
});
OLD
  const ids = summaries.map((s) => s.taskId).sort();
  assert.deepEqual(ids, ['TASK-001', 'TASK-PKG-002']); // loose "TASK*" dirs excluded
});

// --- Issue #28 Phase 2F: completion gates in the Action Center ---

type GateFixture = Partial<GateEntry> & { name: string };
function gateView(entries: GateFixture[], extra: Partial<GateView> = {}): GateView {
  const gates: GateEntry[] = entries.map((entry) => ({
    status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: null, grant: null,
    requiresRecord: false, ran: null, passable: true, unresolvedReason: null, detail: 'can pass now', ...entry,
  }));
  return {
    readable: true, problem: null, finishedPhase: null,
    summary: {
      total: gates.length,
      resolved: gates.filter((gate) => gate.resolved).length,
      passable: gates.filter((gate) => gate.passable).length,
      byStatus: {},
    },
    gates,
    ...extra,
  };
}
const BOUND_MISSING: GateFixture = {
  name: 'deploy', requiresAuthorization: 'deploy_staging', grant: 'missing', passable: false,
  detail: 'waits for a deploy_staging grant',
};

test('a bound gate that only waits for a grant is authorization_required, with the grant command', () => {
  const r = buildReviewSummary('TASK-EAR-1', { phase: 'assigned' }, null, null, null, gateView([BOUND_MISSING]));
  assert.equal(r.actionKind, 'authorization_required');
  assert.equal(r.requiresAction, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.actionReason, 'Gate deploy waits for a deploy_staging grant.');
  assert.equal(
    r.recommendedAction,
    'ruby scripts/record-authorization.rb TASK-EAR-1 grant --action deploy_staging --scope <scope> --actor <you> --via <channel> --reason "<why>"',
  );
  assert.deepEqual(r.gates, { readable: true, total: 1, resolved: 0, passable: 0 });
});

test('several gates waiting for grants are all named', () => {
  const r = buildReviewSummary('T', { phase: 'assigned' }, null, null, null, gateView([
    BOUND_MISSING,
    { ...BOUND_MISSING, name: 'backfill', requiresAuthorization: 'production_backfill' },
  ]));
  assert.equal(r.actionReason, 'Gate deploy waits for a deploy_staging grant; Gate backfill waits for a production_backfill grant.');
});

test('a bound gate still waiting on another gate is not flagged yet', () => {
  const r = buildReviewSummary('T', { phase: 'assigned' }, null, null, null, gateView([
    { name: 'verify' },
    { ...BOUND_MISSING, waitsOn: ['verify (pending)'] },
  ]));
  assert.equal(r.actionKind, null);
});

test('a finished task gets no gate kind', () => {
  const view = gateView([{ ...BOUND_MISSING, detail: 'task is done' }], { finishedPhase: 'done' });
  const r = buildReviewSummary('T', { phase: 'done' }, { review_verdict: 'approved' }, null, null, view);
  assert.equal(r.actionKind, null);
});

test('an unreadable gate view is gates_unreadable, with the problem', () => {
  const view = gateView([], { readable: false, problem: 'completion_gates is not a map' });
  const r = buildReviewSummary('TASK-9', { phase: 'assigned' }, null, null, null, view);
  assert.equal(r.actionKind, 'gates_unreadable');
  assert.equal(r.actionReason, 'Gate state cannot be read: completion_gates is not a map.');
  assert.equal(r.recommendedAction, 'Run ./run-agent.sh status TASK-9 and repair status.yaml / authorization.yaml through their writers.');
  assert.deepEqual(r.gates, { readable: false, total: 0, resolved: 0, passable: 0 });
});

test('an unreadable authorization ledger is gates_unreadable, whether the gate is pending or passed', () => {
  const pending = gateView([{ ...BOUND_MISSING, grant: 'unknown' }]);
  const passed = gateView([{ name: 'deploy', status: 'pass', passable: false, unresolvedReason: 'authorization ledger unreadable' }]);
  for (const view of [pending, passed]) {
    const r = buildReviewSummary('T', { phase: 'assigned' }, null, null, null, view);
    assert.equal(r.actionKind, 'gates_unreadable');
    assert.equal(r.actionReason, 'Gate state cannot be read: the authorization ledger cannot be read.');
  }
});

test('an approved review held by unresolved gates is completion_held, not awaiting_review', () => {
  const view = gateView([
    { name: 'verify', status: 'pass', resolved: true, passable: false, detail: '' },
    { name: 'smoke', detail: 'can pass now' },
    { name: 'publish', passable: false, waitsOn: ['smoke (pending)'], detail: 'waits on smoke (pending)' },
  ]);
  const r = buildReviewSummary('TASK-7', { phase: 'in_review' }, { review_verdict: 'approved' }, null, null, view);
  assert.equal(r.actionKind, 'completion_held');
  assert.equal(r.needsReview, false);
  assert.equal(r.inReviewQueue, true);
  assert.equal(r.actionReason, 'Review approved; the done guard holds the task until its gates resolve: smoke: can pass now; publish: waits on smoke (pending).');
  assert.equal(r.recommendedAction, 'Dispatch the role that owns the open gates; ./run-agent.sh status TASK-7 shows which can pass now.');
});

test('a review without an approval stays awaiting_review even with open gates', () => {
  const view = gateView([{ name: 'smoke' }]);
  assert.equal(buildReviewSummary('T', { phase: 'in_review' }, null, null, null, view).actionKind, 'awaiting_review');
  assert.equal(buildReviewSummary('T', { phase: 'review' }, { review_verdict: 'changes_requested' }, null, null, view).actionKind, 'awaiting_review');
});

test('gate kinds follow decision_pending, then unreadable, authorization, completion_held', () => {
  const decision = { decision: 'approve' as const, actor: 'alice', decidedAt: '2026-06-05T00:00:00Z' };
  const unreadable = gateView([], { readable: false, problem: 'x' });
  assert.equal(buildReviewSummary('T', { phase: 'in_review' }, null, null, decision, unreadable).actionKind, 'decision_pending');
  const ledgerAndGrant = gateView([{ ...BOUND_MISSING, grant: 'unknown' }, { ...BOUND_MISSING, name: 'other' }]);
  assert.equal(buildReviewSummary('T', { phase: 'assigned' }, null, null, null, ledgerAndGrant).actionKind, 'gates_unreadable');
  const approvedWithGrant = gateView([BOUND_MISSING]);
  assert.equal(buildReviewSummary('T', { phase: 'in_review' }, { review_verdict: 'approved' }, null, null, approvedWithGrant).actionKind, 'authorization_required');
  const blocked = gateView([BOUND_MISSING]);
  assert.equal(buildReviewSummary('T', { phase: 'blocked' }, null, null, null, blocked).actionKind, 'authorization_required');
});

test('without a gate view the summary has no gates key and the old classification', () => {
  const r = buildReviewSummary('T', { phase: 'in_review' }, { review_verdict: 'approved' });
  assert.equal(r.actionKind, 'awaiting_review');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'gates'), false);
});

test('getReviewSummaries loads a gate view only for tasks with completion_gates', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-gates-'));
  const statuses: Record<string, Record<string, unknown>> = {
    'TASK-001': { phase: 'assigned' },
    'TASK-002': { phase: 'assigned', completion_gates: { deploy: { status: 'pending' } } },
    'TASK-003': { phase: 'assigned', completion_gates: 'oops' },
  };
  for (const [taskId, status] of Object.entries(statuses)) {
    await fs.mkdir(path.join(runsDir, taskId), { recursive: true });
    await fs.writeFile(path.join(runsDir, taskId, 'status.yaml'), yaml.dump(status));
  }
  const loaded: string[] = [];
  const fake = { load: async (dir: string) => { loaded.push(path.basename(dir)); return gateView([BOUND_MISSING]); } };
  const summaries = await new ReviewModelService(runsDir, fake as unknown as GateViewService).getReviewSummaries();
  assert.deepEqual(loaded.sort(), ['TASK-002', 'TASK-003']);
  const byId = Object.fromEntries(summaries.map((s) => [s.taskId, s]));
  assert.equal(byId['TASK-001'].actionKind, null);
  assert.equal(Object.prototype.hasOwnProperty.call(byId['TASK-001'], 'gates'), false);
  assert.equal(byId['TASK-002'].actionKind, 'authorization_required');
});

test('all gates resolved after an approval is no longer completion_held', () => {
  const view = gateView([{ name: 'smoke', status: 'pass', resolved: true, passable: false, detail: '' }]);
  const r = buildReviewSummary('T', { phase: 'in_review' }, { review_verdict: 'approved' }, null, null, view);
  assert.equal(r.actionKind, 'awaiting_review');
  assert.deepEqual(r.gates, { readable: true, total: 1, resolved: 1, passable: 0 });
});

// Review Focus: the real script and the real writers, end to end.
const OFFICE_ROOT = path.resolve(__dirname, '../../../..');
const governedStatus = (taskId: string) => ({
  task_id: taskId, phase: 'assigned', state: 'assigned', iteration: 1, current_agent: 'dev', ready: true,
  blocked_on: [], waiting_for: [], assignment: { primary: 'dev', parallel: false }, updated_at: '2026-10-01', history: [],
});
function office(runsDir: string, script: string, ...args: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AI_OFFICE_RUNS_DIR: runsDir };
  delete env.AI_OFFICE_NOW;
  execFileSync('ruby', [path.join(OFFICE_ROOT, 'scripts', script), ...args], { env, stdio: 'pipe' });
}

test('a grant recorded between two reads changes the kind: nothing is cached', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-grant-'));
  await fs.mkdir(path.join(runsDir, 'TASK-001'));
  await fs.writeFile(path.join(runsDir, 'TASK-001', 'status.yaml'), yaml.dump(governedStatus('TASK-001')));
  office(runsDir, 'update-completion-gate.rb', 'TASK-001', 'declare', 'deploy', '--actor', 'pm', '--reason', 'd', '--requires-authorization', 'deploy_staging');
  const service = new ReviewModelService(runsDir, new GateViewService(path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb')));
  const before = (await service.getReviewSummaries())[0];
  assert.equal(before.actionKind, 'authorization_required', before.actionReason ?? '');
  office(runsDir, 'record-authorization.rb', 'TASK-001', 'grant', '--action', 'deploy_staging', '--scope', 'staging', '--actor', 'operator', '--via', 'chat', '--reason', 'ok');
  const after = (await service.getReviewSummaries())[0];
  assert.equal(after.actionKind, null);
  assert.deepEqual(after.gates, { readable: true, total: 1, resolved: 0, passable: 1 });
});

test('25 gated tasks read at once all come back readable', async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-many-'));
  const gates = { smoke: { status: 'pending', actor: 'pm', reason: 's', updated_at: '2026-10-08T01:00:00Z' } };
  for (let i = 1; i <= 25; i += 1) {
    const taskId = `TASK-${String(i).padStart(3, '0')}`;
    await fs.mkdir(path.join(runsDir, taskId));
    await fs.writeFile(path.join(runsDir, taskId, 'status.yaml'), yaml.dump({ ...governedStatus(taskId), completion_gates: gates }));
  }
  const service = new ReviewModelService(runsDir, new GateViewService(path.join(OFFICE_ROOT, 'scripts', 'gate-view-json.rb')));
  const summaries = await service.getReviewSummaries();
  assert.equal(summaries.length, 25);
  for (const summary of summaries) {
    assert.deepEqual(summary.gates, { readable: true, total: 1, resolved: 0, passable: 1 }, summary.taskId);
  }
});
NEW
File.write(path, s)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd dashboard/server && node --require ts-node/register --test src/services/reviewModel.test.ts`
Expected: FAIL with `error TS2554: Expected 3-5 arguments, but got 6.`

- [ ] **Step 3: Classify the gate kinds and show them**

Save each script in the scratchpad and run it on its file:
- `ruby <scratchpad>/2f-actionkind-patch.rb dashboard/shared/types.ts`
- `ruby <scratchpad>/2f-reviewmodel-patch.rb dashboard/server/src/services/reviewModel.ts`
- `ruby <scratchpad>/2f-review-route-patch.rb dashboard/server/src/routes/review.ts`
- `ruby <scratchpad>/2f-reviewview-patch.rb dashboard/client/src/views/ReviewView.tsx`

`2f-actionkind-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: the three Action Center gate kinds.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
  | 'awaiting_review'
  | 'decision_pending'
  | 'workflow_exception'
  | 'artifact_drift';

/**
 * Issue #28 Phase 2F: one completion gate as CompletionGuard.gate_view derives it
OLD
  | 'awaiting_review'
  | 'decision_pending'
  | 'workflow_exception'
  | 'artifact_drift'
  | 'gates_unreadable'
  | 'authorization_required'
  | 'completion_held';

/**
 * Issue #28 Phase 2F: one completion gate as CompletionGuard.gate_view derives it
NEW
File.write(path, s)
```

`2f-reviewmodel-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: gate kinds in classifyAction; gate views loaded per task.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
import { config } from '../config';
import { asObject } from './runScanner';
import type {
  ActionKind, ReviewSummary, RunPhase, ReviewVerdict, ConfidenceLevel, RiskLevel, IssueCounts, DecisionRecord,
} from '@shared/types';
import { DecisionStore } from './decisionStore';
import { TASK_ID_PATTERN } from '../pathSecurity';

// Exact enum membership — these mirror the producer schemas. We match by exact
OLD
import { config } from '../config';
import { asObject } from './runScanner';
import type {
  ActionKind, ReviewSummary, RunPhase, ReviewVerdict, ConfidenceLevel, RiskLevel, IssueCounts, DecisionRecord, GateView,
} from '@shared/types';
import { DecisionStore } from './decisionStore';
import { GateViewService, globalGateViews, hasCompletionGates } from './gateView';
import { TASK_ID_PATTERN } from '../pathSecurity';

// Exact enum membership — these mirror the producer schemas. We match by exact
NEW

rep!(s, <<'OLD', <<'NEW')
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function classifyAction(
  phase: RunPhase | null,
  rawPhase: unknown,
  verdict: ReviewVerdict | null,
  decisionPending: boolean,
): ActionClassification | null {
  if (decisionPending) {
    return {
OLD
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Issue #28 Phase 2F: the gate kinds, judged from CompletionGuard.gate_view
// (scripts/gate-view-json.rb), never re-derived here. null = no completion_gates.
function classifyGateAction(
  taskId: string,
  phase: RunPhase | null,
  verdict: ReviewVerdict | null,
  gateView: GateView | null,
): ActionClassification | null {
  if (gateView === null) return null;

  const ledgerUnreadable = gateView.gates.some(
    (gate) => gate.grant === 'unknown' || gate.unresolvedReason === 'authorization ledger unreadable',
  );
  if (!gateView.readable || ledgerUnreadable) {
    const problem = gateView.readable ? 'the authorization ledger cannot be read' : (gateView.problem ?? 'unknown problem');
    return {
      kind: 'gates_unreadable',
      reason: `Gate state cannot be read: ${problem}.`,
      recommendedAction: `Run ./run-agent.sh status ${taskId} and repair status.yaml / authorization.yaml through their writers.`,
    };
  }

  // The writer refuses every edit on a finished task, so nothing there needs a grant.
  const awaitingGrant = gateView.finishedPhase !== null ? [] : gateView.gates.filter(
    (gate) => gate.status === 'pending' && gate.requiresAuthorization !== null
      && gate.grant === 'missing' && gate.waitsOn.length === 0,
  );
  if (awaitingGrant.length > 0) {
    return {
      kind: 'authorization_required',
      reason: `${awaitingGrant.map((gate) => `Gate ${gate.name} waits for a ${gate.requiresAuthorization} grant`).join('; ')}.`,
      recommendedAction: `ruby scripts/record-authorization.rb ${taskId} grant --action ${awaitingGrant[0].requiresAuthorization} --scope <scope> --actor <you> --via <channel> --reason "<why>"`,
    };
  }

  const inReview = phase === 'review' || phase === 'in_review';
  if (inReview && verdict === 'approved' && gateView.summary.resolved < gateView.summary.total) {
    const open = gateView.gates
      .filter((gate) => !gate.resolved)
      .map((gate) => (gate.detail ? `${gate.name}: ${gate.detail}` : gate.name));
    return {
      kind: 'completion_held',
      reason: `Review approved; the done guard holds the task until its gates resolve: ${open.join('; ')}.`,
      recommendedAction: `Dispatch the role that owns the open gates; ./run-agent.sh status ${taskId} shows which can pass now.`,
    };
  }

  return null;
}

function classifyAction(
  taskId: string,
  phase: RunPhase | null,
  rawPhase: unknown,
  verdict: ReviewVerdict | null,
  decisionPending: boolean,
  gateView: GateView | null,
): ActionClassification | null {
  if (decisionPending) {
    return {
NEW

rep!(s, <<'OLD', <<'NEW')
    };
  }

  if (phase === 'review' || phase === 'in_review') {
    return {
      kind: 'awaiting_review',
OLD
    };
  }

  const gateAction = classifyGateAction(taskId, phase, verdict, gateView);
  if (gateAction) return gateAction;

  if (phase === 'review' || phase === 'in_review') {
    return {
      kind: 'awaiting_review',
NEW

rep!(s, <<'OLD', <<'NEW')
  reviewerData: Record<string, any> | null,
  debuggerData: Record<string, any> | null = null,
  latestDecision: DecisionRecord | null = null,
): ReviewSummary {
  const phase = normalizePhase(statusData.phase);
  const verdict = reviewerData ? normalizeVerdict(reviewerData.review_verdict) : null;
OLD
  reviewerData: Record<string, any> | null,
  debuggerData: Record<string, any> | null = null,
  latestDecision: DecisionRecord | null = null,
  gateView: GateView | null = null,
): ReviewSummary {
  const phase = normalizePhase(statusData.phase);
  const verdict = reviewerData ? normalizeVerdict(reviewerData.review_verdict) : null;
NEW

rep!(s, <<'OLD', <<'NEW')
  const statusDecisionAppliedAt = text(statusData.decision_applied_at);
  const decisionPending = latestDecision !== null
    && latestDecision.decidedAt !== statusDecisionAppliedAt;
  const action = classifyAction(phase, statusData.phase, verdict, decisionPending);

  const confidence = debuggerData
    ? normalizeConfidence(debuggerData?.diagnosis?.confidence)
OLD
  const statusDecisionAppliedAt = text(statusData.decision_applied_at);
  const decisionPending = latestDecision !== null
    && latestDecision.decidedAt !== statusDecisionAppliedAt;
  const action = classifyAction(taskId, phase, statusData.phase, verdict, decisionPending, gateView);

  const confidence = debuggerData
    ? normalizeConfidence(debuggerData?.diagnosis?.confidence)
NEW

rep!(s, <<'OLD', <<'NEW')
    issueCounts,
    riskLevel,
    latestDecision,
  };
}

OLD
    issueCounts,
    riskLevel,
    latestDecision,
    ...(gateView ? {
      gates: {
        readable: gateView.readable,
        total: gateView.summary.total,
        resolved: gateView.summary.resolved,
        passable: gateView.summary.passable,
      },
    } : {}),
  };
}

NEW

rep!(s, <<'OLD', <<'NEW')
export class ReviewModelService {
  private readonly decisionStore: DecisionStore;

  constructor(private readonly runsDir: string = config.runsDir) {
    // Bind the decision store to the same runsDir so injection stays consistent.
    this.decisionStore = new DecisionStore(runsDir);
  }
OLD
export class ReviewModelService {
  private readonly decisionStore: DecisionStore;

  constructor(
    private readonly runsDir: string = config.runsDir,
    private readonly gateViews: GateViewService = globalGateViews,
  ) {
    // Bind the decision store to the same runsDir so injection stays consistent.
    this.decisionStore = new DecisionStore(runsDir);
  }
NEW

rep!(s, <<'OLD', <<'NEW')
        const reviewerData = await readYamlObject(path.join(runPath, 'reviewer-output.yaml'));
        const debuggerData = await readYamlObject(path.join(runPath, 'debugger-output.yaml'));
        const latestDecision = await this.decisionStore.latest(taskId);
        return buildReviewSummary(taskId, statusData, reviewerData, debuggerData, latestDecision);
      }),
    );

OLD
        const reviewerData = await readYamlObject(path.join(runPath, 'reviewer-output.yaml'));
        const debuggerData = await readYamlObject(path.join(runPath, 'debugger-output.yaml'));
        const latestDecision = await this.decisionStore.latest(taskId);
        const gateView = hasCompletionGates(statusData) ? await this.gateViews.load(runPath) : null;
        return buildReviewSummary(taskId, statusData, reviewerData, debuggerData, latestDecision, gateView);
      }),
    );

NEW
File.write(path, s)
```

`2f-review-route-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: sort priority and counts for the gate kinds.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
router.get('/', async (_req, res) => {
  try {
    const reviews = await globalReviewModel.getReviewSummaries();
    const priority = {
      awaiting_review: 0,
      decision_pending: 1,
      workflow_exception: 2,
      artifact_drift: 3,
    } as const;

    // Action Center items float to the top in operator priority order.
OLD
router.get('/', async (_req, res) => {
  try {
    const reviews = await globalReviewModel.getReviewSummaries();
    // Phase 2F gate kinds first, in classification order; the existing kinds keep
    // their relative order.
    const priority = {
      gates_unreadable: 0,
      authorization_required: 1,
      completion_held: 2,
      awaiting_review: 3,
      decision_pending: 4,
      workflow_exception: 5,
      artifact_drift: 6,
    } as const;

    // Action Center items float to the top in operator priority order.
NEW

rep!(s, <<'OLD', <<'NEW')
      decision_pending: 0,
      workflow_exception: 0,
      artifact_drift: 0,
    };
    for (const review of reviews) {
      if (review.actionKind) actionCounts[review.actionKind] += 1;
OLD
      decision_pending: 0,
      workflow_exception: 0,
      artifact_drift: 0,
      gates_unreadable: 0,
      authorization_required: 0,
      completion_held: 0,
    };
    for (const review of reviews) {
      if (review.actionKind) actionCounts[review.actionKind] += 1;
NEW
File.write(path, s)
```

`2f-reviewview-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: badges, filter cards and brief for the gate kinds.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
type ActionFilter = ActionKind | 'all';

const ACTION_ORDER: ActionKind[] = [
  'awaiting_review',
  'decision_pending',
  'workflow_exception',
OLD
type ActionFilter = ActionKind | 'all';

const ACTION_ORDER: ActionKind[] = [
  'gates_unreadable',
  'authorization_required',
  'completion_held',
  'awaiting_review',
  'decision_pending',
  'workflow_exception',
NEW

rep!(s, <<'OLD', <<'NEW')
    description: 'Task state and review evidence disagree',
    color: '#a78bfa',
  },
};

function formatAge(value: string | null): string {
OLD
    description: 'Task state and review evidence disagree',
    color: '#a78bfa',
  },
  gates_unreadable: {
    label: 'Gate unreadable',
    description: 'Completion gate state cannot be trusted',
    color: '#f43f5e',
  },
  authorization_required: {
    label: 'Authorization required',
    description: 'A gate waits for a human grant',
    color: '#fb923c',
  },
  completion_held: {
    label: 'Completion held',
    description: 'Approved; open gates hold done',
    color: '#34d399',
  },
};

function formatAge(value: string | null): string {
NEW
File.write(path, s)
```

- [ ] **Step 4: Run the tests and type-check both packages**

Run: `cd dashboard/server && node --require ts-node/register --test src/services/reviewModel.test.ts && npx tsc --noEmit -p . && cd ../client && npx tsc --noEmit -p .`
Expected: `ℹ pass 35`, `ℹ fail 0`; both `tsc` runs print nothing. All 21 pre-existing reviewModel tests pass unmodified. `tsc` is what checks `review.ts`: no test imports the route.

- [ ] **Step 5: Update the read-model doc and schema**

Run `ruby <scratchpad>/2f-readmodel-doc-patch.rb docs/run-summary-read-model.md` and `ruby <scratchpad>/2f-schema-patch.rb schemas/run-summary.schema.yaml`.

`2f-readmodel-doc-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: read-model precedence and the gates field.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
| `riskLevel` (producer half) | `runs/<id>/reviewer-output.yaml` → `risk_level` | [reviewer-output.schema.yaml](../schemas/reviewer-output.schema.yaml) enum (high/medium/low) |
| `latestDecision` | latest entry in `runs/<id>/decision.yaml` → `decisions[]` (human input) | [decision.schema.yaml](../schemas/decision.schema.yaml) |
| `statusUpdatedAt` | `status.yaml` → `updated_at` | — |

Values that don't match the enum **exactly** are dropped to `null` — no
substring/fuzzy matching, no guessing. A typo or a future enum value never
OLD
| `riskLevel` (producer half) | `runs/<id>/reviewer-output.yaml` → `risk_level` | [reviewer-output.schema.yaml](../schemas/reviewer-output.schema.yaml) enum (high/medium/low) |
| `latestDecision` | latest entry in `runs/<id>/decision.yaml` → `decisions[]` (human input) | [decision.schema.yaml](../schemas/decision.schema.yaml) |
| `statusUpdatedAt` | `status.yaml` → `updated_at` | — |
| `gates` | `CompletionGuard.gate_view` over `status.yaml` → `completion_gates` (+ `authorization.yaml`), via `scripts/gate-view-json.rb`; absent without `completion_gates` | [completion-gates.md](completion-gates.md) |

Values that don't match the enum **exactly** are dropped to `null` — no
substring/fuzzy matching, no guessing. A typo or a future enum value never
NEW

rep!(s, <<'OLD', <<'NEW')
- `requiresAction` = `actionKind != null`
- `actionKind` uses this precedence:
  1. unapplied human decision → `decision_pending`
  2. `review | in_review` → `awaiting_review`
  3. terminal phase plus adverse historical verdict → `artifact_drift`
  4. blocked/escalated/validation/devops or off-contract phase → `workflow_exception`
  5. any other adverse verdict/phase mismatch → `artifact_drift`
- `riskLevel` = the **higher** of two contracted signals, never from prose:
  - change risk — `reviewer-output.yaml` `risk_level` (issue #12; the reviewer's
    deterministic classification of the paths it reviewed), and
OLD
- `requiresAction` = `actionKind != null`
- `actionKind` uses this precedence:
  1. unapplied human decision → `decision_pending`
  2. the gate view is unreadable, or the authorization ledger cannot be read → `gates_unreadable`
  3. a pending bound gate with nothing to wait on and no valid grant, on a
     task that is not `done`/`aborted` → `authorization_required`
  4. `review | in_review`, verdict `approved`, and unresolved gates → `completion_held`
  5. `review | in_review` → `awaiting_review`
  6. terminal phase plus adverse historical verdict → `artifact_drift`
  7. blocked/escalated/validation/devops or off-contract phase → `workflow_exception`
  8. any other adverse verdict/phase mismatch → `artifact_drift`

  Steps 2–4 (issue #28 Phase 2F) apply only to a task whose `status.yaml` has
  `completion_gates`; for every other task the precedence is unchanged. They
  read the guard's own gate view (`scripts/gate-view-json.rb`), never a
  TypeScript copy of the gate rules, and a view the server cannot obtain is
  `gates_unreadable`, never an empty all-clear.
- `riskLevel` = the **higher** of two contracted signals, never from prose:
  - change risk — `reviewer-output.yaml` `risk_level` (issue #12; the reviewer's
    deterministic classification of the paths it reviewed), and
NEW

rep!(s, <<'OLD', <<'NEW')
    "awaiting_review": 1,
    "decision_pending": 1,
    "workflow_exception": 2,
    "artifact_drift": 2
  },
  "reviews": [ /* ReviewSummary[], actionable rows first */ ]
}
OLD
    "awaiting_review": 1,
    "decision_pending": 1,
    "workflow_exception": 2,
    "artifact_drift": 2,
    "gates_unreadable": 0,
    "authorization_required": 0,
    "completion_held": 0
  },
  "reviews": [ /* ReviewSummary[], actionable rows first */ ]
}
NEW

rep!(s, <<'OLD', <<'NEW')
- Action Center — classified operator inbox and Command evidence deep links ✅
- Driver reconcile — `run-agent.sh` applies a decision to `status.yaml` at dispatch,
  idempotently, preserving the single-writer invariant ✅
OLD
- Action Center — classified operator inbox and Command evidence deep links ✅
- Driver reconcile — `run-agent.sh` applies a decision to `status.yaml` at dispatch,
  idempotently, preserving the single-writer invariant ✅
- Completion gates (issue #28 Phase 2F) — gate kinds in the Action Center and a
  Completion Gates card in Monitor, from the guard's own gate view ✅
NEW
File.write(path, s)
```

`2f-schema-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: the optional gates property.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
              - type: string
          againstPhase:
            oneOf:
              - type: "null"
              - type: string
OLD
              - type: string
          againstPhase:
            oneOf:
              - type: "null"
              - type: string
  gates:
    description: >
      Issue #28 Phase 2F: completion gate counts from CompletionGuard.gate_view
      (scripts/gate-view-json.rb). Absent for a task whose status.yaml has no
      completion_gates. readable=false means the state cannot be trusted.
    type: object
    additionalProperties: false
    required:
      - readable
      - total
      - resolved
      - passable
    properties:
      readable:
        type: boolean
      total:
        type: integer
        minimum: 0
      resolved:
        type: integer
        minimum: 0
      passable:
        type: integer
        minimum: 0
NEW
File.write(path, s)
```

Run: `ruby -ryaml -e 'p YAML.safe_load(File.read("schemas/run-summary.schema.yaml"))["properties"].keys.last' && bash tests/integration/schema-validator-parity.sh`
Expected: `"gates"`, then the parity PASS line.

- [ ] **Step 6: Commit**

```bash
git add dashboard/shared/types.ts dashboard/server/src/services/reviewModel.ts dashboard/server/src/services/reviewModel.test.ts dashboard/server/src/routes/review.ts dashboard/client/src/views/ReviewView.tsx docs/run-summary-read-model.md schemas/run-summary.schema.yaml
git commit -m "feat(dashboard): completion gate kinds in the Action Center (#28 Phase 2F)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gates in the run detail and the Monitor card

**Files:**
- Create: `dashboard/client/src/views/gateDisplay.ts`, `dashboard/client/src/views/GatesCard.tsx`
- Modify: `dashboard/server/src/services/runScanner.ts`, `dashboard/client/src/views/MonitorView.tsx`, `dashboard/client/src/styles/globals.css`
- Test: `dashboard/client/tests/gateDisplay.test.ts` (new), `dashboard/server/src/services/runScanner.test.ts`

**Interfaces:**
- Consumes: `GateView`, `GateEntry`, `GateViewService`, `globalGateViews`, `hasCompletionGates` (Task 2).
- Produces:
  - `new RunScanner(gateViews: GateViewService = globalGateViews)`;
  - `RunDetail.gates` present only when `status.yaml` has `completion_gates`;
  - `gateTone(gate: GateEntry): 'resolved' | 'na' | 'pending' | 'unresolved'`;
  - `safeRunUrl(value: unknown): string | null`;
  - `GatesCard({ view }: { view: GateView })`.

- [ ] **Step 1: Write the failing client test**

Create `dashboard/client/tests/gateDisplay.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { GateEntry } from '../../shared/types';
import { gateTone, safeRunUrl } from '../src/views/gateDisplay.ts';

function gate(entry: Partial<GateEntry>): GateEntry {
  return {
    name: 'g', status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: null, grant: null,
    requiresRecord: false, ran: null, passable: false, unresolvedReason: null, detail: '', ...entry,
  };
}

test('gateTone: a resolved pass or na reads as done, an unresolved one as a problem', () => {
  assert.equal(gateTone(gate({ status: 'pass', resolved: true })), 'resolved');
  assert.equal(gateTone(gate({ status: 'na', resolved: true })), 'na');
  assert.equal(gateTone(gate({ status: 'pass', resolved: false, unresolvedReason: 'missing ran record' })), 'unresolved');
  assert.equal(gateTone(gate({ status: 'na', resolved: false, unresolvedReason: 'authorization not satisfied' })), 'unresolved');
});

test('gateTone: pending is pending whether or not it can pass now; an unknown status is a problem', () => {
  assert.equal(gateTone(gate({ status: 'pending', passable: true })), 'pending');
  assert.equal(gateTone(gate({ status: 'pending', passable: false })), 'pending');
  assert.equal(gateTone(gate({ status: 'skipped' })), 'unresolved');
});

test('safeRunUrl links only http and https', () => {
  assert.equal(safeRunUrl('https://github.com/o/r/actions/runs/1'), 'https://github.com/o/r/actions/runs/1');
  assert.equal(safeRunUrl('http://localhost:8080/run'), 'http://localhost:8080/run');
  for (const value of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', '/relative/path', 'not a url', '', undefined, null, 42]) {
    assert.equal(safeRunUrl(value), null, String(value));
  }
});
```

Run: `cd dashboard/client && TZ=UTC npx vitest run tests/gateDisplay.test.ts`
Expected: FAIL with `Failed to load url ../src/views/gateDisplay.ts`.

- [ ] **Step 2: Write the display helpers**

Create `dashboard/client/src/views/gateDisplay.ts`:

```ts
import type { GateEntry } from '../../../shared/types';

// Issue #28 Phase 2F: display rules for the Monitor Completion Gates card. The
// gate state itself comes from the server (CompletionGuard.gate_view); these
// only choose how to show it.

export type GateTone = 'resolved' | 'na' | 'pending' | 'unresolved';

/** A pass/na the guard does not count as resolved is a problem, not a success. */
export function gateTone(gate: GateEntry): GateTone {
  if (gate.status === 'pass' || gate.status === 'na') {
    if (!gate.resolved) return 'unresolved';
    return gate.status === 'pass' ? 'resolved' : 'na';
  }
  return gate.status === 'pending' ? 'pending' : 'unresolved';
}

/** The run URL only when it is http(s); anything else (javascript:, data:, relative) is not linked. */
export function safeRunUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
```

Run: `cd dashboard/client && TZ=UTC npx vitest run tests/gateDisplay.test.ts`
Expected: `Tests  3 passed (3)`.

- [ ] **Step 3: Write the failing run-detail test**

Run `ruby <scratchpad>/2f-runscanner-test-patch.rb dashboard/server/src/services/runScanner.test.ts`:

```ruby
# encoding: utf-8
# Phase 2F: run detail gate test.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
import path from 'path';
import yaml from 'js-yaml';
import { sortRunsByPriority, asObject, RunScanner, mapPhaseToRunStatus, classifyActor, latestConductor, buildNextActionPreview } from './runScanner';
import type { RunSummary } from '@shared/types';

test('sortRunsByPriority puts active work first, then newest task id', () => {
  const runs: RunSummary[] = [
OLD
import path from 'path';
import yaml from 'js-yaml';
import { sortRunsByPriority, asObject, RunScanner, mapPhaseToRunStatus, classifyActor, latestConductor, buildNextActionPreview } from './runScanner';
import type { GateView, RunSummary } from '@shared/types';
import type { GateViewService } from './gateView';

test('sortRunsByPriority puts active work first, then newest task id', () => {
  const runs: RunSummary[] = [
NEW

rep!(s, <<'OLD', <<'NEW')
test('latestConductor: case-insensitive operator match', () => {
  assert.equal(latestConductor([{ agent: 'Codex' }]), 'codex');
});
OLD
test('latestConductor: case-insensitive operator match', () => {
  assert.equal(latestConductor([{ agent: 'Codex' }]), 'codex');
});

test('getRunDetail adds the gate view only for a task with completion_gates (#28 Phase 2F)', async () => {
  const base = `TASK-${Date.now()}`;
  const gatedId = `${base}-GATES`;
  const plainId = `${base}-PLAIN`;
  const runsRoot = path.resolve(__dirname, '../../../..', 'runs');
  const view: GateView = {
    readable: true, problem: null, finishedPhase: null,
    summary: { total: 1, resolved: 0, passable: 1, byStatus: { pending: 1 } },
    gates: [{
      name: 'smoke', status: 'pending', resolved: false, waitsOn: [], requiresAuthorization: null, grant: null,
      requiresRecord: false, ran: null, passable: true, unresolvedReason: null, detail: 'can pass now',
    }],
  };
  const loaded: string[] = [];
  const fake = { load: async (dir: string) => { loaded.push(path.basename(dir)); return view; } };
  try {
    for (const [id, extra] of [[gatedId, { completion_gates: { smoke: { status: 'pending' } } }], [plainId, {}]] as const) {
      await fs.mkdir(path.join(runsRoot, id), { recursive: true });
      await fs.writeFile(path.join(runsRoot, id, 'status.yaml'), yaml.dump({ task_id: id, phase: 'assigned', ...extra }));
    }
    const scanner = new RunScanner(fake as unknown as GateViewService);
    const gated = await scanner.getRunDetail(gatedId);
    const plain = await scanner.getRunDetail(plainId);
    assert.deepEqual(gated?.gates, view);
    assert.ok(plain);
    assert.equal(Object.prototype.hasOwnProperty.call(plain, 'gates'), false);
    assert.deepEqual(loaded, [gatedId]);
  } finally {
    await fs.rm(path.join(runsRoot, gatedId), { recursive: true, force: true });
    await fs.rm(path.join(runsRoot, plainId), { recursive: true, force: true });
  }
});
NEW
File.write(path, s)
```

Run: `cd dashboard/server && node --require ts-node/register --test src/services/runScanner.test.ts`
Expected: FAIL with `error TS2554: Expected 0 arguments, but got 1.`

- [ ] **Step 4: Add the gate view to the run detail**

Run `ruby <scratchpad>/2f-runscanner-patch.rb dashboard/server/src/services/runScanner.ts`:

```ruby
# encoding: utf-8
# Phase 2F: RunDetail.gates.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
import yaml from 'js-yaml';
import { config } from '../config';
import { TASK_ID_PATTERN } from '../pathSecurity';
import type {
  RunSummary,
  RunDetail,
OLD
import yaml from 'js-yaml';
import { config } from '../config';
import { TASK_ID_PATTERN } from '../pathSecurity';
import { GateViewService, globalGateViews, hasCompletionGates } from './gateView';
import type {
  RunSummary,
  RunDetail,
NEW

rep!(s, <<'OLD', <<'NEW')
}

export class RunScanner {
  private cache: RunSummary[] | null = null;
  private cacheTimestamp: number = 0;
  private pendingRequest: Promise<RunSummary[]> | null = null;
OLD
}

export class RunScanner {
  constructor(private readonly gateViews: GateViewService = globalGateViews) {}

  private cache: RunSummary[] | null = null;
  private cacheTimestamp: number = 0;
  private pendingRequest: Promise<RunSummary[]> | null = null;
NEW

rep!(s, <<'OLD', <<'NEW')
      // unavailable preview instead of a guessed workflow action.
      detail.nextActionPreview ??= buildNextActionPreview(statusData);

      // List artifacts. A transient readdir failure must not nuke the whole
      // detail — keep the summary/timeline we already have.
      try {
OLD
      // unavailable preview instead of a guessed workflow action.
      detail.nextActionPreview ??= buildNextActionPreview(statusData);

      // Issue #28 Phase 2F: the gate view, only for a task with completion_gates
      // (an unreadable view is still shown, never dropped).
      if (hasCompletionGates(statusData)) {
        detail.gates = await this.gateViews.load(runPath);
      }

      // List artifacts. A transient readdir failure must not nuke the whole
      // detail — keep the summary/timeline we already have.
      try {
NEW
File.write(path, s)
```

Run: `cd dashboard/server && node --require ts-node/register --test src/services/runScanner.test.ts`
Expected: `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 5: Render the card in Monitor**

Create `dashboard/client/src/views/GatesCard.tsx`:

```tsx
import React from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { GateView } from '../../../shared/types';
import { gateTone, safeRunUrl, type GateTone } from './gateDisplay';

const TONE_COLOR: Record<GateTone, string> = {
  resolved: 'var(--status-success)',
  na: 'var(--status-queued)',
  pending: 'var(--status-warning)',
  unresolved: 'var(--status-error)',
};

/**
 * Issue #28 Phase 2F: a task's completion gates in Monitor, with the same text as
 * `run-agent.sh status`. Read-only: no buttons; the Action Center names the
 * command when a human has to act.
 */
export function GatesCard({ view }: { view: GateView }) {
  return (
    <div className="card monitor-section-card gates-card">
      <div className="panel-heading">
        <ShieldCheck size={14} /> <span>Completion Gates</span>
        {view.readable && (
          <span className="gates-card-count">{view.summary.resolved}/{view.summary.total} resolved</span>
        )}
      </div>
      {!view.readable ? (
        <div className="gates-card-unreadable" role="alert">
          Gate state unreadable: {view.problem ?? 'unknown problem'}
        </div>
      ) : (
        <ul className="gate-list">
          {view.gates.map((gate) => {
            const color = TONE_COLOR[gateTone(gate)];
            const runUrl = safeRunUrl(gate.ran?.url);
            return (
              <li key={gate.name} className="gate-item">
                <div className="gate-row">
                  <span className="gate-name">{gate.name}</span>
                  <span className="gate-pill" style={{ color, borderColor: color }}>{gate.status}</span>
                </div>
                {gate.detail && <div className="gate-detail">{gate.detail}</div>}
                {runUrl && (
                  <a className="gate-run-link" href={runUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={11} /> open run
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

Run `ruby <scratchpad>/2f-monitor-patch.rb dashboard/client/src/views/MonitorView.tsx` and `ruby <scratchpad>/2f-css-patch.rb dashboard/client/src/styles/globals.css`.

`2f-monitor-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: render the Completion Gates card.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
import { AlertCircle, Terminal, Loader2, LayoutDashboard, Network, ChevronDown } from 'lucide-react';
import type { HealthStatus, RunDetail } from '../../../shared/types';
import { agentGlyph, KIND_COLOR } from './agentDisplay';

export interface MonitorViewProps {
  loading: boolean;
OLD
import { AlertCircle, Terminal, Loader2, LayoutDashboard, Network, ChevronDown } from 'lucide-react';
import type { HealthStatus, RunDetail } from '../../../shared/types';
import { agentGlyph, KIND_COLOR } from './agentDisplay';
import { GatesCard } from './GatesCard';

export interface MonitorViewProps {
  loading: boolean;
NEW

rep!(s, <<'OLD', <<'NEW')
              </div>

              <div className="monitor-side-column">
                <div className="card monitor-section-card">
                  <div className="panel-heading"><span>Artifacts</span></div>
                  <ul className="artifact-list">
OLD
              </div>

              <div className="monitor-side-column">
                {runDetail.gates && <GatesCard view={runDetail.gates} />}

                <div className="card monitor-section-card">
                  <div className="panel-heading"><span>Artifacts</span></div>
                  <ul className="artifact-list">
NEW
File.write(path, s)
```

`2f-css-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: Completion Gates card styles.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
  color: var(--text-secondary);
}

.monitor-error-card {
  border: 1px solid var(--status-error);
}
OLD
  color: var(--text-secondary);
}

/* Issue #28 Phase 2F: Completion Gates card (Monitor). */
.gates-card-count {
  margin-left: auto;
  font-weight: 600;
  color: var(--text-secondary);
}

.gates-card-unreadable {
  font-size: 13px;
  color: var(--status-error);
  overflow-wrap: anywhere;
}

.gate-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.gate-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
}

.gate-item:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.gate-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.gate-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.gate-pill {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}

.gate-detail {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.gate-run-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11px;
}

.monitor-error-card {
  border: 1px solid var(--status-error);
}
NEW
File.write(path, s)
```

Run: `cd dashboard/client && npx tsc --noEmit -p . && npm test`
Expected: `tsc` prints nothing, then `Tests  1 failed | 43 passed (44)`. The one failure is the known pre-existing `navigation.test.ts` intake case.

- [ ] **Step 6: Commit**

```bash
git add dashboard/client/src/views/gateDisplay.ts dashboard/client/tests/gateDisplay.test.ts dashboard/client/src/views/GatesCard.tsx dashboard/client/src/views/MonitorView.tsx dashboard/client/src/styles/globals.css dashboard/server/src/services/runScanner.ts dashboard/server/src/services/runScanner.test.ts
git commit -m "feat(dashboard): Completion Gates card in Monitor (#28 Phase 2F)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, the full suite, and the browser

**Files:**
- Modify: `docs/completion-gates.md`, `dashboard/README.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Document gates in the dashboard**

Run `ruby <scratchpad>/2f-gates-doc-patch.rb docs/completion-gates.md` and `ruby <scratchpad>/2f-readme-patch.rb dashboard/README.md`.

`2f-gates-doc-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: gates in the dashboard.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')

Limits: "can pass now" is a snapshot. A grant can expire or be revoked
before `pass` runs, and the writer stays the authority. It does not check
`actor`/`reason` or verify `ran`. The dashboard does not show gates yet. Spec:
[`superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md`](superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md).

## Planning gates (Phase 2E)
OLD

Limits: "can pass now" is a snapshot. A grant can expire or be revoked
before `pass` runs, and the writer stays the authority. It does not check
`actor`/`reason` or verify `ran`. The dashboard shows the same view since
Phase 2F (see [Gates in the dashboard](#gates-in-the-dashboard-phase-2f)). Spec:
[`superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md`](superpowers/specs/2026-10-08-gate-status-view-phase-2d-design.md).

## Planning gates (Phase 2E)
NEW

rep!(s, <<'OLD', <<'NEW')

Limits: roles may still not act on a gate; the writer and guards keep the rules. The PM decides which gates a task needs, and nothing infers them. Gates added mid-task do not require a 2A revision. Spec: [`superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md`](superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md).

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
OLD

Limits: roles may still not act on a gate; the writer and guards keep the rules. The PM decides which gates a task needs, and nothing infers them. Gates added mid-task do not require a 2A revision. Spec: [`superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md`](superpowers/specs/2026-10-08-gate-aware-roles-phase-2e-design.md).

## Gates in the dashboard (Phase 2F)

The dashboard reads the same view, through `ruby scripts/gate-view-json.rb
<task_dir>`. That script prints `CompletionGuard.gate_view` as JSON and adds
to each gate its CLI text as `detail` (the words after `name: status — `). It
never writes and always exits 0; a view it cannot build is `readable: false`
with the problem.

- **Action Center.** For a task with `completion_gates`, three kinds come
  right after `decision_pending`:
  - `gates_unreadable`: the view is unreadable, or `authorization.yaml` cannot
    be read.
  - `authorization_required`: a pending bound gate waits only for a grant. It
    names the gate and shows the
    `ruby scripts/record-authorization.rb <TASK> grant --action <action> …`
    command, with placeholders for scope, actor, channel and reason.
  - `completion_held`: the review approved, but unresolved gates hold `done`.
    This replaces the misleading `awaiting_review` for such a task.

  A bound gate still waiting on another gate, and any gate on a `done`/`aborted`
  task, is not flagged.
- **Monitor.** A **Completion Gates** card lists every gate with its status and
  the CLI text, plus an `open run` link for an `http(s)` `ran.url`. An
  unreadable view shows `Gate state unreadable: <problem>` instead of a list.

Tasks without `completion_gates` never run the script, and their Action Center
result and JSON are unchanged. Any failure to get the view (no Ruby, a timeout,
unexpected output) is shown as unreadable, never as nothing to do. The
dashboard stays read-only: it shows the command and never records a grant or
passes a gate. Spec:
[`superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md`](superpowers/specs/2026-10-08-dashboard-gates-phase-2f-design.md).

## Compatibility

A task with no `completion_gates` key behaves exactly as before.
NEW
File.write(path, s)
```

`2f-readme-patch.rb`:

```ruby
# encoding: utf-8
# Phase 2F: gates in the Action Center and Monitor.
path = ARGV[0] or abort "usage: ruby <this script> <file>"
s = File.read(path, encoding: "UTF-8")
def rep!(s, old, new)
  abort "expected exactly one match for: #{old[0, 70].inspect}" unless s.scan(old).size == 1
  s.sub!(old) { new }
end

rep!(s, <<'OLD', <<'NEW')
## Views

- `Command`: command-center shell with live workflow map, queue, agent status, health, logs, and task detail/decision controls
- `Monitor`: browse runs, inspect task details, review timeline, and tail direct log files inside a run directory
- `Action`: operator inbox for awaiting review, pending decision reconciliation, workflow exceptions, and artifact drift; task decisions remain in `Command`
- `Analytics`: read-only workflow metrics built from `runs/`, including health score, failure clusters, trends, long-running work, and agent activity
- `Reports`: project readiness view built from repository source evidence

OLD
## Views

- `Command`: command-center shell with live workflow map, queue, agent status, health, logs, and task detail/decision controls
- `Monitor`: browse runs, inspect task details and completion gates, review timeline, and tail direct log files inside a run directory
- `Action`: operator inbox for completion gates (unreadable, authorization required, completion held), awaiting review, pending decision reconciliation, workflow exceptions, and artifact drift; task decisions remain in `Command`
- `Analytics`: read-only workflow metrics built from `runs/`, including health score, failure clusters, trends, long-running work, and agent activity
- `Reports`: project readiness view built from repository source evidence

NEW

rep!(s, <<'OLD', <<'NEW')
  prefix exists, initialize the ignored `office.config.local.yaml`.
- Recommended next actions and role launch are preview-only. The dashboard does
  not launch, retry, or dispatch a role.

## Current Limitations

OLD
  prefix exists, initialize the ignored `office.config.local.yaml`.
- Recommended next actions and role launch are preview-only. The dashboard does
  not launch, retry, or dispatch a role.
- Completion gates come from `scripts/gate-view-json.rb` (the guard's own view,
  read-only). The dashboard shows the grant command; it never records a grant or
  passes a gate. See [../docs/completion-gates.md](../docs/completion-gates.md).

## Current Limitations

NEW
File.write(path, s)
```

- [ ] **Step 2: Run everything**

Run:
- `cd dashboard/server && npm test`
- `cd dashboard/client && npm test`
- from the worktree root, every integration suite: `for t in tests/integration/*.sh; do bash "$t" > "<scratchpad>/s-$(basename "$t").log" 2>&1 || echo "FAIL $t"; done`

Expected:
- **Server:** `ℹ pass 152`, `ℹ fail 0`.
- **Client:** `Tests  1 failed | 43 passed (44)` (the known `navigation.test.ts` case).
- **Integration:** 53 of 55 suites pass. The only failures are `event-gateway.sh` (M3: `expected '0 dispatched' got '1 dispatch_failed'`) and `task-input-integrity.sh` (T10). Both fail identically on unmodified 8b945e4b

Any other failure is a regression: fix the code, never the test.

- [ ] **Step 3: Build browser fixtures and start the dashboard**

Save as `2f-fixtures.sh` in the scratchpad, then run `bash <scratchpad>/2f-fixtures.sh "$PWD" <scratchpad>/office2f` from the worktree root:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Phase 2F browser fixtures: a throwaway office whose runs/ holds copies of
# TASK-EAR-384/385 plus one task per new Action Center kind, built through the
# real gate writer. Usage: bash 2f-fixtures.sh <worktree> <office_dir>
WT="$1"
OFFICE="$2"
rm -rf "$OFFICE"
mkdir -p "$OFFICE/runs"
ln -s "$WT/scripts" "$OFFICE/scripts"
for t in TASK-EAR-384 TASK-EAR-385; do
  if [[ -d "/Users/earth/Documents/GitHub/ai-dev-office/runs/$t" ]]; then
    cp -R "/Users/earth/Documents/GitHub/ai-dev-office/runs/$t" "$OFFICE/runs/"
  fi
done
export AI_OFFICE_RUNS_DIR="$OFFICE/runs"
unset AI_OFFICE_NOW AI_DEV_OFFICE_OWNERSHIP_EPOCH AI_DEV_OFFICE_RUN_ID
mk() {
  mkdir -p "$OFFICE/runs/$1"
  cat > "$OFFICE/runs/$1/status.yaml" <<YAML
task_id: $1
task_label: $3
phase: $2
state: $2
iteration: 1
current_agent: dev
ready: true
blocked_on: []
waiting_for: []
assignment:
  primary: dev
  parallel: false
updated_at: '2026-10-08'
history: []
YAML
  printf '# %s\n\n%s\n' "$1" "$3" > "$OFFICE/runs/$1/task.md"
}
g() { ruby "$WT/scripts/update-completion-gate.rb" "$@" >/dev/null; }
mk TASK-2F-AUTH assigned "Staging deploy waits for a grant"
g TASK-2F-AUTH declare implementation_verification --actor pm --reason "tests on merged commit"
g TASK-2F-AUTH pass implementation_verification --actor dev --reason "suite green" --ran-by dev --ran-url https://github.com/vestearth/AI-office-agency/actions/runs/1
g TASK-2F-AUTH declare deploy_staging --actor pm --reason "staging deploy" --requires-authorization deploy_staging --after implementation_verification
mk TASK-2F-HELD in_review "Approved, held by open gates"
g TASK-2F-HELD declare implementation_verification --actor pm --reason v
g TASK-2F-HELD pass implementation_verification --actor reviewer --reason verified
g TASK-2F-HELD declare authenticated_staging --actor pm --reason smoke --requires-record
g TASK-2F-HELD declare release_notes --actor pm --reason notes --after authenticated_staging
printf 'review_verdict: approved\nsummary: ok\n' > "$OFFICE/runs/TASK-2F-HELD/reviewer-output.yaml"
mk TASK-2F-BAD assigned "Broken gate state"
printf 'completion_gates: oops\n' >> "$OFFICE/runs/TASK-2F-BAD/status.yaml"
ls "$OFFICE/runs"
```

Expected: the listing shows `TASK-2F-AUTH`, `TASK-2F-BAD` and `TASK-2F-HELD`, plus `TASK-EAR-384` and `TASK-EAR-385` when they exist in the main checkout.

Add these two entries to the `configurations` list in `/Users/earth/Documents/GitHub/.claude/launch.json`. Replace `<scratchpad>` with the absolute scratchpad path:

```json
{
  "name": "dashboard-2f-server",
  "runtimeExecutable": "npx",
  "runtimeArgs": ["ts-node", "src/index.ts"],
  "cwd": "ai-dev-office/.claude/worktrees/issue-28-2f-impl/dashboard/server",
  "env": {
    "AI_OFFICE_ROOT": "<scratchpad>/office2f",
    "DASHBOARD_PORT": "4322",
    "DASHBOARD_ALLOWED_ORIGINS": "http://localhost:3022"
  },
  "port": 4322
},
{
  "name": "dashboard-2f",
  "runtimeExecutable": "npx",
  "runtimeArgs": ["vite", "--port", "3022", "--strictPort"],
  "cwd": "ai-dev-office/.claude/worktrees/issue-28-2f-impl/dashboard/client",
  "env": { "DASHBOARD_API_ORIGIN": "http://localhost:4322" },
  "port": 3022
}
```

Start `dashboard-2f-server`, then `dashboard-2f`, with the preview tool (`preview_start` by name).

- [ ] **Step 4: Verify in the browser**

1. **Action Center** (`http://localhost:3022/?tab=command&view=attention`). The cards read `1 Gate unreadable`, `1 Authorization required` and `1 Completion held`. The rows read:
   - **TASK-2F-BAD:** `Gate state cannot be read: completion_gates is not a map.`
   - **TASK-2F-AUTH:** `Gate deploy_staging waits for a deploy_staging grant.`, next step `ruby scripts/record-authorization.rb TASK-2F-AUTH grant --action deploy_staging --scope <scope> --actor <you> --via <channel> --reason "<why>"`.
   - **TASK-2F-HELD:** `Review approved; the done guard holds the task until its gates resolve: authenticated_staging: can pass now (needs --ran-by and --ran-ref/--ran-url); release_notes: waits on authenticated_staging (pending).`
   - **TASK-EAR-385**, if present: unchanged, still `Awaiting review`.
2. **Monitor** (`?tab=monitor&run=TASK-2F-AUTH`). The Completion Gates card reads `1/2 resolved`:
   - `implementation_verification` has a green `pass` pill, the detail `ran: dev https://github.com/…/runs/1`, and an `open run` link with `rel="noopener noreferrer"`;
   - `deploy_staging` has an amber `pending` pill and `waits for a deploy_staging grant`.
3. **Monitor** (`?run=TASK-2F-BAD`): the card shows only `Gate state unreadable: completion_gates is not a map`, in the error colour.
4. **Monitor** (`?run=TASK-EAR-384`, if present): the card lines match `./run-agent.sh status TASK-EAR-384` in the main checkout.
5. **Review Focus 5:** `resize_window` to the mobile preset. Steps 1 and 2 stay readable, and `document.documentElement.scrollWidth <= window.innerWidth`. Then reset to desktop.
6. **Console:** `read_console_messages` with `onlyErrors` returns none.
7. **Evidence:** take screenshots of the Action Center and the Monitor card for the PR.

Then stop both preview servers and remove the two launch entries.

- [ ] **Step 5: Commit**

```bash
git add docs/completion-gates.md dashboard/README.md
git commit -m "docs(office): completion gates in the dashboard (#28 Phase 2F)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
