# 3D Office: the Escalation room becomes a help desk

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Roadmap item 3 · Lands after: SPAR-45
(labels and readouts by zoom level, `docs/superpowers/specs/2026-10-24-3d-office-labels-by-zoom-design.md`).
SPAR-44 (Aborted heap) has merged.

## Intent

**The room today** (phases `escalated` and `free_roam_complete`, agent `free-roam`, kind `work`):

- **Furniture:** a desk with a chair and a desk lamp (`LAMPS` in `officeLayout.ts`), a side table
  and a coat rack (`officeDecor.tsx`). Nothing says what the room is for.
- **Robots:** a task's robot sits at a desk from the shared desk layout with the `work` posture.
  Only `SCENE_DESK_LIMIT` (4) tasks per room get a desk and a robot.
- **Clicks:** selection comes from the desk, chair and screen instances. Robots and merged decor
  cannot be clicked.

**What the data says** (Claude's check of `runs/*/status.yaml`, 2026-10-24):

- **What lands here.** A task lands here when the workflow cannot go on by itself and a person has
  to decide. The read model gives an escalated task the action kind `workflow_exception`, with the
  recommended action "Open the run in Monitor and resolve the escalation."
- **How often.** Ten tasks have been escalated 13 times in all, five of them (seven times) since
  July. The last time was TASK-EAR-389 on 2026-10-12. The room is empty today and almost always.
- **Why** (Claude grouped them by reading the reasons):
  - the loop guard;
  - the execution budget ran out;
  - a runner without write access;
  - a reviewer that could not run the tests;
  - a task too big to finish;
  - an incident;
  - a real security finding.
- **How tasks leave.** Earth decides, the task is split, it is re-run in a writable workspace, or
  evidence is attached by hand.
- **How long.** Usually minutes or hours. TASK-EAR-304 waited 17 days (2026-09-05 to 09-22).
- **No structured reason.** Only the free-text reason in the history explains why.
  - The read-model contract forbids classifying `lastTransition.reason`.
  - So the room shows the reason as written, as the Aborted room does.
- **Where tasks come from.**
  - Most come from a role: the loop guard, the budget guard, or a runner that hands off.
  - The Review room's Escalate button (SPAR-47) also sends tasks here.
  - When the driver applies that decision, it writes the history row itself
    (`reconcile-decision.rb`): agent `orchestrator`, reason
    `human decision: escalate by <actor>`.
  - The real reason is the decision note, which `DecisionDialog` requires for every action except
    approve.

Earth asked Claude to propose a design (2026-10-24). Claude proposed a help desk with a signal
light. Earth then asked for more furniture, and chose concept D, "furnished help desk", from two
furnished mockups:

- D, a furnished help desk;
- E, a war room.

Earth kept the wall beacon over a tall signal tower. The mockups are in the brainstorm session at
`scratchpad/aborted-room/.superpowers/brainstorm/` (`escalation-concepts.html`,
`escalation-concepts-v2.html`, not in the repo).

## The design (as decided with Earth)

**Furniture: a furnished help desk** (Earth chose D, 2026-10-24).

- **Help desk** in the middle of the room, on a rug, with:
  - a monitor, a desk lamp and a phone;
  - a call button.
- **Seats:** the escalated robot sits on the far side. Earth's empty chair is on the near side.
- **Incident board** on the left wall: notes and strings, no text.
- **Along the walls:** a filing cabinet, a bookcase of binders, a potted plant and a floor lamp.
- **Waiting bench** near the room front, for when several tasks are escalated at once.
- **Removed:** the shared desks with their chairs, the side table and the coat rack. The desk
  lamp moves onto the help desk and stays on the per-room lamp instances (see "Lamps must not glow
  with another room").

**The signal: a rotating beacon on the back wall** (Earth, 2026-10-24).

- It is on while a task waits for a person, and off when the room is empty. The exact rule
  (`escalated` tasks only) is my call below.
- It is meant to be seen from the overview camera, because escalations are rare but each one
  waits for a person.

**What the room tells you** (zoomed in, following the SPAR-45 rule):

- **One line per task:**
  - the task id;
  - where it came from (room and role);
  - how many days it has waited;
  - its escalation reason as written, cut to two lines.
- **Clicking a task** opens the selection card with:
  - the full reason;
  - **Open in Monitor**.

  There is no new action and no server change. An escalation can be resolved in several ways
  (split, re-run, decide, attach evidence), and Monitor is where Earth does that.
- **Empty room:** the beacon is off, the room is dark, and there is no count chip.

## Calls I made (Claude), for Earth to check

**Data:**

- **"Where it came from"** is read from the structured `lastTransition`:
  - **Room:** the phase before ` -> escalated`, mapped to its room with `PHASE_TO_ZONE`, for
    example `assigned` gives Dev Bay.
  - **Role:** `lastTransition.agent`, for example `dev-2`.
  - No text is parsed. The "from" part is left out when `lastTransition` is not the transition
    into the task's current phase. It is also left out when the from-phase is in this room
    itself, for example `escalated -> escalated`.
- **The reason line** is shown only when `lastTransition` is the transition into the task's
  current phase (` -> escalated` or ` -> free_roam_complete`). This is the same guard as
  `closedNote()` for Aborted. Otherwise there is no reason line, so the room never shows an older,
  unrelated reason.
  - **Entry from outside the room:** the line is the escalation reason, as written.
  - **A transition inside the room** (free-roam's own progress, for example `escalated ->
    escalated`): the line is labelled `latest note` instead of being presented as the reason.
    Only the latest transition is kept, so the original reason is not available then.
  - **An escalation from Earth's Escalate button:** the line is Earth's decision note
    (`latestDecision.note`), not the generated `human decision: …` text. The "from" reads
    `from Review · escalated by <actor>`.
    - The rule is structured: `lastTransition.agent` is `orchestrator`, `latestDecision.decision`
      is `escalate`, the decision is applied (`decisionPending` false), and `decidedAt` is not
      later than `lastTransition.at`.
    - This needs `latestDecision` and `decisionPending` on the office task, which SPAR-47 also
      adds.
- **"How long"** is `floor((now − statusUpdatedAt) / 1 day)`, the formula the Blocked and Review
  rooms use. There is no idle threshold for these phases (`IDLE_THRESHOLD_DAYS`), so there is no
  overdue badge.
- **`free_roam_complete`** means free-roam has finished its part and the task waits to be handed
  on to dev, dev-2 or reviewer (phase label "Escalation done", from `phaseLabel` in
  `shared/statusLabels.ts`).
  - The read model gives it no action kind, so it is a hand-off, not a decision for Earth.
  - Its robot stands beside the desk instead of sitting.
  - Its readout line says `free-roam done · waiting for handoff` instead of a reason.
- **The beacon lights for `escalated` tasks only.** A room that holds only `free_roam_complete`
  tasks keeps the beacon off, because nobody has to act. Such stays have lasted minutes.
- **Count chip:** the room's task count, the SPAR-45 default. No exception is needed here.
- **Escalated tasks that also wait on Earth appear in the Blocked queue too** (SPAR-46).
  - An escalated task can carry `operator_decision`, `operator_approval` or `prod_run` waits, or
    the `authorization_required` action kind (gate actions are classified before the phase rule).
  - SPAR-46 lists every task that waits on Earth from any room, tagged with its room, while its
    robot stays in its own room. Earth chose that rule for Dev Bay tasks (2026-10-24), and the
    same rule covers Escalation.
  - So such a task sits at the help desk and is also a line in the Blocked queue, tagged
    `Escalation`. The two rooms answer different questions: what is escalated here, and
    everything that waits on Earth.

**The scene:**

- **Seats:**
  - The desk seat takes the task that has waited longest.
  - The bench has two seats.
  - A `free_roam_complete` task takes a standing spot beside the desk, up to two.
  - A task beyond its spots has no robot. It is still counted and listed.
  - These own spots replace the shared desk layout for this room.
  - There is no seat system for an occupied room on main yet. Done's lounge seats are temporary:
    robots sit for `SIT_SECONDS`, then vanish. SPAR-46 (Blocked) and SPAR-47 (Review) need the
    same kind of fixed own spots. Whichever of the three lands first builds that shared
    mechanism, and the others reuse it.
- **Posture:** robots sit still, without the typing `work` loop, because they are waiting. The
  builder picks the exact seated clip.
- **Robot moment:** when a task lands here while the page is open:
  1. its robot walks in by the room front, using the existing walk rules;
  2. it presses the call button (a short pause with the existing `interact` clip);
  3. it sits down.

  The beacon is on from the moment the data arrives, like every other room readout. It does not
  wait for the robot.
- **Leaving:** the robot walks out to its next room under the existing walk rules.
- **Beacon:**
  - It rotates slowly while on. With reduced motion it is a steady light.
  - Its color is a warm white that passes the palette rule (saturation below 0.15), never a status
    color.
  - It is a separate mesh, so it must not cast shadows: a caster costs a second draw call in the
    shadow pass.
- **Static furniture** goes through the merged decor path, so it adds no draw call:
  - Kenney models already in `dashboard/client/public/office3d/`: `desk`, `chair`,
    `bookcaseClosed`, `cabinetBedDrawer` or a similar cabinet, `pottedPlant`, `computerScreen`,
    and `lampRoundFloor` under the lamp rule below (the desk lamp stays on the per-room lamp
    instances);
  - a bench (Kenney Bench Cushion Low, https://poly.pizza/m/HVxi4kBWBe, or Quaternius Bench,
    https://poly.pizza/m/jLxjFxFRpw, both CC0);
  - the rug, the incident board and the phone as simple shapes.
- **Shadows:** the merged decor mesh already casts shadows (`officeDecor.tsx`), at no extra draw
  call, so the new furniture joins it as it is. Only new separate meshes, like the beacon, stay
  non-casting.
- **Lamps must not glow with another room.**
  - The merged decor's lamp shades share one emissive material. Its glow follows DevOps's
    occupancy (`shadeEmissiveFor('devops')` in `OfficeScene.tsx`).
  - So a lamp added to the merged decor would light up whenever DevOps is busy, even with
    Escalation empty.
  - **The desk lamp** keeps using the existing per-room lamp instances (`LAMPS` in
    `officeLayout.ts`), which glow only while Escalation holds a task, as today.
  - **The floor lamp** is added without a glowing shade, or through the same per-room lamp path.
    The builder picks, at no extra draw call.

**Interaction:**

- **Seats are click targets.** The desk seat, the bench seats and the standing spots select their
  task, the way desks do today. Robots stay non-clickable.
- **Clicking a readout line** selects that task.
- **The selection card** for an escalated task shows the full reason and **Open in Monitor**
  (`navigateTo('monitor', taskId)`).

## Goals, non-goals, anti-goals

**Goals**

- **At a glance**, from the overview: whether anything is escalated at all.
- **Zoomed in:** what is escalated, where it came from, for how long, and why.
- **One click** to the run in Monitor.

**Non-goals**

- **No new way to resolve an escalation** from the 3D Office. No server change.
- **No escalation history.** A "days since the last escalation" line would need history the
  client does not receive today. It is left out.
- **No change to the side panel,** Attention or Monitor.

**Anti-goals: it fails even if it technically works when**

- **Missed:** an escalated task sits in the room and the beacon is off.
- **Inferred:** the room classifies or rewords an escalation reason.
- **Wrong reason:** a reason is shown for a task whose last transition was not into this room.
- **Parade:** opening the page, coming back to the tab, or a stream reconnect shows robots walking
  in or pressing the button.

## Data

- **Already fetched, not yet kept:**
  - `Office3DView` already fetches `/api/review`. Each item carries `phase`, `lastTransition`,
    `statusUpdatedAt`, `title`, `actionKind` and `recommendedAction`.
  - SPAR-44 keeps `lastTransition` and `statusUpdatedAt` on the office task.
  - This room also needs `latestDecision` and `decisionPending`, which SPAR-47 adds as well.
- **Labels:**
  - `PHASE_TO_ZONE` and `ZONE_BY_ID` (`commandZones.ts`) for the "from" room;
  - `phaseLabel` (`shared/statusLabels.ts`) for "Escalation done". `runStatusLabel` gives the run
    status ("Blocked", "In progress") instead.
- **Decision state:** `latestDecision` and `decisionPending`, for escalations made with the
  Escalate button.

## Constraints

- **Scene cost:**
  - The furniture adds no draw call (merged decor).
  - The beacon adds at most one.
  - After SPAR-44 the scene measures 62 on live data and 61 on the stress run. SPAR-46 and SPAR-47
    may add up to two each.
  - So after all three the count may reach about 67, under the shared ceiling of 70. Check it on
    live data and on the 32-robot stress run.
- **Order of work:**
  - This item starts after SPAR-45 merges.
  - It does not depend on SPAR-46 or SPAR-47. All of them touch `officeTasksFromApi` and the seat
    code, so whichever lands later rebases on the others.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - **"From":**
    - the room and role come from `lastTransition` only;
    - they are left out when the last transition is not into the current phase, or comes from
      inside the room.
  - **Reason:**
    - shown as written, only for a transition into the current phase, and cut to two lines;
    - labelled `latest note` for a transition inside the room;
    - Earth's decision note for an Escalate-button escalation, under the structured rule above.
  - **Blocked overlap:** an escalated task with an Earth wait is listed in the Blocked queue,
    tagged `Escalation`, and sits at the help desk.
  - **`free_roam_complete`:** a standing spot and the `waiting for handoff` line.
  - **Seats:**
    - the desk takes the longest wait;
    - two bench seats and two standing spots;
    - a task beyond them is listed with no robot.
  - **Beacon:**
    - on with at least one `escalated` task;
    - off when the room is empty or holds only `free_roam_complete` tasks;
    - steady under reduced motion.
  - **Lamps:** with Escalation empty and DevOps busy, no Escalation lamp glows.
  - **Room:** no shared desk, side table or coat rack in Escalation. The new furniture is present
    and merged.
  - **Clicks:** a seat or a readout line selects the task, and the card shows Open in Monitor.
  - **No movement:** on first load, snap or reduced motion, nothing walks or presses.
- **Live check before merge:**
  - overview and zoomed screenshots, with a client-side mock of an escalated task (the room is
    empty in live data);
  - the empty room on live data;
  - a mocked arrival with the walk, the button and the beacon;
  - the card with the reason and Open in Monitor;
  - draw calls and fps on live data and on the stress run.

## Left to the builder

- **Placement:** the exact positions of every piece of furniture, within the walk and the room
  front.
- **Beacon:** its size, rotation speed and glow, and the pause length at the button.
- **Look:** the seated clip, and the cabinet model choice.

## Open risks

- **Rare use.** The room is empty almost all the time, so the furniture has to read well without
  robots. Check the empty room live.
- **Glare.** The beacon must stand out from the overview without washing out the neighbouring
  Review room, which has glass walls. Check it live at the default camera.
- **Long escalations.** An escalation like TASK-EAR-304's 17 days shows only as a day count. There
  is no overdue rule for these phases.

## Deploy and rollback

Client only. There is no data change, API change or migration. Roll back by reverting the PR.
