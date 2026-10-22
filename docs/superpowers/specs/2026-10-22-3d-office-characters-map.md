# 3D Office agent characters (phase 2b) — decision map

Shaping artifact (decision-wayfinding). Decision-complete on 2026-10-22; the
implementation-ready spec is the last section of this file. Owner: Earth. Follows the decision-complete look map
`2026-10-21-3d-office-visual-direction-map.md` (night look, shipped in PR #108).
Related: SPAR-32 (phase 1), SPAR-34 (#107), SPAR-36 (#108), PR #105
(`history[].operator`).

Starting facts (2026-10-22, checked in the Claude session that wrote this map):

- The scene after #108 renders 52 draw calls of a 60 ceiling, at 60 fps at 1440x900 on
  Earth's M5. That was measured at the WebGL level, with bloom counted.
- Operator data: `RunSummary.currentConductor` (`/api/runs`) reads `history[].operator`
  first. Real rows so far: 7, all `codex` (TASK-EAR-385, TASK-VS-045). There are no
  `claude` or `cursor` rows yet, so the CURSOR_AGENT marker is still unverified.
- Assets: the scene uses the Kenney Furniture Kit (CC0). Quaternius Animated Robot is
  CC0 but ships FBX/OBJ/Blend only (`Robot.fbx` 3,297,804 B, 14 clips). There is no glTF.
  (R1 corrected this: three.js ships a glTF conversion, RobotExpressive.glb.)
- The look rule from the previous map: status is light in the ZONE_COLORS tones
  (cyan/green/amber/red); empty rooms are dark. Operator identity must not reuse those
  colors (flagged on SPAR-34).

```yaml
destination:
  outcome: >-
    Decide how agent characters appear in the 3D Office: what one character stands for,
    how it shows its operator, how it looks and moves, and how it fits the budget. Prove it
    with a prototype Earth approves on live data, then hand the squad an implementation-ready
    spec.
  done_when:
    - "Earth approved a prototype screenshot (and short clip if motion matters) on live data"
    - "D1-D5 resolved with evidence"
    - "The budget is held, or the 60 draw-call ceiling was explicitly raised by Earth; 60 fps at 1440x900; CC0 assets; no new npm dependency"
    - "Spec posted to Multica as a new sub-issue"
  v1_boundary: >-
    In: characters for tasks the scene already shows, operator identity, a few states driven by
    existing data (/api/runs, dashboard:refresh), and reduced-motion behavior. Out: free
    wandering or pathfinding, Multica persona names, sound, TV mode (2c), new APIs, and
    React/three/fiber upgrades.
  status: confirmed
  confirmed_by: "Earth (operator), 2026-10-22, in the Claude session that wrote this map"

nodes:
  - id: I1
    type: investigation
    title: "Per task, what operator data does the dashboard have today, how complete is it, and how does it change over a task's life?"
    status: resolved
    depends_on: []
    outcome: >-
      One derived value per task: RunSummary.currentConductor = the operator on the LATEST history row
      that names one (the `operator` field, else a tool named at the start of free-text `agent`).
      It means "the tool that last wrote a row", not "the tool working now". Coverage is thin: of 19
      open runs, 4 have it (21%): 3 `claude` from legacy free-text agent rows (all Blocked) and 1
      `codex` from the field (TASK-VS-045, Review). All 9 Dev Bay runs and 2 of 3 Review runs are
      unknown. Real `operator` field rows: 7, all codex, in 2 runs. Over a task's life the value only
      changes when a governed writer runs under an AI shell (open/PM by whoever opened it, dev by the
      runner, review by the reviewer). Dashboard button rows strip the marker, so they never change it.
      A task waiting in Dev Bay therefore shows its opener (e.g. the PM tool) until a runner writes.
      No backfill, so unknown stays the majority until new rows accumulate. A separate live signal
      exists: /api/launch/active lists dashboard-started launches with `cli` (claude | codex |
      cursor-agent) and the task id, i.e. "who is working right now", but only for runs started from
      the dashboard (empty at measurement time). The 3D page does not carry currentConductor yet:
      officeTasksFromApi picks id/title/status/currentAgent/updatedAt only. Desk count per room is
      capped at 4 (SCENE_DESK_LIMIT); live zone counts were Dev Bay 9, Blocked 6, Review 3, Inbox 1,
      Aborted 21, Done 536, so at most 4 desks per room show and 40 desks is the hard maximum.
    evidence:
      - "dashboard/server/src/services/runScanner.ts:63-83 (rowOperator, latestConductor), :556-576 (currentConductor in RunSummary)"
      - "dashboard/shared/types.ts:246-254 (RunSummary.currentConductor), :887-918 (OfficeLaunch.cli), :997 (TaskLaunchCli)"
      - "dashboard/client/src/views/office3d/officeSelection.ts:9 (SCENE_DESK_LIMIT 4), :57-74 (officeTasksFromApi drops currentConductor)"
      - "scripts/completion-guard.rb:200-220 (history_operator / with_operator: env var > CURSOR_AGENT > CODEX_THREAD_ID > CLAUDECODE)"
      - "Live GET localhost:4310/api/runs + /api/review, 2026-10-22 (server pid 89511, started 01:27, main 08aa4e46): 576 runs; open 19; conductor claude 3 / codex 1 / none 15; all runs: claude 62, codex 37, none 477"
      - "runs/*/status.yaml scan: 7 rows carry `operator` (TASK-EAR-385 rows 11-13 reviewer, TASK-VS-045 rows 0-3 dev), all codex"
      - "GET /api/launch/active, /chains, /queue: all empty at 2026-10-22 measurement"
    resolved_at: 2026-10-22

  - id: R1
    type: research
    title: "CC0 character options and formats: Quaternius robot (FBX to glb conversion, size, clips), Kenney/KayKit character packs, and a procedural primitive robot"
    status: resolved
    depends_on: []
    outcome: >-
      No FBX conversion is needed. three.js already ships the Quaternius robot as glb:
      examples/models/gltf/RobotExpressive/RobotExpressive.glb (463,988 B). Its README says CC0 1.0,
      model by Tomás Laulhé (Quaternius), converted with FBX2GLTF by Don McCurdy. It has 14 clips (Idle,
      Walking, Running, Dance, Death, Sitting, Standing, Jump, Yes, No, Wave, Punch, ThumbsUp, WalkJump)
      and 3 face morphs. But it is 19 meshes (about 38 calls with a shadow), so it is unusable for a
      crowd. If we ever convert an FBX ourselves, these routes add no npm dependency: three's
      FBXLoader + GLTFExporter in a browser (materials become approximations, and tracks that cannot
      bind are dropped silently); FBX2glTF 0.13.1 (an x86_64 binary that runs under Rosetta); Blender
      (not installed). The npm `three` package has no models.
      Other CC0 options:
      - Kenney Mini Characters (12 characters, GLB, 32 clips including idle/walk/sit/yes/no/die,
        one shared atlas, 243-273 KB each, likely 1 skinned mesh): about 2 calls per character.
      - Kenney Blocky Characters 2.0 (18 characters, GLB, 27 clips, 6 rigid unskinned parts,
        113.6 KB): 12 calls flat if each part is one InstancedMesh driven by AnimationMixer proxies.
      - KayKit Adventurers (CC0, glb, about 3.7 MB per character, 6 skinned parts on 1 atlas) with
        KayKit Character Animations (CC0, 150+ clips, including sitting, cheering, waving, and
        "generic working"; no typing): heavy.
      - Kenney Animated Characters: FBX only, 3 clips.
      - Quaternius Universal Animation Library: about 13k triangles per character.
      - A procedural robot (boxes in one InstancedMesh, plus one emissive InstancedMesh for eyes and
        a status lamp): about 2-4 calls total for any N, no asset, per-tool tint via setColorAt,
        animation hand-written on the CPU, and a boxy look that matches the Kenney furniture.
      Worth prototyping: (1) the procedural instanced robot, (2) Kenney Blocky as per-part instances
      (real clips, 12 calls flat), (3) optionally a Mini Character baked to VAT or morph frames
      (2 calls flat, per R2), which is the heaviest to build.
    evidence:
      - "https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/RobotExpressive/README.md (CC0, author, FBX2GLTF conversion); gh contents API size 463,988 B"
      - "https://github.com/mrdoob/three.js/blob/dev/examples/webgl_animation_skinning_morph.html (clip names, morphs)"
      - "https://quaternius.com/packs/animatedrobot.html (pack: FBX/OBJ/Blend, CC0)"
      - "https://kenney.nl/assets/mini-characters, https://kenney.nl/assets/blocky-characters (CC0; zip sizes via HEAD: 2,403,059 B and 2,148,510 B)"
      - "https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 (LICENSE CC0); https://kaylousberg.itch.io/kaykit-character-animations"
      - "https://quaternius.com/packs/universalanimationlibrary.html"
      - "node_modules/three/examples/jsm/loaders/FBXLoader.js:550-557, exporters/GLTFExporter.js:659-662,1662,2338"
      - "Clip/part counts for the Kenney packs come from third-party repos that use them (SECONDARY, unverified until downloaded): github.com/Lousync/dorm-monopoly (Blocky census), github.com/Aymanbalaa/grand-theft-poutine (Mini clips)"
      - "No asset was downloaded for R1. Approval needed before P1 uses one: RobotExpressive.glb 463,988 B (raw.githubusercontent.com/mrdoob/three.js); kenney_blocky-characters_20.zip 2,148,510 B and kenney_mini-characters.zip 2,403,059 B (kenney.nl)"
    resolved_at: 2026-10-22

  - id: R2
    type: research
    title: "Draw-call and frame cost of N animated characters in three 0.186 / R3F 8 (skinned meshes vs instanced rigid parts vs vertex-animation textures), shadows included"
    status: resolved
    depends_on: []
    outcome: >-
      Of the 52 calls, 14 are post-processing (UnrealBloomPass 13 at nMips 5, OutputPass 1), and 38
      are the scene: about 32 main draws plus 6 moon-shadow draws. Only the moon light casts shadows,
      and the shadow map redraws every frame, so each character mesh that casts a shadow costs 2 calls
      (main + shadow). three counts one call per material/primitive per pass; each glTF primitive
      becomes its own Mesh; an InstancedMesh is 1 call per pass for any N. three 0.186 has no
      instanced or batched skinning. Added calls (DERIVED from source, not measured):
      (A1) RobotExpressive as shipped = 19 primitives -> 38 per robot, over budget at N=1.
      (A2) a robot merged into 1 skinned mesh with 1 material = 2N, which fits only N<=4 (N<=8 without
      shadows). (B) one InstancedMesh per body part = 2P (10-16 for 5-8 parts), flat in N, over budget
      unless the parts share one geometry (2 calls flat) or few parts cast shadows. (D) BatchedMesh
      rigid parts = 2 flat, if WEBGL_multi_draw is present (unverified on Earth's Chrome). (C) VAT in
      one InstancedMesh = 2 flat. (C') InstancedMesh + morph-frame animation (setMorphAt) = 2 flat,
      no custom shader. CPU and GPU cost is small at N<=40 on an M5 for every technique; the draw count
      is the binding limit. Picking: InstancedMesh gives instanceId (already used by the scene);
      VAT and morph frames raycast the bind pose, so they need invisible proxy boxes. Complexity,
      lowest first: B < D < C' < A2 < C.
    evidence:
      - "node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js:101 (nMips 5), :282-368 (13 fsQuad renders); OutputPass.js:90-129"
      - "node_modules/three/src/renderers/webgl/WebGLShadowMap.js:86 (autoUpdate true), :526-562 (one shadow draw per caster group)"
      - "node_modules/three/src/renderers/webgl/WebGLRenderer.js:1337-1339 (instanced draw), :1939-1952 (one draw per group); WebGLInfo.js:18-20"
      - "node_modules/three/src/objects/InstancedMesh.js and BatchedMesh.js: no skin/skeleton code (grep, 2026-10-22)"
      - "office3d/officeNightView.tsx:94 (spots castShadow=false); OfficeScene.tsx:470,487,498 + officeDecor.tsx:212 (shadow casters)"
      - "RobotExpressive.glb JSON chunk (mrdoob/three.js examples/models/gltf/RobotExpressive), parsed by the R2 agent: 19 primitives, 3 materials, 3,237 tris, 7,214 verts, 2 skins x 43 joints; the binary was fetched for parsing and not kept"
      - "Spot-checked by the map owner against local three 0.186.1 source, 2026-10-22"
    resolved_at: 2026-10-22

  - id: D1
    type: decision
    title: "What does one character stand for (a running task at its desk, an operator per room, or something else), and how many can be on screen?"
    status: resolved
    depends_on: [I1]
    outcome: >-
      One character = one task at its drawn desk. Characters sit at every drawn (occupied) desk in
      the work rooms (Inbox, Dev Bay, Review, Escalation, DevOps, Debug Lab) and the stuck rooms
      (Blocked, Val.Failed). Done and Aborted get none. The cap follows the existing desk cap,
      SCENE_DESK_LIMIT = 4 per room, so at most 32 characters (8 rooms x 4); live data today gives 12
      (Dev Bay 4 of 9, Review 3, Inbox 1, Blocked 4 of 6). The operator comes from the task's
      currentConductor; most characters are "unknown" today (4 of 12 known). Consequence for D3/D5:
      the count is set by desks, not by budget, so the technique must cost the same for any N
      (instanced parts, VAT, or morph frames per R2). A skinned mesh per character (2N calls) is out.
    evidence: ["I1", "R2", "Earth chose option 1 of 4 in this session's D1 question, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D2
    type: decision
    title: "How a character shows its operator, including unknown or missing operator, without reusing status colors"
    status: resolved
    depends_on: [D1]
    outcome: >-
      Two channels on every character, plus text. (1) A glowing visor in a per-tool color, and
      (2) a per-tool head accessory shape: claude = flat cap, codex = antenna, cursor = two ears,
      antigravity = ring above the head, copilot = goggles (shapes are the proposal; P1 may adjust).
      The color must avoid the status tones (cyan #22d3ee, green #22c55e, amber #f59e0b, red #ef4444)
      and the purple neon spur (#af5df6). Only about 3 safe hues exist (magenta, indigo, white),
      and the room spotlights tint everything in status colors, so the shape carries identity when
      color fails, including for color-blind viewers. The palette was locked from the P1 render
      (palette c, Earth, 2026-10-22): claude #ff4fd8 (magenta), codex #f2f5ff (white), cursor
      #6e7bff (indigo), antigravity #b8ff4a (lime), copilot #c3a6ff (lavender), unknown #3a414b
      (unlit). Rendered in cyan, green, and amber rooms, claude, codex, and cursor stay distinct.
      Copilot drifts toward white in bright rooms, so its goggles carry it; no copilot agent exists
      today. Palette a (copilot #ff7aa8) merged with claude and was rejected. Unknown operator (no row names one) = a bare head with a grey,
      unlit visor. Legacy `gemini` (free text) shows as antigravity (the CLI's current name). The full
      tool name always appears as text in the hover/selection card and in the side panel. That
      carries exactness and accessibility; the 3D marks are a glance aid.
    evidence:
      - "dashboard/client/src/views/commandZones.ts:8 (ZONE_COLORS), office3d/officeLook.ts:24,32 (neonSpur purple, NEON_SPINE = cyan)"
      - "office3d/officeNightView.tsx:89-119 (a SpotLight per room colored by room.tone)"
      - "I1 (unknown is the majority today); hand-over note 2026-10-21: antigravity and copilot runtimes exist with no agents"
      - "Earth chose option 1 of 4 in this session's D2 question, 2026-10-22"
    resolved_at: 2026-10-22

  - id: P1
    type: prototype
    title: "Throwaway spike of characters on the #108 scene with live data, in 2-3 techniques from R1/R2; screenshot, clip, and measure draw calls and fps"
    status: resolved
    outcome: >-
      Built on 08aa4e46 in a scratch worktree; not committed. Measured in real Chrome (ANGLE Metal, M5,
      1440x900, DSF 2) with draw calls counted at the WebGL level and bloom included:
      base 52 calls; robot 55; robotclips 55; blocky 67 (60 without shadows). All runs held 60 fps,
      and the numbers were the same at 12 live characters and at 32 (stress).
      Techniques:
      - robot: procedural boxes in one InstancedMesh plus a glow InstancedMesh, motion written by
        hand.
      - robotclips: the same boxes driven by Kenney Blocky's CC0 clips through hidden proxy rigs
        with AnimationMixer.
      - blocky: Blocky textured, one InstancedMesh per part.
      All three use the D2 identity overlay as instances in the same two meshes, so identity costs
      0 extra calls.
      Look findings:
      - At the default zoom a character is about 10 px, and only the visor glow color reads.
        Accessories read from zoom 70 (the current max) upward.
      - Seated characters face away from the default camera, so the visor must wrap the head.
      - A light body blows out under the room spotlights plus bloom; a dark matte body
        (#4a5361) works.
      - Inside status-lit rooms, magenta and rose merge and lime drifts yellow, so shape carries
        identity there.
      - Blocky's clips (sit, walk, idle, emote-yes/no, interact, ...) drive any box rig whose
        node names match.
      Earth approved the robotclips render and clip on live data as the V1 reference, and locked
      palette c from P1-palette-compare.jpg (2026-10-22).
    evidence:
      - "side-session-notes/local_de35909e-.../p1-characters/: P1-characters-compare.jpg, P1-motion-robot-robotclips-blocky.mp4, stats.json, p1-chars-spike.diff, p1Chars.tsx.txt, capture scripts, README.md"
      - "Asset: kenney_blocky-characters_20.zip 2,148,510 B (kenney.nl; License.txt says CC0), downloaded to the scratchpad with Earth's approval; character-a.glb 113,596 B = 6 rigid box meshes, 72 tris, 1 texture, 27 clips"
    resolved_at: 2026-10-22
    scope: >-
      Earth chose (2026-10-22): (a) a procedural robot built from boxes in one InstancedMesh plus an
      emissive visor InstancedMesh, versus (b) Kenney Blocky Characters 2.0 as per-part InstancedMeshes
      driven by AnimationMixer proxies with real clips. No VAT. Earth approved downloading
      kenney_blocky-characters_20.zip (2,148,510 B, kenney.nl) into a scratch folder, never the repo.
    depends_on: [D1, R1, R2]

  - id: D3
    type: decision
    title: "Asset and animation technique for V1"
    status: resolved
    depends_on: [P1]
    outcome: >-
      robotclips. Every part of every character, plus the D2 accessories, is a unit box in ONE
      InstancedMesh: a dark matte MeshStandardMaterial with instanceColor that casts shadows.
      Visor bands and glow tips go in a second InstancedMesh (MeshBasicMaterial, toneMapped false,
      no shadow). Motion comes from Kenney Blocky Characters 2.0 CC0 clips. Each character gets a
      hidden proxy rig (a clone of the Blocky node tree) with an AnimationMixer. Every frame, each
      part's matrixWorld times that part's bounding box becomes one box instance. Asset: one Blocky
      glb (character-a.glb, 113,596 B), used only for its node tree, part boxes, and 27 clips; its
      texture is not drawn. Measured: 55 draw calls (+3) at 12 and at 32 characters, 60 fps.
      Rejected: blocky textured (67 calls, over the 60 ceiling, and it shows people rather than
      agents); robot with hand-written motion (same cost, stiffer, and every state is code).
    evidence: ["P1 (stats.json, P1-characters-compare.jpg, P1-motion-robot-robotclips-blocky.mp4)", "Earth chose robotclips (option 1 of 3) in this session's D3 question, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D4
    type: decision
    title: "Animation states and what triggers them (working, idle, moving on a phase change, done, blocked), plus reduced-motion behavior"
    status: resolved
    depends_on: [D1, P1]
    outcome: >-
      Triggers are only what the page already loads: each task's zone (phase) and operator, compared
      between refreshes (dashboard:refresh / the existing load).
      - Work rooms: seated working loop (Blocky sit + interact-right).
      - Blocked and Val.Failed: seated, slow head-shake loop (sit + emote-no at about 0.45x).
      - Zone change: the character stands and walks to its new desk along fixed waypoints. The route
        goes out its room's open front edge, along the aisles, and in through the target room's
        front. This is not pathfinding. The whole move takes about 2-4 s; long routes use sprint
        instead of walk.
      - Into Done: stand, emote-yes for about 1.5 s, walk out the front, disappear (Done has no
        characters, per D1).
      - Into Aborted: disappear in place.
      - New task: walks in through the Inbox front edge.
      - Target room already full (a 5th task): the character walks to that room's front and
        disappears.
      - Desks re-laid out inside a room: the character walks (short slide) to its new desk.
      "Disappear" takes about 0.4 s. Instanced opaque boxes can scale to zero; a true alpha fade
      would need per-instance opacity, which is the implementer's call if it stays within budget.
      Reduced motion (prefers-reduced-motion, frameloop demand): static seated poses, no loops, no
      walking or emotes; characters appear at their new desk instantly. A hidden tab freezes, as
      the scene does today. The live-launch emphasis (/api/launch/active) was not chosen for V1.
    evidence: ["I1 (data and refresh path)", "P1 (sit+interact, sit+emote-no, walk rendered and measured)", "Earth chose option 1 of 4 in this session's D4 question, 2026-10-22"]
    resolved_at: 2026-10-22

  - id: D5
    type: decision
    title: "Budget: keep 60 draw calls or raise it; fps target; asset size limit"
    status: resolved
    depends_on: [P1]
    outcome: >-
      Earth raised the 3D Office ceiling from 60 to 70 draw calls (WebGL level, bloom included,
      1440x900). This supersedes the 60 in the look map (2026-10-21-3d-office-visual-direction-map.md)
      and in the comment at office3d/officeDecor.tsx:1. V1 characters still get a fixed 3-call
      budget (body + its shadow + glow) for any number of characters, so V1 is expected at about 55;
      the other 15 calls are headroom for later work, not for V1. Acceptance: <= 70 calls (expected
      ~55) and 60 fps at 1440x900 on Earth's M5 with 32 characters (stress) and with live data. The
      character asset stays small (the Blocky glb 113,596 B plus its ~20 KB texture, or stripped):
      150 KB total. The option Earth picked kept the first option's criteria (60 fps, asset cap)
      and only raised the ceiling. No new npm dependency.
    evidence: ["P1 stats.json (robotclips 55 at N=12 and N=32, 60 fps)", "Earth chose 'raise the ceiling to 70' in this session's D5 question, 2026-10-22"]
    resolved_at: 2026-10-22

fog:
  - item: "Show Multica persona names (Niko, Michael, ...) on characters"
    why_not_a_node: "Office runs do not record which Multica agent ran them; no data path yet"
  - item: "Characters walking freely or pathfinding around the office"
    why_not_a_node: "No evidence it is wanted beyond room-to-room moves; out of V1"
  - item: "Sound on state changes"
    why_not_a_node: "Nobody asked; dashboard is silent today"

deferred:
  - id: 2c-tv-mode
    reason: "Out of V1"
  - id: SPAR-35
    reason: "Separate data/perf issue (empty task list after rapid tab switching), in backlog"
  - id: live-launch-emphasis
    reason: "Faster typing and a visor pulse for tasks in /api/launch/active. Offered in D4 and not chosen: it only sees dashboard-started runs (0 at measurement)"
  - id: textured-characters
    reason: "Blocky textured costs 67 calls (D3). The ceiling is now 70 (D5), and a BatchedMesh variant might cost about 57, but it is unmeasured. Revisit only if Earth wants faces"
  - id: low-end-fps
    reason: "Only Earth's M5 was measured. No slower device is available; D5 kept the M5 target"
```

## Checkpoints

```yaml
checkpoint:
  written_at: 2026-10-22
  map: "ai-dev-office/docs/superpowers/specs/2026-10-22-3d-office-characters-map.md"
  destination: "Character design decided, prototype approved, spec handed off (confirmed by Earth 2026-10-22)"
  resolved: []
  frontier: [I1, R1, R2]
  blocked: ["D1 waits on I1", "P1 waits on D1, R1, R2", "D2-D5 follow P1/D1"]
  fog: ["Multica persona names", "free walking/pathfinding", "sound"]
  findings_to_keep:
    - "Measuring recipe that works: build the client in a scratch worktree (symlink node_modules from the main checkout), serve dist with a small node static server that proxies /api to localhost:4310, then drive real Chrome headless via playwright-core from /Users/earth/Documents/GitHub/_staging-verify-spar28 (channel 'chrome', Metal GPU). Count draw calls by wrapping WebGL2RenderingContext.prototype draw* in an init script, per rAF frame. The in-app browser pane pauses rAF when hidden, so it cannot measure."
    - "The map file is uncommitted in the main checkout; Earth commits/pushes maps on request."
  next_action: "Run I1, R1, R2 in parallel (independent), then take D1 to Earth"
```

```yaml
checkpoint:
  written_at: 2026-10-22
  map: "ai-dev-office/docs/superpowers/specs/2026-10-22-3d-office-characters-map.md"
  destination: "Character design decided, prototype approved, spec handed off (confirmed by Earth 2026-10-22)"
  resolved:
    - "I1: currentConductor = last writer; 4 of 19 open runs known; desks capped at 4 per room"
    - "R1: RobotExpressive glb exists but is 19 meshes; Kenney Blocky 2.0 = 6 rigid boxes + 27 CC0 clips"
    - "R2: 52 = 38 scene + 14 bloom; instanced techniques cost the same at any N; no instanced skinning in three 0.186"
    - "D1: one character per drawn desk in work + stuck rooms, max 32"
    - "D2: wrapped visor glow + head accessory per tool; text in card/panel; unknown = bare grey"
    - "P1: robot 55 / robotclips 55 / blocky 67 calls, all 60 fps; approved robotclips + palette c"
    - "D3: robotclips (boxes in one InstancedMesh + glow InstancedMesh, Blocky clips via proxy rigs)"
    - "D4: seated loops, waypoint walk on zone change, Done celebrate+leave, Aborted vanish, reduced motion static"
    - "D5: ceiling raised to 70; V1 expected 55; 60 fps M5 at 32 characters; asset <=150 KB"
  frontier: []
  blocked: []
  fog: ["Multica persona names", "free walking/pathfinding", "sound"]
  findings_to_keep:
    - "Evidence: side-session-notes/local_de35909e-.../p1-characters/ (README, compare sheets, clip, stats.json, spike diff, scripts)"
    - "Capture without a server process: playwright page.route serves dist and forwards /api to :4310; stub /api/events with a one-shot SSE body or the context never closes"
    - "The map file is uncommitted in the main checkout; Earth commits/pushes maps on request."
  done_when_status:
    - "Prototype approved on live data: met (robotclips + palette c, Earth 2026-10-22)"
    - "D1-D5 resolved with evidence: met"
    - "Budget: met. Earth raised the ceiling to 70; P1 measured 55 calls, 60 fps, CC0, no new npm dependency"
    - "Spec posted to Multica: met. SPAR-38 '3D Office: agent characters (phase 2b, robotclips)', sub-issue of SPAR-32, assigned to squad AI Dev Team, status todo (2026-10-22, with Earth's approval)"
  next_action: "None for shaping. Follow SPAR-38: review the squad's PRs against D1-D5 and the spec below."
```

## Implementation-ready spec (V1)

**Destination.** Each task at a drawn desk in the 3D Office gets a small robot. The robot shows
which AI tool last wrote to the task, and it moves when the task changes room. It fits the
budget and uses no new dependency. Source of truth: the nodes above. If this summary conflicts
with them, the nodes win.

**Locked decisions**

| # | Decision | Why (evidence) |
|---|---|---|
| D1 | One character per drawn desk in work rooms (Inbox, Dev Bay, Review, Escalation, DevOps, Debug Lab) and stuck rooms (Blocked, Val.Failed); none in Done/Aborted; at most 4 per room (`SCENE_DESK_LIMIT`), 32 in all | The data is per task, and the desk cap already exists (I1) |
| D2 | A visor band that wraps the head and glows in the tool color, plus a head accessory; the tool name as text in the selection card and side panel; unknown = bare head, unlit `#3a414b` | Only about 3 hues are safe beside the status colors; the spotlights tint the body; seated robots face away from the camera (P1) |
| D3 | robotclips: unit boxes in ONE InstancedMesh, glow in a second; motion from Kenney Blocky 2.0 CC0 clips through hidden proxy rigs | 55 calls at any N, 60 fps, authored motion (P1) |
| D4 | The states table below; reduced motion is static | Earth's choice, rendered in P1 |
| D5 | Ceiling 70 (was 60); V1 expected 55; 60 fps at 1440x900 on the M5 with 32 characters; character asset <= 150 KB | P1 measurements |

**Identity table (palette c, locked from the render)**

| operator | visor / glow | accessory (boxes in the body mesh unless noted) |
|---|---|---|
| claude | `#ff4fd8` | flat cap over the head plus a front brim |
| codex | `#f2f5ff` | thin antenna with a glowing tip (glow mesh) |
| cursor | `#6e7bff` | two ears, tilted about ±0.35 rad |
| antigravity (and legacy `gemini`) | `#b8ff4a` | square halo ring above the head (glow mesh) |
| copilot | `#c3a6ff` | goggles: two glowing lenses on the front of the band |
| unknown | `#3a414b`, gain 1 (no bloom) | none |

The operator is `RunSummary.currentConductor`. In the text, call it the last operator, because
it is the last writer and not a live signal (I1).

**States (D4)**

| trigger | behavior |
|---|---|
| task in a work room | seated loop: Blocky `sit` + `interact-right` (about 1.6x) |
| task in Blocked / Val.Failed | seated loop: `sit` + `emote-no` (about 0.45x) |
| first load or remount (no previous data in this mount) | every character is placed seated at its desk at once; nobody walks in |
| zone changed between loads | stand, walk the waypoints (own room's open front edge → aisles → target room's front → desk), sit; about 2-4 s in total; use `sprint` on long routes |
| moved into Done | stand at its old desk, `emote-yes` for about 1.5 s, walk out its old room's front, vanish |
| moved into Aborted | vanish in place |
| new task (appeared since the previous load in this mount) | walk in through Inbox's front edge |
| task becomes drawn because a desk freed in a full room | walk in through that room's front edge |
| target room full (a 5th task) | walk to that room's front, vanish |
| desks re-laid out within a room | short walk to the new desk |
| reduced motion | static seated pose, no loops or walks or emotes, instant moves (`frameloop="demand"` as today) |
| hidden tab | frozen (as today) |

"Vanish" takes about 0.4 s. Scaling the instance to zero is fine; a per-instance alpha fade is
optional and must stay within budget.

**Build notes (from the P1 spike; reference only)**

- Data: `officeTasksFromApi` also maps `currentConductor` to `OfficeTask.operator`, normalizing
  `gemini` to antigravity. Add the operator to `OfficeTaskLine`, the selection card, and
  `OfficeDetail`.
- Asset: `character-a.glb` from Kenney Blocky Characters 2.0 (113,596 B; 6 nodes leg-left,
  leg-right, torso, arm-left, arm-right, head; 27 clips). Ship its `Textures/texture-a.png`
  (about 20 KB), or strip the image reference so GLTFLoader requests nothing extra. Either way,
  loading must produce no 404 and no console error. Add the Blocky CC0 notice as
  `public/office3d/License-blocky.txt`; never overwrite the existing `License.txt` (Kenney
  Furniture Kit).
- Rig: for each character, `scene.clone(true)` with meshes hidden, plus an `AnimationMixer`.
  Each frame, each part's `matrixWorld` times its geometry bounding box becomes one unit-box
  instance. Height is about 0.9 (scale = 0.9 / Blocky bbox height). The seat is at about
  `FLOOR_TOP + 0.36`, the slot at desk z + 0.5, `rotY = PI`.
- Materials:
  - Body: `MeshStandardMaterial` white × `instanceColor`, roughness 0.85, metalness 0.05; body
    `#4a5361`, limbs `#2f363f`; `castShadow`, `frustumCulled = false`, `raycast` null.
  - Glow: `MeshBasicMaterial` with `toneMapped: false`; color × 1.6 so it blooms (bloom threshold
    is 0.9); band height about 0.22 of head height.
  - Light bodies blow out under the spotlights, so keep them dark (P1).
- Picking is unchanged: characters take no raycasts, and desks and chairs stay the targets.
- Keep the logic pure and testable in a separate module (slots, operator mapping, identity
  table, move planner), and put the R3F view in its own file. Mount it in `OfficeScene` after
  the decor.
- Update the "60 draw calls" comment at `office3d/officeDecor.tsx:1` to 70.

**Acceptance and evidence for the PR**

- `npm test` and `npm run build` in `dashboard/client`, with the `Office3DView` chunk size
  before and after.
- Regression tests for at least:
  - slot rules: work and stuck rooms only, cap 4, none in Done/Aborted;
  - `officeTasksFromApi` carries `currentConductor` into `OfficeTask.operator`;
  - operator mapping, including `gemini` and unknown;
  - palette rule, measurable: each operator glow color is at least 30° of hue away from every
    `ZONE_COLORS` tone and the neon purple `#af5df6`, or is near-white (saturation < 0.15).
    copilot `#c3a6ff` is a named exception, 13° from the neon purple. Earth kept it on
    2026-10-22, with the goggles accessory carrying its identity. The test lists the exception
    explicitly; it does not loosen the rule;
  - move planner: first load or remount places everyone seated (no walk-in), front-edge
    waypoints, Inbox entry for new tasks, entry through the room's front when a freed desk
    reveals a task, Done celebrate-at-old-desk-then-leave, Aborted vanish, overflow vanish;
  - reduced motion means no moves.
- Draw calls counted at the WebGL level, with bloom, at 1440x900: <= 70 (expected 55) on live
  data and with 32 characters. 60 fps on the M5.
- Screenshots (overview, Dev Bay at zoom 70, reduced motion) next to
  `P1-characters-compare.jpg`, plus a short clip of one zone-change walk.

**V1 excludes:** free wandering or pathfinding, Multica persona names, sound, TV mode (2c), the
live-launch emphasis, textured characters, new APIs or server changes, React/three/fiber
upgrades, and any new npm dependency.

**Open risks**

- Most characters will be "unknown" until new history rows accumulate (no backfill).
- The `CURSOR_AGENT` stamp is still unverified, because there are no cursor rows yet.
- Waypoint walks may clip room corners; the clip is the check.
- Only the M5 was measured.
- The Blocky clip names are part of the asset contract. A missing clip must fall back to a
  static pose, not throw.

**Deploy and rollback:** client only, no data or API change, no migration. Roll back by
reverting the PR.

**Amended 2026-10-22 after the spec was posted as SPAR-38 (Claude spec review, Earth
approved):**
- A first-load/remount rule, so the page does not open with a parade from Inbox.
- An entry rule for a task a freed desk reveals.
- Done: the celebration happens at the old desk.
- The Blocky license goes in its own file, `License-blocky.txt`.
- No 404 or console error when the texture reference is stripped.
- A test that `officeTasksFromApi` carries `currentConductor`.
- A measurable palette rule, with copilot as a named exception.
