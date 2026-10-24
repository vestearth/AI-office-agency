# 3D Office: the Aborted room becomes a discard heap

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Follows: SPAR-41 (Done lounge,
`docs/superpowers/specs/2026-10-23-3d-office-done-lounge-design.md`), SPAR-42 (Inbox reception,
`docs/superpowers/specs/2026-10-23-3d-office-inbox-reception-design.md`)

## Intent

Today the Aborted room is a dead room, like Done was before SPAR-41:

- **Furniture:** it holds 21 tasks but draws up to four empty desks with chairs, a bookcase and
  two open boxes (`officeDecor.tsx`, `officeLayout.ts` draws desks for every zone but Done).
- **Light:** it is always dark, because `roomLightLevel` returns 0 for every terminal room
  except Done.
- **Robots:** when a task is aborted, its robot vanishes at its desk on the spot
  (`planMove`: `next.terminal === 'aborted'` returns `vanish`).
- **Information:** nothing in the room says which task was aborted last or why.

Earth wants the Aborted room to be used, the same way the Done room became a lounge:

- **See at a glance which task was aborted most recently, and why** (Earth, 2026-10-24).
  Earth first asked for one short sentence, for example "superseded by TASK-VS-040". The reason
  is now shown as written and cut short, to keep the read-model contract (see "The reason is
  shown as written").
- **Robots walk to the Aborted room and throw their work away** instead of vanishing at their
  desk.
- **New furniture.** Earth chose concept C, "discard pile", from three mockups:
  - A, a disposal corner;
  - B, a shred desk;
  - C, a discard pile.

  Earth then allowed new CC0 models and picked C3, "mixed heap", from three C variants:
  - C1, a pile on pallets;
  - C2, a dumpster;
  - C3, a mixed heap.

  The mockups are in the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
  (not in the repo).

## The design (as decided with Earth)

**Furniture: a mixed discard heap.**

- **Heap:** a messy heap in the back-left corner, made of cardboard boxes, trash bags and loose
  papers. It grows with the number of aborted tasks and spreads from the corner toward the
  middle of the room.
- **Crates:** stacked in the back-right corner.
- **Note board:** a board prop on the left wall. Its text is a DOM readout under the room's
  front, like the Done room TV (see "What the room tells you").
- **Removed:** the Aborted desks and chairs (nobody sits in Aborted), the bookcase, and the two
  open boxes.

**Assets.** The heap uses:

- the Kenney `cardboardBoxOpen` and `cardboardBoxClosed` already in
  `dashboard/client/public/office3d/`;
- three new CC0 models by Quaternius:
  - Trash Bags (https://poly.pizza/m/eitNk4I4R1);
  - Debris Papers (https://poly.pizza/m/MujITy1NRR);
  - Crate (https://poly.pizza/m/SfJtdV8GDr).

The license was checked on each model page on 2026-10-24: "Public Domain (CC0)". A license
note for the Quaternius files goes next to the existing `License.txt`.

**What the room tells you:**

- **The note board** has two parts:
  - **The prop:** a flat board in a decor color on the left wall.
  - **The readout:** a DOM block like the Done TV. It is anchored in the empty canvas just below
    the room's front edge, not on the wall. From the default camera there is free space there,
    and pinning the text to the left wall would cover the Dev room. (Claude's call.)
- **The readout has three lines:**
  1. `aborted N`: the total number of aborted tasks.
  2. The id of the most recently aborted task.
  3. The reason for that task, as written. It may wrap onto a second line, then ends with an
     ellipsis. The line is left out when there is no abort reason.

  The block is up to about 220 px wide.
- **The heap:** grows with the total number of aborted tasks ever (Earth chose the total over a
  recent window, 2026-10-24).
  - Pieces = `min(36, ceil(3.6 × √N))`: 21 aborted tasks give 17 pieces, 50 give 26, and 100 or
    more give 36.
  - The heap keeps visibly growing for a long time, and its largest footprint is fixed at 36
    pieces.
  - The board carries the real number. (Claude's call; a flat cap of 24 would already be 88 %
    full today.)

**Robots throw their work away.** When a drawn task turns aborted while the page is open:

1. The robot stands up from its desk, carrying a box.
2. It walks out through its room's front, along the aisles, and in through the Aborted front.
   These are the same waypoint rules as the Done delivery walk.
3. At one of three drop spots in front of the heap, it pauses briefly to toss the box onto the
   heap, then vanishes with the existing scale-down vanish.

**Many aborts at once.** This follows the Done room's real rule (Done lounge spec, "Sofa
capacity"):

- Every robot of an aborted task walks.
- There are three drop spots, tracked across data rounds the way the Inbox pick-up spots are.
- A robot that arrives when all three spots are taken vanishes at the Aborted front, as extra
  robots do at the Done door. (Claude's call.)

**When the room changes.** The board and the heap update as soon as the data arrives, the same
way the Done lounge does. They do not wait for the robot to arrive.

**The reason is shown as written, cut to two lines** (Earth, 2026-10-24).

- **Why not a short sentence:** Earth first asked for a short sentence such as
  `superseded by TASK-VS-040`, made by matching rules on the client. The builder check then found
  that the read-model contract forbids that:
  - `schemas/run-summary.schema.yaml` says the dashboard "must not infer them from free-form
    text", and that `lastTransition.reason` "is displayed verbatim and never classified";
  - `docs/run-summary-read-model.md` and `dashboard/shared/types.ts` say the same.

  Earth chose to keep the contract.
- **Which reason:** use the reason only when `lastTransition` is the transition into aborted
  (its `phase` ends in `-> aborted`). This is the guard `closedNote()` in `views/monitorDetail.ts`
  already applies, so reuse it.
  - Otherwise the board shows no reason line. Today that applies to TASK-EAR-256 and
    TASK-EAR-112, whose history is non-standard.
- **How it is cut:** the text is shown as written and wraps onto at most two lines of the readout
  (about 90 characters), then ends with an ellipsis.
- **What it looks like today:** most reasons state the outcome in their first words, for example:
  - `Operator decision 2026-10-17: superseded by TASK-VS-040, which carries…`
  - `Operator-approved throwaway smoke test of the dashboard New task flow…`
  - `Superseded by TASK-EAR-402 at operator request (2026-10-12): cut a…`
- **Later option:** a short field written at abort time would give crisp sentences without
  breaking the contract. It needs the validator, the abort tooling, the server and the client, so
  it is out of V1.

**"Most recently aborted" means by abort time, everywhere** (Earth, 2026-10-24).

- **The problem:** today terminal zones sort by `updated_at` (`zonePreview` in `commandZones.ts`),
  which is often a date only. Tasks closed on the same day fall back to the `/api/review` order,
  which is effectively task id.
  - So the side panel shows TASK-VS-030 first, although TASK-EAR-415 was aborted later
    (`lastTransition.at` 2026-10-17T01:49:24Z against 2026-10-16T20:02:49Z).
- **The fix:**
  - Terminal-zone ordering uses the time of the closing transition (`closedNote().at`) first,
    then `updatedAt`.
  - The side panel, the Command map hover and the Done lounge TV all sort this way, so the
    Aborted board's latest task always equals the first task in the side panel.
  - `CommandView` already orders by `lastTransition.at ?? updatedAt` for the same reason.
  - Office tasks must carry `lastTransition`, which `officeTasksFromApi` drops today.

**Existing rules still hold** (SPAR-38/39/41/42):

- First load, remount, a hidden tab, a stream gap and reduced motion all place robots without
  walking.
- In those cases an aborted task's robot simply disappears, as today. The board and the heap
  just show the data.

## Goals, non-goals, anti-goals

**Goals**
- From the default camera you can tell Aborted is where cancelled work gets dumped.
- The board tells you which task was aborted last and why, in at most two lines of reason.
- Every abort seen during the session shows its robot walking over and throwing its work on the
  heap.

**Non-goals (V1)**
- No server or API change, and no change to how tasks are aborted or what `status.yaml` stores.
- No list of aborted tasks in the room. The side panel already lists them.
- No editing of reasons, and no classifying or rewording of them (read-model contract).
- No sound and no particle effects.
- No change to the other rooms, except one approved shared change: terminal zones now sort by
  abort or close time. That also reorders the Done lounge TV and the Command map hover (Earth,
  2026-10-24).

**Anti-goals: it fails even if it technically works when**
- The heap blocks the door, the walk or the drop spots, or a robot clips through the heap.
- The board covers other rooms or their labels from the default camera. The Done TV already
  covers Review when zoomed in; do not repeat that.
- Opening the page, coming back to the tab, or a stream reconnect shows a parade of robots
  walking to Aborted.
- The board shows a reason from a different task than the id above it.
- Anything in the room reads as a status color (cyan, green, amber, red, neon purple), for
  example a green bag or crate.

## Data

- **Aborted tasks:** the zone `aborted` (phase `aborted`). The total is
  `tasksInZone('aborted', …).length`.
- **Latest task:** the first Aborted task in terminal-zone order, by the time of the closing
  transition first and then `updatedAt`.
- **Its reason:** `closedNote(review).reason`, built from `lastTransition`, which is already in
  `/api/review`.
- No server change.

## Constraints

- **Draw calls:** at most 70 at 1440×900 with bloom, on live data and with the 32-robot stress
  (today 58 and 57, and 60 with three Inbox pick-ups).
  - Fixed props (crates) go through the merged decor path, on the existing material buckets.
  - The heap pieces change with the count, so instance them the way the Done pile (`pileSlots`)
    and the Inbox queue shelf do.
  - The carried box reuses existing instanced meshes.
- **Performance and dependencies:** 60 fps on the M5. No new npm dependency. CC0 models only.
  Keep the new GLB files small.
- **Light:** without light the heap cannot be seen, because terminal rooms stay dark. Aborted
  gets a dim light whenever it holds tasks, at the Done lounge level (`LOUNGE_LIGHT_LEVEL`
  0.05), in a low-saturation neutral color that passes the palette rule. (Claude's call.)
- **Clearance:**
  - At the heap's largest size, the path from the Aborted door to each drop spot stays clear.
  - The three drop spots are fixed in front of the heap's largest footprint.
  - A walking robot never clips heap pieces or crates.
- **Palette:** any new color (the light, and any glow on the carried box) passes the palette
  rule: hue at least 30° from every `ZONE_COLORS` tone and the neon purple, or saturation below
  0.15. Recolor the new models through the decor buckets so nothing reads as a status color.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - an abort plan walks to an Aborted drop spot, then vanishes;
  - the drop spots hold one robot each across data rounds, and a robot that finds all three
    taken vanishes at the Aborted front;
  - no walk for snap, first load or reduced motion;
  - the heap piece count follows `min(36, ceil(3.6 × √N))`;
  - terminal-zone ordering puts the latest closing transition first, even when two tasks share
    a date-only `updated_at` (fixture: TASK-EAR-415 before TASK-VS-030);
  - the board shows the reason as written, only for a transition into aborted, and leaves the
    reason line out otherwise;
  - the board text is cut to two lines;
  - Aborted draws no desks.

## Calls I made (Claude), for Earth to check

- **Desks removed** from Aborted, because nobody sits there.
- **What the robot carries:** a cardboard box in a decor color. It does not emote at its desk,
  because `emote-no` already means a blocked robot.
- **Every robot walks, with three drop spots.** Extra robots vanish at the Aborted front, the
  Done room's real rule. My first draft said "at most three walk, as in Done", which misread
  Done.
- **The toss** is a pause of about a second with an existing Blocky clip. The builder picks the
  clip.
- **The heap grows as `min(36, ceil(3.6 × √N))`**, and the real number is on the board.
- **The board text sits under the room's front edge**, in empty canvas, not on the wall. The
  wall keeps a plain board prop.
- **Board line 1 is `aborted N`.** The text is English, like the rest of the dashboard.
- **A dim neutral light** whenever Aborted holds tasks.
- **No reason line when the abort reason is missing.** This reuses the `closedNote()` guard, so
  the board never shows an older, unrelated reason.

## Left to the builder

- **Heap:** the piece order, the mix of boxes, bags and papers as it grows, and how far it
  spreads.
- **Placement:** the crate stack, the three drop spots, the board prop, and the exact readout
  offset under the room front, within the constraints.
- **Look:** the light color within the palette rule, and the toss clip.
- **Models:** importing the Quaternius GLB files and recoloring them. If they clash with the
  Kenney style, fall back to Kenney boxes and say so in the PR.

## Open risks

- **Heap growth.** A heap that spreads to the middle can crowd the walk. The cap and the fixed
  drop spots are the guards.
- **Long reasons.** A reason that saves its outcome for later in the text gets cut before the
  outcome (for example TASK-EAR-364, "Operator asked for a re-check…"). The side panel and the
  run detail still show the full text. A short field written at abort time is the later fix.
- **Shared ordering.** Sorting terminal zones by close time touches the Done lounge TV and the
  Command map hover. Check both in the live review.
- **Board placement.** The DOM board can cover nearby rooms at some zoom levels.
- **Mixed model style.** Quaternius and Kenney models may look mismatched. Recoloring through the
  decor buckets is the first lever.

## Deploy and rollback

Client only, no data or API change, no migration. Roll back by reverting the PR.
