# 3D Office: the Debug Lab becomes a robot clinic

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 (Earth approved all remaining room work and asked Claude to settle the builder-check calls) · Roadmap item 5 · Lands after: SPAR-45
(labels and readouts by zoom level, `docs/superpowers/specs/2026-10-24-3d-office-labels-by-zoom-design.md`).
SPAR-44 (Aborted heap) has merged.

## Intent

**The room today** (zone `debug`, phases `debugging` and `debugging_complete`, agent `debugger`,
kind `work`):

- **Robots:** a task's robot sits at a desk from the shared desk layout with the `work` posture.
  Only `SCENE_DESK_LIMIT` (4) tasks per room get a desk.
- **Furniture:** desks with screens, a TV cabinet and two drawer cabinets (`officeDecor.tsx`).
  Nothing says it is where work gets fixed.

**What the data says** (Claude's check of `runs/*/status.yaml`, 2026-10-24):

- **How often.** 49 entries into `debugging` across 34 tasks.
  - 23 of them are dated: 3 in June, 14 in July, 4 in August and 2 in October. The other 26 have
    no `at`.
  - The last two were TASK-VS-026 (2026-10-15) and TASK-EAR-404 (2026-10-16).
  - The room is empty today.
- **Who sends work here.** The reviewer, in 45 of 49 cases, after review finds a defect. The
  history reason is the reviewer's finding, as written.
- **Where it goes next.** 48 recorded exits:
  - 43 back to review (36 to `in_review`, 7 to `review`);
  - 2 to blocked;
  - 2 to done;
  - 1 to aborted.
- **How long.** Fast. The six entries with full timestamps lasted 4 to 33 minutes.
- **Loops.** Some tasks bounce between Review and Debug Lab several times: TASK-032 six times,
  TASK-EAR-110 four times, TASK-067 three times. A task that keeps coming back is the thing worth
  noticing.
- **`debugging_complete`** has never been used. The sync script sets it only when the debugger
  hands off to dev or dev-2 (`sync-status-from-output.rb`). A hand-off to the reviewer goes straight
  to the review queue.
- **Earth's own Changes decision also sends work here.** `request_changes` maps to `debugging`
  (`reconcile-decision.rb`).
  - The history row it writes has agent `orchestrator` and reason
    `human decision: request_changes by <actor>`.
  - The real reason is the decision note, which `DecisionDialog` requires.
  - None of the 49 past entries came this way. SPAR-47 puts the Changes button in the 3D Review
    room, so this will become a main route.
- **Rows written during a stay.**
  - Branch updates and other bookkeeping can add `debugging -> debugging` rows during a stay. 5 of
    the 49 stays had them.
  - TASK-VS-026 got one five minutes into a 23-minute stay.
  - After such a row, `lastTransition` no longer describes the entry.

**Earth's direction (2026-10-24):**

- Earth asked Claude to recommend a design. Claude proposed a repair room that says what is being
  fixed, why, and which round it is.
- Earth asked for the round count, and **allowed a server change** for it. This is the first
  server change in the room roadmap.
- Earth chose concept J, "robot clinic", over concept I, an electronics repair room ("ชอบแบบ J
  ครับ ผมว่าเจ๋งดี").

The mockups are in the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
(`debug-concepts.html`, not in the repo).

## The design (as decided with Earth)

**Furniture: a robot clinic** (Earth chose J).

- **Exam table** with a robot dummy lying on it, under a big exam lamp that does not glow.
- **Tool tray** on a stand.
- **Monitor cart** with a screen that does not glow.
- **Hospital curtain screen** near the room front.
- **Bug board** on the left wall: insect silhouettes pinned to a board, no text. It is a pun on
  "bug".
- **Kept:** the shared desks, so robots keep sitting where they sit today.
- **Removed:** the TV cabinet and the drawer cabinets.

**Round tags.**

- Beside each robot's desk hangs one tag per round: the number of times the task has entered
  Debug Lab.
- From the third round on, the tags are a brighter warm white, so a looping task stands out.
- The tags have no text.

**The round count comes from the server** (Earth allowed it, 2026-10-24).

**What the room tells you** (zoomed in, following the SPAR-45 rule):

- **One line per task:**
  - the task id;
  - how long it has been here, in minutes or hours;
  - a `round N` badge;
  - who sent it back;
  - the reason as written, cut to two lines.
- **Clicking a task** opens the selection card with:
  - the round badge;
  - the full reason;
  - **Open in Monitor**.

## Calls I made (Claude), for Earth to check

**Server (the one change Earth allowed):**

- **Two new fields** (Claude's call, 2026-10-24). They are derived from the same history pass:
  - **`ReviewSummary.debugRounds: number`:**
    - the number of `status.yaml` `history[]` phase transitions whose target is `debugging` and
      whose source is not `debugging`, that is, how many times the task entered the room;
    - 0 for a task that never entered it;
    - counted over all history, in any order.
  - **`ReviewSummary.debugEntry: { agent, phase, reason, at } | null`:**
    - the latest of those entry rows, by time, the same ordering `lastTransition` uses;
    - `agent` is classified like `lastTransition.agent`;
    - `reason` is displayed verbatim and never classified, under the same contract as
      `lastTransition.reason`;
    - null when there is no entry row.
    - It exists because bookkeeping rows during a stay (branch updates) replace `lastTransition`.
      Without it, the reviewer's finding would vanish minutes into a stay.
- **Shared rules for both fields:**
  - Both are computed in `reviewModel.ts` next to the existing `lastTransition(history)`.
  - Gate updates (`gate <name>: a -> b`) are skipped, as `lastTransition` skips them.
- **This is structured data.** It counts the `phase` field of history rows and never reads the
  reason text, so it keeps the read-model contract.
- **Where it is documented:**
  - `dashboard/shared/types.ts`;
  - `schemas/run-summary.schema.yaml`;
  - `docs/run-summary-read-model.md`.
- **Tests:** server tests in `reviewModel.test.ts` cover 0, 1, several, out-of-order history,
  gate rows and `debugging -> debugging` rows.
- **No migration.** There is no data change: the field is derived on read.

**Client:**

- **All three come from `debugEntry`, not `lastTransition`:**
  - "how long" is the age of `debugEntry.at`;
  - "who sent it back" is `debugEntry.agent`, for example `reviewer`;
  - the reason is `debugEntry.reason`, as written, cut to two lines.
  - So a bookkeeping row during the stay changes none of them, and no `latest note` label is
    needed in this room.
- **"How long" format:**
  - When `debugEntry.at` has a time, it uses `formatAge` (`views/formatAge.ts`): minutes, then
    hours.
  - When it is date-only, it is `floor(days)`, shown as `today` or `Nd`, the rule the Escalation
    and Val.Failed rooms use.
  - `formatAge` would turn a date-only value into misleading hours, because it reads it as UTC
    midnight.
  - With no `at`, there is no age.
- **An entry from Earth's Changes decision** (`debugEntry.agent` is `orchestrator`):
  - the "who" part reads `sent back by <actor> (Changes)`;
  - the reason line is Earth's decision note, `latestDecision.note`.
  - The rule is structured: `latestDecision.decision` is `request_changes`, the decision is
    applied (`decisionPending` false), and `decidedAt` is not later than `debugEntry.at`.
    Otherwise the row is shown as written.
  - This needs `latestDecision` and `decisionPending` on the office task, which SPAR-47 also adds.
  - It is the same pattern as SPAR-48's Escalate rule. The two share the readout-line helper.
- **"Looping" starts at round 3.**
  - From the third round, the tags brighten and the readout badge is highlighted.
  - The number is a constant in the client, so it can change later.
- **`debugRounds` is 0 while the task is in the room.** This can happen with a hand-set phase or
  legacy history. There are no tags and no badge, and the line shows no round. It never pretends
  to be round 1.
- **`debugging_complete`** (never used so far): the readout line says
  `debugger done · waiting for dev`, with no reason. That phase is set only for a hand-off to dev
  or dev-2. The robot stays at its desk.
- **Count chip:** the room's task count, the SPAR-45 default.

**The scene:**

- **Round tags follow their desk.** Desks move with the task count and with held rows, so the
  tags are placed from the same desk row data each frame, not baked into the static decor.
- **Colors at zero draw calls.**
  - The merged decor has only three colors (wood, metal, fabric).
  - So the pieces that need their own color are instances of the existing instanced meshes that
    take a per-instance color, for example the box-shaped rack bodies (`geoms.rack` with
    `mats.paint`). These are the tags, the dummy robot, the bug silhouettes, the curtain panels and
    the tray.
  - Large plain pieces stay in the merged decor: the table frame, the lamp arm, the cart and the
    board backing.
- **Nothing glows.**
  - The exam lamp, the monitor and the tags are non-emissive.
  - The merged decor's lamp-shade material glows with DevOps's occupancy
    (`shadeEmissiveFor('devops')`), so it is not used here.
- **Draw calls:** none added. Robots, walks and postures are unchanged.

**Interaction:**

- **Clicks:** a desk or a readout line selects the task. The card shows the round badge, the full
  reason and Open in Monitor.
- **Shared new work:** today the card and readouts are `pointer-events: none`, and the card has no
  buttons. SPAR-46 to SPAR-49 need clickable lines and an interactive card too. Whichever lands
  first builds them.

## Goals, non-goals, anti-goals

**Goals**

- **Empty:** the room reads as a place where robots get fixed, even empty.
- **Occupied:** you can see what is being fixed, for how long, why, and whether it keeps coming
  back.
- **One click** to the run in Monitor.

**Non-goals**

- **No new seats, walk or robot moment.** The walk between Review and Debug Lab already exists.
- **No change to how tasks are routed** to or from debugging.
- **No server change beyond `debugRounds` and `debugEntry`.**

**Anti-goals: it fails even if it technically works when**

- **Wrong count:** the round count differs from the number of entries into `debugging` in the
  task's history.
- **Inferred:** the room reads or classifies reason text.
- **Glows with another room:** anything in Debug Lab glows because DevOps is busy.
- **Tags float:** tags are left floating where a desk used to be.

## Data

- **Server:** `ReviewSummary.debugRounds` and `ReviewSummary.debugEntry` (new), computed from
  `status.yaml` `history[]`.
- **Client:** `officeTasksFromApi` keeps:
  - `debugRounds` and `debugEntry`;
  - `latestDecision` and `decisionPending` (also added by SPAR-47);
  - `lastTransition` and `statusUpdatedAt`, already kept since SPAR-44.
- **Labels:** `PHASE_TO_ZONE`, `ZONE_BY_ID`, `formatAge`.

## Constraints

- **Scene cost:** zero new draw calls, on live data and on the 32-robot stress run.
- **Assets:** simple shapes only. No new model is needed.
- **Order of work:**
  - This item starts after SPAR-45 merges.
  - It shares the readout-line helper with SPAR-48 and SPAR-49. Whichever lands later reuses it.
- **Tests** (vitest and the server's test runner, each seen failing before the change):
  - **Server, `debugRounds`:** 0, 1, several, out-of-order history, gate rows, and
    `debugging -> debugging` rows.
  - **Server, `debugEntry`:**
    - the latest entry row by time;
    - unchanged by a later `debugging -> debugging` row;
    - null with no entry.
  - **"How long":**
    - minutes from a timestamped `debugEntry.at`;
    - `today` or `Nd` from a date-only one;
    - none without `at`.
  - **"Who" and reason:**
    - taken from `debugEntry`, not `lastTransition`;
    - Earth's note and `sent back by <actor> (Changes)` for an applied Changes decision.
  - **Round 0 in the room:** no tags, no badge.
  - **Rounds:**
    - N tags for round N, attached to the task's desk in the current row;
    - brighter from round 3;
    - the badge in the readout and the card.
  - **`debugging_complete`:** the `waiting for dev` line.
  - **Decor:**
    - Debug Lab has the table, dummy, lamp, tray, cart, curtain and board;
    - it no longer has the TV cabinet or the drawer cabinets;
    - nothing new uses the lamp-shade material.
- **Live check before merge:**
  - the empty room on live data;
  - an occupied room with a client-side mock: a task in round 1 and a task in round 4;
  - the card;
  - `/api/review` showing `debugRounds` for real past tasks: TASK-EAR-110 = 4 and TASK-032 = 6
    on today's data;
  - `debugEntry` for TASK-VS-026, which is still the reviewer's finding despite the later branch
    row;
  - draw calls unchanged.

## Left to the builder

- **Placement:** the exact positions of the clinic pieces, within the desks and the walk.
- **Tags:** their shape and how they hang beside a desk.
- **Dummy:** its proportions, built from simple shapes.

## Deploy and rollback

- **The client and the server ship together** in the dashboard (`dashboard/server` and
  `dashboard/client`).
- **No migration.** `debugRounds` is derived on read.
- **Rollback:** revert the PR.
- **Older clients** ignore the new fields, so the server change is safe to deploy first.
