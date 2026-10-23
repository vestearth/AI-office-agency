# 3D Office: the Review room becomes an inspection line

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Roadmap item 2 · Lands after: SPAR-44
(Aborted heap, `docs/superpowers/specs/2026-10-24-3d-office-aborted-heap-design.md`) and SPAR-45
(labels and readouts by zoom level, `docs/superpowers/specs/2026-10-24-3d-office-labels-by-zoom-design.md`)

## Intent

Today the Review room looks like any other office:

- **Robots:** each task sits at a desk from the shared desk layout (`desksForZone`/`sceneDesks` in
  `officeSelection.ts`) with the `work` posture.
  - Only `SCENE_DESK_LIMIT` (4) tasks per room get a desk and a robot.
- **Furniture:**
  - desks with screens (`SCREENS` in `officeLayout.ts`);
  - a big screen on the back wall that lights in the room tone while the room holds tasks
    (`officeLayout.ts`, `zone.id === 'review'`);
  - a table and two chairs (`officeDecor.tsx`);
  - glass side walls (`glassRoom` in `officeLayout.ts`).
- **Clicks:** selection comes from the desk, chair and screen instances. Robots and merged decor
  cannot be clicked.
- **Information:** nothing says which task has waited longest, and the 3D Office has no way to
  record a decision. Earth has to go to Command or Attention to decide.

Earth wants the room to answer one question: **"which task has waited longest for review, so I
can review it right away"** (Earth, 2026-10-24).

Most tasks in the Review room wait for a human decision. `classifyAction` in `reviewModel.ts`
gives a task in phase `review` or `in_review` the action kind `awaiting_review` (`needsReview`
true), unless one of these comes first:

- a recorded decision that is not applied yet (`decision_pending`);
- a gate action (`completion_held`, `authorization_required`, `gates_unreadable`);
- an unreadable status (`workflow_exception`);
- a newer task that supersedes it (`artifact_drift`, set by `assessSupersession`).

**An approval can be held.** `reconcile-decision.rb` maps `approve` to `done`, but holds it while
a completion gate is unresolved.
- It does not mark the decision applied, so `decisionPending` stays true until the gates
  resolve, even after the driver runs.
- Two of today's three review tasks are in that position.

On 2026-10-24 the live data has three tasks waiting for a decision:

| Task | Waited (since last status change) | `idle` | Completion gates |
|---|---|---|---|
| TASK-EAR-390 | 9 days | `{ days: 9, thresholdDays: 7 }`, overdue | 1 of 2 resolved |
| TASK-VS-045 | 1–2 days | none | 1 of 1 resolved |
| TASK-EAR-405 | today | none | 1 of 2 resolved |

Earth chose concept C, "inspection line", from three mockups:

- A, a hearing room;
- B, an inspection table;
- C, an inspection line.

The mockups are in the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
(`review-concepts-v2.html`, not in the repo).

## The design (as decided with Earth)

**Act right there (Earth, 2026-10-24).**

- Clicking a task waiting for review opens the decision panel in the 3D Office, without leaving
  it.
- It is the existing `QuickDecisionPanel` (`views/QuickDecisionPanel.tsx`), the one Command's
  queue and Attention already open. It shows:
  - the review facts;
  - the next action;
  - the reviewer issues;
  - Approve, Changes, Escalate and Reject.
- It is a modal over the page.
- It records the decision through the existing `POST /api/decisions/:taskId`, so there is no
  server change.

**The room: an inspection line.**

- **Line:** a conveyor runs along the back wall into an inspection gate at one end.
- **Boxes:** each task is a box on the conveyor, in waiting order. The longest wait sits at the
  gate.
- **Robots:** each robot stands in front of its own box.

**The decision moment (Earth, 2026-10-24).**

- **The box moves as soon as Earth decides.** It does not wait for the driver to move the task to
  its next phase.
- **The signal:** `decisionPending`. The read model sets it when a decision is recorded but not
  yet applied to status.yaml (`latestDecision.decidedAt !== statusDecisionAppliedAt`).
- **The robot follows later.** It walks out when the driver actually changes the task's phase.

## Calls I made (Claude), for Earth to check

**Data:**

- **Three kinds of Review-room task:**
  - **Waiting for a decision:** `needsReview`, the action kind `awaiting_review`. These are the
    boxes on the line.
  - **Decided:** `decisionPending`. The decision is recorded but not yet applied.
  - **Other:** any other action kind (`completion_held`, `authorization_required`,
    `gates_unreadable`, `workflow_exception`, `artifact_drift`). These do not wait for a review
    decision.
- **"How long":**
  - `floor((now − statusUpdatedAt) / 1 day)`, the same formula the server uses for `idle`
    (`reviewModel.ts`), so the readout and the overdue flag never disagree.
  - Order: longest wait first, so the oldest box is at the gate.
- **Overdue** means the task has an `idle` value. The server sets it once a review-phase task
  passes its threshold of 7 days (`IDLE_THRESHOLD_DAYS`). The threshold is read from
  `idle.thresholdDays` and never hard-coded.
- **Where a decided box goes,** by `latestDecision.decision`. It leaves the line at once:

  | Decision | Box goes to |
  |---|---|
  | `approve` | through the gate, to the far side |
  | `request_changes` | a return rack at the start end of the line, off the line itself |
  | `escalate` | lifted onto a shelf beside the gate |
  | `reject` | into a bin beside the gate |

  - The box stays there until the task leaves the room.
  - Each of these spots holds up to two boxes, each with its robot beside it. A third decided
    task of the same kind is listed but has no box or robot.
- **A held approval** stays on the far side of the gate.
  - Its readout line says `decided · approve · gates 1/2`, from `ReviewSummary.gates`.
  - So Earth can see that the approval waits for gates, not for the driver.
- **The line closes up.** When a box leaves the line, the waiting boxes behind it move up toward
  the gate, so the oldest waiting box is always at the gate.
  - Their robots move with them and re-seat with no walk. That is the existing rule for a seat
    change inside the same room (`planMove`, SPAR-39).
- **Other tasks get no box.**
  - Their robots stand at a side spot near the room front, up to two.
  - The readout lists them under `not waiting for a decision`, with the label Attention gives
    their action kind.
- **Re-deciding is allowed.**
  - Clicking a decided box or line opens the panel too, and it shows `decided: … · actor`.
  - A newer decision supersedes the older one, as in Attention. This is the only way to correct
    a mistaken decision from the 3D Office.

**The scene:**

- **Removed from Review:**
  - the desks and desk screens;
  - the back-wall screen, because the conveyor takes the back wall;
  - the decor table and its two chairs.
- **Kept:** the glass side walls.
- **The gate carries a small lit panel** in place of the back-wall screen.
  - It keeps the screen's rule: lit in the room tone while the room holds any task (`count > 0`).
  - It uses the existing wall-screen instances, so the cost is unchanged.
- **The overdue marker is a plain hanging tag with no text,** above the overdue box.
  - It is neutral warm white, never a status color.
  - The days are shown in the readout. Text in the 3D scene would cost a texture.
- **Review gets its own standing spots instead of desks,** the way Done has its lounge seats.
  - The line holds up to four waiting boxes, each with its robot. Four is the same as
    `SCENE_DESK_LIMIT`, so the side list and its arrow keys still reach every box on the line.
  - The decided spots and the side spots are listed above.
  - A task beyond its spots has no box and no robot. It is still counted and listed.
  - Robots are instanced, so more robots do not add draw calls.
  - New meshes do not cast shadows. A shadow caster costs a second draw call in the shadow pass,
    and SPAR-44 measured no visible difference in these dim rooms.
- **Robots stand** beside their box with an existing standing clip, not the seated `work` loop.
- **Leaving:**
  - When a task's phase changes, its robot picks up a box and walks out by the room front, to
    whatever room the new phase puts it in. That uses the existing walk rules, including
    SPAR-44's walk to the heap if the task becomes aborted.
  - The task's box disappears from its spot as the robot sets off.
  - The carried box reuses SPAR-44's carried-box rendering.
- **Existing rules hold:** first load, remount, a hidden tab, a stream gap and reduced motion
  place boxes and robots with no movement (SPAR-38/39/41/42).

**Interaction:**

- **Clicking a box, or its readout line, opens `QuickDecisionPanel`** for that task. That covers
  waiting and decided boxes.
  - It also selects the task.
  - Closing the panel (✕ or Esc) returns to the 3D view with the task still selected.
  - Clicking an "other" task's line or robot spot shows the selection card with **Open in
    Monitor**, the way Attention treats those kinds. It does not open the panel.
- **The side-panel list keeps its behaviour:** arrow keys and clicks select. Selecting a review
  task there shows a **Review & decide** button on the selection card, like Attention's, which
  opens the panel. Arrow-key browsing never pops a modal.
- **After a decision,** the panel's `onDecided` reloads the office data. The box then moves on
  the next render, not on the next stream tick.
- **Robots stay non-clickable.**
- **Readout** (zoomed in, following the SPAR-45 rule):
  - **Header:** `awaiting review · N`, where N is the number of tasks that still need a decision.
  - **One line per task:** id and age, with an `over 7d` badge when overdue (the number from
    `idle.thresholdDays`).
  - **A decided task** shows `decided · approve`, or the decision taken, instead of its age.
    A held approval adds `gates 1/2`.
  - **Other tasks** come after a `not waiting for a decision` heading.
  - **Footer hint:** `click a task to decide`.
- **Count chip:**
  - The Review chip counts only tasks that still need a decision.
  - This is an exception to SPAR-45, where an open room's chip is its task count, the same way
    Blocked (SPAR-46) is an exception.
  - When nothing needs a decision, the chip hides.

## Goals, non-goals, anti-goals

**Goals**

- **At a glance:** the chip says how many tasks need a decision, and the oldest box sits at the
  gate with a tag if it is overdue.
- **Zoomed in:** the readout lists every task waiting for review, oldest first, with its age.
- **One click** from a task to the decision panel, and the box visibly passes the gate the moment
  a decision is recorded.

**Non-goals**

- **No new decision UI, endpoint or server change.** The existing panel and endpoint are reused.
- **No change to how the driver applies decisions,** or to which phase a decision leads to.
- **No change to the side panel's list,** Command, Attention or Monitor.

**Anti-goals: it fails even if it technically works when**

- **Out of order:** the box at the gate is not the task that waited longest.
- **Wrong box moves:** a box moves without a recorded decision, or shows a decision different
  from `latestDecision`.
- **Stuck on screen:** a decided box still reads as waiting, or a decided task still counts in the
  chip.
- **Unwanted modal:** a modal opens on keyboard browsing, page load or a data refresh.
- **Parade:** opening the page, coming back to the tab, or a stream reconnect shows boxes sliding
  or robots walking.

## Data

- **Already fetched, not yet kept:**
  - `Office3DView` already fetches `/api/review`. Each `ReviewSummary` carries `needsReview`,
    `actionKind`, `decisionPending`, `latestDecision`, `idle`, `gates`, `statusUpdatedAt`, `title`
    and `phase`.
  - `officeTasksFromApi` keeps only a few of these, `needsReview` among them. SPAR-44 adds
    `lastTransition` and `statusUpdatedAt`. SPAR-46 adds `waitsOn`, `isReleaseTrain`,
    `actionKind` and `recommendedAction`.
  - This item also needs `decisionPending`, `latestDecision`, `idle` and `gates`.
  - It needs the full `ReviewSummary` of the clicked task to hand to `QuickDecisionPanel`.
- **Decision panel:** `QuickDecisionPanel` (props `review`, `status`, `onClose`, `onDecided`),
  `DecisionDialog`, `POST /api/decisions/:taskId`.
- **Decision state:** `decisionPending` and `latestDecision`, computed in `reviewModel.ts`.

## Constraints

- **Scene cost:**
  - Static props go through the merged decor path: the conveyor, gate frame, shelf and bin.
  - The boxes on the line (one instanced mesh) and the overdue tags may add at most two draw
    calls together.
  - After SPAR-44 (merged 2026-10-24) the scene measures 62 on live data and 61 on the stress
    run. SPAR-46 may add up to two more.
  - So after this item the count may reach about 66, under the shared ceiling of 70, on live data
    and on the 32-robot stress run.
- **Assets:**
  - The boxes reuse the Kenney cardboard box geometry already in the repo.
  - The conveyor, gate, shelf, bin and tag are simple shapes. No new model is needed.
  - Everything is recolored through the decor buckets under the palette rule.
- **Order of work:**
  - This item starts after SPAR-45 merges. SPAR-44 has already merged.
  - It reuses SPAR-44's carried box and SPAR-45's readout and chip.
  - It does not depend on SPAR-46, but both touch `officeTasksFromApi`. Whichever lands second
    rebases on the other.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - **Order:** boxes are in waiting order, the longest wait at the gate. The age formula matches
    the server's `idle` days.
  - **Overdue:** the tag shows only for tasks with `idle`. The badge uses `idle.thresholdDays`.
  - **Decided boxes:**
    - a `decisionPending` box goes to the spot for its `latestDecision.decision`;
    - it leaves the chip count;
    - its readout line shows `decided · <decision>`.
  - **Line:**
    - at most four waiting boxes and robots, and a fifth waiting task is listed but has no box;
    - when a box leaves, the rest move up toward the gate and re-seat with no walk.
  - **Decided spots:**
    - up to two boxes per decision spot;
    - a held approval's line shows `gates x/y`.
  - **Other kinds:** no box, a side spot, listed under `not waiting for a decision`, and a click
    shows the card, not the panel.
  - **Re-deciding:** clicking a decided box opens the panel.
  - **Room:** no desks, desk screens, back-wall screen or decor table in Review. The glass walls
    stay.
  - **Clicks:**
    - a box click or a readout-line click opens the panel for that task;
    - arrow-key selection in the side list never opens it;
    - the selection card's Review & decide button does.
  - **No movement:** on first load, snap or reduced motion, nothing slides or walks.
- **Live check before merge:**
  - overview and zoomed screenshots on live data;
  - the panel opened from a box and from the readout;
  - a client-side mocked decision moving a box through the gate, and another to the return
    rack, with no real decision recorded;
  - a mocked phase change walking the robot out;
  - draw calls and fps on live data and the 32-robot stress run with a full line;
  - approving a task with open gates (mocked on the client) shows the box past the gate and
    `gates x/y`.

## Left to the builder

- **Layout:** the exact conveyor, gate, shelf and bin positions, the box spacing, and which end
  the gate is on, within the room front rule.
- **Motion:** the box slide and the gate moment, kept short (around a second). Reduced motion
  snaps.
- **Standing:** the standing clip, and how a robot faces its box.
- **Panel:** how the panel's `status` chip is filled in this host, using the same vocabulary as
  Command's queue.

## Open risks

- **Held approvals can sit past the gate for a long time.** An approval waits for its completion
  gates, and running the driver does not move it.
  - The readout's `gates x/y` says why.
  - But the panel's next action for `decision_pending` still says to run the driver, which can
    mislead. That text comes from the server and is out of scope here.
- **Line cap.** More than four tasks waiting for review leaves some without a box. The readout
  still lists them.
- **Similarity to Inbox.** The Inbox queue shelf also shows boxes in a row. The gate and the
  conveyor should read differently. Check it live.

## Found later (Claude, 2026-10-24)

The builder checks of later rooms found these facts in the code. They apply to this design.

- **The merged decor has only three colors.**
  - Its non-emissive materials are wood, metal and fabric (`officeDecor.tsx`), and `bake()` drops
    vertex colors.
  - So a simple shape that needs its own color cannot get it there: paper, notes, board lines,
    indicator panels, bars, a plant. It would come out brown, slate or plum, and a potted plant
    would get plum leaves.
  - **At no draw call:** add such shapes as instances of the existing instanced meshes that
    already take a per-instance color, for example the box-shaped rack bodies (`geoms.rack` with
    `mats.paint`) or the pot, soil and foliage meshes the Inbox plant uses.
  - **Otherwise:** use this document's draw-call allowance.
- **Lamp shades must not join the merged decor.** Its lamp-shade material glows with DevOps's
  occupancy (`shadeEmissiveFor('devops')` in `OfficeScene.tsx`).
- **The selection card and the readouts cannot be clicked today.**
  - Both are `pointer-events: none` (`Office3DView.tsx`).
  - The card only lists up to three `taskId · status · last operator` lines.
  - So these are all new work:
    - clickable readout lines;
    - an interactive card with buttons: Copy command, Open in Monitor, and Review & decide.
  - They are shared by SPAR-46, SPAR-47, SPAR-48 and the Val.Failed room. Whichever lands first
    builds them, and the others reuse them.
- **There is no fixed-seat system for an occupied room on main.**
  - Done's lounge seats are temporary: robots sit for `SIT_SECONDS`, then vanish.
  - Every other room seats robots at the shared desks.
  - SPAR-46, SPAR-47 and SPAR-48 all need fixed own spots. Whichever lands first builds that
    shared mechanism, and the others reuse it.

## Deploy and rollback

Client only. There is no data change, API change or migration. Roll back by reverting the PR.
