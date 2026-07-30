# TASK-EAR-166 — Fix the schedule generator's category contract (unblocks TASK-EAR-151)

## Type

bugfix

## Workstream

backend

## Priority

high

## Created

2026-07-29

## Epic

Canonical game-classification (TASK-EAR-140..153). This is the **real**
final-phase blocker that TASK-EAR-162's gate check uncovered — TASK-EAR-151
(retire the fuzzy fallback) cannot proceed until this lands.

## Context

Full evidence: `runs/TASK-EAR-162/gate-check-findings.md` (reconciled against
live staging data 2026-07-29). Summary of what was proven:

`Games-Labs-Missions/internal/services/schedule_defaults.go` `category_turnover`
branch (`:207-218`) **gates on one function and stores the result of another**:

- `categoryToGameType` (`:106-112`) — uppercased normalized token for **any**
  non-empty/non-`all` label. Permissive.
- `categoryToGameCategory` (`:122-139`) — hardcoded 5-case switch
  (`slot`/`crash`/`arcade`/`minigame`/`card`), `default: return ""`. Strict.

So a label that passes the gate can still store an **empty `game_category`**,
and `activity_match.go:52-57` then forces every match for that rule down the
legacy fuzzy fallback — permanently, and silently (failure mode is "still
scores, via fallback", not an error).

### The sharp part — the canonical code itself breaks Slots

Executing both mappings over every canonical code and label form:

| input | `game_type` | `game_category` | |
| --- | --- | --- | --- |
| `Slot` | `SLOT` | `SLOTS` | ok |
| **`Slots`** / **`SLOTS`** | `SLOTS` | **(empty)** | **bug** |
| `CRASH` / `ARCADE` / `MINIGAME` / `CARD` | same | same | ok |
| `Fishing` | `FISHING` | (empty) | bug |

**`SLOT` is the only one of the five whose canonical code (`SLOTS`) differs
from the singular UI label (`Slot`) the switch expects.** The other four have
code == label and round-trip cleanly, which is why this defect stayed invisible
— it only bites Slots, the largest category in the product. The one real
offending row in staging is exactly that:

```text
daily-real-2026-07-09-t2   TURNOVER_GAME_TYPE | SLOTS | <NULL>
```

The epic's original one-letter `SLOT` vs `SLOTS` mismatch (the TASK-EAR-140
root cause) was therefore **never eliminated — it was relocated** from the
matcher into the generator's mapping pair.

## Objective

Make it structurally impossible for the generator to persist a
`TURNOVER_GAME_TYPE` / `ROUND_COUNT_GAME_TYPE` rule with an empty
`game_category`.

## Requirements

1. **Make the gate and the stored value agree.** A label that cannot resolve
   to a canonical `game_category` must not silently produce a category-scoped
   rule. Choose one and state why:
   - fail loudly at config time (preferred if the write path can surface an
     error to the operator), or
   - fall back to `TURNOVER_AMOUNT` — the branch already taken for
     empty/`all`, i.e. "any game" — which is honest but silently widens the
     mission's scope, so it must be visible somewhere.
   Do **not** keep a path that writes `game_type` without `game_category`.
2. **Accept the canonical codes as input.** `SLOTS` (and any other canonical
   code) must resolve correctly, not just the singular UI labels. Whatever
   normalization is chosen must handle label ⇄ code equivalence rather than
   hardcoding one spelling.
3. **Resolve the ownership split.** `Games-Labs-Game/migrations/030` documents
   game categories as **admin-extensible rows** ("an admin-managed row insert
   here, not a code change") while Missions hardcodes five mappings — so any
   sixth category added by an admin silently reintroduces this bug. Either
   have Missions consume the Game service's category set, or make the
   divergence explicit and loud (reject unknown codes rather than degrade).
   A silently drifting hardcoded duplicate is the thing to eliminate.
4. **Correct the existing invalid rules — after the code fix, not before.**
   3 daily rows currently have empty `game_category` (1 real, 2 seed). A
   data-only correction applied first would be overwritten by the next
   generation cycle — the epic's own recorded lesson.
5. **Idempotent migration if one is used.** `migrations/run.go` re-executes
   every `.sql` on every boot with no version table; a non-idempotent
   statement crashes future deploys. See the knowledge-base lesson
   "Boot-Time Migration Runners That Replay Every File".

## Acceptance criteria

- No code path in the generator can persist a category-scoped rule with an
  empty `game_category`; covered by a test that feeds **canonical codes,
  singular UI labels, and an unknown label** and asserts the outcome for each
  (this is the exact matrix that exposed the bug).
- Passing `SLOTS` resolves correctly rather than yielding empty.
- Existing invalid daily rules corrected, after the code change.
- `go build ./...`, `go vet ./...`, `go test ./...` clean.
- No change to `activity_match.go` — the fallback stays until TASK-EAR-151,
  which is a separate decision gated on this task.

## Out of scope

- **Retiring the fuzzy fallback** (TASK-EAR-151) — still blocked; this task
  makes it *possible*, not done. Its gate also needs redefining first (see
  below).
- **Weekly FISHING pool rows** (16 rows, `weekly_activity_pool_entries`) —
  real config drift, but it has **not** been proven that this generator wrote
  them. Trace the pool write path in its own task before assuming the same
  cause.
- **Redefining the TASK-EAR-151 gate** — the current metric counts all history
  with no time predicate, so it can never return to zero by construction. Its
  replacement needs a time-bounded query **plus** a config invariant proving
  no empty-category rule can be created. Separate task.
