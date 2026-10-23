# 3D Office: the Val.Failed room becomes a QA lab (light redesign)

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Roadmap item 4 · Lands after: SPAR-45
(labels and readouts by zoom level, `docs/superpowers/specs/2026-10-24-3d-office-labels-by-zoom-design.md`).
SPAR-44 (Aborted heap) has merged.

## Intent

**The room today** (zone id `rejected`, label "Val.Failed", phase `validation_failed`, kind
`stuck` with the red alert):

- **Robots:** a task's robot sits at a desk from the shared desk layout with the `blocked`
  posture. Only `SCENE_DESK_LIMIT` (4) tasks per room get a desk.
- **Furniture:** desks with screens (`SCREENS` in `officeLayout.ts`), a trash can and an open box
  (`officeDecor.tsx`). Nothing says what the room is for.
- **Alert:** when it holds a task, the room shows its red alert edges and a pulsing floor, like
  every `stuck` room.

**What the data says** (Claude's check of `runs/*`, 2026-10-24):

- **Never used.** No task has ever entered `validation_failed`.
  - None of the `status.yaml` files on origin/main contains it.
  - None of the 146 local `meta.yaml` event logs records a `validation_failed` event. `meta.yaml`
    is gitignored, so this comes from the main checkout.
- **What it is for.** It is the office's safety net for broken agent output. `run-agent.sh`
  routes a task here when:
  - the agent's output cannot be parsed (`output could not be parsed during sync`);
  - the PM's gate plan conflicts with status.yaml (`gate plan conflicts with status.yaml: …`);
  - the output contract fails, for example an `approved` verdict without the evidence the
    reviewer policy requires (`enforce-output-contract.rb`).
- **Not about completion gates.** A refused completion gate keeps the task in its phase and does
  not route here (`docs/completion-gates.md`). The roadmap's first idea, "which gates fail", was
  wrong.
- **Retries.**
  - The output-contract route counts its failures in `validation_failed_retries`.
  - At `loop_guard.validation_failed_retry_limit` (3), `run-agent.sh` halts the task.
  - The other two routes do not touch the counter.
  - The counter is not in the dashboard read model.
- **Who wrote the row.**
  - The parse-error and gate-conflict routes record the failing role as the history agent.
  - The output-contract route writes its own row with agent `orchestrator`
    (`enforce-output-contract.rb`). There the failing role appears only inside the reason text,
    for example `reviewer output failed schema validation: …`.
  - A repeated contract failure writes no new row, but sets `updated_at` to that day.
- **The read model** gives such a task the action kind `workflow_exception` and the recommended
  action "Inspect validation evidence and route the required fix."

**Earth's direction (2026-10-24):**

- Earth asked Claude how much to do, given that the room is never used and the draw-call budget
  is nearly spent.
- Claude proposed a light redesign: static decor only, the readout, and the card.
- Earth asked for mockups and chose concept G, "QA lab", from three:
  - F, a rework shop;
  - G, a QA lab;
  - H, a returns room.

The mockups are in the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
(`valfailed-concepts-v3.html`, not in the repo).

## The design (as decided with Earth)

**Scope: light.** Static decor, the readout and the card. There is:

- no new seat system;
- no beacon, because the red alert already marks an occupied room;
- no special robot moment;
- no server change.

**Furniture: a QA lab** (Earth chose G).

- **Instrument rack** on the back wall, with small indicator panels that do not glow.
- **Checklist board** on the left wall: lines and boxes, no text.
- **Reject bin** with crumpled papers beside the desk.
- **Magnifier arm** on a small fixed QA table beside the rack. In the mockup it was on the desk,
  but desks move with the task count.
- **Also:** a rug under the desk, a filing cabinet and a potted plant.
- **Kept:** the shared desks and their screens, so robots keep sitting where they sit today.
- **Removed:** the trash can and the open box. The reject bin replaces them.

**What the room tells you** (zoomed in, following the SPAR-45 rule), the same pattern as the
Escalation room (SPAR-48):

- **One line per task:**
  - the task id;
  - where it came from (room and role);
  - how many days it has waited;
  - the reason as written, cut to two lines.
- **Clicking a task** opens the selection card with the full reason and **Open in Monitor**.
  - Today's 3D selection card has neither. It lists up to three `taskId · status · last
    operator` lines, and it and the readouts are `pointer-events: none` (`Office3DView.tsx`).
  - So clickable readout lines and an interactive card with a button are new work.
  - SPAR-46, SPAR-47 and SPAR-48 need the same thing. Whichever lands first builds it, and this
    room reuses it.

## Calls I made (Claude), for Earth to check

- **"Where it came from"** is read from the structured `lastTransition`:
  - **Room:** the phase before ` -> validation_failed`, mapped with `PHASE_TO_ZONE`.
  - **Role:** `lastTransition.agent`, the role whose output failed, on the parse-error and
    gate-conflict routes.
  - **When the agent is `orchestrator`** (the output-contract route), the role is left out and
    only the room is shown. The verbatim reason that follows already names the role. The prefix
    is never parsed.
  - The "from" part is left out when `lastTransition` is not the transition into
    `validation_failed`. It is also left out for a move inside the room
    (`validation_failed -> validation_failed`, written when free-roam or PM fails again here).
    For such a move, the reason line is labelled `latest note`, the same rule as SPAR-48
    (Escalation).
  - So the two rooms share one readout-line helper with one rule.
- **The reason** is shown as written, only when `lastTransition` is the transition into
  `validation_failed`, the same guard as `closedNote()` for Aborted. It is cut to two lines.
- **"How long"** is `floor((now − statusUpdatedAt) / 1 day)`, the formula the other rooms use.
  There is no idle threshold for this phase.
  - A repeated contract failure resets `updated_at`, so here the number means "since the last
    failure", not "since entry".
  - That is acceptable: it tells Earth whether the task is still being retried.
- **No retry count.**
  - "Failed x of 3" would need `validation_failed_retries` and the limit from the server.
  - The card's Open in Monitor shows the run, so that is left out.
- **Count chip:** the room's task count, the SPAR-45 default.
- **Indicator panels and the magnifier do not glow.** The merged decor's lamp-shade material
  glows with DevOps's occupancy (`shadeEmissiveFor('devops')`), so nothing in this room may use
  it.
- **Colors at zero draw calls.**
  - The merged decor has only three non-emissive colors: wood, metal and fabric
    (`officeDecor.tsx`). `bake()` drops vertex colors.
  - So papers, indicator panels and checklist lines in the merged decor would all be brown, slate
    or plum. A potted plant there would get plum leaves.
  - **Shapes that need their own color** are added as instances of the existing instanced meshes
    that already take a per-instance color: the box-shaped rack bodies, and the pot, soil and
    foliage meshes the Inbox plant uses (`officeLayout.ts`, `officeProps.ts`). These are the
    papers, the indicator panels, the checklist lines and the plant. That costs no draw call.
  - **Large plain pieces** (the rack frame, the cabinet, the table, the bin, the board backing)
    stay in the merged decor buckets.
  - Adding a color attribute to the whole merged decor would touch every room, so it is not done.
- **Shadows:** the merged decor already casts shadows, at no extra draw call. The existing
  instanced meshes keep their current shadow setting. No new mesh is added.

## Goals, non-goals, anti-goals

**Goals**

- **Empty:** the room reads as a QA lab, even empty.
- **Occupied:** the readout says which task failed validation, from which role, for how long and
  why.
- **One click** to the run in Monitor.

**Non-goals**

- **No new seats, beacon or walk.**
- **No retry count.**
- **No server change.**
- **No change to the side panel,** Attention or Monitor.

**Anti-goals: it fails even if it technically works when**

- **Glows with another room:** anything in Val.Failed glows because another room is busy.
- **Inferred:** the room classifies or rewords a reason.
- **Wrong reason:** a reason is shown for a task whose last transition was not into
  `validation_failed`.
- **Draw calls:** the redesign adds any.

## Data

- **Fetched and kept:** `lastTransition` and `statusUpdatedAt` are already on the office task
  since SPAR-44. Nothing else is needed.
- **Labels:** `PHASE_TO_ZONE` and `ZONE_BY_ID` (`commandZones.ts`).

## Constraints

- **Scene cost:** zero new draw calls. Every new piece goes through the merged decor path.
- **Assets:**
  - `cabinetBedDrawer` or a similar cabinet, and `pottedPlant`, both Kenney and already in
    `dashboard/client/public/office3d/`;
  - the rack, board, bin, papers, magnifier and rug as simple shapes;
  - everything recolored through the decor buckets under the palette rule.
- **Order of work:**
  - This item starts after SPAR-45 merges, because it uses SPAR-45's readout placement.
  - It may share the readout-line helper with SPAR-48 (Escalation). Whichever lands second reuses
    the first.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - **"From":**
    - the room and role come from `lastTransition` only;
    - the role is left out for agent `orchestrator`;
    - both are left out when the last transition is not into `validation_failed`, or comes from
      inside the room. Then the text is labelled `latest note`.
  - **Reason:** shown as written, only for a transition into `validation_failed`, and cut to two
    lines.
  - **Decor:**
    - Val.Failed has the rack, board, bin, magnifier, rug, cabinet and plant;
    - it no longer has the trash can or the open box;
    - none of the new pieces uses the lamp-shade material;
    - the colored pieces are instances of existing per-instance-colored meshes, and the draw-call
      count does not change.
  - **Clicks:** a desk or a readout line selects the task, and the card shows Open in Monitor.
- **Live check before merge:**
  - the empty room on live data, with DevOps busy if possible, to show nothing glows;
  - an occupied room with a client-side mock of a `validation_failed` task, at overview and
    zoomed;
  - the card;
  - draw calls unchanged on live data and on the stress run.

## Left to the builder

- **Placement:** the exact positions, within the desks and the walk.
- **Look:** the indicator panel colors and the crumpled-paper shapes, within the palette rule.

## Open risks

- **Rarely seen.** The room may stay empty for months. Its look matters mostly when empty.
- **Retries.** A task that fails repeatedly shows no count. Earth reads the history in Monitor.

## Deploy and rollback

Client only. There is no data change, API change or migration. Roll back by reverting the PR.
