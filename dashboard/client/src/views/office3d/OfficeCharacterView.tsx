import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  Color,
  InstancedMesh,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import {
  BODY_COLOR,
  CHARACTER_HEIGHT,
  CURSOR_EAR_TILT,
  FACING_Y,
  LIMB_COLOR,
  OPERATOR_VISOR,
  resolveClipCues,
  resolveGaitClip,
  resolveNamedClip,
  seatClipCues,
  visorGain,
  type CharacterOperator,
  type ClipCue,
} from './officeCharacters';
import {
  CELEBRATE_SECONDS,
  SPRINT_SPEED,
  VANISH_SECONDS,
  WALK_SPEED,
  actorRootY,
  classifyTasks,
  planMove,
  type CharacterPlace,
  type FootStance,
  type MovePlan,
} from './officeMove';
import type { OfficeTask, OfficeZoneStats } from './officeSelection';

const PARTS = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'] as const;
type PartName = (typeof PARTS)[number];
/** Seated cast is 32. A few extra slots cover one arrival or departure without a new mesh. */
const MAX_ACTORS = 40;
const BODY_CAP = MAX_ACTORS * 12;
const GLOW_CAP = MAX_ACTORS * 12;

const BODY = new Color(BODY_COLOR);
const LIMB = new Color(LIMB_COLOR);
const BODY_PARTS = new Set<PartName>(['torso', 'head']);

interface BlockyRig {
  scene: Object3D;
  clips: AnimationClip[];
  boxes: Record<PartName, Box3>;
  scale: number;
  sitLift: number;
}

interface Proxy {
  root: Object3D;
  parts: Partial<Record<PartName, Object3D>>;
  mixer: AnimationMixer;
  modeSig: string;
}

type PoseMode = 'work' | 'blocked' | 'still' | 'walk' | 'sprint' | 'emote-yes';

interface Actor {
  taskId: string;
  operator: CharacterOperator;
  posture: 'work' | 'blocked';
  reduced: boolean;
  proxy: Proxy;
  acceptedKey: string;
  x: number;
  z: number;
  rotY: number;
  seated: boolean;
  scaleMul: number;
  plan: MovePlan | null;
  cursor: number;
  celebrateLeft: number;
  vanishLeft: number;
  dead: boolean;
}

function assetUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}office3d/character-a.glb`;
}

let rigPromise: Promise<BlockyRig> | null = null;

function loadRig(): Promise<BlockyRig> {
  if (!rigPromise) {
    rigPromise = loadRigOnce().catch((error: unknown) => {
      rigPromise = null;
      throw error;
    });
  }
  return rigPromise;
}

async function loadRigOnce(): Promise<BlockyRig> {
  const gltf = await new GLTFLoader().loadAsync(assetUrl());
  const boxes = {} as Record<PartName, Box3>;
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const name = mesh.name as PartName;
    if (!PARTS.includes(name)) return;
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) boxes[name] = mesh.geometry.boundingBox.clone();
  });
  gltf.scene.updateMatrixWorld(true);
  const all = new Box3().setFromObject(gltf.scene);
  const height = all.max.y - all.min.y;
  const scale = height > 0 ? CHARACTER_HEIGHT / height : 1;
  const sitLift = measureSitLift(gltf.scene, gltf.animations, boxes);
  return { scene: gltf.scene, clips: gltf.animations, boxes, scale, sitLift };
}

function measureSitLift(scene: Object3D, clips: AnimationClip[], boxes: Partial<Record<PartName, Box3>>): number {
  const sit = AnimationClip.findByName(clips, 'sit');
  if (!sit) return 0;
  const probe = scene.clone(true);
  const mixer = new AnimationMixer(probe);
  const action = mixer.clipAction(sit);
  action.play();
  mixer.update(0.01);
  probe.updateMatrixWorld(true);
  let hipY = Infinity;
  for (const name of ['leg-left', 'leg-right'] as const) {
    const box = boxes[name];
    const node = probe.getObjectByName(name);
    if (!box || !node) continue;
    const placed = box.clone().applyMatrix4(node.matrixWorld);
    hipY = Math.min(hipY, placed.min.y);
  }
  mixer.stopAllAction();
  return Number.isFinite(hipY) ? hipY : 0;
}

function phaseOf(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 33 + key.charCodeAt(index)) >>> 0;
  return (hash % 1300) / 1000;
}

function makeProxy(rig: BlockyRig): Proxy {
  const root = new Object3D();
  const cloned = rig.scene.clone(true);
  cloned.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh) mesh.visible = false;
  });
  root.add(cloned);
  const parts: Proxy['parts'] = {};
  for (const name of PARTS) {
    const node = cloned.getObjectByName(name);
    if (node) parts[name] = node;
  }
  return { root, parts, mixer: new AnimationMixer(cloned), modeSig: '' };
}

function placeKey(place: CharacterPlace | null): string {
  if (!place) return 'gone';
  if (place.terminal) return place.terminal;
  if (!place.drawn || !place.seat) return `overflow:${place.zoneId}`;
  return `seat:${place.zoneId}:${place.seat.x.toFixed(3)}:${place.seat.z.toFixed(3)}`;
}

function clipNames(rig: BlockyRig): string[] {
  return rig.clips.map((clip) => clip.name);
}

function cuesFor(actor: Actor, mode: PoseMode, rig: BlockyRig): ClipCue[] {
  const names = clipNames(rig);
  if (mode === 'walk' || mode === 'sprint') {
    const gait = resolveGaitClip(mode, names);
    return gait ? [{ name: gait, timeScale: 1 }] : [];
  }
  if (mode === 'emote-yes') {
    const name = resolveNamedClip('emote-yes', names);
    return name ? [{ name, timeScale: 1 }] : [];
  }
  if (mode === 'still') return resolveClipCues(seatClipCues(actor.posture, true), names);
  return resolveClipCues(seatClipCues(mode === 'blocked' ? 'blocked' : 'work', false), names);
}

function setMode(actor: Actor, rig: BlockyRig, mode: PoseMode): void {
  const cues = cuesFor(actor, mode, rig);
  const once = mode === 'emote-yes';
  const sig = `${mode}|${cues.map((cue) => `${cue.name}@${cue.timeScale}`).join(',')}|${once ? 'once' : 'loop'}`;
  if (actor.proxy.modeSig === sig) return;
  actor.proxy.modeSig = sig;
  const mixer = actor.proxy.mixer;
  mixer.stopAllAction();
  for (const cue of cues) {
    const clip = AnimationClip.findByName(rig.clips, cue.name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    action.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.timeScale = cue.timeScale;
    if (mode === 'still') action.time = 0.25;
    action.play();
  }
  if (mode === 'still') mixer.update(0);
  else if (mode === 'work' || mode === 'blocked') mixer.update(phaseOf(actor.taskId));
  else mixer.update(0);
}

function sitMode(actor: Actor): PoseMode {
  if (actor.reduced) return 'still';
  return actor.posture === 'blocked' ? 'blocked' : 'work';
}

function face(actor: Actor, from: { x: number; z: number }, to: { x: number; z: number }): void {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx * dx + dz * dz > 1e-6) actor.rotY = Math.atan2(dx, dz);
}

function begin(actor: Actor, plan: MovePlan, rig: BlockyRig): void {
  actor.proxy.modeSig = '';
  actor.plan = null;
  actor.cursor = 0;
  actor.celebrateLeft = 0;
  actor.vanishLeft = 0;
  actor.scaleMul = 1;
  actor.dead = false;
  if (plan.action === 'instant') {
    if (plan.vanish || plan.points.length === 0) {
      actor.dead = true;
      return;
    }
    actor.x = plan.points[0].x;
    actor.z = plan.points[0].z;
    actor.seated = true;
    actor.rotY = FACING_Y;
    setMode(actor, rig, 'still');
    return;
  }
  if (plan.action === 'stay') {
    const point = plan.points[0];
    if (point) {
      actor.x = point.x;
      actor.z = point.z;
    }
    actor.seated = true;
    actor.rotY = FACING_Y;
    setMode(actor, rig, sitMode(actor));
    return;
  }
  if (plan.action === 'vanish' || plan.points.length === 0) {
    actor.vanishLeft = VANISH_SECONDS;
    actor.seated = true;
    setMode(actor, rig, 'still');
    return;
  }
  const start = plan.points[0];
  actor.x = start.x;
  actor.z = start.z;
  actor.plan = plan;
  actor.cursor = plan.points.length > 1 ? 1 : plan.points.length;
  actor.celebrateLeft = plan.celebrate ? CELEBRATE_SECONDS : 0;
  actor.seated = false;
  actor.rotY = FACING_Y;
  if (!plan.celebrate && plan.points[1]) face(actor, start, plan.points[1]);
  setMode(actor, rig, plan.celebrate ? 'emote-yes' : plan.gait === 'sprint' ? 'sprint' : 'walk');
}

function finish(actor: Actor, rig: BlockyRig): void {
  const plan = actor.plan;
  actor.plan = null;
  actor.cursor = 0;
  const last = plan?.points[plan.points.length - 1];
  if (last) {
    actor.x = last.x;
    actor.z = last.z;
  }
  if (plan?.vanish) {
    actor.vanishLeft = VANISH_SECONDS;
    actor.scaleMul = 1;
    actor.seated = false;
    return;
  }
  actor.seated = true;
  actor.rotY = FACING_Y;
  setMode(actor, rig, sitMode(actor));
}

function advance(actor: Actor, rig: BlockyRig, step: number): void {
  if (actor.dead || step <= 0) return;
  if (actor.celebrateLeft > 0) {
    actor.celebrateLeft = Math.max(0, actor.celebrateLeft - step);
    if (actor.celebrateLeft > 0) return;
    actor.seated = false;
    const plan = actor.plan;
    if (plan && plan.points.length > 1) {
      face(actor, plan.points[0], plan.points[1]);
      setMode(actor, rig, plan.gait === 'sprint' ? 'sprint' : 'walk');
    }
  }
  if (actor.vanishLeft > 0) {
    actor.vanishLeft -= step;
    actor.scaleMul = Math.max(0, actor.vanishLeft / VANISH_SECONDS);
    if (actor.vanishLeft <= 0) actor.dead = true;
    return;
  }
  const plan = actor.plan;
  if (!plan) return;
  const speed = plan.gait === 'sprint' ? SPRINT_SPEED : WALK_SPEED;
  let remain = speed * step;
  while (remain > 0 && actor.cursor < plan.points.length) {
    const target = plan.points[actor.cursor];
    const dx = target.x - actor.x;
    const dz = target.z - actor.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) {
      actor.cursor += 1;
      continue;
    }
    actor.rotY = Math.atan2(dx, dz);
    if (dist <= remain) {
      actor.x = target.x;
      actor.z = target.z;
      remain -= dist;
      actor.cursor += 1;
    } else {
      actor.x += (dx / dist) * remain;
      actor.z += (dz / dist) * remain;
      remain = 0;
    }
  }
  if (actor.cursor >= plan.points.length) finish(actor, rig);
}

function moving(actor: Actor): boolean {
  return actor.plan !== null || actor.celebrateLeft > 0 || actor.vanishLeft > 0;
}

function createActor(rig: BlockyRig, place: CharacterPlace): Actor {
  return {
    taskId: place.taskId,
    operator: place.operator,
    posture: place.posture,
    reduced: false,
    proxy: makeProxy(rig),
    acceptedKey: '',
    x: place.seat?.x ?? 0,
    z: place.seat?.z ?? 0,
    rotY: FACING_Y,
    seated: true,
    scaleMul: 1,
    plan: null,
    cursor: 0,
    celebrateLeft: 0,
    vanishLeft: 0,
    dead: false,
  };
}

function shouldSkipCreate(plan: MovePlan | null): boolean {
  if (!plan) return true;
  if (plan.action === 'vanish') return true;
  if (plan.vanish && plan.points.length === 0) return true;
  if (plan.action === 'stay' && plan.points.length === 0) return true;
  return false;
}

function cachedPlaces(
  tasks: OfficeTask[],
  stats: OfficeZoneStats,
  cache: { tasks: OfficeTask[] | null; stats: OfficeZoneStats | null; places: CharacterPlace[] },
): CharacterPlace[] {
  if (cache.tasks === tasks && cache.stats === stats) return cache.places;
  cache.tasks = tasks;
  cache.stats = stats;
  cache.places = classifyTasks(tasks, stats);
  return cache.places;
}

function syncActors(
  rig: BlockyRig,
  actors: Map<string, Actor>,
  prevPlaces: Map<string, CharacterPlace>,
  booted: { current: boolean },
  tasks: OfficeTask[],
  stats: OfficeZoneStats,
  reducedMotion: boolean,
  settled: boolean,
  placeCache: { tasks: OfficeTask[] | null; stats: OfficeZoneStats | null; places: CharacterPlace[] },
): void {
  if (!settled) return;
  const initial = !booted.current;
  const places = cachedPlaces(tasks, stats, placeCache);
  const nextIds = new Set<string>();
  for (const place of places) {
    nextIds.add(place.taskId);
    const key = placeKey(place);
    let actor = actors.get(place.taskId);
    if (actor?.dead) {
      actor.proxy.mixer.stopAllAction();
      actors.delete(place.taskId);
      actor = undefined;
    }
    if (actor && actor.acceptedKey === key && actor.reduced === reducedMotion) {
      actor.operator = place.operator;
      actor.posture = place.posture;
      continue;
    }
    const plan = planMove(prevPlaces.get(place.taskId) ?? null, place, { reducedMotion, initial });
    if (!actor) {
      if (shouldSkipCreate(plan) || actors.size >= MAX_ACTORS) continue;
      actor = createActor(rig, place);
      actors.set(place.taskId, actor);
    }
    if (!plan) continue;
    actor.operator = place.operator;
    actor.posture = place.posture;
    actor.reduced = reducedMotion;
    actor.acceptedKey = key;
    begin(actor, plan, rig);
  }
  if (!initial) {
    for (const [taskId, earlier] of prevPlaces) {
      if (nextIds.has(taskId)) continue;
      const actor = actors.get(taskId);
      if (!actor || actor.dead) continue;
      if (actor.acceptedKey === 'gone' && actor.reduced === reducedMotion) continue;
      const plan = planMove(earlier, null, { reducedMotion, initial: false });
      if (!plan) continue;
      actor.reduced = reducedMotion;
      actor.acceptedKey = 'gone';
      begin(actor, plan, rig);
    }
  }
  prevPlaces.clear();
  for (const place of places) prevPlaces.set(place.taskId, place);
  booted.current = true;
}

class Batch {
  private n = 0;

  constructor(private mesh: InstancedMesh) {}

  begin(): void {
    this.n = 0;
  }

  push(matrix: Matrix4, color: Color): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.n, matrix);
    this.mesh.setColorAt(this.n, color);
    this.n += 1;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const tmp = new Matrix4();
const rot = new Matrix4();
const glowColor = new Color();

function box(batch: Batch, parent: Matrix4, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: Color, rz = 0): void {
  tmp.makeScale(sx, sy, sz);
  if (rz) tmp.premultiply(rot.makeRotationZ(rz));
  tmp.setPosition(cx, cy, cz);
  tmp.premultiply(parent);
  batch.push(tmp, color);
}

function paintIdentity(body: Batch, glow: Batch, head: Matrix4, bounds: Box3, operator: CharacterOperator): void {
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  const depth = bounds.max.z - bounds.min.z;
  const cx = (bounds.max.x + bounds.min.x) / 2;
  const cz = (bounds.max.z + bounds.min.z) / 2;
  const top = bounds.max.y;
  const visorY = bounds.min.y + height * 0.58;
  const bandH = height * 0.22;
  const t = Math.max(0.012, width * 0.05);
  glowColor.set(OPERATOR_VISOR[operator]).multiplyScalar(visorGain(operator));
  box(glow, head, cx, visorY, bounds.max.z + t / 2, width * 0.86, bandH, t, glowColor);
  box(glow, head, cx, visorY, bounds.min.z - t / 2, width * 0.86, bandH, t, glowColor);
  box(glow, head, bounds.max.x + t / 2, visorY, cz, t, bandH, depth * 0.86, glowColor);
  box(glow, head, bounds.min.x - t / 2, visorY, cz, t, bandH, depth * 0.86, glowColor);
  if (operator === 'claude') {
    box(body, head, cx, top + height * 0.09, cz, width * 1.1, height * 0.18, depth * 1.1, BODY);
    box(body, head, cx, top + height * 0.03, bounds.max.z + depth * 0.22, width * 0.92, height * 0.06, depth * 0.5, BODY);
  } else if (operator === 'codex') {
    box(body, head, cx, top + height * 0.35, cz, width * 0.08, height * 0.7, width * 0.08, LIMB);
    box(glow, head, cx, top + height * 0.75, cz, width * 0.2, width * 0.2, width * 0.2, glowColor);
  } else if (operator === 'cursor') {
    box(body, head, bounds.min.x + width * 0.18, top + height * 0.22, cz, width * 0.2, height * 0.5, depth * 0.3, BODY, CURSOR_EAR_TILT);
    box(body, head, bounds.max.x - width * 0.18, top + height * 0.22, cz, width * 0.2, height * 0.5, depth * 0.3, BODY, -CURSOR_EAR_TILT);
  } else if (operator === 'antigravity') {
    const y = top + height * 0.5;
    const ring = width * 0.48;
    box(glow, head, cx, y, cz + ring, width, t, t, glowColor);
    box(glow, head, cx, y, cz - ring, width, t, t, glowColor);
    box(glow, head, cx + ring, y, cz, t, t, width, glowColor);
    box(glow, head, cx - ring, y, cz, t, t, width, glowColor);
  } else if (operator === 'copilot') {
    // Seated robots face -z and the default camera sits on +z, so the face is hidden.
    // The lenses rest on the crown, toward the back of the head.
    const crown = top + height * 0.14;
    box(body, head, cx, crown, cz, width * 1.05, height * 0.07, depth * 1.08, LIMB);
    box(body, head, cx, top - height * 0.08, bounds.min.z - t, width * 0.86, height * 0.22, t * 1.5, LIMB);
    box(glow, head, cx - width * 0.22, crown + height * 0.06, bounds.min.z + depth * 0.28, width * 0.34, height * 0.1, depth * 0.36, glowColor);
    box(glow, head, cx + width * 0.22, crown + height * 0.06, bounds.min.z + depth * 0.28, width * 0.34, height * 0.1, depth * 0.36, glowColor);
  }
}

function stanceOf(actor: Actor): FootStance {
  if (actor.celebrateLeft > 0) return 'celebrate';
  return actor.seated ? 'sit' : 'stand';
}

function placeActor(actor: Actor, rig: BlockyRig): void {
  const sitDrop = rig.sitLift * rig.scale * actor.scaleMul;
  actor.proxy.root.scale.setScalar(rig.scale * actor.scaleMul);
  actor.proxy.root.position.set(actor.x, actorRootY(actor.x, actor.z, stanceOf(actor), sitDrop), actor.z);
  actor.proxy.root.rotation.set(0, actor.rotY, 0);
  actor.proxy.root.updateMatrixWorld(true);
}

export function OfficeCharacterView({
  tasks,
  stats,
  animate,
  reducedMotion,
  settled,
}: {
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  animate: boolean;
  reducedMotion: boolean;
  settled: boolean;
}) {
  const { gl, invalidate } = useThree();
  const [rig, setRig] = useState<BlockyRig | null>(null);
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const bodyMat = useMemo(() => new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.05 }), []);
  const glowMat = useMemo(() => new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), []);
  const bodyRef = useRef<InstancedMesh>(null);
  const glowRef = useRef<InstancedMesh>(null);
  const batches = useRef<{ body: Batch; glow: Batch } | null>(null);
  const actors = useRef(new Map<string, Actor>());
  const prevPlaces = useRef(new Map<string, CharacterPlace>());
  const booted = useRef(false);
  const placeCache = useRef<{ tasks: OfficeTask[] | null; stats: OfficeZoneStats | null; places: CharacterPlace[] }>({
    tasks: null,
    stats: null,
    places: [],
  });
  const headBox = useMemo(() => new Box3(), []);
  const tasksRef = useRef(tasks);
  const statsRef = useRef(stats);
  const reducedRef = useRef(reducedMotion);
  const animateRef = useRef(animate);
  const settledRef = useRef(settled);
  tasksRef.current = tasks;
  statsRef.current = stats;
  reducedRef.current = reducedMotion;
  animateRef.current = animate;
  settledRef.current = settled;

  useEffect(() => {
    let live = true;
    loadRig().then((next) => {
      if (!live) return;
      setRig(next);
      gl.domElement.dataset.chars = 'ready';
      gl.domElement.dataset.moving = '0';
      invalidate();
    }).catch(() => {
      if (!live) return;
      gl.domElement.dataset.chars = 'error';
      invalidate();
    });
    return () => {
      live = false;
    };
  }, [gl, invalidate]);

  useEffect(() => {
    invalidate();
  }, [invalidate, tasks, stats, reducedMotion, rig]);

  useEffect(() => () => {
    for (const actor of actors.current.values()) actor.proxy.mixer.stopAllAction();
    bodyMat.dispose();
    glowMat.dispose();
    unit.dispose();
  }, [bodyMat, glowMat, unit]);

  useLayoutEffect(() => {
    for (const mesh of [bodyRef.current, glowRef.current]) {
      if (!mesh) continue;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.raycast = () => undefined;
    }
  }, [rig]);

  useFrame((_, delta) => {
    const bodyMesh = bodyRef.current;
    const glowMesh = glowRef.current;
    if (!bodyMesh || !glowMesh) return;
    if (!batches.current) batches.current = { body: new Batch(bodyMesh), glow: new Batch(glowMesh) };
    const body = batches.current.body;
    const glow = batches.current.glow;
    body.begin();
    glow.begin();
    if (rig) {
      syncActors(rig, actors.current, prevPlaces.current, booted, tasksRef.current, statsRef.current, reducedRef.current, settledRef.current, placeCache.current);
      const step = animateRef.current ? Math.min(delta, 0.05) : 0;
      let walking = 0;
      for (const actor of actors.current.values()) {
        if (actor.dead) continue;
        advance(actor, rig, step);
        if (animateRef.current) actor.proxy.mixer.update(step);
        if (moving(actor)) walking += 1;
      }
      for (const [taskId, actor] of actors.current) {
        if (!actor.dead) continue;
        actor.proxy.mixer.stopAllAction();
        actors.current.delete(taskId);
      }
      for (const actor of actors.current.values()) {
        if (actor.scaleMul <= 0.001) continue;
        placeActor(actor, rig);
        for (const name of PARTS) {
          const node = actor.proxy.parts[name];
          const bounds = rig.boxes[name];
          if (!node || !bounds) continue;
          const color = BODY_PARTS.has(name) ? BODY : LIMB;
          box(
            body,
            node.matrixWorld,
            (bounds.max.x + bounds.min.x) / 2,
            (bounds.max.y + bounds.min.y) / 2,
            (bounds.max.z + bounds.min.z) / 2,
            bounds.max.x - bounds.min.x,
            bounds.max.y - bounds.min.y,
            bounds.max.z - bounds.min.z,
            color,
          );
        }
        const head = actor.proxy.parts.head;
        const headBounds = rig.boxes.head;
        if (head && headBounds) {
          headBox.copy(headBounds);
          paintIdentity(body, glow, head.matrixWorld, headBox, actor.operator);
        }
      }
      gl.domElement.dataset.charCount = String(actors.current.size);
      gl.domElement.dataset.moving = String(walking);
    }
    body.end();
    glow.end();
  });

  return (
    <>
      <instancedMesh ref={bodyRef} args={[unit, bodyMat, BODY_CAP]} castShadow frustumCulled={false} raycast={() => undefined} />
      <instancedMesh ref={glowRef} args={[unit, glowMat, GLOW_CAP]} frustumCulled={false} raycast={() => undefined} />
    </>
  );
}
