# 3D Office: Dev Bay becomes an office with a kanban whiteboard

Status: approved direction (Earth, 2026-10-25, mockup O3). Roadmap item 7 had been "leave as is" on
2026-10-24. Earth reopened it on 2026-10-25, after every other room was renovated (SPAR-41..52).

## Intent

**The room today** (zone `dev`, label "Dev Bay", phase `assigned`, room at (0, 7)):
- It is the busiest room: 10 tasks live on 2026-10-25.
- **Only 4 robots are drawn.** The shared desks draw 4 robots (`SCENE_DESK_LIMIT`) because the room
  has no seats of its own.
- **No readout.** It has no readout of its own, so zooming in shows nothing about the tasks.
- **Furniture:** two Kenney bookcases and two cardboard boxes along the back wall.

**What Earth wants** (2026-10-25):
- **What the room is:** Dev Bay is where work is being done once a task is under way. It is not a
  room for stuck work.
- **The glance signal:** at a glance, how far each task has got through its completion gates.
- **The look:** the room should read as an office ("ห้องทำงาน").
- **The layout:** Earth picked mockup O3: an office with four desks, a meeting table, and a kanban
  whiteboard on the back wall.
- **Server change allowed:** Earth allowed one (2026-10-25).

**What the data says** (Claude's check, 2026-10-25):
- **Tasks pass through fast.** Of 176 recorded stays in `assigned`:
  - the median stay is minutes and 90% leave within about 7 hours;
  - exits go to in_review 251, done 39, review 26, blocked 17, escalated 6 and aborted 4.
- **Why it fills up anyway:** work happens in the agents' own sessions, and the status changes when
  they report. The tasks that stay are the ones the room is about.
- **The 10 tasks now fall into three groups:**
  - **waiting on someone:** VS-004 (no gates, waits on Earth for 30 days), EAR-384 (3/4, waits on
    QA), EAR-406 (0/2, waits on approval and a prod run);
  - **all gates resolved but still in the room:** VS-041 (4/4), VS-042 (2/2), EAR-416 (1/1);
  - **moving:** EAR-401 (0/1), VS-043, VS-044 and VS-046 (each 0/2).
- **Completion gates are the progress signal.**
  - 9 of the 10 have gates. Each gate has a name and a status, and a pass carries the actor, the
    reason and evidence (for example VS-041: `implementation_verification` → `deploy_staging` →
    `staging_acceptance` → `knowledge_closeout`).
  - Gate names seen across all runs: `implementation_verification` (39), `deploy_staging` (30),
    `staging_acceptance` (30), `deploy_production` (20), `production_acceptance` (20),
    `authenticated_staging` (8), `shared_lib_publication` (7), `knowledge_closeout` (7),
    `train_prepared` (1), `prod_boot_acceptance` (1) and `product_contract`.
- **Who is working on it.** The role (`currentAgent`) is known for every task: dev, dev-2, devops
  or debugger, so the room holds all roles. The AI tool is rarely recorded: `history[].operator`
  has 17 entries in total, and only VS-046 has a conductor today. The room therefore shows the role,
  not the tool.
- **Nothing runs from the dashboard.** The launcher has 4 records ever, and the run queue is empty.
  "Working right now" cannot be observed, so the room does not claim it.

## The design (as decided with Earth)

**The kanban whiteboard** on the back wall:
- **Columns** follow the gate each task needs next. In mockup O3 they were ตรวจ → staging → prod →
  ครบ → ไม่มี gate; this doc adds ปิดงาน, see Calls.
- **One sticky note per task** in the room, placed in the column of its next gate.
- **Dots on each note:** one per gate, inked when resolved. No text on the board. The task ids are
  in the readout.
- **A note moves** to the next column when its next gate resolves.

**The office** (O3):
- **Desks:** four workstations, each with a monitor, a desk lamp and a mug.
- **Meeting area:** a meeting table with chairs.
- **Along the walls:** bookcases, a filing cabinet, a printer, a water cooler and plants.
- **Floor and window:** carpet tiles, and a window with blinds on the left wall.

**Zoomed in** (the SPAR-45 rule), one readout `dev bay · N`, one line per task:
- the task id and its role (`currentAgent`, as written);
- one small cell per gate, lit when resolved;
- the next gate's name, `gate ครบ · รอย้ายออก` when all have resolved, or `ไม่มี gate`;
- a second line naming what it waits on, when `waitsOn` is set (for example `รอ QA`,
  `รอ Earth อนุมัติ`).

**Clicks:**
- **What selects the task:** a note, a readout line, or a desk.
- **The card shows:**
  - the task's gates in order, each with its state;
  - Open in Monitor;
  - the shared `WaitBlock` when the task waits on Earth (SPAR-46).

**The moment** (Earth confirmed): when a gate resolves, a robot walks to the whiteboard, the note
moves to its new column, and the robot walks back.

**Which tasks get the four robots** (Earth decided, 2026-10-25, after the builder check): the most
recently active tasks.
- **Why the shared rule doesn't fit:**
  - Every other room seats its oldest tasks first: `zonePreview` in `commandZones.ts` sorts urgent
    tasks first, then by oldest `updatedAt`.
  - In Dev Bay that seats the tasks that wait on someone. Today that is VS-004, EAR-384, EAR-401 and
    EAR-406.
  - A gate write sets `updated_at` (`scripts/update-completion-gate.rb`), so the task that just
    moved would leave its desk on the same snapshot, and its robot would walk out instead of to the
    board.
- **Dev Bay's rule:** urgent tasks first, as everywhere, then the newest `updatedAt` first, then task
  id.
  - A task whose gate just resolved stays seated, so its robot is the one that walks to the board.
  - Tasks that have waited a long time are shown on the whiteboard only.
- **Scope:** every other room keeps its rule.

## Calls I made (Claude), for Earth to check

Earth read the first eight calls below and agreed to all of them (2026-10-25). The calls after the
builder check are marked "(builder check)".

- **A sixth column, ปิดงาน, for `knowledge_closeout`.**
  - Mockup O3 grouped it under ครบ, but a task whose next gate is the closeout is not done.
  - Putting it under ครบ would show work as finished early, the anti-goal SPAR-51 kept for its
    board.
  - Today no task in the room has the closeout as its next gate.
- **Column of each gate name:**
  - **ตรวจ:** `implementation_verification`, `product_contract`, `shared_lib_publication`,
    `train_prepared`;
  - **staging:** `deploy_staging`, `staging_acceptance`, `authenticated_staging`;
  - **prod:** `deploy_production`, `production_acceptance`, `prod_boot_acceptance`;
  - **ปิดงาน:** `knowledge_closeout`.
  - A gate name the map does not know goes to ตรวจ, and the readout shows its real name.
- **The next gate:** the first unresolved gate in `completion_gates` order.
  - Gate views keep the status.yaml order (`scripts/completion-guard.rb` `gate_view`).
  - `resolved` comes from the done guard, so `na` counts as resolved, as in the counts the room
    already uses.
- **Unreadable gates:** the note goes to the last column, which is labelled
  `ไม่มี gate / อ่านไม่ได้`. The readout says `gates unreadable`, the same rule as SPAR-51.
- **Order within a column:** by task id, so notes never shuffle when dates change (SPAR-51).
- **Capacity:**
  - Each column shows at most 5 notes. More than that fills a sixth slot.
  - The readout always lists every task.
  - The builder check found that the scene cannot draw `+N` text, so the sixth slot is a small
    stack of notes; see the call below.
- **Dots:** at most 6 per note. A longer gate list scales as on the DevOps board: `floor`, and full
  only when every gate has resolved.
- **Which robot walks:**
  - When the task has one of the 4 drawn robots, that robot walks.
  - Otherwise no robot walks and the note slides on its own. The room never borrows another task's
    robot.
- **Guards on the moment:**
  - It plays once, and only on a live change.
  - Not on first load, a hidden tab or a stream gap. Reuse the Review line's guards in
    `officeCatchUp.ts`.
  - With reduced motion the note jumps.
- **The desks move to a front row,** like DevOps (`deskZ('dev')`, around 0.8). The board and the
  meeting table then have the back two thirds of the room.
- **Role, not tool:** the readout names the role. The AI tool appears only where `operator` is
  recorded, as the card already shows ("last operator").
- **(builder check) Four fixed workstations, 2 + 2 with a centre aisle.**
  - **The problem:** the shared desk row cannot keep a walk to the board clear. `deskGap`/`deskLocalX`
    in `officeLook.ts` put 4 desks at x ±0.475 and ±1.425, which leaves gaps of about 0.1 and side
    lanes of about 0.21. The walk needs a clearance of 0.2 on each side.
  - **Dev Bay gets its own desk layout:**
    - four workstations, always drawn, as in mockup O3;
    - two on each side of a centre aisle that leads to the board;
    - a workstation without a task has no robot and a dark monitor.
  - **Scope:** every other room keeps the shared row. Desk poses, character slots and selection
    anchors for `dev` follow the new layout.
- **(builder check) The walk plays on every resolved gate, not only on a column change.**
  - The robot walks to the board and back each time.
  - At the board, the note moves when its column changed. Otherwise its dot inks when the robot
    arrives.
  - This matches what Earth confirmed: "when a gate resolves, a robot walks".
- **(builder check) No text in the scene.**
  - The scene has no 3D text, and names and readouts are HTML overlays.
  - So the overflow is not a `+N` note. A column holds 5 notes plus a sixth slot, a small stack of
    notes that means "more".
  - The readout's head line gives the exact count for each column, for example
    `ตรวจ 4 · staging 1 · prod 1 · ปิดงาน 0 · ครบ 3 · ไม่มี 1`.
  - The sight-line test covers all 6 × 6 slots.
- **(builder check) One gates block for every card.**
  - The SPAR-51 `GatesBlock` keeps its `gates x/y` line and adds the ordered list below it, one
    line per gate with its name and state (pass, na or pending).
  - It is used wherever the block shows today (open release trains, in any room) and for every Dev
    Bay task with gates. EAR-406 is both, and gets one block.
  - The SPAR-51 card test is extended, not loosened: it still checks the `gates x/y` line.
- **(builder check) `items` carries the status too:** `{ name, status, resolved }`. Then `na` shows
  as na rather than as pass. The column logic still uses `resolved`.
- **(builder check) Notes and dots get one instanced mesh of their own.**
  - It is not emissive, has no shadow and uses per-instance colors.
  - It is driven imperatively, the way SPAR-51's `ReleaseBoardLights` is, so a note can slide.
  - `rackBody` is set from React props and has no per-frame path. That is why it is not used.
  - This is the room's one draw call: 66 → 67.
- **(builder check) `assigned_parallel` shares the room.** ครบ means "every gate resolved" and says
  so (`gate ครบ`). A parallel task can still have open branches that the done guard waits on. That
  has happened in 5 runs ever, so it stays a known gap (see Open risks).

## Goals, non-goals, anti-goals

**Goals**
- From the overview, see where the room's work is piling up: which columns hold notes, and how
  full each one is. The exact counts are in the readout.
- Zoomed in, read each task's role, how many gates have resolved, and the next gate's name.
- Tasks whose gates have all resolved stand out, because they sit in a column of their own.
- The room reads as an office.

**Non-goals**
- Showing which AI tool works a task when it is not recorded.
- Claiming that a task is being worked on right now.
- Drawing a robot for every task. The 4 desks stay. The board covers every task.
- Gate names on the board itself.

**Anti-goals: it fails even if it technically works when**
- A task shows as done (ครบ) before every gate has resolved.
- Notes reshuffle or the board flickers when nothing changed.
- A note hides behind furniture from the default camera (the SPAR-51 rack lesson).
- The readout covers a room name (SPAR-52).
- The room turns into a lab or a factory instead of an office.

## Data

**Server change** (Earth allowed, 2026-10-25):
- **Where:** `ReviewSummary.gates` gains an ordered list of the task's gates. In
  `dashboard/server/src/services/reviewModel.ts`, add `items: { name: string; resolved: boolean }[]`
  next to `total`/`resolved`/`passable`.
- **Source:**
  - It is projected from `gateView.gates` (`GateEntry.name`, `GateEntry.resolved`), which the
    server already loads for every task with `completion_gates`.
  - It is a projection only. Nothing is derived from prose.
  - An unreadable view keeps `items: []`.
- **Types and contract:**
  - Update `dashboard/shared/types.ts`.
  - Update the read-model contract. `schemas/run-summary.schema.yaml` defines `gates` with
    `additionalProperties: false` (around lines 227–250), so `items` has to be added there. Update
    `docs/run-summary-read-model.md` if it lists the fields.
  - The item shape is `{ name, status, resolved }`, from `GateEntry.name`, `.status` and
    `.resolved`.
- **Server tests** (`node --test`, seen failing first):
  - `items` follows `completion_gates` order;
  - `na` keeps its status and reads as resolved;
  - unreadable gives `[]`;
  - a task without gates still has no `gates`.
- **Existing server tests to extend, not loosen:** `reviewModel.test.ts` compares the whole `gates`
  object with `deepEqual` in several places (around lines 261, 292, 456, 482, 497, 505 and 509).
  Each gets the expected `items`.

**Already on the office task:**
- `currentAgent`, `operator`, `waitsOn` and `gates` counts;
- `lastTransition`, `statusUpdatedAt`, `actionKind` and `recommendedAction`.

**Shared pieces on main to reuse, not rebuild:**
- the list readout (`o3d-queue` / `o3d-eline`, `LIST_READOUTS`) and the placement of SPAR-52:
  names stay in their room, a readout that cannot clear one shrinks and scrolls;
- `o3d-card live`, `WaitBlock` and the gates card block from SPAR-51 (`GatesBlock`);
- the SPAR-51 helpers for gates: `litSegments`-style scaling, unreadable handling, task-id order;
- `officeCatchUp.ts` guards; the character walk (`planMove`) and its clearance tests;
- the sight-line test of SPAR-51 (`officeDevops.test.ts`, "the board from the default camera").

## Constraints

- **Scene cost:**
  - Main measures 66 draw calls on live data and on the stress run (2026-10-24, after SPAR-51 and
    SPAR-52). The ceiling is 70.
  - **Budget for this room: +1 at most.**
  - **Notes and dots:** one instanced mesh of their own, with per-instance colors, not emissive and
    no shadow. It is driven imperatively so notes can slide. This is the room's +1 (66 → 67).
    Nothing on the board glows.
  - **Whiteboard, meeting table, chairs, bookcases, cabinet, printer, cooler, carpet, window
    blinds:** merged decor (wood, metal, fabric), or the Kenney models already in
    `dashboard/client/public/office3d/`. Those are `desk`, `chairDesk`, `table`, `chair`,
    `bookcaseOpen`, `bookcaseClosed`, `cabinetBedDrawer`, `pottedPlant`, `coatRackStanding`,
    `trashcan` and `computerScreen`. They are CC0 and recolored through the decor buckets.
  - **No new mesh casts a shadow.**
- **Traps known from earlier rooms:**
  - **Colors:** the merged decor has only three colors, so small colored pieces (notes, mugs,
    plants) use per-instance-colored meshes.
  - **Lamp shades:** the merged decor's lamp-shade material glows with DevOps
    (`shadeEmissiveFor('devops')`). Desk lamps here must not use that bucket.
  - **Hidden corner:** the near +x wall hides anything past local x ≈ 1.2 from the default camera.
  - **Occlusion:** the board must pass a sight-line test like SPAR-51's. No piece may stand
    between a note slot and the default camera (offset (24, 20, 20.5)).
- **Furniture placement:**
  - The existing bookcases and boxes on the back wall move, because the whiteboard takes that wall.
  - The desks, chairs and seated robots keep the shared clearance from every piece, with 0 to 4
    tasks.
  - So does every walk: into a seat, out of it, and along the centre aisle to the board and back.
- **Order of work:** branch from the newest `origin/main` (`53510863` or later).
  - It touches shared files: `officeLabels.ts`, `officeLayout.ts`, `officeDecor.tsx`,
    `Office3DView.tsx`, and `deskZ` in `officeReception.ts`.
  - Merge `main` in if another PR lands first. Never rebase or force-push after the PR opens.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - **Columns:**
    - the next gate decides the column;
    - all resolved → ครบ;
    - no gates or unreadable → the last column;
    - `knowledge_closeout` next → ปิดงาน;
    - an unknown gate name → ตรวจ.
  - **Notes:**
    - task-id order inside a column;
    - at most 5 notes, then the stack in the sixth slot;
    - the readout head line counts every column;
    - dots follow `items`, scaled past 6, full only when all resolved;
    - a resolved gate in an earlier column does not reorder others.
  - **Desks:** four workstations at all times in the 2 + 2 layout; an empty one has no robot and a
    dark monitor; other rooms keep the shared row.
  - **Seating:**
    - Dev Bay seats urgent tasks first, then the newest `updatedAt`, then task id;
    - every other room keeps oldest first;
    - with more than 4 tasks, a task whose gate write bumps its `updated_at` stays seated and walks
      to the board, and does not leave the room.
  - **Readout:** one line per task with role, cells and next gate name; the wait line when `waitsOn`
    is set; it never covers a room name (SPAR-52 sweep).
  - **Clicks:** a note, a line and a desk each select the task; the card lists the gates in order
    with Open in Monitor; a task waiting on Earth also gets `WaitBlock`.
  - **Moment:**
    - a resolved gate walks the task's own robot to the board and back, once;
    - the note moves when its column changed, and only its dot inks when it did not;
    - no walk on first load, a hidden tab, a stream gap or reduced motion (the note jumps);
    - a task without a drawn robot slides its note.
  - **Sight line:** every slot (6 columns × 6 slots) is visible from the default camera, and the test
    fails when a piece stands in front.
  - **The gates block:** the `gates x/y` line stays, followed by one line per gate in order with
    its state, for trains in any room and for Dev Bay tasks.
  - **Clearance:** desks, chairs, seated robots and walks keep clear of the furniture.
  - **Existing tests to rewrite, not loosen,** if they pin Dev Bay's decor (bookcase and box
    placements) or desk z.
  - **Time zone:** any date-only test sets a non-UTC zone inside the test (`inBangkok()`), because
    `npm test` pins `TZ=UTC`.
- **Live check before merge:**
  - **Live data, overview and zoomed:** the board shows today's spread (ตรวจ 4 · staging 1 · prod 1 ·
    ครบ 3 · none 1, or whatever is live then). The readout lists all tasks.
  - **A client-side mock of a gate resolving:**
    - it changes `gates.items` and `updatedAt` together, as a real gate write does;
    - one walk and one note move;
    - none on reload or with reduced motion.
  - **A mock with 8+ tasks in one column** shows the `+N` note.
  - **Draw calls and fps** on live data and the stress run: main +1 at most.
  - **Servers:** never stop or restart the dashboard on ports 4310 or 3001, and never use
    `pkill`/`killall` by name. Use your own `DASHBOARD_PORT` and kill only your own PID.

## Left to the builder

- **Placement:** exact furniture positions and `deskZ('dev')`, within the limits above.
- **Look:**
  - note size, colors (paper tones, not status colors) and dot size;
  - the column labels as small printed cards or no labels at all (text in the scene is optional; the
    readout carries the names);
  - the window and the blinds.
- **The walk:** its path and timing, and whether the robot pauses at the board.

## Open risks

- **Columns crowd.** If many tasks share one column (8+ in ตรวจ), the stack hides who is there
  until zoomed. The readout lists all of them and counts each column.
- **Parallel tasks.** A task in `assigned_parallel` can show ครบ while the done guard still waits
  on its branches. The read model has no branch state, and that has happened in 5 runs ever.
- **Next gate by file order.** A gate list with `after` dependencies might name a next gate that
  cannot pass yet. The readout shows its name honestly. A smarter "next" is out of scope.
- **Notes that sit in ครบ.** Tasks with every gate resolved stay in the room until someone moves
  them. The room will show them plainly, which is the point, but Earth may see them often.
- **Server payload.** `/api/review` grows by one short list for each of the ~51 tasks with gates.

## Deploy and rollback

- **Deploy:** server and client ship in one PR. The client reads `gates.items` when present and
  treats a missing list as "counts only". In that case a note goes to ครบ when every gate has
  resolved and to ตรวจ otherwise, and no gate names show, so an old server does not break the room.
- **Data:** there is no data change and no migration.
- **Roll back** by reverting the PR.
