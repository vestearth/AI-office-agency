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
    status: claimed
    claimed_by: "Claude session local_aa4a13f6 '3D Office look prototype (P1)', started 2026-10-22"
    depends_on: [D1, I1]
    notes: >-
      Spike in a scratch worktree of feat/3d-office-2a; never committed or pushed. Variants
      should differ on the open questions of D2-D4: (v1) per-room light pool as an emissive
      radial decal on a dark floor + bloom; (v2) real per-room PointLight/SpotLight + bloom;
      (v3) emissive rim/edge + screen glow only, no pool. Every variant: key light down to a
      dim moonlight, dark neutral floor albedo, status color only in emitted light.

  - id: D2
    type: decision
    title: "How a room shows its status (floor fill, light pool, rim/edge glow, wall strip, or label chip)"
    status: blocked
    depends_on: [P1]

  - id: D3
    type: decision
    title: "Lighting model: ambient level, real per-room lights versus emissive surfaces, shadow settings"
    status: blocked
    depends_on: [P1]

  - id: D4
    type: decision
    title: "Post-processing: bloom or none, which pass from three/examples, and its frame cost"
    status: blocked
    depends_on: [P1]

  - id: D5
    type: decision
    title: "Palette and materials: floor, wall, furniture, and accent colors, and their saturation"
    status: open
    depends_on: [D1]

  - id: D6
    type: decision
    title: "Composition: room arrangement (separate islands versus one connected floor), spacing, default camera angle and zoom"
    status: open
    depends_on: [D1]

  - id: D7
    type: decision
    title: "Prop density per room and which extra CC0 items (same Kenney pack first)"
    status: blocked
    depends_on: [D1, D6]

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
