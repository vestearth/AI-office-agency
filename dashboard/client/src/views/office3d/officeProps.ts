import {
  Box3,
  BufferGeometry,
  Mesh,
  Vector3,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type PartName =
  | 'deskWood'
  | 'deskMetal'
  | 'chairMetal'
  | 'chairFabric'
  | 'screenBezel'
  | 'screenPanel'
  | 'lampMetal'
  | 'lampShade'
  | 'pot'
  | 'soil'
  | 'foliage';

export type OfficeParts = Record<PartName, BufferGeometry>;

const FILES = ['desk', 'chairDesk', 'computerScreen', 'lampRoundTable', 'pottedPlant'] as const;

function partName(file: string, material: Material): PartName {
  const color = (material as MeshStandardMaterial).color;
  const red = color?.r ?? 0;
  const green = color?.g ?? 0;
  if (file === 'computerScreen') return green > 0.6 ? 'screenPanel' : 'screenBezel';
  if (file === 'lampRoundTable') return red > 0.9 ? 'lampShade' : 'lampMetal';
  if (file === 'pottedPlant') {
    if (green > 0.7 && red < 0.4) return 'foliage';
    if (red > 0.8) return 'pot';
    return 'soil';
  }
  if (file === 'chairDesk') return red > 0.8 ? 'chairFabric' : 'chairMetal';
  return red > 0.8 ? 'deskWood' : 'deskMetal';
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

let officeParts: Promise<OfficeParts> | null = null;

function assetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}office3d/${file}.glb`;
}

async function loadFile(file: (typeof FILES)[number]): Promise<{ file: string; parts: BufferGeometry[] }> {
  const gltf = await new GLTFLoader().loadAsync(assetUrl(file));
  gltf.scene.updateMatrixWorld(true);
  const parts: BufferGeometry[] = [];
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    parts.push(bake(mesh));
    const name = partName(file, materials[0]);
    const tagged = parts[parts.length - 1];
    tagged.userData.part = name;
  });
  centerParts(parts);
  return { file, parts };
}

async function loadOfficePartsOnce(): Promise<OfficeParts> {
  const loadedFiles = await Promise.all(FILES.map((file) => loadFile(file)));
  const buckets = new Map<PartName, BufferGeometry[]>();
  for (const { parts } of loadedFiles) {
    for (const geometry of parts) {
      const name = geometry.userData.part as PartName;
      const list = buckets.get(name) ?? [];
      list.push(geometry);
      buckets.set(name, list);
    }
  }
  const names: PartName[] = [
    'deskWood', 'deskMetal', 'chairMetal', 'chairFabric', 'screenBezel', 'screenPanel',
    'lampMetal', 'lampShade', 'pot', 'soil', 'foliage',
  ];
  const loaded = {} as OfficeParts;
  for (const name of names) {
    const list = buckets.get(name) ?? [];
    if (list.length === 0) throw new Error(`Missing office part ${name}`);
    loaded[name] = list.length === 1 ? list[0] : mergeGeometries(list, false);
  }
  return loaded;
}

/** One download per session. A rejected load is forgotten so the next visit can retry. */
export function loadOfficeParts(): Promise<OfficeParts> {
  if (!officeParts) {
    officeParts = loadOfficePartsOnce().catch((error: unknown) => {
      officeParts = null;
      throw error;
    });
  }
  return officeParts;
}
