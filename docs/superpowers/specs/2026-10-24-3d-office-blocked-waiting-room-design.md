# 3D Office: the Blocked room becomes a waiting room for Earth's queue

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Roadmap item 1 · Lands after: SPAR-44
(Aborted heap, `docs/superpowers/specs/2026-10-24-3d-office-aborted-heap-design.md`) and SPAR-45
(labels and readouts by zoom level, `docs/superpowers/specs/2026-10-24-3d-office-labels-by-zoom-design.md`)

## Intent

Today the Blocked room says only that tasks are stuck:

- **Robots:** a blocked task's robot sits at a desk from the shared desk layout
  (`desksForZone`/`sceneDesks` in `officeSelection.ts`) with the `blocked` posture (sit +
  `emote-no`).
  - Only `SCENE_DESK_LIMIT` (4) tasks per room get a desk and a robot.
  - Blocked has six tasks today, so two of them have no robot.
- **Clicks:** selection comes from the desk, chair and screen instances. Robots and merged decor
  cannot be clicked.
- **Furniture:** desks with screens (`SCREENS` in `officeLayout.ts`) and three cardboard boxes
  (`officeDecor.tsx`).
- **Information:** nothing says who each task waits on, for how long, or what to do about it.
  The selection card has no link and no command.

Earth wants the room to answer one question: **"which tasks are waiting for me to approve, so I
can act on them right away"** (Earth, 2026-10-24).

On 2026-10-24 the live data has eight tasks that matter here. Six wait on Earth, two wait on
someone else in the Blocked room:

| Task | Room | Waits on (structured) | Since last status change |
|---|---|---|---|
| TASK-VS-004 | Dev Bay | `operator_decision`, `operator_approval` | 28–29 days |
| TASK-EAR-391 | Blocked | `prod_run` ref TASK-EAR-402 | 15 days |
| TASK-EAR-368 | Blocked | `prod_run` | 14 days |
| TASK-EAR-309 | Blocked | `prod_run` | 12 days |
| TASK-EAR-402 | Blocked | `prod_run` (its own run), actionKind `authorization_required` | 9 days |
| TASK-EAR-406 | Dev Bay | `operator_approval`, `prod_run` ref TASK-EAR-402, actionKind `authorization_required` | 9 days |
| TASK-EAR-369 | Blocked | `aws_permission` | 12 days |
| TASK-EAR-349 | Blocked | `aws_permission` | 12 days |

A ninth task, TASK-EAR-384 in Dev Bay, waits on `qa`. It is not listed, because it waits on
someone else and is not in the Blocked room (see "Calls I made").

Only TASK-EAR-402 and TASK-EAR-406 carry a command today: their `recommendedAction` is
`ruby scripts/record-authorization.rb … grant …`. The others carry prose, for example "Resolve the
recorded blocker before dispatching another role."

Earth chose concept B, "waiting room", from three mockups:

- A, a roadblock;
- B, a waiting room;
- C, a sign-off desk.

The mockups are in the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
(`blocked-concepts-v3.html`, not in the repo).

## The design (as decided with Earth)

**Who counts as "waiting on you" (Earth, 2026-10-24):**

- **On Earth:** `prod_run`, `operator_decision` and `operator_approval` waits, and the
  `authorization_required` action kind.
- **On someone else:** `aws_permission` waits. Earth does not grant AWS permissions.
- **Tasks in other rooms count too.** The room counts and names tasks that wait on Earth from any
  room, for example TASK-EAR-406 and TASK-VS-004 in Dev Bay.
- **Their robots stay where their phase puts them.** The Blocked room only counts and names them.

**What "act on it" means (Earth, 2026-10-24):**

- Clicking a task that waits on Earth takes Earth to the command to run.
- The dashboard does **not** grant or approve anything itself. There is no new write path and no
  server change.

**The room: a waiting room.**

- **Front row:** chairs face a queue board on the back wall. These seats are the queue of tasks waiting
  on Earth.
- **Bench:** a bench near the front of the room holds the robots waiting on someone else.
- **Wall:** a wall clock, and a closed door on a wall.
- **Robot moment:** when a task leaves the Blocked room, its robot stands up and walks out to its
  next room, using the existing walk rules.

**Readout (zoomed in, following the SPAR-45 rule):**

- **Header:** `waiting on you · N`.
- **One line per task:** the task id, what it waits on, and how long.
  - A task outside the Blocked room is tagged with its room, for example `Dev Bay`.
  - A task whose only wait is another listed task sits under that task, for example
    TASK-EAR-391 under TASK-EAR-402.
- **After that:** `waiting on others · M`, with the same columns, in a dimmer color.

**Card when a waiting task is selected:**

- **Wait line:** "Waiting on you · 9d · …".
- **The task has a command:** the command line with a **Copy command** button, the same
  `CommandCopy` that Attention and Monitor use. TASK-EAR-402 and TASK-EAR-406 are examples.
- **The task waits on another task:** a button that selects that task. TASK-EAR-391 is an
  example: "Waiting on TASK-EAR-402", with a button to go to TASK-EAR-402.
- **The task has no command:** the card says so plainly, "No command recorded for this wait".
- **Every waiting task:** an **Open in Monitor** button (`navigateTo('monitor', taskId)`).

## Calls I made (Claude), for Earth to check

**Data and classification:**

- **A release train's own prod run still counts as waiting on Earth.**
  - `isOwnRunWait` (`dashboard/shared/waitKinds.ts`) marks it as "the act, not something that act
    unblocks", and Attention leaves it out of "What unblocks work".
  - But running prod needs Earth's approval, so TASK-EAR-402 counts.
- **Other wait kinds:**
  - `qa` and `external` count as "waiting on others".
  - The read model does not say who grants them. This is my guess, not Earth's.
- **"Waiting on others" lists only tasks in the Blocked room.** A task in another room that waits
  only on someone else is not Earth's queue and is not listed. TASK-EAR-384 is an example: it is
  in Dev Bay and waits on `qa`.
- **A blocked task with no `waits_on` recorded:**
  - It goes on the bench and is listed under "waiting on others" as `wait not recorded`.
  - It is not counted as waiting on Earth, because the data does not say so.
  - A task in another room with no waits and no `authorization_required` is not listed at all.
- **"How long"** is the age of `statusUpdatedAt` (status.yaml `updated_at`, already in the
  `/api/review` response), in whole days. It is the same basis as the room's existing "Oldest
  wait" line ("since the last status change").
- **Short wait labels** to fit the readout:

  | Wait | Label |
  |---|---|
  | `prod_run` | prod run |
  | `operator_decision` | decision |
  | `operator_approval` | approval |
  | `authorization_required` | grant |
  | `aws_permission` | AWS permission |
  | `qa` | QA |
  | `external` | external party |

  - The card uses the full `WAIT_KIND_LABEL` text.
  - "grant" comes from the action kind only. The grant's name sits in the command text, and the
    dashboard must not parse free text.
- **Chains:**
  - A task goes under another task only when every wait it has is a `ref` to that task, and that
    task is in the list.
  - TASK-EAR-406 also waits on Earth's `operator_approval`, so it keeps its own line.
  - When the referenced task is not in the list, for example because it closed, the task gets
    its own line.
- **Order:**
  - Longest wait first, by each line's own age.
  - A task under another task keeps its own age, even when it is older than its parent
    (TASK-EAR-391 15d under TASK-EAR-402 9d).

**The scene:**

- **The board shows no text.**
  - Text in the 3D scene costs a texture and draw calls, and the readout already carries the
    names.
  - It shows one lit bar per task waiting on Earth, including tasks in other rooms, up to a cap.
  - When that count drops, one bar blinks and goes out.
  - The mockup said the board "calls the task's number". This replaces that.
- **Desks and screens are removed from Blocked**, the way SPAR-41 and SPAR-44 removed them from
  Done and Aborted. The cardboard boxes go too.
- **Robots keep the `blocked` posture** (sit + `emote-no`) on the chairs and the bench.
- **Blocked gets its own seats instead of desks**, the way the Done lounge has its own seats.
  - Four chairs face the board (the Earth queue) and the bench has three seats, so up to seven
    Blocked robots. This replaces the shared limit of four desks for this room only.
  - The Earth queue fills the chairs, longest wait first. Tasks waiting on others take the bench.
  - A Blocked task beyond its group's seats has no robot. It is still counted and listed.
  - Robots are instanced, so more robots do not add draw calls.
- **A task that changes group re-seats in place.** When a Blocked task's waits change between "on
  Earth" and "on others", its robot moves to its new seat with no walk. That is the existing rule
  for a seat change inside the same room (`planMove`, SPAR-39). Walking from a chair to the bench
  would be new behaviour, so it is left out.
- **Robots leave by the room front,** the open +z side (`roomFront`). The existing walk rules
  already use it. The neon strip from Dev Bay is a floor strip, not a doorway.
  - The board goes on the back wall, which the chairs face.
  - The closed door goes on the left (−x) wall, which shows from the default camera.
  - The bench sits near the front.

**Interaction:**

- **Seats are click targets.** The queue chairs and the bench seats select their task, the way
  desks, chairs and screens do today.
  - The chairs can reuse the existing chair instances, at no extra draw call.
  - The bench seats get per-seat hit boxes.
  - Robots stay non-clickable.
- **Clicking a readout line selects that task**, with the same selection a desk click makes.
  This matters for TASK-EAR-406 and TASK-VS-004, which have no robot in the Blocked room.
- **The card's waiting block shows in every room.** Selecting TASK-EAR-406's desk in Dev Bay
  shows the same block and command as clicking its readout line.
- **Readout and card, with SPAR-45:**
  - The readout hides only when the Blocked room itself is selected, as SPAR-45 says for a room
    selection.
  - Selecting a task keeps the readout, from a line, a seat or a desk in another room. The
    selected line is highlighted and the card is placed so it does not cover the readout. So
    "Go to TASK-EAR-402" keeps the list on screen.
  - When the Blocked room is selected, the room card lists the tasks in readout order: the Earth
    queue first, including tasks from other rooms with their room tag, then the others.
- **Count chip:**
  - The Blocked room's chip is the number of tasks waiting on Earth, including other rooms.
  - This is an exception to the SPAR-45 rule that an open room's chip is its task count.
  - When nothing waits on Earth, the chip hides, even if tasks wait on others.
- **Empty state:** no task waits on Earth. The front row is empty, the board is dark and the
  chip is hidden. Robots waiting on others still sit on the bench.

## Goals, non-goals, anti-goals

**Goals**

- **At a glance:** the overview chip says how many tasks wait on Earth, and the room shows them
  as a queue in front of a board.
- **Zoomed in:** the readout lists exactly which tasks wait on Earth, on what, and for how long,
  across all rooms.
- **One click** from a waiting task to the command to run, or to the task that has to move
  first.

**Non-goals**

- **No approving or granting from the dashboard.** No server change and no new write path.
- **No change to how phases map to rooms.** Robots of waiting tasks in other rooms stay in those
  rooms.
- **No change to the side panel, Attention or Monitor.**

**Anti-goals: it fails even if it technically works when**

- **Wrong side:** a task waiting on someone else is shown as waiting on Earth, or the reverse.
- **Inferred from text:** the room reads a reason or command text to decide anything.
- **Missing command:** a command is copied from somewhere other than the task's own
  `recommendedAction`. Or the card shows a command for a task that has none.
- **Missing task:** a task waiting on Earth in another room is missing from the readout.
- **Stranded child:** a chained task disappears because its parent closed.

## Data

- **Already fetched, not yet kept:**
  - `Office3DView` already fetches `/api/review`, and each item carries `waitsOn`,
    `isReleaseTrain`, `actionKind`, `recommendedAction`, `statusUpdatedAt`, `title` and `phase`.
    No new request is needed.
  - But `officeTasksFromApi` (`officeSelection.ts`) keeps only a few of these fields. SPAR-44
    adds `lastTransition` and `statusUpdatedAt`. This item adds `waitsOn`, `isReleaseTrain`,
    `actionKind` and `recommendedAction` to the office task.
- **Wait kinds and labels:** `dashboard/shared/waitKinds.ts` (`WAIT_KINDS`, `WAIT_KIND_LABEL`,
  `isOwnRunWait`).
- **Command display:** `isShellCommand` and `CommandCopy` in
  `dashboard/client/src/views/CommandCopy.tsx`.
- **Navigation:** `navigateTo` in `dashboard/client/src/navigation.ts`.

## Constraints

- **Scene cost:**
  - Static props go through the merged decor path: the bench frame, board frame, clock and door.
  - This item adds at most two draw calls: the board bars, and the chair instances if the builder
    uses `chair.glb`.
  - SPAR-44 measured 62 draw calls on live data and 61 on the stress run (Claude's live review,
    2026-10-24), so this item may reach about 64.
  - Draw calls must stay under the shared ceiling of 70, on both live data and the 32-robot
    stress run.
- **Assets:**
  - Chairs: the clickable chair instances use the Kenney `chairDesk` model (`officeProps.ts`).
    The Kenney `chair.glb`, already in `dashboard/client/public/office3d/`, looks more like a
    waiting room. It would need its own clickable instances, possibly one more draw call. The
    builder picks, within the draw-call limit above.
  - Bench: Kenney Bench Cushion Low, CC0 (https://poly.pizza/m/HVxi4kBWBe), or a Quaternius
    bench, CC0 (https://poly.pizza/m/jLxjFxFRpw).
  - Board, clock and door: simple shapes, no new model.
  - Everything is recolored through the decor buckets under the palette rule. The board bars are
    a neutral warm white, never the amber status color.
- **Order of work:**
  - This item builds on SPAR-45's readout placement and chip.
  - It starts after SPAR-45 merges, which itself waits for SPAR-44.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - **Classification:**
    - `prod_run` (including a release train's own run), `operator_decision`,
      `operator_approval` and `authorization_required` count as waiting on Earth;
    - `aws_permission`, `qa` and `external` count as waiting on others;
    - a blocked task with no waits is `wait not recorded` and is not counted.
  - **Other rooms:** a task in another room that waits on Earth is listed, with its room tag,
    and its robot stays in its own room.
  - **Chains:**
    - a task whose waits all reference a listed task goes under it;
    - a task with its own Earth wait keeps its own line;
    - a task whose reference is not listed gets its own line.
  - **Order:** longest wait first, and a child keeps its own age.
  - **Chip:** the count waiting on Earth; hidden at 0, even with others waiting.
  - **Board bars:** they equal that count, up to the cap.
  - **Card:**
    - the command with Copy when `recommendedAction` is a shell command;
    - "Go to" for a chained task;
    - the "no command" line and Open in Monitor otherwise.
  - **Room:** no desks or screens in Blocked; Earth-queue robots on chairs, the others on the
    bench.
  - **Seats:**
    - up to four chair robots and three bench robots;
    - the longest Earth waits get the chairs;
    - a task beyond its group's seats has no robot but stays listed;
    - a group change re-seats with no walk.
  - **Clicks:** clicking a line, a chair or a bench seat selects that task.
  - **Selection and readout:**
    - the readout stays, with that line highlighted, while a task is selected;
    - it hides while the Blocked room itself is selected;
    - the room card lists tasks in readout order.
  - **"Waiting on others":** a task in another room that waits only on others is not listed.
- **Live check before merge:**
  - overview and zoomed screenshots on live data;
  - the card for TASK-EAR-402, TASK-EAR-391 and TASK-EAR-368;
  - clicking TASK-EAR-406 from the readout;
  - a robot leaving the queue;
  - draw calls and fps on live data and the 32-robot stress run.

## Left to the builder

- **Room layout:** the exact chair, bench, board, clock and door positions, and the bar cap.
- **Seat order:** how robots are ordered on the chairs and the bench when ages tie.
- **Bar blink:** the timing, and how the blink shows with reduced motion.
- **Off-screen card:** where the card sits when the selected task's robot is off screen, for
  example a Dev Bay task picked from the Blocked readout. The card must stay visible.
- **Readout columns:** the widths and truncation.

## Open risks

- **Overlap with Escalation (roadmap item 3).** The roadmap planned Escalation as "how many need
  Earth's decision/approval". This room now holds the per-task queue of Earth's waits from every
  room. When item 3 is designed, decide what Escalation shows so two rooms do not count the same
  thing.
- **Guessed owners.** `qa` and `external` are treated as "others" without Earth confirming it.
- **The bench can look like the queue.** If Earth-queue and bench robots are hard to tell apart
  in the night look, the readout carries the truth. Check it live.
- **Seven robots in one room.** Blocked can now hold up to seven robots where other rooms hold
  four. Check the stress run with a full Blocked room for crowding and frame time.

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
