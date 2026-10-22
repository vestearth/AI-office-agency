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
  LIMB_COLOR,
  OPERATOR_VISOR,
  characterSlots,
  seatClipCues,
  visorGain,
  type CharacterOperator,
  type CharacterSlot,
} from './officeCharacters';
import type { OfficeTask, OfficeZoneStats } from './officeSelection';

const PARTS = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'] as const;
type PartName = (typeof PARTS)[number];
const MAX_CHARACTERS = 32;
const BODY_CAP = MAX_CHARACTERS * 12;
const GLOW_CAP = MAX_CHARACTERS * 12;

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
  slot: CharacterSlot;
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

function makeProxy(rig: BlockyRig, slot: CharacterSlot, reducedMotion: boolean): Proxy {
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
  const mixer = new AnimationMixer(cloned);
  for (const cue of seatClipCues(slot.posture, reducedMotion)) {
    const clip = AnimationClip.findByName(rig.clips, cue.name);
    if (!clip) continue;
    const action = mixer.clipAction(clip);
    action.setLoop(LoopRepeat, Infinity);
    action.timeScale = cue.timeScale;
    if (reducedMotion) action.time = 0.25;
    action.play();
  }
  mixer.update(reducedMotion ? 0 : phaseOf(slot.key));
  return { root, parts, mixer, slot };
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

function placeProxy(proxy: Proxy, rig: BlockyRig): void {
  const slot = proxy.slot;
  proxy.root.scale.setScalar(rig.scale);
  proxy.root.position.set(slot.x, slot.y - rig.sitLift * rig.scale, slot.z);
  proxy.root.rotation.set(0, slot.rotY, 0);
  proxy.root.updateMatrixWorld(true);
}

export function OfficeCharacterView({
  tasks,
  stats,
  animate,
  reducedMotion,
}: {
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  animate: boolean;
  reducedMotion: boolean;
}) {
  const { gl, invalidate } = useThree();
  const slots = useMemo(() => characterSlots(tasks, stats).slice(0, MAX_CHARACTERS), [tasks, stats]);
  const [rig, setRig] = useState<BlockyRig | null>(null);
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const bodyMat = useMemo(() => new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.05 }), []);
  const glowMat = useMemo(() => new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), []);
  const bodyRef = useRef<InstancedMesh>(null);
  const glowRef = useRef<InstancedMesh>(null);
  const proxies = useMemo(() => (rig ? slots.map((slot) => makeProxy(rig, slot, reducedMotion)) : []), [rig, slots, reducedMotion]);
  const headBox = useMemo(() => new Box3(), []);

  useEffect(() => {
    let live = true;
    loadRig().then((next) => {
      if (!live) return;
      setRig(next);
      gl.domElement.dataset.chars = 'ready';
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
    gl.domElement.dataset.charCount = String(slots.length);
  }, [gl, slots.length]);

  useEffect(() => {
    invalidate();
    return () => {
      for (const proxy of proxies) proxy.mixer.stopAllAction();
    };
  }, [invalidate, proxies]);

  useEffect(() => () => {
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
    const body = new Batch(bodyMesh);
    const glow = new Batch(glowMesh);
    body.begin();
    glow.begin();
    if (rig) {
      for (const proxy of proxies) {
        if (animate) proxy.mixer.update(Math.min(delta, 0.05));
        placeProxy(proxy, rig);
        for (const name of PARTS) {
          const node = proxy.parts[name];
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
        const head = proxy.parts.head;
        const headBounds = rig.boxes.head;
        if (head && headBounds) {
          headBox.copy(headBounds);
          paintIdentity(body, glow, head.matrixWorld, headBox, proxy.slot.operator);
        }
      }
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
