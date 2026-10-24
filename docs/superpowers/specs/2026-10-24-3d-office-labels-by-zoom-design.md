# 3D Office: room labels and readouts by zoom level

Date: 2026-10-24 · Status: approved by Earth 2026-10-24 · Roadmap item 0, done before the room
redesigns 1–6 (Blocked, Review, Escalation, Val.Failed, Debug Lab, DevOps) · Touches: the Done TV
(SPAR-41) and the Aborted readout (SPAR-44)

## Intent

Today `ProjectOverlays` in `dashboard/client/src/views/office3d/OfficeScene.tsx` places:

- each room name above the room centre (`project(layout.x, 1.7, layout.z)`);
- the Done TV above the Done back wall.

Both are only clamped to the stage edges (`clampOverlay`). Nothing stops one overlay from covering
another, or covering another room. Only the selection card avoids its room (`placeBeside`).

Zoomed in, this already goes wrong. The SPAR-42 review screenshot shows "Review" on top of
"DevOps", "Debug Lab" on top of "Done", and the Done TV covering the Review room. Every room in
the roadmap adds a readout of its own, so it will get worse.

Earth chose concept A, "by zoom level", from three mockups (2026-10-24):

- A, by zoom level;
- B, always visible with leader lines;
- C, docked in a strip under the stage.

The mockups are in the brainstorm session at `scratchpad/aborted-room/.superpowers/brainstorm/`
(not in the repo).

## The design (as decided with Earth)

**Overview (the default camera, and any view zoomed out that far):**

- Only room names, each with a small count chip. No readout floats in the scene.
- Names never overlap each other.

**Zoomed in:**

- The room in the middle of the stage shows its readout beside the room, on the side with more
  free space, the way the selection card is placed today.
- The readout appears by itself as the room comes to the middle. No click is needed (Earth,
  2026-10-24).
- The other rooms on screen keep showing only their names and chips.

**Which readouts follow the rule:**

- the Done TV (SPAR-41, merged), which is always visible today;
- the Aborted readout (SPAR-44, in progress), which is anchored under the Aborted front today;
- every readout the roadmap adds later (items 1–6), from the start.

## Calls I made (Claude), for Earth to check

- **Count chip per room:**
  - **Open rooms:** the number of tasks in the room, the same count the side panel shows.
  - **Done:** tasks closed today (Asia/Bangkok), the same number as the Done TV (`loungeReadout`).
    The side panel's Done count is the all-time total (537 today), which says nothing at a
    glance.
  - **Aborted:** the total number of aborted tasks, the same number as line 1 of the Aborted
    readout.
  - **When a room's number is 0:** no chip.
  - **Colors:** neutral, never a status color. The room rim already carries the status.
- **Names of rooms on screen never overlap: they move, they never hide.** A layout pass each frame
  places names in priority order: rooms with tasks first, then the fixed zone order. A name that
  would overlap one already placed is nudged up or down by its own height until it is clear. Names
  keep their order from frame to frame so they do not jitter.
- **Names of rooms off screen are hidden, not clamped to the edge.** Clamping is what stacked
  "Review" on "DevOps" and "Debug Lab" on "Done" in the SPAR-42 screenshot: the two rooms of each
  pair project to the same screen height. A name shows when its anchor point is inside the stage.
- **"Zoomed in" depends on the camera zoom, not on the stage width.**
  - The default camera (zoom 30) is always the overview, on every window size.
  - Focus is possible above a fixed camera zoom of about 45 (OrbitControls goes to 70). The
    builder tunes the number live.
  - A fraction of the stage width does not work on every screen. On a 1920 px window it is never
    reached, and on a narrow one-column layout the default camera would already count as zoomed
    in (builder check, 2026-10-24).
- **"The middle of the stage":**
  - Above that zoom, the focused room is the one whose centre is nearest the stage centre, among
    rooms whose centre is inside the middle third of the stage.
  - With hysteresis, the focus moves to another room only when that room is clearly nearer the
    centre, so panning between two rooms does not make readouts flicker.
- **Readout placement** (Earth decided the fallback, 2026-10-24):
  - **First choice:** a clear spot beside the focused room, on the freer side, or below it.
  - **When nothing is clear**, which is the normal case for central rooms once zoomed in:
    - the readout may cover part of a neighbouring room's floor and walls;
    - it takes the candidate spot that covers the least of other rooms' footprints;
    - it never covers a name, the selection card, or the focused room itself.
  - **Why there is rarely a clear spot:** at the zoom where focus starts, a room is about
    290 × 210 px on a 1440 px window, and its neighbours sit about 215–290 px across and 135 px up
    or down (builder check, 2026-10-24).
- **The selection card wins over the readout for a room selection.** When the focused room is the
  selected room, its readout hides, because the card already carries the details. When another
  room is selected, the card is placed so it does not cover the readout.
- **A selected Done task keeps SPAR-41's behaviour.** SPAR-41 highlights the TV for an older Done
  task (`tvHot`) and anchors the card at the TV. So selecting a Done task shows the Done readout
  at any zoom, highlighted, and the card is placed beside it. Without this the TV highlight would
  never be visible and `tvHot` would become dead code.
- **Fades:** readouts fade in and out over about 150 ms. With reduced motion they appear and
  disappear without a fade.
- **SPAR-44 keeps its spec, and this item lands after it.** Niko is building the Aborted readout
  as specified, and has nothing committed yet (2026-10-24).
  - SPAR-44 touches the same code: `ProjectOverlays`, `Office3DView`, `officeTasksFromApi` and
    terminal ordering.
  - So this item branches from `main` after SPAR-44 merges, then moves both the Done TV and the
    Aborted readout to the new rule in one change.

## Goals, non-goals, anti-goals

**Goals**
- No overlapping names or readouts, at any zoom.
- The overview reads cleanly: names and counts only.
- Bringing a room to the middle while zoomed in shows its readout, without a click.

**Non-goals**
- No new readout content. Each room's own issue owns what its readout says.
- No change to the 3D scene, robots, colors or room furniture.
- No server or API change, and no change to the side panel.

**Anti-goals: it fails even if it technically works when**
- Readouts flicker on and off while panning or zooming slowly.
- A readout covers a name, the selection card or the focused room, or covers a neighbouring room
  when a clear spot exists.
- Names jitter or swap places from frame to frame.
- The Done "closed today" number can no longer be seen at a glance. The chip keeps it.

## Data

- **Counts:** the per-zone stats the side panel uses (`summarizeZones`). For Done, the
  `loungeReadout` closed-today number from `/api/analytics/flow`. For Aborted, the total number
  of aborted tasks.
- **Positions:** the existing projection in `ProjectOverlays`.

## Constraints

- **Scene cost:** DOM overlays only, so no draw-call change. The layout pass runs every frame, so
  it must stay cheap: ten names and at most one readout and one card.
- **Camera range:** works across the whole OrbitControls range (zoom 12–70), with panning and
  stage resizing.
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - two names whose anchors overlap come out apart, in a stable order;
  - a room whose anchor is off the stage has no name shown (no edge clamping);
  - focus picks no room at camera zoom 30 on any stage width, and the nearest-centre room above
    the zoom threshold;
  - hysteresis keeps the focus while the camera moves slightly toward a neighbour;
  - a readout is never placed over a name, the card or the focused room;
  - a readout takes a clear spot when one exists, and otherwise the spot that covers the least of
    other rooms;
  - chip values: open room count, Done closed today, Aborted total, and no chip at 0;
  - the focused room's readout hides while that room is selected;
  - a selected Done task shows the Done readout highlighted, at any zoom.
- **Live check before merge:**
  - overview and zoomed screenshots at several zoom levels;
  - a slow pan across neighbouring rooms with no flicker;
  - the Done readout and the Aborted readout both behave the same way.

## Left to the builder

- **Focus:** the exact threshold, the hysteresis margin and the fade timing.
- **Names:** the nudge step, and the chip styling within the palette rule.
- **Placement:** how occupied rectangles are computed for room footprints, names and the card.

## Open risks

- **Focus between two rooms.** With the camera centred between two rooms, the focus could jump
  between them. Hysteresis is the guard; check it live.
- **Small stages.** On a narrow stage a readout rarely has a clear spot, so the least-cover
  fallback matters.
- **Overview no longer shows the Done TV or the Aborted readout.** Earth accepted this trade-off
  with concept A. The chips carry the numbers.

## Deploy and rollback

Client only, no data or API change, no migration. Roll back by reverting the PR.
