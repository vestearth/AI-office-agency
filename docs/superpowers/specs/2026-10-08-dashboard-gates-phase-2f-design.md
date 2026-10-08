# Phase 2F — Dashboard Gates

**Status:** design, approved in conversation 2026-10-08; pending written-spec review. **Issue:** vestearth/AI-office-agency#28. **Builds on:** Phase 1A–1D and 2A–2E (all merged; main 508ec4fd).

## Summary

Show completion gates and the human authority boundary in the dashboard, where the operator works. There are two parts.

1. **Action Center.** Three new action kinds:
   - `gates_unreadable`: the gate state cannot be trusted;
   - `authorization_required`: a gate can pass as soon as a human records a grant;
   - `completion_held`: the review approved the task, but the `done` guard holds it until its gates resolve.

   Each one comes with an evidence-backed reason and the next command.
2. **Monitor.** A **Completion Gates** card on the run detail lists every gate with the same text as `run-agent.sh status`.

The gate rules stay in Ruby. A new read-only `scripts/gate-view-json.rb` prints `CompletionGuard.gate_view` as JSON, and the dashboard server calls it with `execFile`. Nothing in the dashboard writes.

## Evidence

- **The dashboard knows nothing about gates.** Nothing under `dashboard/` mentions any of these: `completion_gates`, `requires_authorization`, `authorization.yaml`, `revisions`, `branches`, a failure class.
- **The Action Center misreports a held task.** `classifyAction` (`dashboard/server/src/services/reviewModel.ts`) maps any `review | in_review` phase to `awaiting_review`, with the reason "a reviewer decision is required".
  - A task whose reviewer already approved, but which the `done` guard holds (sync exit 5, Phase 1A), stays in its review phase.
  - The dashboard tells the operator to review it again, and never names the gate that is actually holding it.
- **Issue #28 acceptance still has one open item:** "Define where the human authority boundary is recorded and how the Office surfaces it."
  - Recording is done: the 1B authorization ledger, gate bindings, 2C run records.
  - Surfacing exists only in the CLI (`run-agent.sh status`, 2D) and the agent prompt (2E). Neither reaches the operator who must record a grant.
- **The rules already exist in one place.**
  - `CompletionGuard.gate_view` (2D) derives resolved / waits_on / grant / passable with the guard's own rules, fail-closed on an unreadable ledger.
  - `GateStatusText.suffix` (2D, moved in 2E) renders the text the CLI and prompt show.
  - `reviewModel.ts` already argues against a TypeScript copy of a safety rule: "a drifting copy of a safety rule is worse than a conservative signal".
- **There is precedent for calling Ruby from the server.** `dashboard/server/src/services/knowledgeReviews.ts` runs `execFile('ruby', [validatorPath, '--json', file], { timeout: 5_000, maxBuffer: 1024 * 1024 })`.
- **Usage today:** 2 of 519 tasks in the main checkout have `completion_gates` (TASK-EAR-384, TASK-EAR-385).
  - Neither has a bound gate or a reviewer approval yet, so today they get the Monitor card but no new action kind.
  - The new kinds are exercised by fixtures, not by live tasks.

## Concepts kept separate

| Concept | Where | 2F change |
|---|---|---|
| Gate rules (resolution, ordering, records, authorization, `done` guard) | `CompletionGuard`, writer, validator | none |
| Gate text | `GateStatusText.suffix` | none (reused) |
| **Gate view as data** | `scripts/gate-view-json.rb` | **new, read-only** |
| **Calling it** | `dashboard/server/src/services/gateView.ts` | **new** |
| **Action Center classification** | `reviewModel.ts` `classifyAction` | **3 new kinds, gated tasks only** |
| **Run detail** | `runScanner.ts` `getRunDetail` → `RunDetail.gates` | **new optional field** |
| **UI** | `ReviewView.tsx` badges/filter, new `GatesCard.tsx` in Monitor | **new** |

## Non-goals

- **No writes from the dashboard.** It does not record grants, pass gates or edit `status.yaml`; `dashboard/README.md` already forbids that. It shows the command to run.
- No change to gate rules, the writer, the validator, the CLI or the prompt.
- No change to the Action Center result, or to any JSON field, for a task without `completion_gates`.
- No display of revisions, branches or failure classes. That is a later slice, if usage appears.
- No Execution Blueprint.

## Design

### 1. `scripts/gate-view-json.rb`

`ruby scripts/gate-view-json.rb <task_dir>` reads `<task_dir>/status.yaml`, calls `CompletionGuard.gate_view(status, task_dir)`, and prints one JSON object. It never writes, and it always exits 0.

```json
{
  "readable": true,
  "problem": null,
  "finished_phase": null,
  "summary": { "total": 4, "resolved": 2, "passable": 1, "by_status": { "pass": 2, "pending": 2 } },
  "gates": [
    {
      "name": "authenticated_staging",
      "status": "pending",
      "resolved": false,
      "waits_on": [],
      "requires_authorization": "deploy_staging",
      "grant": "missing",
      "requires_record": true,
      "ran": null,
      "passable": false,
      "unresolved_reason": null,
      "detail": "waits for a deploy_staging grant"
    }
  ]
}
```

- **Fields:** every gate field is `gate_view`'s own, unchanged. The script adds one field, `detail`: `GateStatusText.suffix(gate, finished_phase)` with its leading `" — "` removed, or `""` when the suffix is empty.
- **CLI parity:** `"  #{name}: #{status}" + (detail.empty? ? "" : " — #{detail}")` is byte-equal to the corresponding line of `run-agent.sh status`.
- **Errors:** an unreadable view (`gate_view` readable=false) prints its `readable: false` and `problem` with an empty `gates` and a zero `summary`. Any exception does the same, including a missing task dir, an unparseable `status.yaml`, a non-map status, or a JSON generation error. Its `problem` is `"gate view failed: <exception class>"`. Every output carries all top-level keys.
- **Ledger:** it reads `authorization.yaml` through `gate_view`. An unreadable ledger gives `grant: "unknown"` and leaves bound gates unresolved (2D fail-closed rule).

### 2. Server: `gateView.ts`

```ts
export class GateViewService {
  constructor(
    scriptPath = path.join(config.aiOfficeRoot, 'scripts', 'gate-view-json.rb'),
    timeoutMs = 5_000,
  ) {}
  load(taskDir: string): Promise<GateView>   // never rejects
}
export function parseGateView(stdout: string): GateView   // throws on a wrong shape
export function hasCompletionGates(statusData: Record<string, unknown>): boolean
```

- **The call:** `execFile('ruby', [scriptPath, taskDir], { timeout, maxBuffer: 1024 * 1024 })`. There is no shell, and the arguments are an array.
- **`taskDir`:** it is always `path.join(runsDir, taskId)` for a `taskId` that passed `TASK_ID_PATTERN`. Callers already enforce this: the review model filters directory names with it, and the run route uses `resolveRunDir`.
- **Strict parsing, no guessing.** `parseGateView` checks:
  - `readable` is a boolean;
  - `gates` is an array of objects with the documented fields and types;
  - `summary` has numeric `total` / `resolved` / `passable`;
  - `grant` is one of `available | missing | unknown | null`.

  It converts snake_case to camelCase in this one place.
- **Failure means unreadable, never empty.** All of these become `{ readable: false, problem: "gate view unavailable: <short reason>", finishedPhase: null, summary: zeros, gates: [] }`:
  - ruby is missing or the script is missing;
  - a non-zero exit, a timeout, or `maxBuffer` exceeded;
  - stdout that is not JSON, or JSON of the wrong shape.

  `load` never rejects.
- **When the call happens.** `hasCompletionGates` is true when the parsed `status.yaml` object has the key `completion_gates`, whatever its value. A non-map value still triggers the call, so the script can report it as unreadable.
  - Callers make the call only then. A task without the key never spawns Ruby.
  - Today that is 2 calls per Action Center refresh.
- **No cache.** A grant's validity depends on the current time (`expires_at`), so caching on file mtimes would show an expired grant as available.

### 3. Types (`dashboard/shared/types.ts`)

```ts
export type ActionKind =
  | 'awaiting_review' | 'decision_pending' | 'workflow_exception' | 'artifact_drift'
  | 'gates_unreadable' | 'authorization_required' | 'completion_held';

export interface GateEntry {
  name: string;
  status: string;                       // as stored: pending | pass | na
  resolved: boolean;
  waitsOn: string[];
  requiresAuthorization: string | null;
  grant: 'available' | 'missing' | 'unknown' | null;
  requiresRecord: boolean;
  ran: Record<string, string> | null;   // 2C record, pass gates only
  passable: boolean;
  unresolvedReason: string | null;
  detail: string;                       // CLI text after "name: status — "
}

export interface GateView {
  readable: boolean;
  problem: string | null;
  finishedPhase: string | null;
  summary: { total: number; resolved: number; passable: number; byStatus: Record<string, number> };
  gates: GateEntry[];
}

// RunDetail
gates?: GateView;
// ReviewSummary
gates?: { readable: boolean; total: number; resolved: number; passable: number };
```

- Both new optional fields are **absent** (not `null`) for a task without `completion_gates`, so that task's JSON is unchanged.
- `ran` values are converted to strings. A non-string value, e.g. a YAML time, becomes its JSON string.

### 4. Action Center classification

`buildReviewSummary(taskId, statusData, reviewerData, debuggerData, latestDecision, gateView = null)` gains a sixth parameter and stays pure. `classifyAction` gets the gate view, and the three gate kinds are checked **immediately after `decision_pending`**. When `gateView` is `null` (no `completion_gates`), they are skipped, so the existing chain and its results are unchanged.

| Order | Kind | Condition | `actionReason` | `recommendedAction` |
|---|---|---|---|---|
| 1 | `decision_pending` | unchanged | unchanged | unchanged |
| 2 | `gates_unreadable` | `!readable`, or any gate with `grant === 'unknown'` or `unresolvedReason === 'authorization ledger unreadable'` | `Gate state cannot be read: <problem>` (or `the authorization ledger cannot be read`) | `Run ./run-agent.sh status <TASK> and repair status.yaml / authorization.yaml through their writers.` |
| 3 | `authorization_required` | `finishedPhase === null` and some gate is `pending`, has `requiresAuthorization`, `grant === 'missing'` and `waitsOn` empty | `Gate <name> waits for a <action> grant` (several joined with `; `) | `ruby scripts/record-authorization.rb <TASK> grant --action <action> --scope <scope> --actor <you> --via <channel> --reason "<why>"` (first such gate) |
| 4 | `completion_held` | phase `review \| in_review`, verdict `approved`, `summary.resolved < summary.total` | `Review approved; the done guard holds the task until its gates resolve: <name> (<detail>), …` (unresolved gates, in stored order) | `Dispatch the role that owns the open gates; ./run-agent.sh status <TASK> shows which can pass now.` |
| 5+ | existing chain | unchanged | unchanged | unchanged |

- **Why unreadable comes first:** when the gate state cannot be read, every conclusion drawn from it is suspect.
- **Why `authorization_required` comes before the rest:** it is the authority boundary, an action only a human can take.
- **What `completion_held` replaces:** the misleading `awaiting_review` for an approved, held task.
- **Not flagged:**
  - A bound gate still waiting on another gate (`waitsOn` non-empty). It waits its turn.
  - Any gate on a `done | aborted` task (`finishedPhase` set). The writer refuses edits there, and 2D renders `task is <phase>`.
- **`needsReview`** stays `actionKind === 'awaiting_review'`, so a held task leaves the review count. **`requiresAction`** stays `actionKind !== null`.
- **`ReviewSummary.gates`** is set from the view whenever one was loaded.

`ReviewModelService.getReviewSummaries` loads the gate view only when `hasCompletionGates(statusData)`, and passes it as the sixth argument.

### 5. Run detail and the Monitor card

- **Server:** `RunScanner.getRunDetail` sets `detail.gates = await gateViews.load(runPath)` when `hasCompletionGates(statusData)`. There is no new endpoint; Monitor already fetches `GET /api/runs/:id`.
- **Client:** a new `dashboard/client/src/views/GatesCard.tsx` renders in `MonitorView`'s `monitor-side-column`, above Artifacts, only when `runDetail.gates` is present.
  - **Header:** `Completion Gates` and `<resolved>/<total> resolved`.
  - **One row per gate, in stored order:** the name; a status pill; and `detail` on a second line when non-empty. For a pass gate with a run record, `detail` already reads `ran: <by> <ref|url>` (the CLI text). The card adds only an `open run` link when `ran.url` is safe, so the text is not repeated.
  - **Pill tone:** `gateTone(entry)` is a pure function. `pass`/`na` that are resolved are green/grey. `pending` is amber. `pass`/`na` that are **not** resolved are red, with `unresolvedReason` as the detail.
  - **Links:** `safeRunUrl(url)` is a pure function. It returns the URL only for `http:` / `https:`, so anything else renders as plain text.
  - **Unreadable view:** the card shows `Gate state unreadable: <problem>` in the error tone, and no gate list.
  - **No buttons, no writes.**
- **Action Center (`ReviewView.tsx`):** `ACTION_META` gains labels and colours for the three kinds, and the filter and `buildActionBrief` include them. Labels: `Gate unreadable`, `Authorization required`, `Completion held`.

### 6. Files

| File | Change |
|---|---|
| `scripts/gate-view-json.rb` | new: gate view as JSON |
| `dashboard/server/src/services/gateView.ts` | new: `GateViewService`, `parseGateView`, `hasCompletionGates` |
| `dashboard/server/src/services/reviewModel.ts` | sixth parameter, three kinds, load gate views |
| `dashboard/server/src/services/runScanner.ts` | `RunDetail.gates` |
| `dashboard/shared/types.ts` | `ActionKind`, `GateEntry`, `GateView`, the two optional fields |
| `dashboard/client/src/views/GatesCard.tsx` | new: the card, `gateTone`, `safeRunUrl` |
| `dashboard/client/src/views/MonitorView.tsx` | render the card |
| `dashboard/client/src/views/ReviewView.tsx` | badges, filter, brief |
| `docs/run-summary-read-model.md` | precedence list and `gates` |
| `schemas/run-summary.schema.yaml` | optional `gates` property |
| `docs/completion-gates.md` | "Dashboard (Phase 2F)" section |
| `dashboard/README.md` | gates in the Action Center and Monitor |

## Tests

**Ruby — `tests/integration/gate-view-json.sh` (new):**

- **G1 mixed gates:** declared through the writer — pass, pending passable, pending waiting on another gate, pending bound without a grant, pass with a run record. Every field matches the expected value.
- **G2 CLI parity:** for every gate, `"  name: status" (+ " — detail")` equals the matching line of `ruby scripts/gate-status-text.rb <dir>`. Run on G1, on a finished task, and on a task with an unreadable ledger.
- **G3 unreadable ledger:** `grant: "unknown"`, `readable: true`.
- **G4 non-map `completion_gates`:** `readable: false` with the 2D problem text.
- **G5 finished task:** `passable: false`, detail `task is done`.
- **G6 garbage:** a missing dir, an unparseable `status.yaml`, and a non-map status. Each gives exit 0, valid JSON, `readable: false`, and all top-level keys.
- **G7 read-only:** a checksum of the task dir is unchanged after a run.

**Server — `node --test` (the server's runner):**

- **`reviewModel.test.ts`:**
  - each new kind fires on its fixture;
  - precedence:
    - `decision_pending` beats every gate kind;
    - unreadable beats `authorization_required`;
    - `authorization_required` beats `completion_held`;
    - `completion_held` needs verdict `approved`;
    - a bound gate with non-empty `waitsOn` is not `authorization_required`;
    - a finished task gets no gate kind;
  - with `gateView = null`, every pre-existing case returns the same summary. Existing tests pass unmodified, and no `gates` key appears.
- **`gateView.test.ts`:**
  - the real script against a temp runs dir parses into the documented shape;
  - each failure becomes `readable: false` with a problem, and `load` resolves: script path missing, a stub script printing non-JSON, a stub printing the wrong shape, a stub sleeping past a 200 ms timeout, a stub exiting 1;
  - `hasCompletionGates` covers absent, map and non-map values.
- **`runScanner`:** `getRunDetail` includes `gates` only when `status.yaml` has `completion_gates`.

**Client — vitest:**

- `gateTone` covers each status/resolved combination.
- `safeRunUrl` accepts http/https and rejects `javascript:`, `data:`, relative paths and non-strings.

**Browser:** the dashboard preview against a temporary `AI_OFFICE_ROOT`. Its `runs/` holds copies of TASK-EAR-384/385 plus fixtures for the three kinds; its `scripts/` points at the branch's scripts. Screenshots of the Action Center and the Monitor card go in the PR.

## Rollout, evidence and rollback

- **No data migration, no new status field, no writer change.** The script is read-only, and the dashboard reads only what already exists.
- **Rollout:** merge, then restart the dashboard server.
- **Rollback:** revert the PR. Nothing persisted depends on it.
- **After merge:** open the dashboard on the main checkout and confirm EAR-384/385 show their gate cards with the same text as `./run-agent.sh status`.

## Documented limits

- **An unparseable `status.yaml` is read as `{}`.** It therefore has no `completion_gates`, and the task gets no gate view. This is the dashboard's existing behaviour for the whole task, and 2F does not change it.
- **One Ruby process per gated task per refresh**, run in parallel and uncapped. That is fine at 2 tasks. If gates are adopted widely, a batch mode (`gate-view-json.rb DIR...`) or a concurrency cap is the follow-up.
- **`schemas/run-summary.schema.yaml` is already missing several fields** (`actionKind`, `actionReason`, `recommendedAction`, `requiresAction`, `decisionPending`, `title`, `statusUpdatedAt`) even though it sets `additionalProperties: false`. No test checks it. 2F adds `gates` only, and leaves the existing drift as it is.
- **The command shown for `authorization_required` has placeholders** for scope, actor, channel and reason. The operator fills them in; the dashboard does not choose a scope.

## Deferred

- Recording a grant or passing a gate from the dashboard. That needs an authenticated write path and a decision on who may grant.
- Revisions, branches and failure classes in the dashboard.
- A gate count in the all-runs list (`RunSummary`).
- A batch/cached gate view for many gated tasks.
