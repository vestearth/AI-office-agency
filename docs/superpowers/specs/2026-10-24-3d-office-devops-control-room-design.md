# 3D Office: the DevOps room becomes a deploy control room

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Roadmap item 6 · Lands after: SPAR-46..50
(Blocked, Review, Escalation, Val.Failed and Debug Lab rooms, all merged on 2026-10-24; main at
`034af9f9` when this was written).

## Intent

**The room today** (zone `devops`, label "DevOps", phases `devops_needed` and `devops_complete`,
agent `devops`, kind `work`):

- **Robots:** a task's robot sits at a desk from the shared desk layout with the `work` posture.
  Only `SCENE_DESK_LIMIT` (4) tasks get a desk.
- **Furniture:**
  - shared desks without screens (`SCREENS` in `officeLayout.ts` leaves `devops` out);
  - a floor lamp (`lampRoundFloor`, `officeDecor.tsx`) whose shade glows with DevOps occupancy
    (`shadeEmissiveFor('devops')`);
  - a three-tier rack at the back right (`rackBody` + `rackLed` in `officeLayout.ts`). Its LEDs
    take the room tone while the room holds a task, and go dark otherwise (`mats.led.userData.dark`).
- **Nothing says** what DevOps is doing or how far a release has got.

**What the data says** (Claude's check, 2026-10-24):

- **Rarely used.** Tasks have entered DevOps 19 times, across 17 tasks. The last was TASK-VS-026 on
  2026-10-15, for a few minutes. The room is empty today.
- **Release trains live elsewhere.** The open release trains (`isReleaseTrain`, status.yaml
  `carries` non-empty) are TASK-EAR-402 (phase `blocked`) and TASK-EAR-406 (phase `assigned`).
  Their robots sit in Blocked and Dev Bay.
- **Their progress is structured.** `/api/review` gives each one
  `gates: { readable, total, resolved, passable }` (completion gates):
  - TASK-EAR-402: 1 of 4 resolved;
  - TASK-EAR-406: 0 of 2 resolved.
  - There are no gate names in `ReviewSummary`, only counts.

Claude proposed that the room answer two questions: what DevOps is doing now, and **how far each
release train has got**. Earth chose concept P, "deploy control room", from three mockups:

- P, a deploy control room;
- Q, a server room;
- R, a rocket launch pad.

Earth then asked for more furniture and chose **P2**, "control room with a go/no-go corner", from two
furnished takes (P1 full control room, P2 control room with a go/no-go corner). The mockups are in
the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
(`devops-concepts.html`, `devops-p-furnished-v2.html`, not in the repo).

## The design (as decided with Earth)

**The release board** on the back wall:

- One row per open release train, one segment per completion gate.
- A resolved gate's segment is lit in warm white (the Blocked queue board's bar color,
  `BAR_COLOR`). An unresolved one is dark.
- No text.

**Furniture (P2):**

- **Back wall:** the release board, with a wall clock (no numbers) to its left.
- **Left wall:** a deploy checklist whiteboard, made of lines and tick boxes with no text.
- **Go/no-go corner:** a small meeting table with three chairs and papers on it.
- **Back right:**
  - a single-monitor console;
  - two racks: the existing three-tier rack plus a second one;
  - a cable tray above the racks.
- **Elsewhere:**
  - a filing cabinet, a coffee corner (low cabinet, coffee machine, two mugs), a plant and a rug;
  - the room's existing floor lamp.
- **The desk row moves to the front** (Earth, 2026-10-24).
  - **Why:** up to 4 shared desks fill the middle of the room (`SCENE_DESK_LIMIT`, `DESK_Z` 0.35),
    so the go/no-go corner would collide with desks 3 and 4.
  - **How:** DevOps gets its own desk-row depth through `deskZ(zoneId)` (`officeReception.ts`),
    the way Inbox moved its row back behind the counter (`INBOX_DESK_Z`). The desks, the 4-desk
    limit, held rows and seat mechanics stay the shared ones; only the row's z changes.
  - **Effect:** the robots sit near the open front, facing the back wall, so they look at the
    release board. The back two thirds of the room hold the board, the console, the racks and the
    go/no-go corner.
  - The desks stay without screens, as on main. The console carries the room's one monitor.

**What the room tells you** (zoomed in, the SPAR-45 rule), with one readout in two parts:

- **Head:** `devops · N` and one line per task in the room. Each line has the id, where it came
  from, how long, and the reason as written cut to two lines. It follows the same transition rule
  as Escalation (SPAR-48) and Val.Failed (SPAR-49) and reuses their exported pieces (see "Calls I
  made").
- **`release trains`:** one line per open release train, with the id, a small segment strip and
  `gates x/y`. It is shown even when no task is in the room.

**Clicks:**

- A desk, a task line or a train line selects that task.
- **A train's card** shows its gates line and **Open in Monitor**.
  - A train selected from this readout keeps its own room selection (Blocked or Dev Bay), the way a
    Dev Bay task picked from the Blocked readout does.
  - For a train that waits on Earth, the card also carries the existing waiting block, so EAR-402's
    grant command is one Copy away (SPAR-46).

## Calls I made (Claude), for Earth to check

**Data:**

- **Which rows the board shows:** open release trains only (`isReleaseTrain` and the phase not in a
  terminal room). Tasks with completion gates that are not trains are left out. Today that would be
  ten more rows that have nothing to do with releasing.
- **Order:** by task id, so a row never moves.
  - `statusUpdatedAt` does not work as the order. `scripts/update-completion-gate.rb` sets
    `updated_at` to today on every gate update.
  - So ordering by age would move a train to the bottom at the moment its segment lights. With more
    than 4 trains it could also push that train off the board.
- **Caps:**
  - The board draws at most 4 rows and 6 segments per row.
  - The readout lists every train and its exact `gates x/y`.
  - A train with more than 6 gates fills the row by proportion: lit segments =
    `floor(6 × resolved / total)`.
  - A full row only when `resolved === total`, so the board never shows a train as done early. Its
    line says the real numbers.
  - No train on main has more than 5 gates today.
- **`gates.readable` false:** the row stays dark and the line says `gates unreadable`. Nothing is
  guessed.
- **No `gates` at all** (a train without completion gates): the row stays dark and the line says
  `no gates`.
- **`passable`:** not shown. The board shows only what has resolved.
- **Tasks in the room:**
  - "Where it came from" and the reason come from the structured `lastTransition`, only when it
    is the transition into the task's current phase (` -> devops_needed` or ` -> devops_complete`).
    This is the same guard as SPAR-48 and SPAR-49.
  - A move inside the room is labelled `latest note`.
  - `devops_complete` reads `devops done · waiting for handoff`, the way Escalation's
    `free_roam_complete` does.
  - **The role** is `lastTransition.agent` as written, `orchestrator` included. That is the
    Escalation rule without its "escalated by Earth" branch, because no human decision routes a
    task into DevOps.
  - **No shared helper yet.** `originOf` is private and written twice today
    (`officeEscalation.ts`, `officeValFailed.ts`), and only `ARROW`, `clean`, `daysSince`, `ordered`
    and `roomLabel` are exported. Reuse those. Extracting one origin helper for the three rooms is
    allowed if it keeps both existing rooms' tests unchanged.
  - "How long" is `floor((now − statusUpdatedAt) / 1 day)` with the local-midnight rule (`timeOf`).
- **Count chip:** the room's task count, the SPAR-45 default. Trains are not counted, because they
  are not in this room.

**The scene:**

- **Segment changes:**
  - When a gate resolves between two loads, its segment lights with one short blink.
  - First load, a hidden tab, a stream gap and reduced motion show the board as it is, with no
    blink. Use the catch-up guard the Review line uses (`initialCatchUp` / `onStreamPhase` /
    `onFrame` in `officeCatchUp.ts`, as in `officeReviewView.tsx`).
  - The Blocked board's `QueueBars` does not have those guards (it only skips under reduced
    motion), so do not copy it, and do not change it in this item.
- **The rack LEDs** keep their current rule: room tone while DevOps holds a task, dark otherwise.
  The board must not use the LED material, because it has to show trains while the room is empty.
- **The floor lamp:** its shade already glows with DevOps occupancy, which is this room. It may move
  within the room.
- **The front desk row** (my numbers, the builder may tune them):
  - `deskZ('devops')` around 0.8, so the chairs sit about 1.26 from the centre, inside the 1.7 front
    edge.
  - Robots keep the normal straight walk between their seat and the room front (`roomFront`). The
    row is in front of the furniture, so that walk crosses nothing.
  - Any arrival or departure route that passes the furniture must keep the clearance the other
    rooms' walk tests use.
- **Placement limits** (from the builder check):
  - Pieces past local x ≈ 1.2 hide behind the near +x wall from the default camera
    (`officeDecor.tsx` note). Keep the racks, console and cabinet inside that.
  - Nothing may stand in front of the desk row or in the walk lanes to the room front.

## Goals, non-goals, anti-goals

**Goals**

- **At a glance:** the board shows how far each open release train has got, even when the room is
  empty.
- **Zoomed in:** the readout names each train and its `gates x/y`, and lists what DevOps is
  handling and why.
- **One click** from a train to its card, and from there to Monitor or to the grant command.

**Non-goals**

- **No server change.** Every field is already in `/api/review`.
- **No gate names** on the board or in the readout. The read model has counts only.
- **No deploy action** from the 3D Office.
- **No change** to the side panel, Attention or Monitor.

**Anti-goals: it fails even if it technically works when**

- **Lies about progress:** a segment is lit for a gate that has not resolved, or an unreadable gate
  set is shown as progress.
- **Inferred:** the room reads a reason or a command to decide anything.
- **Glows with another room:** anything in DevOps glows because another room is busy.
- **Parade:** first load, a tab return or a stream reconnect blinks segments or walks robots.

## Data

- **Already on the office task:**
  - `waitsOn`, `isReleaseTrain`, `actionKind`, `recommendedAction` (SPAR-46);
  - `latestDecision`, `decisionPending` (SPAR-48);
  - `idle`, `gates` (SPAR-47);
  - `lastTransition`, `statusUpdatedAt` (SPAR-44).
- Nothing new is fetched or kept.
- **Shared pieces on main to reuse, not rebuild:**
  - the list readout (`o3d-queue` / `o3d-eline`, `LIST_READOUTS`) and the
    `EscalationReadout` / `EscalationBlock` views;
  - the exported line pieces `ARROW`, `clean`, `daysSince`, `ordered`, `roomLabel`;
  - `o3d-card live` and `WaitBlock`;
  - `timeOf()` and `waitDays()`;
  - the Blocked bar material and `BAR_COLOR`.

## Constraints

- **Scene cost:**
  - Main measures 65 draw calls on live data and on the stress run (Claude's review harness,
    2026-10-24). The shared ceiling is 70.
  - **Lit segments, one draw call:** a new instanced mesh of their own, no shadow.
    - It reuses the Blocked bar material (`mats.bars`, warm-white emissive, `BAR_COLOR`), so the
      two boards match.
    - Sharing the Blocked `QueueBars` mesh itself would need a refactor of a merged SPAR-46
      component with a different blink rule, so it is not done. Budget: 65 → 66.
  - **Dark segments, the second rack body and the console screen:** instances of the existing
    per-instance-colored meshes (`geoms.rack` + `mats.paint`, the screen instances).
  - **Large plain pieces** go through the merged decor: table, chairs, cabinet, coffee cabinet,
    whiteboard backing, cable tray, clock and rug. The merged decor already casts shadows at no
    extra draw call, as Debug Lab's and the QA lab's pieces do.
  - **No new mesh casts a shadow:** a separate caster costs a second draw call in the shadow pass.
- **Colors:**
  - The merged decor has only wood, metal and fabric, and `bake()` drops vertex colors.
  - So papers, tick boxes, mugs, the clock face and the plant use per-instance-colored meshes:
    the rack bodies, and the pot, soil and foliage meshes the Inbox plant uses.
  - The lamp-shade material of the merged decor glows with DevOps. Here that is the right room, but
    no new piece uses it except the existing floor lamp.
- **Assets:**
  - Kenney models already in `dashboard/client/public/office3d/`: `table`, `chair`,
    `cabinetBedDrawer`, `pottedPlant`, `computerScreen`, `lampRoundFloor`.
  - Everything else is simple shapes. All CC0, recolored through the decor buckets under the palette
    rule.
- **Order of work:** after SPAR-50, which has merged.
  - It touches the same shared files (`officeLabels.ts`, `officeLayout.ts`, `officeDecor.tsx`,
    `Office3DView.tsx`), plus `deskZ` in `officeReception.ts` for the desk row.
  - Branch from the newest `origin/main`.
  - PR #129 (time zone and day count) may land first; merge `main` in if it does.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - **Board rows:**
    - only open release trains, in task-id order;
    - a resolved gate does not move its row;
    - at most 4 rows and 6 segments;
    - lit segments = resolved, scaled with `floor` when total > 6, a full row only at
      `resolved === total`;
    - unreadable or missing gates show dark with the right line text.
  - **Existing tests to rewrite, not loosen:**
    - `officeDebug.test.ts` (around line 136) and `officeQaLab.test.ts` (around line 42) pin
      DevOps' `rackBody` instances at exactly 3.
    - The new pieces on the rack mesh break that count by design.
    - Rewrite both to check what they mean, that DevOps keeps its three-tier rack (for example by
      the rack tier poses), and keep them as strict.
  - **Readout:**
    - the `devops · N` lines follow the shared transition rule;
    - `devops_complete` shows the handoff text;
    - the `release trains` section shows even with the room empty.
  - **Clicks:**
    - a train line selects the train in its own room;
    - the card shows `gates x/y` and Open in Monitor;
    - for EAR-402-like data, the card also shows the waiting block with Copy.
  - **Blink:**
    - a newly resolved gate blinks once;
    - no blink on first load, snap or reduced motion.
  - **No glow from elsewhere:** with DevOps empty, nothing new in the room is lit except the board
    segments of resolved gates.
  - **Room:** the P2 pieces are present and merged, and the shared desks stay.
  - **Desk row:**
    - `deskZ('devops')` is the new front row, and every other room keeps its value;
    - DevOps seats, selection anchors and desk poses use it;
    - with 4 DevOps tasks, no desk, chair or seated robot overlaps a P2 piece;
    - every walk into and out of a DevOps seat keeps the shared clearance from the furniture.
  - **Time zone:** any date-only age test sets a non-UTC zone inside the test, because
    `npm test` pins `TZ=UTC` (see PR #129).
- **Live check before merge:**
  - overview and zoomed screenshots on live data: the board with EAR-402 1/4 and EAR-406 0/2, room
    empty;
  - a client-side mock of a DevOps task and of a gate resolving (one blink);
  - the train card for EAR-402 with Copy and Open in Monitor;
  - draw calls and fps on live data and on the stress run, equal to main or +1 at most;
  - never stop or restart the dashboard on ports 4310 or 3001. Use your own `DASHBOARD_PORT` and
    kill only your own PID.

## Left to the builder

- **Placement:** exact positions of the furniture behind the front desk row, and the exact
  `deskZ('devops')`, within the limits above.
- **Look:**
  - the segment size and spacing;
  - the blink timing (reuse `BLINK_STEP_MS` if it reads well);
  - the clock and the coffee-corner details.
- **Proportional rows:** whether a train with more than 6 gates gets a small marker. No text.

## Open risks

- **Few trains.** Most of the time the board has zero to two rows. The room must still read as a
  control room when the board is dark.
- **Selection jumps rooms.** Picking a train from the DevOps readout selects a task in Blocked or
  Dev Bay. The card is placed clear of the readout (`placeCardClear`), as for SPAR-46.
- **Overlap with Blocked.** EAR-402 and EAR-406 also appear in the Blocked queue, because they wait
  on Earth. The two rooms answer different questions: who waits on Earth, and how far each release
  has got.

## Deploy and rollback

Client only. There is no data change, API change or migration. Roll back by reverting the PR.
