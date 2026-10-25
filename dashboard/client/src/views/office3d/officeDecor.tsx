// Static decor, merged into one mesh per material so the night scene stays inside 70 draw calls.
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type Material,
} from 'three';
import { ABORTED } from './officeAborted';
import { BLOCKED } from './officeBlocked';
import { DEBUG_LAB } from './officeDebug';
import { DEVBAY, devBayBoxes } from './officeDevBay';
import { DEVOPS, devopsBoxes } from './officeDevops';
import { ESCALATION } from './officeEscalation';
import { FLOOR_TOP, SCENE } from './officeLook';
import { LOUNGE, LOUNGE_LIGHT } from './officeLounge';
import { RECEPTION } from './officeReception';
import { qaLabBoxes } from './officeQaLab';
import { REVIEW } from './officeReview';
import { ROOM_LAYOUT } from './officeSelection';

export type DecorBucket = 'wood' | 'metal' | 'fabric' | 'shade' | 'loungeShade';

/** The lounge floor lamp follows the Done light rule, not the DevOps shade. */
export function placedDecorBucket(zoneId: string, material: DecorBucket): DecorBucket {
  if (material !== 'shade') return material;
  if (zoneId === 'done') return 'loungeShade';
  // The help desk's floor lamp must not glow with DevOps: its shade joins the unlit fabric bucket.
  return zoneId === 'escalation' ? 'fabric' : material;
}

export interface DecorPlacement {
  file: string;
  zoneId: string;
  /** Room-local offset. y is extra height above the floor (used to stack a box). */
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  /** Per-axis stretch on top of `scale`, for a model that is the wrong shape (the waiting room's bench). */
  stretch?: readonly [number, number, number];
}

/**
 * Back-wall band (local z about -1.5 to -0.5) so pieces sit behind the desk row
 * (desks at z 0.35) and behind monitors. The near wall is +x from this camera,
 * so pieces stay at local x <= ~1. DevOps lamp sits opposite the code racks. Debug Lab has no models:
 * its clinic is boxes, see `debugFixtures`.
 */
export const DECOR_PLACEMENTS: DecorPlacement[] = [
  ...RECEPTION.counters.map((item) => ({ ...item, zoneId: 'inbox' })),
  { ...RECEPTION.shelf, zoneId: 'inbox' },

  // Dev Bay is an office: a meeting table with four chairs, two bookcases on the left wall and a low cabinet that
  // carries the printer. The whiteboard, filing cabinet, cooler and window are boxes, see `devBayFixtures`.
  { file: DEVBAY.table.file, zoneId: 'dev', x: DEVBAY.table.x, y: 0, z: DEVBAY.table.z, rotY: DEVBAY.table.rotY, scale: DEVBAY.table.scale },
  ...DEVBAY.chairs.map((chair) => ({ file: 'chair', zoneId: 'dev', x: chair.x, y: 0, z: chair.z, rotY: chair.rotY, scale: DEVBAY.chairScale })),
  ...DEVBAY.bookcases.map((shelf) => ({ file: shelf.file, zoneId: 'dev', x: shelf.x, y: 0, z: shelf.z, rotY: shelf.rotY, scale: shelf.scale })),
  { file: DEVBAY.cabinet.file, zoneId: 'dev', x: DEVBAY.cabinet.x, y: 0, z: DEVBAY.cabinet.z, rotY: 0, scale: DEVBAY.cabinet.scale },

  { file: 'loungeSofa', zoneId: 'done', ...LOUNGE.sofa },
  { file: 'loungeChair', zoneId: 'done', ...LOUNGE.chair },
  { file: 'loungeSofaOttoman', zoneId: 'done', ...LOUNGE.ottoman },
  { file: 'tableCoffee', zoneId: 'done', ...LOUNGE.table },
  { file: 'cabinetTelevisionDoors', zoneId: 'done', ...LOUNGE.tv },
  { file: 'lampRoundFloor', zoneId: 'done', ...LOUNGE.lamp },

  ...ABORTED.crates.map((item) => ({ ...item, zoneId: 'aborted' })),

  { file: 'lampRoundFloor', zoneId: 'devops', x: DEVOPS.lamp.x, y: 0, z: DEVOPS.lamp.z, rotY: 0, scale: DEVOPS.lamp.scale },
  { file: DEVOPS.table.file, zoneId: 'devops', x: DEVOPS.table.x, y: 0, z: DEVOPS.table.z, rotY: DEVOPS.table.rotY, scale: DEVOPS.table.scale },
  ...DEVOPS.chairs.map((chair) => ({ file: 'chair', zoneId: 'devops', x: chair.x, y: 0, z: chair.z, rotY: chair.rotY, scale: DEVOPS.chairScale })),
  { file: 'cabinetBedDrawer', zoneId: 'devops', x: DEVOPS.cabinet.x, y: 0, z: DEVOPS.cabinet.z, rotY: 0, scale: DEVOPS.cabinet.scale },

  { file: 'chair', zoneId: 'escalation', x: ESCALATION.earthChair.x, y: 0, z: ESCALATION.earthChair.z, rotY: Math.PI, scale: 1.2 },
  { file: 'cabinetBedDrawer', zoneId: 'escalation', x: ESCALATION.cabinet.x, y: 0, z: ESCALATION.cabinet.z, rotY: 0, scale: 1.35 },
  { file: 'bookcaseClosed', zoneId: 'escalation', x: ESCALATION.bookcase.x, y: 0, z: ESCALATION.bookcase.z, rotY: 0, scale: 1.05 },
  { file: 'lampRoundFloor', zoneId: 'escalation', x: ESCALATION.floorLamp.x, y: 0, z: ESCALATION.floorLamp.z, rotY: 0, scale: 1.15 },
  { file: 'benchCushionLow', zoneId: 'escalation', x: ESCALATION.benchFrame.x, y: 0, z: ESCALATION.benchFrame.z, rotY: 0, scale: 1, stretch: ESCALATION.benchFrame.stretch },

  { file: 'benchCushionLow', zoneId: 'blocked', x: BLOCKED.benchFrame.x, y: 0, z: BLOCKED.benchFrame.z, rotY: 0, scale: 1, stretch: BLOCKED.benchFrame.stretch },

  { file: 'cabinetBedDrawer', zoneId: 'rejected', x: 0.4, y: 0, z: -1.48, rotY: 0, scale: 1.35 },
];

function flat(geometry: BufferGeometry): BufferGeometry {
  const plain = geometry.index ? geometry.toNonIndexed() : geometry;
  if (plain !== geometry) geometry.dispose();
  plain.deleteAttribute('uv');
  return plain;
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  return flat(new BoxGeometry(w, h, d)).translate(x, y, z);
}

/**
 * The waiting room's queue board, wall clock and closed door: simple shapes that join the merged
 * decor buckets at no draw call. Room-local numbers come from `BLOCKED`; the result is in world space.
 */
export function blockedFixtures(): Partial<Record<DecorBucket, BufferGeometry[]>> {
  const layout = ROOM_LAYOUT.blocked;
  const at = (x: number, y: number, z: number): [number, number, number] => [layout.x + x, FLOOR_TOP + y, layout.z + z];
  const { board, clock, door } = BLOCKED;
  const rim = flat(new CylinderGeometry(clock.r, clock.r, clock.d, 20)).rotateX(Math.PI / 2).translate(...at(clock.x, clock.y, clock.z));
  const face = flat(new CylinderGeometry(clock.r * 0.82, clock.r * 0.82, clock.d, 20))
    .rotateX(Math.PI / 2)
    .translate(...at(clock.x, clock.y, clock.z + 0.012));
  return {
    metal: [
      boxAt(board.w, board.h, board.d, ...at(board.x, board.y, board.z)),
      face,
      boxAt(door.w * 0.6, 0.05, 0.05, ...at(door.x + 0.04, door.y, door.z + door.d * 0.32)),
    ],
    wood: [
      rim,
      boxAt(clock.r * 0.08, clock.r * 0.62, clock.d, ...at(clock.x, clock.y + clock.r * 0.3, clock.z + clock.d * 0.9)),
      boxAt(clock.r * 0.5, clock.r * 0.08, clock.d, ...at(clock.x + clock.r * 0.22, clock.y, clock.z + clock.d * 0.9)),
      boxAt(door.w, door.h, door.d, ...at(door.x, door.y, door.z)),
    ],
  };
}

/**
 * The help desk's rug, call button, phone, incident board (notes and strings, no text) and the
 * beacon's bracket: simple shapes that join the merged decor buckets at no draw call. They can only
 * take the three decor colors (wood, metal, fabric). Room-local numbers come from `ESCALATION`;
 * the result is in world space.
 */
export function escalationFixtures(): Partial<Record<DecorBucket, BufferGeometry[]>> {
  const layout = ROOM_LAYOUT.escalation;
  const at = (x: number, y: number, z: number): [number, number, number] => [layout.x + x, FLOOR_TOP + y, layout.z + z];
  const { rug, desk, button, phone, board, beacon } = ESCALATION;
  const top = desk.top;
  const buttonBase = flat(new CylinderGeometry(button.r * 1.35, button.r * 1.35, button.h * 0.5, 14)).translate(...at(button.x, top + button.h * 0.25, button.z));
  const buttonCap = flat(new CylinderGeometry(button.r, button.r, button.h, 14)).translate(...at(button.x, top + button.h * 0.5 + 0.012, button.z));
  const noteFace = board.x + board.w / 2 + 0.012;
  const note = (dz: number, dy: number): BufferGeometry => boxAt(0.012, 0.11, 0.13, ...at(noteFace, board.y + dy, board.z + dz));
  const string = (dz: number, dy: number, length: number, tilt: number): BufferGeometry => flat(new BoxGeometry(0.008, 0.012, length))
    .rotateX(tilt)
    .translate(...at(noteFace + 0.012, board.y + dy, board.z + dz));
  return {
    fabric: [
      boxAt(rug.w, rug.h, rug.d, ...at(ESCALATION.rug.x, rug.h / 2, rug.z)),
      string(-0.12, 0.03, 0.62, 0.62),
      string(0.14, 0.02, 0.58, -0.7),
      string(0.0, -0.1, 0.9, 0.12),
    ],
    metal: [
      boxAt(board.w, board.h, board.d, ...at(board.x, board.y, board.z)),
      buttonBase,
      boxAt(phone.w, phone.h, phone.d, ...at(phone.x, top + phone.h / 2, phone.z)),
      boxAt(phone.w * 0.62, phone.h * 0.9, phone.d * 0.36, ...at(phone.x, top + phone.h + 0.015, phone.z - 0.03)),
      boxAt(0.14, 0.14, 0.07, ...at(beacon.x, beacon.y - 0.02, beacon.z - 0.05)),
    ],
    wood: [
      buttonCap,
      note(-0.38, 0.17),
      note(-0.14, 0.1),
      note(0.16, 0.18),
      note(0.4, 0.08),
      note(-0.3, -0.12),
      note(0.3, -0.14),
    ],
  };
}

/**
 * The Debug Lab clinic's table frame, lamp stand and arm, tray stand, monitor cart, curtain frame and
 * bug-board backing: plain boxes that join the merged decor at no draw call. Only wood, metal and
 * fabric: the lamp-shade bucket glows with DevOps. Room-local numbers come from `DEBUG_LAB`; the
 * result is in world space.
 */
export function debugFixtures(): Partial<Record<DecorBucket, BufferGeometry[]>> {
  const layout = ROOM_LAYOUT.debug;
  const out: Partial<Record<DecorBucket, BufferGeometry[]>> = {};
  for (const item of DEBUG_LAB.frame) {
    (out[item.bucket] ??= []).push(boxAt(item.w, item.h, item.d, layout.x + item.x, FLOOR_TOP + item.y, layout.z + item.z));
  }
  return out;
}

/**
 * The deploy control room's board backing, cable tray, console, checklist whiteboard, coffee corner, rug
 * and clock rim: plain boxes and one cylinder that join the merged decor buckets at no draw call. Wood,
 * metal and fabric only, so nothing here glows. Room-local numbers come from `DEVOPS`; the result is in
 * world space.
 */
export function devopsFixtures(): Partial<Record<DecorBucket, BufferGeometry[]>> {
  const layout = ROOM_LAYOUT.devops;
  const out: Partial<Record<DecorBucket, BufferGeometry[]>> = {};
  for (const item of devopsBoxes()) {
    (out[item.bucket] ??= []).push(boxAt(item.w, item.h, item.d, layout.x + item.x, FLOOR_TOP + item.y, layout.z + item.z));
  }
  const { clock } = DEVOPS;
  (out.wood ??= []).push(
    flat(new CylinderGeometry(clock.r, clock.r, clock.d, 20)).rotateX(Math.PI / 2).translate(layout.x + clock.x, FLOOR_TOP + clock.y, layout.z + clock.z),
  );
  return out;
}

/**
 * Dev Bay's whiteboard backing and tray, rug and aisle runner, filing cabinet, printer, water cooler and window
 * with its blind: plain boxes that join the merged decor buckets at no draw call. Wood, metal and fabric only,
 * so nothing here glows. Room-local numbers come from `DEVBAY`; the result is in world space.
 */
export function devBayFixtures(): Partial<Record<DecorBucket, BufferGeometry[]>> {
  const layout = ROOM_LAYOUT.dev;
  const out: Partial<Record<DecorBucket, BufferGeometry[]>> = {};
  for (const item of devBayBoxes()) {
    (out[item.bucket] ??= []).push(boxAt(item.w, item.h, item.d, layout.x + item.x, FLOOR_TOP + item.y, layout.z + item.z));
  }
  return out;
}

export type DecorGeometries = Partial<Record<DecorBucket, BufferGeometry>>;

const FILES = [...new Set(DECOR_PLACEMENTS.map((item) => item.file))];

function assetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}office3d/${file}.glb`;
}

/** Raw pack names mapped onto the locked D5 albedos. woodDark boxes share wood. */
function bucket(name: string): DecorBucket {
  if (name === 'lamp') return 'shade';
  if (name.startsWith('carpet') || name === 'plant') return 'fabric';
  if (name === 'metal' || name === 'metalDark' || name === '_defaultMat') return 'metal';
  return 'wood';
}

function bake(mesh: Mesh): BufferGeometry {
  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  const plain = geometry.index ? geometry.toNonIndexed() : geometry;
  if (plain !== geometry) geometry.dispose();
  for (const name of Object.keys(plain.attributes)) {
    if (name !== 'position' && name !== 'normal') plain.deleteAttribute(name);
  }
  if (!plain.getAttribute('normal')) plain.computeVertexNormals();
  return plain;
}

function centerParts(parts: BufferGeometry[]): void {
  const box = new Box3();
  const item = new Box3();
  for (const geometry of parts) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox) item.copy(geometry.boundingBox);
    box.union(item);
  }
  const center = new Vector3();
  box.getCenter(center);
  for (const geometry of parts) geometry.translate(-center.x, -box.min.y, -center.z);
}

async function loadFile(file: string): Promise<Map<DecorBucket, BufferGeometry[]>> {
  const gltf = await new GLTFLoader().loadAsync(assetUrl(file));
  gltf.scene.updateMatrixWorld(true);
  const grouped = new Map<DecorBucket, BufferGeometry[]>();
  const all: BufferGeometry[] = [];
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const geometry = bake(mesh);
    const name = bucket((materials[0] as Material & { name?: string }).name || '');
    geometry.userData.bucket = name;
    const list = grouped.get(name) ?? [];
    list.push(geometry);
    grouped.set(name, list);
    all.push(geometry);
  });
  centerParts(all);
  return grouped;
}

let decorGeometries: Promise<DecorGeometries> | null = null;

async function loadDecorOnce(): Promise<DecorGeometries> {
  const loaded = new Map(await Promise.all(FILES.map(async (file) => [file, await loadFile(file)] as const)));
  const buckets = new Map<DecorBucket, BufferGeometry[]>();
  const stamp = new Object3D();
  for (const placement of DECOR_PLACEMENTS) {
    const layout = ROOM_LAYOUT[placement.zoneId];
    const parts = loaded.get(placement.file);
    if (!layout || !parts) throw new Error(`Missing decor ${placement.file} in ${placement.zoneId}`);
    stamp.position.set(layout.x + placement.x, FLOOR_TOP + placement.y, layout.z + placement.z);
    stamp.rotation.set(0, placement.rotY, 0);
    const [kx, ky, kz] = placement.stretch ?? [1, 1, 1];
    stamp.scale.set(placement.scale * kx, placement.scale * ky, placement.scale * kz);
    stamp.updateMatrix();
    for (const [raw, geometries] of parts) {
      const name = placedDecorBucket(placement.zoneId, raw);
      const list = buckets.get(name) ?? [];
      for (const geometry of geometries) {
        const placed = geometry.clone();
        placed.applyMatrix4(stamp.matrix);
        list.push(placed);
      }
      buckets.set(name, list);
    }
  }
  // The Aborted note board is a flat box, not a model: it joins the wood bucket at no extra draw call.
  const board = ABORTED.board;
  const boardLayout = ROOM_LAYOUT.aborted;
  const slab = new BoxGeometry(board.w, board.h, board.d).toNonIndexed();
  slab.deleteAttribute('uv');
  slab.translate(boardLayout.x + board.x, FLOOR_TOP + board.y, boardLayout.z + board.z);
  buckets.set('wood', [...(buckets.get('wood') ?? []), slab]);
  for (const [name, shapes] of Object.entries(escalationFixtures()) as Array<[DecorBucket, BufferGeometry[]]>) {
    buckets.set(name, [...(buckets.get(name) ?? []), ...shapes]);
  }
  for (const [name, shapes] of Object.entries(blockedFixtures()) as Array<[DecorBucket, BufferGeometry[]]>) {
    buckets.set(name, [...(buckets.get(name) ?? []), ...shapes]);
  }
  // The Val.Failed QA lab pieces are flat boxes too: wood, metal and fabric only, never the lamp shade.
  const qaLayout = ROOM_LAYOUT.rejected;
  for (const piece of qaLabBoxes()) {
    const slab = new BoxGeometry(piece.w, piece.h, piece.d).toNonIndexed();
    slab.deleteAttribute('uv');
    slab.translate(qaLayout.x + piece.x, FLOOR_TOP + piece.y, qaLayout.z + piece.z);
    buckets.set(piece.bucket, [...(buckets.get(piece.bucket) ?? []), slab]);
  }
  // The Review conveyor, gate, rack, shelf and bin are plain boxes too, in the same three buckets.
  const reviewLayout = ROOM_LAYOUT.review;
  for (const item of REVIEW.props) {
    buckets.set(item.bucket, [...(buckets.get(item.bucket) ?? []), boxAt(item.w, item.h, item.d, reviewLayout.x + item.x, FLOOR_TOP + item.y, reviewLayout.z + item.z)]);
  }
  for (const [name, shapes] of Object.entries(devopsFixtures()) as Array<[DecorBucket, BufferGeometry[]]>) {
    buckets.set(name, [...(buckets.get(name) ?? []), ...shapes]);
  }
  for (const [name, shapes] of Object.entries(debugFixtures()) as Array<[DecorBucket, BufferGeometry[]]>) {
    buckets.set(name, [...(buckets.get(name) ?? []), ...shapes]);
  }
  for (const [name, shapes] of Object.entries(devBayFixtures()) as Array<[DecorBucket, BufferGeometry[]]>) {
    buckets.set(name, [...(buckets.get(name) ?? []), ...shapes]);
  }
  const merged = {} as DecorGeometries;
  for (const [name, list] of buckets) {
    const geometry = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geometry) throw new Error(`Could not merge decor ${name}`);
    geometry.computeBoundingSphere();
    merged[name] = geometry;
    if (list.length > 1) for (const item of list) item.dispose();
  }
  return merged;
}

const propGeometry = new Map<string, Promise<BufferGeometry>>();

/** One centered mesh for a kit file. The pile and the coffee-table box instance this. */
export function loadPropGeometry(file: string): Promise<BufferGeometry> {
  let pending = propGeometry.get(file);
  if (!pending) {
    pending = loadFile(file).then((grouped) => {
      const parts = [...grouped.values()].flat();
      if (parts.length === 0) throw new Error(`Missing prop ${file}`);
      if (parts.length === 1) return parts[0];
      const merged = mergeGeometries(parts, false);
      if (!merged) throw new Error(`Could not merge prop ${file}`);
      for (const part of parts) part.dispose();
      merged.computeBoundingSphere();
      return merged;
    });
    propGeometry.set(file, pending);
  }
  return pending;
}

export function loadDecorGeometries(): Promise<DecorGeometries> {
  if (!decorGeometries) {
    decorGeometries = loadDecorOnce().catch((error: unknown) => {
      decorGeometries = null;
      throw error;
    });
  }
  return decorGeometries;
}

/** Not pickable. DevOps and the Done lounge each have their own shade material. */
export function DecorMeshes({
  geometries,
  shadeEmissive,
  loungeShadeEmissive,
}: {
  geometries: DecorGeometries;
  shadeEmissive: number;
  loungeShadeEmissive: number;
}) {
  const materials = useMemo(() => ({
    wood: new MeshStandardMaterial({ color: SCENE.wood, roughness: 0.8, metalness: 0.04 }),
    metal: new MeshStandardMaterial({ color: SCENE.metal, roughness: 0.8, metalness: 0.04 }),
    fabric: new MeshStandardMaterial({ color: SCENE.fabric, roughness: 0.8, metalness: 0.04 }),
    shade: new MeshStandardMaterial({
      color: SCENE.shade, emissive: SCENE.shade, emissiveIntensity: shadeEmissive, roughness: 0.45,
    }),
    loungeShade: new MeshStandardMaterial({
      color: LOUNGE_LIGHT, emissive: LOUNGE_LIGHT, emissiveIntensity: loungeShadeEmissive, roughness: 0.45,
    }),
  }), []);
  useLayoutEffect(() => {
    materials.shade.emissiveIntensity = shadeEmissive;
    materials.loungeShade.emissiveIntensity = loungeShadeEmissive;
  }, [materials, shadeEmissive, loungeShadeEmissive]);
  useEffect(() => () => {
    for (const material of Object.values(materials)) material.dispose();
  }, [materials]);
  const order: DecorBucket[] = ['wood', 'metal', 'fabric', 'shade', 'loungeShade'];
  return (
    <>
      {order.map((name) => {
        const geometry = geometries[name];
        if (!geometry) return null;
        return (
          <mesh
            key={name}
            geometry={geometry}
            material={materials[name]}
            castShadow
            receiveShadow
            frustumCulled={false}
            raycast={() => undefined}
          />
        );
      })}
    </>
  );
}
