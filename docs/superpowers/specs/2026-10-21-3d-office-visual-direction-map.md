# 3D Office visual direction — decision map

Shaping artifact (decision-wayfinding). Not an implementation spec yet. Owner:
Earth. Related: Multica SPAR-32 (phase 1, PR #103 merged), SPAR-34 (phase 2a,
PR #107 open), SPAR-35 (backlog).

Why this map exists: on 2026-10-21 Earth reviewed the PR #107 render and said
it still does not look good. The approved concept (dark low-poly office;
light = data, so empty rooms are dark and busy rooms are lit; a readable side
panel) did not come through. Floors render as flat pastel fills, empty rooms are
light gray, and the screens do not read as light sources. A Claude review of the
#107 build against live data, 2026-10-21, found the same.

```yaml
destination:
  outcome: >-
    Decide the 3D Office visual direction, prove it with a prototype screenshot
    Earth approves, and hand Niko an implementation-ready spec to revise PR #107
    (or to follow it).
  done_when:
    - "Earth picked a north-star reference and approved a prototype screenshot of the chosen direction"
    - "D2-D7 resolved with evidence: status expression, lighting, post-processing, palette/materials, composition/camera, prop density"
    - "The prototype holds the budget: <=60 draw calls and 60 fps at 1440x900 on Earth's Mac, CC0 assets only, no new npm dependency"
    - "D8 (what happens to PR #107 meanwhile) decided"
    - "Spec posted to SPAR-34 for implementation"
  v1_boundary: >-
    The static scene look plus the ambient motion 2a already has. Out: characters (2b),
    TV mode (2c), new API/data, React/three/fiber upgrades.
  status: confirmed
  confirmed_by: "Earth (operator), 2026-10-21, in the Claude session that wrote this map"

nodes:
  - id: I1
    type: investigation
    title: "Why does the #107 render read pastel and flat? Map each visual symptom to the material, light, or tone-mapping setting that causes it"
    status: resolved
    depends_on: []
    outcome: >-
      Status is painted, not lit. The floor material is white x the instance color
      (the zoneTone status color), plus a weak emissive of the same color
      (statusMaterial 0.16-0.34). One directional key light (1.35), RoomEnvironment (0.4)
      and ambient (0.16) light every room the same. So each floor reflects a bright
      saturated color, which ACES tone mapping washes to pastel. Empty and terminal rooms
      get gray #5b6776 as albedo under the same key light, so they render lighter than the
      #10161e ground, not dark. Screens are small emissive panels (0.55) with no bloom and no
      light cast into the room, so they never read as light sources. Hover and selection
      multiply the color by 1.4, which makes it brighter pastel. The concept "light = data"
      became "paint = data under daylight".
    evidence:
      - "OfficeScene.tsx@23839404:45-64 statusMaterial (white base, emissive x vColor)"
      - "OfficeScene.tsx@23839404:453-467 ambient 0.16, directional 1.35 with shadows; :192 environmentIntensity 0.4"
      - "officeLayout.ts@23839404:146-150 floor pose color = zoneTone; :181-200 screen color = tone"
      - "commandZones.ts ZONE_COLORS gray #5b6776 for empty/terminal (zoneTone)"
      - "Claude browser check of the #107 build on live data, 2026-10-21 (look-options/0-current-pr107.jpg)"
    resolved_at: 2026-10-21

  - id: R1
    type: research
    title: "Assemble 3-4 candidate north-star looks (reference images plus what makes each work) for Earth to compare"
    status: resolved
    depends_on: []
    outcome: >-
      Four candidates. A, neon ops floor (our own office-bg.webp): dark navy, cyan/purple floor
      neon, glass rooms, glowing monitors, red alert room. It continues the Operations view
      but needs bloom to work. B, night diorama (Dribbble "isometric room night"): dark
      cut-away rooms lit from inside by warm lamps and screens; status only as accent light.
      C, spotlight islands (Bruno Simon): near-black ground, each room an island in its own
      pool of light, and that light's color and strength is the status. It maps most
      directly to "light = data", but empty rooms need a faint outline so they do not vanish.
      D, minimal dark slate: monochrome dark rooms, with status only as thin glowing edges
      and LEDs. It is the most legible and the least striking. Claude's recommendation:
      C as the base with A's accents (monitor glow, neon spine, bloom).
    evidence:
      - "ai-dev-office/dashboard/client/public/office-bg.webp (A)"
      - "dribbble.com/search/isometric-room-night, viewed 2026-10-21 (B)"
      - "bruno-simon.com, viewed 2026-10-21 (C)"
      - "Comparison images sent to Earth: Claude scratchpad look-options/ (0-current, A, B, C)"
    resolved_at: 2026-10-21

  - id: D1
    type: decision
    title: "Which north-star look does the 3D Office aim for?"
    status: resolved
    depends_on: [R1]
    outcome: >-
      C (spotlight islands) as the base, with accents from A (neon ops floor). The ground is
      near-black. Each room is an island inside its own pool of light, and the pool's color
      and strength is the room's status. Empty rooms are dark and keep only a faint outline.
      On top: glowing monitors, the neon spine along the workflow, and bloom.
    evidence: ["R1", "Earth's choice, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D8
    type: decision
    title: "What happens to PR #107 while the look is reworked: hold it, or merge it with the two review fixes and do the look as a follow-up PR?"
    status: resolved
    depends_on: []
    outcome: >-
      Fix the two review findings in #107 (drag clears or changes selection;
      InstancedMesh boundingSphere is never recomputed), then merge it. The new look ships
      in a follow-up PR on top of it.
    evidence: ["Earth's choice, 2026-10-22", "Claude review of #107, 2026-10-21"]
    resolved_at: 2026-10-22

  - id: P1
    type: prototype
    title: "Throwaway lighting/status spike in the chosen look: render 2-3 variants with the #107 rooms and Kenney props; screenshot each and measure draw calls and fps"
    status: resolved
    claimed_by: "Claude session local_aa4a13f6 '3D Office look prototype (P1)', started 2026-10-22"
    depends_on: [D1, I1]
    notes: >-
      Spike in a scratch worktree of feat/3d-office-2a; never committed or pushed. Variants
      should differ on the open questions of D2-D4: (v1) per-room light pool as an emissive
      radial decal on a dark floor + bloom; (v2) real per-room PointLight/SpotLight + bloom;
      (v3) emissive rim/edge + screen glow only, no pool. Every variant: key light down to a
      dim moonlight, dark neutral floor albedo, status color only in emitted light.
    outcome: >-
      All variants hold the budget with room to spare. Measured in system Chrome (ANGLE Metal,
      Apple M5) at 1440x900, DPR 2, so the canvas is 1320x1203 at the scene's 1.5 DPR cap, on
      live data (575 runs). Draw calls, scene plus post: #107 now 28+0, v1 28+14=42,
      v2 26+14=40, v3 26+14=40, v4 28+14=42. Every variant runs at 60 fps (rAF cap) at
      1440x900, and also at 2560x1440 (3000x2013 canvas). The 14 post calls are bloom's
      full-screen passes. The spike's Office3DView chunk is 274.19 kB gzip.
      Shared night base: moonlight #9db3e8 at 0.6, replacing the white 1.35 key, with the same
      1024 PCF shadow. Ambient 0.05 (was 0.16); RoomEnvironment 0.12 (was 0.4). Background
      #05070b, ground #080b10, grid #111925. Floors #1f2631 carry no status color; walls
      #161d27/#1b2430. Empty and terminal rooms get a faint #7f93b0 outline (wall caps, front
      posts, floor lip) at x0.22. Monitors emit 2.0 in the room tone, lamp shades 1.4, and the
      neon spine is boosted x1.8.
      Post chain, all from three/examples: EffectComposer (HalfFloat target, MSAA 4) ->
      RenderPass -> UnrealBloomPass (strength 0.85, radius 0.55, threshold 0.9) ->
      OutputPass (ACES). Hover/selection multiplies the room's emission x1.6.
      How each variant reads:
      v1 (decal pool): the strongest island read, but the decal lights nothing, so props are
      dark silhouettes.
      v2 (one SpotLight per room, fixed count of 10, no shadows): rooms lit from inside and
      props readable, but only a faint pool on the ground.
      v3 (rim + screens): neon-sign outlines and very legible status, but interiors stay dark
      and the rooms no longer read as spotlight islands.
      v4, a hybrid added after v1-v3: v2's spotlights plus v1's ground halo at 0.6. It keeps
      lit interiors and the island pool. Claude's recommendation.
      Findings for the spec:
      (a) In #107 every desk monitor faces away from its chair and the camera (screen pose
      rotY = PI), so there is no visible monitor glow. The spike uses rotY 0.
      (b) The 2.3x Review wall screen is the brightest flare in every night variant and needs
      its own lower intensity.
      (c) The layout's projected centre is off the #107 aim; target (-1.2, 0, -0.1) centres
      the cluster. Zoom cannot go above 30 without clipping Blocked at the stage's 880 px width.
    evidence:
      - "Comparison sheets: side-session-notes/local_de35909e-fc7c-4b1c-a4dc-ba207ff20d85/p1-office-look/P1-compare-overview.jpg, P1-compare-selected-devbay.jpg, P1-v4-and-camera.jpg (+ per-variant 1440px jpgs)"
      - "Numbers: same folder, stats-1440x900.json (fps, draw calls, scene calls, triangles, canvas size, GPU string)"
      - "Spike code: same folder, p1-spike.diff + p1Night.tsx.txt (on c10d66d4 = 23839404 plus the two #107 review fixes, which do not touch the look); capture via p1-capture.mjs (playwright-core + system Chrome), serve via p1-serve.mjs"
      - "Variant URL knobs in the spike: ?look=base|v1|v2|v3|v4, plus mk ek ak sk ng lk pk rk ok bs br bt tx tz zm"
    resolved_at: 2026-10-22

  - id: D2
    type: decision
    title: "How a room shows its status (floor fill, light pool, rim/edge glow, wall strip, or label chip)"
    status: resolved
    depends_on: [P1]
    outcome: >-
      v4. Status is light, never paint. A working room with tasks gets a spotlight in its
      ZONE_COLORS tone, which lights the floor, props and walls from inside, and a soft additive
      radial halo on the ground around the island (decal at 0.6). Strength is 1.0 for active or
      needs-a-human rooms and 0.7 for idle rooms with tasks. Needs-a-human rooms pulse. Wall caps,
      front posts and the floor lip carry an outline in the room tone at 0.9. Empty and terminal
      rooms show only the faint #7f93b0 outline at 0.22. Hover and selection raise the room's
      light x1.6. Desk monitors glow in the room tone.
    evidence: ["P1 (v4 tiles in P1-v4-and-camera.jpg; v1-v3 in P1-compare-*.jpg)", "Earth picked v4 from the rendered prototype screenshots, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D3
    type: decision
    title: "Lighting model: ambient level, real per-room lights versus emissive surfaces, shadow settings"
    status: resolved
    depends_on: [P1]
    outcome: >-
      Real lights, as rendered in v4. Moonlight directional #9db3e8 at 0.6, from the #107 key
      position, keeps the 1024 PCF shadow. Ambient 0.05, RoomEnvironment 0.12. There are 10
      SpotLights, one per room, always present so the shader compiles once. Each sits 6.5 above
      the room aimed at its floor (angle 0.5, penumbra 0.8, decay 2, distance 16, intensity 1800
      x level) and casts no shadow. A dark room's light is set to intensity 0, never removed.
    evidence: ["P1 v2/v4 measurements: 60 fps at 1440x900 and 2560x1440 with 10 spotlights", "Earth's v4 pick, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D4
    type: decision
    title: "Post-processing: bloom or none, which pass from three/examples, and its frame cost"
    status: resolved
    depends_on: [P1]
    outcome: >-
      Bloom on. The chain is EffectComposer (HalfFloat target, MSAA 4) -> RenderPass ->
      UnrealBloomPass (strength 0.85, radius 0.55, threshold 0.9) -> OutputPass (ACES, exposure
      1.05), all from three/examples/jsm with no new dependency. A priority-1 useFrame drives the
      composer. Measured cost: +14 draw calls (v4 total 42 of 60), +~6.4 kB gzip on the
      Office3DView chunk, and 60 fps at 1440x900 and 2560x1440 on Earth's Mac (M5).
    evidence: ["P1 stats-1440x900.json", "Earth's v4 pick, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D5
    type: decision
    title: "Palette and materials: floor, wall, furniture, and accent colors, and their saturation"
    status: resolved
    depends_on: [D1]
    outcome: >-
      Locked as rendered in P1. Background #05070b, ground #080b10, grid #111925. Floor
      #1f2631 (roughness 0.82) carries no status color. Walls are #161d27 on the back and right,
      #1b2430 on the left. Kenney prop albedos are unchanged (wood #6a4b32, metal #3e4854,
      fabric #4c3b45). Status colors stay ZONE_COLORS (cyan/green/amber/red), as emitted light
      only. The empty-room outline is #7f93b0 at 0.22. Accents: monitors emit 2.0 in the room
      tone with a +/-14% flicker; lamp shades #ffe7a8 emit 1.4; the neon spine and spurs gain
      x1.8; the Review glass loses most of its emissive (0.06). The glass-edge and alert-edge
      strips of #107 are dropped, since the outline does their job. One change from the render:
      the 2.3x Review wall screen gets its own lower intensity, because it is the brightest
      flare in the scene.
    evidence: ["P1 screenshots", "Earth: 'lock as rendered', 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D6
    type: decision
    title: "Composition: room arrangement (separate islands versus one connected floor), spacing, default camera angle and zoom"
    status: resolved
    depends_on: [D1]
    outcome: >-
      Keep the #107 composition: 10 separate islands on the ROOM_LAYOUT grid (6 apart in x,
      7 in z), the orthographic iso camera with offset (24, 20, 20.5) from its target, zoom 30,
      and the OrbitControls limits. Two changes. (1) Move the aim from (0, 0, 3.5) to
      (-1.2, 0, -0.1), so the cluster sits in the middle of the stage. The camera position moves
      by the same offset. (2) Desk monitors face their chair and the camera (screen pose rotY 0,
      not PI). Zoom stays at 30: at the 880 px stage width, 34 clips Blocked.
    evidence: ["P1-v4-and-camera.jpg (lower row)", "Earth's pick 'islands + re-aim', 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D7
    type: decision
    title: "Prop density per room and which extra CC0 items (same Kenney pack first)"
    status: resolved
    depends_on: [D1, D6]
    outcome: >-
      Fuller furnishing than v4. Each room gets a themed set from the same Kenney Furniture
      Kit (CC0, already licensed in public/office3d/License.txt): for example lounge seating
      in Inbox, a meeting table and chairs in Review, bookcases and boxes in Dev Bay, Done and
      Aborted, cabinets in Debug Lab, the code racks plus a floor lamp in DevOps. These are
      examples only; the real names come from the pack. Rules: (1) no other asset source, and
      only the glb files actually used get committed; (2) decor is static and not pickable, so
      it is merged or instanced per material; (3) the whole scene, bloom included, stays at or
      under 60 draw calls at 1440x900, measured with gl.info.autoReset = false; (4) decor never
      blocks a room's status light, its desks, or its monitors at the default camera; (5) empty
      and terminal rooms stay dark: their decor gets no light of its own. The exact per-room item
      list is the spec's first step, approved by Earth on a screenshot before implementation.
    evidence: ["Earth: 'ตกแต่งเต็มกว่านี้' (fuller than v4), 2026-10-22", "P1 budget headroom: v4 = 42 of 60 draw calls"]
    resolved_at: 2026-10-22

fog:
  - item: "Custom or AI-generated 3D props instead of Kenney"
    why_not_a_node: "No evidence yet that the Kenney pack cannot reach the chosen look"
  - item: "Theme variants (day/night) or user-selectable looks"
    why_not_a_node: "Nobody has asked for it; one look first"
  - item: "Phone-width look of the 3D stage"
    why_not_a_node: "The dashboard is used on desktop; no requirement yet"

deferred:
  - id: 2b-characters
    reason: "Out of V1. Waits for operator data (history[].operator, PR #105) to show up in real rows"
  - id: 2c-tv-mode
    reason: "Out of V1"
  - id: D7a-item-list
    reason: >-
      The exact Kenney items per room need the pack's file list and a render. This is the
      first step of the implementation spec, with Earth's screenshot approval as the gate.
      It is not shaping work.
```

## Checkpoints

```yaml
checkpoint:
  written_at: 2026-10-22
  map: "ai-dev-office/docs/superpowers/specs/2026-10-21-3d-office-visual-direction-map.md"
  destination: "Visual direction decided, prototype approved, spec to SPAR-34 (confirmed by Earth 2026-10-21)"
  resolved:
    - "I1: status is painted (albedo = zoneTone) under one strong key light, not lit; empty rooms gray albedo, so light; screens weak emissive with no bloom"
    - "R1: four candidate looks A neon ops / B night diorama / C spotlight islands / D minimal slate"
    - "D1: C base + A accents (dark ground, room light pool = status, empty rooms dark with faint outline, glowing monitors, neon spine, bloom)"
    - "D8: fix the two #107 review bugs, merge #107, new look in a follow-up PR (fix request posted to SPAR-34, comment 01a15fb9, 2026-10-21T18:28Z)"
  findings_to_keep:
    - "Baseline for the spike: branch feat/3d-office-2a @ 23839404 (PR #107); look code lives in office3d/OfficeScene.tsx (materials, lights, Canvas), officeLayout.ts (pose colors), officeLook.ts (SCENE palette)"
    - "Budget: 2a measured 24-28 draw calls (ceiling 60); Office3DView chunk 267.81 kB gzip; props are 5 Kenney glb (74,648 B, CC0); no new npm deps (three/examples passes are fine)"
    - "Local preview recipe that works: build the client in a scratch worktree (symlink node_modules from the main checkout), serve dist with a small node static server that proxies /api to localhost:4310, start it via a .claude/launch.json entry with runtimeExecutable node. vite preview from launch.json fails with EPERM on the main checkout's node_modules."
    - "R3F onClick fires after a drag; any new click handler must ignore event.delta > ~3"
  frontier: [D5, D6]
  claimed:
    - "P1: Claude session local_aa4a13f6 (it will also propose D5/D6 from its screenshots)"
  blocked: ["D2, D3, D4 wait on P1", "D7 waits on D6"]
  fog: ["custom/AI-generated props", "theme variants", "phone-width look"]
  next_action: "Run P1 in a fresh session: three variants (decal light pool + bloom / real per-room lights + bloom / emissive rim + screen glow only) on the #107 code in a scratch worktree; screenshot each beside look-options/0-current-pr107.jpg; record draw calls and fps; let Earth pick, which resolves D2-D4 and informs D5/D6"
```

```yaml
checkpoint:
  written_at: 2026-10-22
  written_by: "Claude session local_aa4a13f6 (P1)"
  map: "ai-dev-office/docs/superpowers/specs/2026-10-21-3d-office-visual-direction-map.md"
  destination: "Visual direction decided, prototype approved, spec to SPAR-34 (confirmed by Earth 2026-10-21)"
  resolved:
    - "I1, R1, D1, D8 (see the previous checkpoint)"
    - "P1: four night variants plus #107 rendered on live data; all fit the budget (<=42 draw calls including 14 bloom passes, 60 fps at 1440x900 and 2560x1440 on Earth's M5)"
    - "D2: v4, which is a spotlight per room in the status tone plus a soft ground halo; empty and terminal rooms get only a faint outline"
    - "D3: moonlight 0.6 + ambient 0.05 + env 0.12; 10 fixed SpotLights without shadows; moon keeps the 1024 PCF shadow"
    - "D4: UnrealBloomPass 0.85/0.55/0.9 in EffectComposer + OutputPass, three/examples only"
    - "D5: night palette locked as rendered; Review wall screen gets a lower intensity"
    - "D6: keep the islands, spacing, iso camera and zoom 30; aim at (-1.2,0,-0.1); monitors face the chair"
  done_when_status:
    - "North-star + approved prototype screenshot: met (Earth picked v4 from the P1 screenshots)"
    - "D2-D7 resolved: D2-D6 done, D7 open"
    - "Budget held by the prototype: met (P1 numbers)"
    - "D8 decided: met"
    - "Spec posted to SPAR-34: not yet (after D7)"
  findings_to_keep:
    - "Evidence folder (outside the repo): /Users/earth/Library/Application Support/Claude/side-session-notes/local_de35909e-fc7c-4b1c-a4dc-ba207ff20d85/p1-office-look/ holds the comparison sheets, per-variant jpgs, stats-1440x900.json, p1-spike.diff, p1Night.tsx.txt, and p1-capture.mjs/p1-serve.mjs"
    - "The spike diff is the reference implementation for the v4 look: p1Night.tsx (roomGlows, poolItems, rimItems, Decor, RoomSpots, Post) + OfficeScene.tsx wiring. It is throwaway code (URL knobs, window.__p1 stats). Do not merge it as is."
    - "Measuring with bloom: set gl.info.autoReset = false and reset once per frame, or the count shows only the last pass. A playwright-core capture with system Chrome (headless) uses the real Metal GPU, so it gives representative fps and full-resolution screenshots."
    - "#107 bug that matters for the look: desk monitors face away from the chair and the camera (rotY PI in officeLayout.ts screen pose)"
  frontier: [D7]
  blocked: []
  fog: ["custom/AI-generated props", "theme variants", "phone-width look"]
  next_action: "Resolve D7 (prop density per room, extra Kenney CC0 items) against the v4 render, then write the implementation-ready spec (D2-D7 + budget + the monitor-facing fix) and post it to SPAR-34 for Niko. No production code until then."
```

```yaml
checkpoint:
  written_at: 2026-10-22
  written_by: "Claude session local_de35909e (map owner)"
  map: "ai-dev-office/docs/superpowers/specs/2026-10-21-3d-office-visual-direction-map.md"
  destination: "Visual direction decided, prototype approved, spec handed off: decision-complete"
  resolved:
    - "D7: fuller furnishing from the same Kenney Furniture Kit, with themed sets per room; static decor merged or instanced; total <=60 draw calls with bloom; decor never blocks status light, desks or monitors; empty and terminal rooms stay dark"
  done_when_status:
    - "North-star and approved prototype screenshot: met (v4)"
    - "D2-D7 resolved: met (D7a, the exact item list, deferred into the spec's first step with Earth's screenshot gate)"
    - "Budget held by the prototype: met (v4 = 42 of 60 draw calls, 60 fps)"
    - "D8 decided: met (#107 fixed at c10d66d4 and approved; Earth merges it)"
    - "Spec handed off: met, as new sub-issue SPAR-36 under SPAR-32 rather than a SPAR-34 comment (Earth's choice, 2026-10-22: SPAR-34 closes with #107)"
  handoff: "SPAR-36 '3D Office: night look (v4) + fuller furnishing', assigned to the AI Dev Team squad (lead Jason Duval), status todo, 2026-10-22. Step 1 = item list + screenshot for Earth's approval; step 2 implements on a branch from origin/main after #107 merges."
  frontier: []
  fog: ["custom/AI-generated props", "theme variants", "phone-width look"]
  next_action: "None for shaping. Follow SPAR-36: approve the step-1 item list, then review the PR against this map's D2-D7."
```
