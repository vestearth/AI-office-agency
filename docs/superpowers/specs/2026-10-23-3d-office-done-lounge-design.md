# 3D Office: the Done room becomes a lounge

Date: 2026-10-23 · Status: draft for Earth's approval · Follows: SPAR-38 (characters),
SPAR-39 (desk hold, replan), map `docs/superpowers/specs/2026-10-22-3d-office-characters-map.md`

## Intent

Today the Done room is a dead room. It draws up to four desks for the most recent done
tasks, its light is always off (`roomLightLevel` returns 0 for every terminal room), no robot
ever enters it, and nothing in it says which work finished last or how much closed today. A
finished robot celebrates at its old desk, walks to its own room's front and vanishes there.

Earth wants the Done room to be different from the other rooms and actually used:

- **See at a glance which tasks finished most recently, and how many closed today.**
- **Robots deliver their finished work to the Done room** instead of vanishing at their own
  room's front.
- **New furniture for the Done room.** Earth chose concept C, "lounge after done", from three
  mockups (A delivery shelf, B podium, C lounge). The mockups are in the brainstorm
  session at `scratchpad/done-room/.superpowers/brainstorm/` (not in the repo).

## The design (as decided with Earth)

**Furniture: a lounge.** It replaces the four done desks and their chairs. The items:

- a sofa along the back wall;
- a coffee table in the middle;
- a TV cabinet against the left wall, with a screen;
- a floor lamp;
- a corner where cardboard boxes pile up.

All of it comes from the Kenney Furniture Kit already shipped in
`dashboard/client/public/office3d/`: `loungeSofa`, `loungeSofaOttoman`, `loungeChair`,
`tableCoffee`, `cabinetTelevisionDoors`, `lampRoundFloor`, `pottedPlant`,
`cardboardBoxClosed` and `cardboardBoxOpen`. The current Done decor
(`bookcaseOpenLow` and two boxes in `officeDecor.tsx`) is replaced.

**What the room tells you:**

- **TV screen:** "closed today N" and the three most recent done task ids.
- **Glowing box on the coffee table:** the most recent done task.
- **Box pile in the corner:** one box per task closed today. It grows through the day and is
  back to zero after local midnight.

**Robots deliver to the room.** When a drawn task turns Done:

1. The robot celebrates at its old desk, as now (`CELEBRATE_SECONDS`).
2. It walks out through its room's front, along the aisles, and in through the Done room's
   front. These are the same waypoint rules as zone-to-zone walks (SPAR-38 PR 2).
3. It sits on the sofa for a short while, then vanishes (the existing scale-down vanish).

**When the lounge changes.** The TV, the coffee-table box, the pile and the light update as
soon as the data arrives. They do not wait for the robot to sit down, so the TV always equals
Insights. The robot's walk is the visible delivery: for the few seconds it walks over, the box
is already on the table. (Claude's call, see below.)

**"Today"** means since local midnight, Asia/Bangkok, counting completed tasks only.
Cancelled tasks belong to Aborted and are not counted. This is the same definition the
Insights throughput uses.

**Room light.** The Done room lights up once at least one task closed today. Its light is a
warm, low-saturation white, so it does not read as any status color. The room outline (zone
tone) keeps its meaning.

## Goals, non-goals, anti-goals

**Goals**

- From the overview camera you can tell the Done room by its lounge, TV and box pile, and see
  that it is lit and has a pile when work closed today.
- At default zoom you can read today's count and the latest task id on the TV.
- Every robot that finishes during the session visibly walks to the lounge, sits, and goes.

**Non-goals (V1)**

- No server or API change. The data already exists (see Data).
- No change to the other rooms, the Aborted room, or the work and stuck room flows. The one
  exception is the hidden-tab catch-up rule under Constraints: it fixes an existing
  parade for every walk.
- **Inbox stays as it is in this V1.** Inbox already has a lounge set (`officeDecor.tsx:37-40`:
  `loungeSofa`, `loungeChair`, `tableCoffee`, `loungeSofaOttoman`). Earth decided on 2026-10-23
  to redesign Inbox later, as a separate design. Until then, both rooms have a sofa. Done stands
  apart through its TV, the box pile, the warm light and the robots sitting in it.
- No history browsing beyond the latest three. The side panel keeps the full list as now.
- No sound, no confetti or particle effects, no daily-reset animation.

**Anti-goals: it fails even if it technically works when**

- The lounge is brighter or more eye-catching than a room that needs attention. Done must
  stay calm.
- The TV count disagrees with Insights' "closed" for today.
- Robots pile into each other on the sofa, or clip through the lounge furniture.
- Opening the page (or coming back to the tab) shows a parade of robots walking to the lounge.

## Data

- **Today's count:** `Office3DView` already fetches `/api/analytics/flow?days=7`. In
  `flow.throughput.days`, the entry whose `date` is today's local date carries `closed`.
  `flowInsights.ts` buckets by `OFFICE_TZ` (default Asia/Bangkok) using the run's last timed
  transition into done. Use that entry. If `flow` is null (its fetch failed), the TV shows "–"
  and the pile shows nothing. Do not guess.
- **Latest done tasks:** the tasks in the Done zone are already ordered newest first by
  `updatedAt` (`zonePreview`, terminal branch). The first is the coffee-table box. The first
  three are the TV list.

## Constraints

- Draw calls: at most 70 at 1440×900 with bloom, on live data and with the 32-robot stress
  (today: 55 and 53). The furniture goes through the existing merged Kenney decor path. The
  box pile is one instanced mesh, capped.
- 60 fps on the M5, including while robots walk to the lounge.
- No new npm dependency. CC0 assets only, from the kit already in the repo.
- Light color: it must pass the measurable palette rule from the characters map. Hue at least
  30° from every `ZONE_COLORS` tone and the neon purple, or saturation below 0.15. A
  low-saturation warm white satisfies it.
- First load, remount and a failed-then-successful first fetch place no robots in the lounge.
  The rules are the same as SPAR-38/39: walks only for transitions seen within one mount.
- **Hidden-tab catch-up, for every walk:** while the browser tab is hidden, `animate` is false
  and frames stop, but data keeps arriving. Today, on return, `syncActors` plans a walk for
  every transition that happened while away, which is a parade, and Done deliveries would join
  it. The rule: a transition first applied while the page was hidden, or across a stream
  reconnect, snaps like reduced motion. The robot is placed at its new seat, a finished robot
  vanishes at its desk, and the lounge updates. This holds for every walk, not only Done.
  (Claude's call.)
- **Midnight:** after local midnight, the TV shows today's count (0 until something closes)
  even if no refresh event arrived, and the pile empties.
- Reduced motion: no walking. A finishing robot vanishes at its desk as now. The lounge (TV,
  box, pile, light) updates instantly.
- Selection: the side list and keyboard navigation keep working for Done tasks. Selecting a
  Done task in the list highlights something visible in the lounge (the coffee-table box for
  the latest, otherwise the TV), and the selection card anchors there.
- Tests (vitest, `dashboard/client`). Each regression test must be seen failing before the
  change. They cover:
  - the move planner: Done → walk to the lounge, sit, vanish; a full sofa; reduced motion;
    first load;
  - the Done light rule (lit only when today > 0). This intentionally changes the existing
    `officeNight.test.ts` expectation `roomLightLevel(done, …) === 0`. The change is the
    behavior change itself, not a weakened test;
  - the TV and pile derivation from `flow`, including `flow === null`;
  - the palette rule for the lounge light.

## Calls I made (Claude), for Earth to check

- **The lounge updates on data, not on the robot's arrival.** That keeps the TV equal to
  Insights, which is an anti-goal, and keeps the lounge a pure function of `flow` and the Done
  list. The robot's walk is the delivery animation. With the other choice, a robot that
  vanishes at a full sofa, or a task that closes with no robot on the board, would need
  "delivered" rules, and the TV would lag Insights.
- **The hidden-tab catch-up rule covers every walk**, not only Done. It restores the no-parade
  rule Earth set in SPAR-38. Done-only would leave the same parade in the other rooms.
- **Sofa capacity:** at most three robots sit at once (sofa plus ottoman or lounge chair,
  whatever the models fit without overlap). A robot that finds the lounge full vanishes at the
  Done room's front instead of sitting.
- **Sit time:** about 4 s, then vanish.
- **Box pile cap:** 12 boxes. Above that the pile stays full, and the TV still shows the real
  count.
- **TV text:** a DOM overlay projected onto the TV screen position, like the existing room
  labels and selection card (`ProjectOverlays`), so it is crisp and costs no draw calls. The
  builder may choose a texture instead if the overlay cannot stay aligned when orbiting.
- **The room's label count:** the side list header for Done keeps the all-time count. The Done
  room's detail panel adds "closed today N".

## Left to the builder

- Exact placement, scale and rotation of the lounge furniture, the sofa seat height, and the
  sit offset for the Blocky rig on a sofa (the chair uses `SEAT_Y`).
- Exact light hex within the palette rule, and its level.
- How the Done room's front door and the sofa seats join the existing waypoint graph.
- Whether the glowing box uses the existing glow mesh or its own.
- **Freeing the old desk.** Today the desk hold (`deskHoldForRoom`, `officeMove.ts`) keeps a
  leaving robot's desk until that robot vanishes. With the lounge, that would freeze the old
  room for the whole walk and sit. Release it once the robot has left its room. The other
  SPAR-39 rules stay: never more than four desks, and no overlap.
- **The midnight refresh mechanism.** Data refreshes only on stream events, so something must
  roll "today" over at local midnight. A timer or a refetch both work.
- **Splitting the lamp-shade material.** It is shared by the decor lamps today, and its glow
  follows the DevOps room. The lounge's floor lamp follows the Done light rule.

## Open risks

- The latest-three list uses `updatedAt` while today's count uses the server's done
  transition time. A done run whose `status.yaml` is touched later could reorder the list.
  The metadata writers are meant not to bump `updated_at`.
- Many tasks closing within seconds (a batch close) send several robots at once. The sofa cap
  and the vanish-at-the-door rule keep that bounded.
- The Kenney sofa's seat height may not suit the Blocky sit pose. In that case pick a
  different seat model from the kit; do not add an asset.

## Deploy and rollback

Client only, no data or API change, no migration. Roll back by reverting the PR.
