// Static decor, merged into one mesh per material so the night scene stays inside 70 draw calls.
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Box3,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type Material,
} from 'three';
import { FLOOR_TOP, SCENE } from './officeLook';
import { LOUNGE, LOUNGE_LIGHT } from './officeLounge';
import { RECEPTION } from './officeReception';
import { ROOM_LAYOUT } from './officeSelection';

export type DecorBucket = 'wood' | 'metal' | 'fabric' | 'shade' | 'loungeShade';

/** The lounge floor lamp follows the Done light rule, not the DevOps shade. */
export function placedDecorBucket(zoneId: string, material: DecorBucket): DecorBucket {
  return material === 'shade' && zoneId === 'done' ? 'loungeShade' : material;
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
}

/**
 * Back-wall band (local z about -1.5 to -0.5) so pieces sit behind the desk row
 * (desks at z 0.35) and behind monitors. The near wall is +x from this camera,
 * so pieces stay at local x <= ~1. Review's meeting set stays left of the wall
 * screen. DevOps lamp sits opposite the code racks.
 */
export const DECOR_PLACEMENTS: DecorPlacement[] = [
  ...RECEPTION.counters.map((item) => ({ ...item, zoneId: 'inbox' })),
  { ...RECEPTION.shelf, zoneId: 'inbox' },

  { file: 'table', zoneId: 'review', x: -1.2, y: 0, z: -0.95, rotY: 0, scale: 1.2 },
  { file: 'chair', zoneId: 'review', x: -1.2, y: 0, z: -0.48, rotY: Math.PI, scale: 1.2 },
  { file: 'chair', zoneId: 'review', x: -1.88, y: 0, z: -0.95, rotY: Math.PI / 2, scale: 1.2 },

  { file: 'bookcaseOpen', zoneId: 'dev', x: -1.55, y: 0, z: -1.48, rotY: 0, scale: 1.05 },
  { file: 'bookcaseClosed', zoneId: 'dev', x: -0.35, y: 0, z: -1.48, rotY: 0, scale: 1.05 },
  { file: 'cardboardBoxClosed', zoneId: 'dev', x: 0.4, y: 0, z: -1.46, rotY: 0.3, scale: 1.4 },
  { file: 'cardboardBoxClosed', zoneId: 'dev', x: 0.95, y: 0, z: -1.42, rotY: -0.2, scale: 1.4 },

  { file: 'loungeSofa', zoneId: 'done', ...LOUNGE.sofa },
  { file: 'loungeChair', zoneId: 'done', ...LOUNGE.chair },
  { file: 'loungeSofaOttoman', zoneId: 'done', ...LOUNGE.ottoman },
  { file: 'tableCoffee', zoneId: 'done', ...LOUNGE.table },
  { file: 'cabinetTelevisionDoors', zoneId: 'done', ...LOUNGE.tv },
  { file: 'lampRoundFloor', zoneId: 'done', ...LOUNGE.lamp },

  { file: 'bookcaseClosedWide', zoneId: 'aborted', x: -0.35, y: 0, z: -1.48, rotY: 0, scale: 1.05 },
  { file: 'cardboardBoxOpen', zoneId: 'aborted', x: -1.45, y: 0, z: -1.32, rotY: 0.4, scale: 1.3 },
  { file: 'cardboardBoxOpen', zoneId: 'aborted', x: 0.7, y: 0, z: -1.28, rotY: -0.3, scale: 1.3 },

  { file: 'cabinetTelevisionDoors', zoneId: 'debug', x: -0.85, y: 0, z: -1.45, rotY: 0, scale: 1.2 },
  { file: 'cabinetBedDrawer', zoneId: 'debug', x: 0.35, y: 0, z: -1.48, rotY: 0, scale: 1.35 },
  { file: 'cabinetBedDrawer', zoneId: 'debug', x: 0.85, y: 0, z: -1.48, rotY: 0, scale: 1.35 },

  { file: 'lampRoundFloor', zoneId: 'devops', x: -1.45, y: 0, z: -1.15, rotY: 0, scale: 1.15 },

  { file: 'coatRackStanding', zoneId: 'escalation', x: -1.45, y: 0, z: -1.35, rotY: 0, scale: 1.1 },
  { file: 'sideTable', zoneId: 'escalation', x: 0.15, y: 0, z: -1.42, rotY: 0, scale: 1.15 },

  { file: 'cardboardBoxClosed', zoneId: 'blocked', x: -1.15, y: 0, z: -1.46, rotY: 0.2, scale: 1.45 },
  { file: 'cardboardBoxClosed', zoneId: 'blocked', x: -1.12, y: 0.41, z: -1.44, rotY: -0.25, scale: 1.2 },
  { file: 'cardboardBoxOpen', zoneId: 'blocked', x: 0.45, y: 0, z: -1.35, rotY: 0.35, scale: 1.3 },

  { file: 'trashcan', zoneId: 'rejected', x: 0.35, y: 0, z: -1.32, rotY: 0, scale: 1.2 },
  { file: 'cardboardBoxOpen', zoneId: 'rejected', x: -1.3, y: 0, z: -1.4, rotY: 0.2, scale: 1.3 },
];

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
    stamp.scale.setScalar(placement.scale);
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
