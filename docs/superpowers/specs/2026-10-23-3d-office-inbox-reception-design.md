# 3D Office: the Inbox room becomes a reception

Date: 2026-10-23 · Status: draft for Earth's approval · Follows: SPAR-41 (Done lounge, `docs/superpowers/specs/2026-10-23-3d-office-done-lounge-design.md`), SPAR-38/39 (characters, desk hold, replan)

## Intent

Today a robot for a new task walks in through the Inbox door and goes straight to a desk.
There is no moment of "receiving the work". The Inbox room is also furnished with a lounge set
(`officeDecor.tsx:43-46`: `loungeSofa`, `loungeChair`, `tableCoffee`, `loungeSofaOttoman`),
which now duplicates the Done lounge from SPAR-41.

Earth wants to **see a robot come to the front of the Inbox room to receive the work.**
Earth chose concept B, "reception desk and queue shelf", from three mockups (A a counter beside
the door, B a reception desk with a queue shelf, C a mail cabinet on the side wall). The
mockups are in the brainstorm session at `scratchpad/inbox-room/.superpowers/brainstorm/`
(not in the repo).

## The design (as decided with Earth)

**Furniture: a reception.**
- A reception desk with a monitor stands in the middle of the entrance, just inside the door,
  facing the door.
- A shelf stands against the back wall, with a plant.
- The Inbox lounge set is removed, because Done is the lounge now.
- Everything comes from the Kenney Furniture Kit already shipped in
  `dashboard/client/public/office3d/` (for example `desk` or `table` for the counter,
  `computerScreen`, `bookcaseOpen` or `bookcaseClosedWide`, `pottedPlant`).

**Desks:** the Inbox keeps its work desks behind the reception desk, up to four as in every
other room. The rules are SPAR-38/39: one robot per drawn desk, the desk hold, and the full-room
rule.

**A new task arrives:**
1. A glowing envelope appears on the reception desk as soon as the data arrives.
2. The task's robot walks in through the Inbox door to the reception desk and stops briefly to
   pick the envelope up (about 1 s).
3. The robot carries the envelope around the reception desk to its seat. The envelope
   disappears when the robot sits down.

**A new task while the Inbox is full** (four desks drawn, or held at four by the SPAR-39 rule):
no robot walks and no envelope appears. The task only adds a box to the queue shelf, on data.
When a desk frees and that task is revealed, its robot walks in through the Inbox door, picks
up its envelope at the reception desk, and carries it to the freed seat. The envelope appears
on the counter at the moment of the reveal. (Claude's call.) A new task whose room is another
full room keeps today's overflow walk, with the pick-up added: in through the Inbox door, pick
up, walk to that room's front, vanish.

**Queue shelf:** boxes on the back shelf count only the Inbox tasks that overflow the four
desks, `max(0, Inbox tasks − 4)`, capped at about six boxes. Tasks that have a desk are already
visible as seated robots, so the shelf shows only the overflow (Earth, 2026-10-23).

**Envelope color:** a warm, low-saturation white, the same family as the Done coffee-table box.
It must not read as a status color.

**Existing rules still hold** (SPAR-38/39/41):
- First load, remount, a hidden tab, a stream gap and reduced motion all place robots without
  walking.
- In those cases no envelope is shown either. The robot simply appears at its desk.

## Goals, non-goals, anti-goals

**Goals**
- From the default camera you can tell the Inbox is the reception: the desk faces the door, and
  the lounge is gone.
- Every new task seen during the session shows the pick-up moment: envelope on the desk, robot
  comes in, picks it up, and carries it to a seat.
- With more than four Inbox tasks, the shelf shows how many are waiting beyond the desks.

**Non-goals (V1)**
- No server or API change.
- No change to the other rooms, except that a new task heading for another room also picks up
  its envelope at the Inbox reception first (see Claude's calls).
- No queue list or wall screen in the Inbox. The side panel already lists the tasks.
- No sound or particle effects.

**Anti-goals: it fails even if it technically works when**
- The reception desk hides the seated robots behind it from the default camera.
- Robots bump into or clip through the reception desk, or pile up on one spot when several
  tasks arrive together.
- Opening the page, coming back to the tab, or a stream reconnect shows a parade of robots
  picking up envelopes.
- The shelf duplicates what the seated robots already show.

## Data

- **New task:** the existing planner's `enter` and `overflow` plans for a task with no previous
  place. Both start at the Inbox door (`enterPoints`, `officeMove.ts:272`). The pick-up stop
  goes right after that door point.
- **Queue shelf:** the count of tasks in the Inbox zone (`tasksInZone('inbox', …)`) minus the
  drawn desks (`SCENE_DESK_LIMIT`, 4), floored at zero and capped.

## Constraints

- **Draw calls:** at most 70 at 1440×900 with bloom, on live data and with the 32-robot stress
  (today 61 and 59). The reception desk and shelf go through the existing merged decor path.
  The envelope and the shelf boxes are instanced or reuse existing glow meshes.
- **Performance and dependencies:** 60 fps on the M5. No new npm dependency. CC0 kit assets
  only.
- **Clearance:** the counter must leave clear paths:
  - from the door to the pick-up spot and on to every Inbox seat;
  - from every Inbox seat out through the door, for tasks that move on to Dev Bay;
  - with no clipping through the desk, the chairs, or the counter.
  - The Inbox desk row may move back (Inbox only) now that the lounge's back band is free.
- **Visibility:** seated Inbox robots stay visible from the default camera.
- **Palette:** the envelope color passes the palette rule (hue at least 30° from every
  `ZONE_COLORS` tone and the neon purple, or saturation below 0.15).
- **Tests** (vitest, `dashboard/client`, each seen failing before the change):
  - the `enter` and `overflow` routes include the pick-up stop after the Inbox door;
  - the pick-up pause;
  - the envelope is not shown for snap, reduced motion or first load;
  - the shelf count (`max(0, n − 4)`, capped);
  - concurrent arrivals do not share a pick-up spot, and a skipper has no envelope;
  - an Inbox-full arrival has no walk; the revealed robot picks up when a desk frees.

## Calls I made (Claude), for Earth to check

- **Every new task picks up at the Inbox reception, whatever room it is heading for.** Today
  every new task already enters through the Inbox door (`enterPoints`). The pick-up stop is
  added right after it, so a task that starts in Dev Bay also collects its envelope first. The
  same holds for an `overflow` robot, which then walks to its full room's front and vanishes.
- **Pick-up spots:** the counter has up to three pick-up spots. When more robots arrive at
  once, the extra ones skip the pick-up and walk straight to their seat, so nobody piles up.
  Only a robot that holds a pick-up spot gets an envelope, so the counter never shows more than
  three. A robot that skips never has one. Several robots starting at the same Inbox door point
  during a batch is today's SPAR-38 behavior; it does not count as piling up.
- **An Inbox-full arrival shows no walk.** It adds a shelf box instead of walking in, picking
  up, and walking back out the door it came in through. When a desk frees, the revealed robot
  walks in and picks up. This keeps the shelf and the robots telling the same story.
- **Existing test assertions that change by design may be updated, not loosened.** There are
  two:
  - `officeMove.test.ts` "brings a new task in through the Inbox front" uses `aisleIsClear` and
    its `interior()` helper. The helper may allow the new door → pick-up → seat segments inside
    the Inbox, and only those. It must still reject a segment that crosses a wall or cuts
    through furniture.
  - `officeCharacters.test.ts:183` checks the Inbox seat at `DESK_Z + SLOT_Z_OFFSET`. If the
    Inbox desk row moves back, it may check the new Inbox desk Z plus the same offset.
  - The PR body names each changed assertion and says why. This matches the
    `officeNight.test.ts` change in the Done spec.
- **The pause is about 1 s.** It uses an existing Blocky clip (for example `interact-right`). The
  builder picks the clip.
- **Shelf cap:** six boxes. The real count stays in the side panel.
- **The envelope appears on data and disappears when the robot sits.** A robot that skips the
  pick-up takes no envelope, and its envelope disappears when it sits.

## Left to the builder

- Exact counter model and placement, the monitor, the shelf model, and the new desk row
  position for the Inbox.
- The pick-up spot coordinates and how they join the waypoint graph.
- The envelope mesh (a thin box is fine), its emissive level within the palette rule, and how the
  robot "carries" it (a glow box attached in front of the torso, like the existing visor glow).
- The clip used for the pick-up.

## Open risks

- A reception desk in the middle of the entrance narrows the path in and out. Moving the desk
  row back is the first lever. If that is not enough, report back before moving the desk
  off-center, because that is Earth's B layout.
- Batch arrivals (many tasks opened at once) mean many robots. The three spots, the skip rule
  (a skipper has no envelope), and the Inbox-full rule keep the counter at three envelopes or
  fewer.
- The Inbox light stays cyan. The envelope is the only warm element and should still read on a
  cyan floor.

## Deploy and rollback

Client only, no data or API change, no migration. Roll back by reverting the PR.
