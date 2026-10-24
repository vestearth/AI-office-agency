import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ZONES } from '../commandZones';
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
  INTERACT_TIMESCALE,
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
  commitRoomDesks,
  deskHoldForRoom,
  needsReceptionPickup,
  pickPickupSpot,
  planMove,
  resumeMove,
  roomRect,
  type CharacterPlace,
  type DeskActorState,
  type FootStance,
  type MovePlan,
} from './officeMove';
import { initialCatchUp, onFrame, onStreamPhase } from './officeCatchUp';
import type { DeskRowMap, ShownDesk } from './officeLook';
import { FLOOR_TOP, SCENE } from './officeLook';
import { ABORTED, THROW_SECONDS, pickDropSpot, takenDropSpots } from './officeAborted';
import { PRESS_SECONDS } from './officeEscalation';
import { COUNTER_TOP_Y, ENVELOPE_COLOR, PICKUP_SECONDS, PICKUP_SPOTS, envelopeOnCounter, takenPickupSpots } from './officeReception';
import { ROOM_LAYOUT, desksForZone, sceneDesks, type OfficeTask, type OfficeZoneStats } from './officeSelection';

const PARTS = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'] as const;
type PartName = (typeof PARTS)[number];
/** Seated cast is 36 (24 at desks, 7 in the waiting room, 5 at the help desk). A few extra slots cover arrivals and departures without a new mesh. */
const MAX_ACTORS = 44;
const BODY_CAP = MAX_ACTORS * 12;
const GLOW_CAP = MAX_ACTORS * 12;
/** Envelopes at the counter plus boxes on their way to the heap. */
const ENVELOPE_CAP = PICKUP_SPOTS.length + 12;

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

type PoseMode = 'work' | 'blocked' | 'waiting' | 'standing' | 'still' | 'walk' | 'sprint' | 'emote-yes' | 'interact';

interface Actor {
  taskId: string;
  operator: CharacterOperator;
  posture: CharacterPlace['posture'];
  /** Sits or stands at rest, and which way it faces there. */
  stance: CharacterPlace['stance'];
  facing: number;
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
  pickupLeft: number;
  /** Seconds left at the help desk's call button. */
  pressLeft: number;
  /** Seconds left of the toss at the heap. */
  throwLeft: number;
  /** Carrying a box to the Aborted heap. */
  carryBox: boolean;
  /** Aborted drop spot held until the box is thrown. */
  dropSpot: number | null;
  envelope: 'none' | 'counter' | 'carry';
  envelopeX: number;
  envelopeZ: number;
  sitLeft: number;
  vanishLeft: number;
  dead: boolean;
  delivering: boolean;
  leftOrigin: boolean;
  originZoneId: string | null;
  loungeSeatIndex: number | null;
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
  return `seat:${place.zoneId}:${place.seat.x.toFixed(3)}:${place.seat.z.toFixed(3)}:${place.stance}`;
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
  if (mode === 'interact') {
    const name = resolveNamedClip('interact-right', names);
    return name ? [{ name, timeScale: INTERACT_TIMESCALE }] : [];
  }
  if (mode === 'still') return resolveClipCues(seatClipCues(actor.posture, true), names);
  return resolveClipCues(seatClipCues(mode === 'blocked' || mode === 'waiting' || mode === 'standing' ? mode : 'work', false), names);
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
  else if (mode === 'work' || mode === 'blocked' || mode === 'waiting' || mode === 'standing') mixer.update(phaseOf(actor.taskId));
  else mixer.update(0);
}

function sitMode(actor: Actor): PoseMode {
  if (actor.reduced) return 'still';
  return actor.posture;
}

function clearEnvelope(actor: Actor): void {
  actor.pickupLeft = 0;
  actor.envelope = 'none';
}

function armEnvelope(actor: Actor, route: MovePlan): void {
  const pickup = route.points.find((point) => point.role === 'pickup');
  actor.pickupLeft = 0;
  actor.envelope = pickup ? 'counter' : 'none';
  const rest = pickup ? envelopeOnCounter(pickup) : null;
  actor.envelopeX = rest?.x ?? 0;
  actor.envelopeZ = rest?.z ?? 0;
}

function face(actor: Actor, from: { x: number; z: number }, to: { x: number; z: number }): void {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx * dx + dz * dz > 1e-6) actor.rotY = Math.atan2(dx, dz);
}

function begin(actor: Actor, plan: MovePlan, rig: BlockyRig): void {
  const alreadyMoving = actor.plan !== null || actor.celebrateLeft > 0 || actor.vanishLeft > 0 || !actor.seated;
  const route = alreadyMoving ? resumeMove({ x: actor.x, z: actor.z }, plan) : plan;
  actor.proxy.modeSig = '';
  actor.plan = null;
  actor.cursor = 0;
  actor.celebrateLeft = 0;
  actor.sitLeft = 0;
  actor.vanishLeft = 0;
  actor.scaleMul = 1;
  actor.dead = false;
  clearEnvelope(actor);
  actor.pressLeft = 0;
  actor.throwLeft = 0;
  actor.carryBox = false;
  actor.dropSpot = null;
  actor.loungeSeatIndex = route.action === 'instant' ? null : route.seatIndex;
  actor.delivering = route.action === 'leave' && route.vanish;
  if (route.action === 'instant') {
    actor.delivering = false;
    actor.loungeSeatIndex = null;
    if (route.vanish || route.points.length === 0) {
      actor.dead = true;
      return;
    }
    actor.x = route.points[0].x;
    actor.z = route.points[0].z;
    actor.seated = actor.stance === 'sit';
    actor.rotY = actor.facing;
    setMode(actor, rig, 'still');
    return;
  }
  if (route.action === 'stay') {
    const point = route.points[0];
    if (point) {
      actor.x = point.x;
      actor.z = point.z;
    }
    actor.seated = actor.stance === 'sit';
    actor.rotY = actor.facing;
    setMode(actor, rig, sitMode(actor));
    return;
  }
  if (route.action === 'vanish' || route.points.length === 0) {
    actor.vanishLeft = VANISH_SECONDS;
    actor.seated = true;
    setMode(actor, rig, 'still');
    return;
  }
  const start = route.points[0];
  actor.x = start.x;
  actor.z = start.z;
  actor.plan = route;
  actor.cursor = route.points.length > 1 ? 1 : route.points.length;
  actor.celebrateLeft = route.celebrate ? CELEBRATE_SECONDS : 0;
  actor.seated = false;
  actor.rotY = FACING_Y;
  armEnvelope(actor, route);
  if (route.action === 'leave' && !route.celebrate && route.vanish) {
    actor.carryBox = true;
    actor.dropSpot = route.dropSpot ?? null;
  }
  if (!route.celebrate && route.points[1]) face(actor, start, route.points[1]);
  if (start.role === 'pickup') {
    actor.pickupLeft = PICKUP_SECONDS;
    setMode(actor, rig, 'interact');
    return;
  }
  setMode(actor, rig, route.celebrate ? 'emote-yes' : route.gait === 'sprint' ? 'sprint' : 'walk');
}

function finish(actor: Actor, rig: BlockyRig): void {
  const plan = actor.plan;
  actor.plan = null;
  actor.cursor = 0;
  clearEnvelope(actor);
  const last = plan?.points[plan.points.length - 1];
  if (last) {
    actor.x = last.x;
    actor.z = last.z;
  }
  if (plan && plan.sitSeconds > 0) {
    actor.seated = true;
    actor.sitLeft = plan.sitSeconds;
    actor.rotY = FACING_Y;
    setMode(actor, rig, sitMode(actor));
    return;
  }
  if (plan?.vanish) {
    actor.vanishLeft = VANISH_SECONDS;
    actor.scaleMul = 1;
    actor.seated = false;
    return;
  }
  actor.seated = actor.stance === 'sit';
  actor.rotY = actor.facing;
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
  if (actor.sitLeft > 0) {
    actor.seated = true;
    actor.sitLeft = Math.max(0, actor.sitLeft - step);
    if (actor.sitLeft > 0) return;
    actor.vanishLeft = VANISH_SECONDS;
    actor.scaleMul = 1;
    return;
  }
  if (actor.vanishLeft > 0) {
    actor.vanishLeft -= step;
    actor.scaleMul = Math.max(0, actor.vanishLeft / VANISH_SECONDS);
    if (actor.vanishLeft <= 0) actor.dead = true;
    return;
  }
  if (actor.throwLeft > 0) {
    actor.throwLeft = Math.max(0, actor.throwLeft - step);
    if (actor.throwLeft > 0) return;
    actor.carryBox = false;
    actor.dropSpot = null;
  }
  if (actor.pressLeft > 0) {
    actor.pressLeft = Math.max(0, actor.pressLeft - step);
    if (actor.pressLeft > 0) return;
    const paused = actor.plan;
    const next = paused?.points[actor.cursor];
    if (paused && next) {
      face(actor, { x: actor.x, z: actor.z }, next);
      setMode(actor, rig, paused.gait === 'sprint' ? 'sprint' : 'walk');
    }
  }
  if (actor.pickupLeft > 0) {
    actor.pickupLeft = Math.max(0, actor.pickupLeft - step);
    if (actor.pickupLeft > 0) return;
    actor.envelope = 'carry';
    const paused = actor.plan;
    const next = paused?.points[actor.cursor];
    if (paused && next) {
      face(actor, { x: actor.x, z: actor.z }, next);
      setMode(actor, rig, paused.gait === 'sprint' ? 'sprint' : 'walk');
    }
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
      if (holdPickup(actor, rig, target) || holdThrow(actor, rig, target) || holdPress(actor, rig, target)) return;
      continue;
    }
    actor.rotY = Math.atan2(dx, dz);
    if (dist <= remain) {
      actor.x = target.x;
      actor.z = target.z;
      remain -= dist;
      actor.cursor += 1;
      if (holdPickup(actor, rig, target) || holdThrow(actor, rig, target) || holdPress(actor, rig, target)) return;
    } else {
      actor.x += (dx / dist) * remain;
      actor.z += (dz / dist) * remain;
      remain = 0;
    }
  }
  if (actor.cursor >= plan.points.length) finish(actor, rig);
}

function holdPickup(actor: Actor, rig: BlockyRig, target: MovePlan['points'][number]): boolean {
  if (target.role !== 'pickup') return false;
  actor.pickupLeft = PICKUP_SECONDS;
  actor.envelope = 'counter';
  const rest = envelopeOnCounter(target);
  actor.envelopeX = rest.x;
  actor.envelopeZ = rest.z;
  setMode(actor, rig, 'interact');
  return true;
}

/** At the drop spot: face the heap and toss the box for about a second with the interact clip. */
function holdThrow(actor: Actor, rig: BlockyRig, target: MovePlan['points'][number]): boolean {
  if (target.role !== 'throw') return false;
  actor.throwLeft = THROW_SECONDS;
  actor.rotY = Math.PI;
  setMode(actor, rig, 'interact');
  return true;
}

/** At the help desk's call button: face the desk and press for a moment with the interact clip. */
function holdPress(actor: Actor, rig: BlockyRig, target: MovePlan['points'][number]): boolean {
  if (target.role !== 'press') return false;
  actor.pressLeft = PRESS_SECONDS;
  actor.rotY = Math.PI;
  setMode(actor, rig, 'interact');
  return true;
}

function moving(actor: Actor): boolean {
  return actor.plan !== null || actor.celebrateLeft > 0 || actor.vanishLeft > 0 || actor.pickupLeft > 0 || actor.throwLeft > 0 || actor.pressLeft > 0;
}

function createActor(rig: BlockyRig, place: CharacterPlace): Actor {
  return {
    taskId: place.taskId,
    operator: place.operator,
    posture: place.posture,
    stance: place.stance,
    facing: place.facing,
    reduced: false,
    proxy: makeProxy(rig),
    acceptedKey: '',
    x: place.seat?.x ?? 0,
    z: place.seat?.z ?? 0,
    rotY: place.facing,
    seated: place.stance === 'sit',
    scaleMul: 1,
    plan: null,
    cursor: 0,
    celebrateLeft: 0,
    pickupLeft: 0,
    pressLeft: 0,
    throwLeft: 0,
    carryBox: false,
    dropSpot: null,
    envelope: 'none',
    envelopeX: 0,
    envelopeZ: 0,
    sitLeft: 0,
    vanishLeft: 0,
    dead: false,
    delivering: false,
    leftOrigin: false,
    originZoneId: null,
    loungeSeatIndex: null,
  };
}

function shouldSkipCreate(plan: MovePlan | null): boolean {
  if (!plan) return true;
  if (plan.action === 'vanish') return true;
  if (plan.vanish && plan.points.length === 0) return true;
  if (plan.action === 'stay' && plan.points.length === 0) return true;
  return false;
}

function rowSignature(rows: DeskRowMap): string {
  return ZONES.map((zone) => {
    const row = rows[zone.id] ?? [];
    return `${zone.id}:${row.map((desk) => `${desk.taskId ?? ''}@${desk.localX.toFixed(3)}`).join(',')}`;
  }).join('|');
}

function layoutRows(
  tasks: OfficeTask[],
  stats: OfficeZoneStats,
  previous: Map<string, readonly ShownDesk[]>,
  prevPlaces: Map<string, CharacterPlace>,
  actors: Map<string, Actor>,
  reduced: boolean,
): DeskRowMap {
  const flags = new Map<string, DeskActorState>();
  for (const [taskId, actor] of actors) {
    flags.set(taskId, {
      moving: moving(actor),
      dead: actor.dead,
      delivering: actor.delivering,
      leftOrigin: actor.leftOrigin,
    });
  }
  const next: Record<string, readonly ShownDesk[]> = {};
  for (const zone of ZONES) {
    // The waiting room and the help desk have fixed seats, not a desk row that holds while robots walk.
    if (zone.id === 'blocked' || zone.id === 'escalation') {
      next[zone.id] = [];
      continue;
    }
    const desired = sceneDesks(desksForZone(zone.id, tasks, stats)).map((desk) => desk.taskId);
    const prior = previous.get(zone.id) ?? null;
    const motion = reduced
      ? { hold: false, retainTaskIds: [] as string[] }
      : deskHoldForRoom(zone.id, prior, desired, prevPlaces, flags);
    const row = commitRoomDesks(zone.id, tasks, stats, prior, motion);
    next[zone.id] = row;
    previous.set(zone.id, row);
  }
  return next;
}

function cachedPlaces(
  tasks: OfficeTask[],
  stats: OfficeZoneStats,
  cache: { tasks: OfficeTask[] | null; stats: OfficeZoneStats | null; sig: string; places: CharacterPlace[] },
  rows: DeskRowMap,
): CharacterPlace[] {
  const sig = rowSignature(rows);
  if (cache.tasks === tasks && cache.stats === stats && cache.sig === sig) return cache.places;
  cache.tasks = tasks;
  cache.stats = stats;
  cache.sig = sig;
  cache.places = classifyTasks(tasks, stats, rows);
  return cache.places;
}

function markLeftOrigin(actors: Map<string, Actor>): void {
  for (const actor of actors.values()) {
    if (!actor.delivering || actor.leftOrigin || !actor.originZoneId) continue;
    const rect = roomRect(actor.originZoneId);
    const inside = actor.x >= rect.minX && actor.x <= rect.maxX && actor.z >= rect.minZ && actor.z <= rect.maxZ;
    if (!inside) actor.leftOrigin = true;
  }
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
  placeCache: { tasks: OfficeTask[] | null; stats: OfficeZoneStats | null; sig: string; places: CharacterPlace[] },
  rowsRef: Map<string, readonly ShownDesk[]>,
  publishRows: (rows: DeskRowMap, signature: string) => void,
  snap: boolean,
): void {
  if (!settled) return;
  markLeftOrigin(actors);
  const initial = !booted.current;
  const rows = layoutRows(tasks, stats, rowsRef, prevPlaces, actors, reducedMotion);
  publishRows(rows, rowSignature(rows));
  const places = cachedPlaces(tasks, stats, placeCache, rows);
  const nextIds = new Set<string>();
  const takenSeats = new Set<number>();
  const takenSpots = takenPickupSpots(actors.values());
  const takenDrops = takenDropSpots(actors.values());
  for (const actor of actors.values()) {
    if (actor.loungeSeatIndex != null && !actor.dead) takenSeats.add(actor.loungeSeatIndex);
  }
  for (const place of places) {
    nextIds.add(place.taskId);
    const key = placeKey(place);
    let actor = actors.get(place.taskId);
    if (actor?.dead) {
      actor.proxy.mixer.stopAllAction();
      actors.delete(place.taskId);
      actor = undefined;
    }
    const prev = prevPlaces.get(place.taskId) ?? null;
    const enRoute = Boolean(actor && (actor.plan !== null || actor.celebrateLeft > 0 || actor.vanishLeft > 0 || actor.sitLeft > 0 || actor.pickupLeft > 0 || actor.pressLeft > 0 || actor.throwLeft > 0 || !actor.seated));
    if (actor && actor.acceptedKey === key && actor.reduced === reducedMotion && !(snap && enRoute)) {
      actor.operator = place.operator;
      actor.posture = place.posture;
      actor.stance = place.stance;
      actor.facing = place.facing;
      continue;
    }
    const previousSeat = actor?.loungeSeatIndex ?? null;
    if (previousSeat != null) takenSeats.delete(previousSeat);
    let pickupSpot: number | null | undefined;
    if (needsReceptionPickup(prev, place, { reducedMotion, initial, snap })) {
      pickupSpot = pickPickupSpot(place.zoneId === 'inbox' ? place.seat : null, takenSpots);
      if (pickupSpot !== null) takenSpots.add(pickupSpot);
    }
    let dropSpot: number | null | undefined;
    if (place.terminal === 'aborted' && prev?.seat && !reducedMotion && !initial && !snap) {
      dropSpot = pickDropSpot(prev.seat, takenDrops);
      if (dropSpot !== null) takenDrops.add(dropSpot);
    }
    const plan = planMove(prev, place, { reducedMotion, initial, snap, takenSeats: new Set(takenSeats), pickupSpot, dropSpot });
    if (!actor) {
      if (shouldSkipCreate(plan) || actors.size >= MAX_ACTORS) {
        if (previousSeat != null) takenSeats.add(previousSeat);
        continue;
      }
      actor = createActor(rig, place);
      actors.set(place.taskId, actor);
    }
    if (!plan) {
      if (previousSeat != null) takenSeats.add(previousSeat);
      continue;
    }
    if (plan.seatIndex != null) takenSeats.add(plan.seatIndex);
    actor.operator = place.operator;
    actor.posture = place.posture;
    actor.stance = place.stance;
    actor.facing = place.facing;
    actor.reduced = reducedMotion;
    actor.acceptedKey = key;
    if (plan.action === 'leave' && prev) actor.originZoneId = prev.zoneId;
    begin(actor, plan, rig);
  }
  if (!initial) {
    for (const [taskId, earlier] of prevPlaces) {
      if (nextIds.has(taskId)) continue;
      const actor = actors.get(taskId);
      if (!actor || actor.dead) continue;
      if (actor.acceptedKey === 'gone' && actor.reduced === reducedMotion) continue;
      const plan = planMove(earlier, null, { reducedMotion, initial: false, snap });
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
const envelopeDummy = new Object3D();
const ENVELOPE = new Color(ENVELOPE_COLOR);
const CARRIED_BOX = new Color(SCENE.wood);
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

function pushEnvelope(batch: Batch, actor: Actor): void {
  if (actor.envelope === 'none' || actor.dead || actor.scaleMul <= 0.001) return;
  let x = actor.envelopeX;
  let y = FLOOR_TOP + (actor.envelope === 'counter' ? COUNTER_TOP_Y + 0.025 : 0.68);
  let z = actor.envelopeZ;
  let rotY = 0;
  if (actor.envelope === 'carry') {
    x = actor.x + Math.sin(actor.rotY) * 0.22;
    z = actor.z + Math.cos(actor.rotY) * 0.22;
    y = actorRootY(actor.x, actor.z, 'stand', 0) + 0.55;
    rotY = actor.rotY;
  }
  envelopeDummy.position.set(x, y, z);
  envelopeDummy.rotation.set(0, rotY, 0);
  envelopeDummy.scale.set(0.22, 0.05, 0.14);
  envelopeDummy.updateMatrix();
  batch.push(envelopeDummy.matrix, ENVELOPE);
}

/** The box a robot carries to the heap: in front of it while walking, tossed in an arc over the throw. */
function pushCarriedBox(batch: Batch, actor: Actor): void {
  if (!actor.carryBox || actor.dead || actor.scaleMul <= 0.001) return;
  const handX = actor.x + Math.sin(actor.rotY) * 0.22;
  const handZ = actor.z + Math.cos(actor.rotY) * 0.22;
  const handY = actorRootY(actor.x, actor.z, 'stand', 0) + 0.55;
  let x = handX;
  let y = handY;
  let z = handZ;
  if (actor.throwLeft > 0) {
    const t = Math.min(1, Math.max(0, 1 - actor.throwLeft / THROW_SECONDS));
    if (t > 0.7) return;
    const k = t / 0.7;
    const room = ROOM_LAYOUT.aborted;
    const targetX = room.x + Math.min(0.1, Math.max(-1.5, actor.x - room.x));
    const targetZ = room.z + ABORTED.dropSpots[0].z - 0.65;
    x = handX + (targetX - handX) * k;
    z = handZ + (targetZ - handZ) * k;
    y = handY + (FLOOR_TOP + 0.45 - handY) * k + Math.sin(k * Math.PI) * 0.35;
  }
  envelopeDummy.position.set(x, y, z);
  envelopeDummy.rotation.set(0, actor.rotY, 0);
  envelopeDummy.scale.setScalar(actor.scaleMul * 0.24);
  envelopeDummy.updateMatrix();
  batch.push(envelopeDummy.matrix, CARRIED_BOX);
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
  streamOpen,
  awaitingReload,
  onDeskRows,
}: {
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  animate: boolean;
  reducedMotion: boolean;
  settled: boolean;
  /** False while the dashboard stream is down after it has been open. Connecting does not count. */
  streamOpen: boolean;
  /** True from a reconnect until the reload that reconnect started has been applied. */
  awaitingReload: boolean;
  onDeskRows?: (rows: DeskRowMap) => void;
}) {
  const { gl, invalidate } = useThree();
  const [rig, setRig] = useState<BlockyRig | null>(null);
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const bodyMat = useMemo(() => new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.05 }), []);
  const glowMat = useMemo(() => new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), []);
  const envelopeMat = useMemo(() => new MeshStandardMaterial({
    color: ENVELOPE_COLOR,
    emissive: ENVELOPE_COLOR,
    emissiveIntensity: 0.08,
    roughness: 0.7,
    metalness: 0,
  }), []);
  const bodyRef = useRef<InstancedMesh>(null);
  const glowRef = useRef<InstancedMesh>(null);
  const envelopeRef = useRef<InstancedMesh>(null);
  const batches = useRef<{ body: Batch; glow: Batch; envelope: Batch } | null>(null);
  const actors = useRef(new Map<string, Actor>());
  const prevPlaces = useRef(new Map<string, CharacterPlace>());
  const booted = useRef(false);
  const placeCache = useRef<{ tasks: OfficeTask[] | null; stats: OfficeZoneStats | null; sig: string; places: CharacterPlace[] }>({
    tasks: null,
    stats: null,
    sig: '',
    places: [],
  });
  const deskRowsRef = useRef(new Map<string, readonly ShownDesk[]>());
  const publishedRows = useRef('');
  const onDeskRowsRef = useRef(onDeskRows);
  onDeskRowsRef.current = onDeskRows;
  const headBox = useMemo(() => new Box3(), []);
  const tasksRef = useRef(tasks);
  const statsRef = useRef(stats);
  const reducedRef = useRef(reducedMotion);
  const animateRef = useRef(animate);
  const settledRef = useRef(settled);
  const streamOpenRef = useRef(streamOpen);
  const awaitingRef = useRef(awaitingReload);
  const catchRef = useRef(initialCatchUp(streamOpen));
  tasksRef.current = tasks;
  statsRef.current = stats;
  reducedRef.current = reducedMotion;
  animateRef.current = animate;
  settledRef.current = settled;
  streamOpenRef.current = streamOpen;
  awaitingRef.current = awaitingReload;

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
    envelopeMat.dispose();
    unit.dispose();
  }, [bodyMat, glowMat, envelopeMat, unit]);

  useEffect(() => {
    if (!animate) catchRef.current = { ...catchRef.current, armed: true };
  }, [animate]);

  useEffect(() => {
    const step = onStreamPhase(catchRef.current, streamOpen);
    catchRef.current = { ...step.state, awaitingReload: awaitingRef.current };
  }, [streamOpen]);

  useLayoutEffect(() => {
    for (const mesh of [bodyRef.current, glowRef.current, envelopeRef.current]) {
      if (!mesh) continue;
      mesh.count = 0;
      mesh.visible = mesh !== envelopeRef.current;
      mesh.frustumCulled = false;
      mesh.raycast = () => undefined;
    }
  }, [rig]);

  useFrame((_, delta) => {
    const bodyMesh = bodyRef.current;
    const glowMesh = glowRef.current;
    const envelopeMesh = envelopeRef.current;
    if (!bodyMesh || !glowMesh || !envelopeMesh) return;
    if (!batches.current) batches.current = { body: new Batch(bodyMesh), glow: new Batch(glowMesh), envelope: new Batch(envelopeMesh) };
    const body = batches.current.body;
    const glow = batches.current.glow;
    const envelope = batches.current.envelope;
    body.begin();
    glow.begin();
    envelope.begin();
    if (rig) {
      catchRef.current = { ...catchRef.current, awaitingReload: awaitingRef.current };
      const frame = onFrame(catchRef.current, animateRef.current, streamOpenRef.current);
      catchRef.current = frame.state;
      syncActors(
        rig,
        actors.current,
        prevPlaces.current,
        booted,
        tasksRef.current,
        statsRef.current,
        reducedRef.current,
        settledRef.current,
        placeCache.current,
        deskRowsRef.current,
        (rows, signature) => {
          if (signature === publishedRows.current) return;
          publishedRows.current = signature;
          onDeskRowsRef.current?.(rows);
        },
        frame.snap,
      );
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
        pushEnvelope(envelope, actor);
        pushCarriedBox(envelope, actor);
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
    envelope.end();
    envelopeMesh.visible = envelopeMesh.count > 0;
  });

  return (
    <>
      <instancedMesh ref={bodyRef} args={[unit, bodyMat, BODY_CAP]} castShadow frustumCulled={false} raycast={() => undefined} />
      <instancedMesh ref={glowRef} args={[unit, glowMat, GLOW_CAP]} frustumCulled={false} raycast={() => undefined} />
      <instancedMesh ref={envelopeRef} args={[unit, envelopeMat, ENVELOPE_CAP]} visible={false} frustumCulled={false} raycast={() => undefined} />
    </>
  );
}
