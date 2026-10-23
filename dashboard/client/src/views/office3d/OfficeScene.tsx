import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PMREMGenerator,
  ShaderMaterial,
  Vector3,
} from 'three';
import { ZONES } from '../commandZones';
import { OfficeCharacterView } from './OfficeCharacterView';
import { DecorMeshes, loadDecorGeometries, type DecorGeometries } from './officeDecor';
import { SCENE, FLOOR_TOP, ROOM_D, ROOM_W, WALL_H, WALL_T, placeBeside, type DeskRowMap, type ScreenBox } from './officeLook';
import { READOUT_ROOMS, layoutNames, pickFocus, placeCardClear, placeReadout, visibleReadouts, type NameItem } from './officeLabels';
import { buildOfficePoses, neonRuns, selectionAnchor, type NeonRun, type Pose } from './officeLayout';
import { heapPieceCount } from './officeAborted';
import { BAR_COLOR, boardBars } from './officeBlocked';
import { QueueBars } from './officeBlockedView';
import { AbortedHeap } from './officeAbortedView';
import { LOUNGE, LOUNGE_LAMP_EMISSIVE } from './officeLounge';
import { LoungeMeshes } from './officeLoungeView';
import { queueBoxCount } from './officeReception';
import { QueueShelf } from './officeReceptionView';
import {
  MONITOR_EMISSIVE, NIGHT, OFFICE_AIM, REVIEW_WALL_EMISSIVE, poolItems, rimItems, roomGlows, shadeEmissiveFor, splitLampPoses,
} from './officeNight';
import { GlowInstances, NightPost, NightPulse, RoomSpots, flatPlane, poolMaterial, radialTexture } from './officeNightView';
import { applyInstancePoses, isClick } from './officePick';
import { loadOfficeParts, type OfficeParts, type PartName } from './officeProps';
import { ROOM_LAYOUT, tasksInZone, type OfficeSelection, type OfficeTask, type OfficeZoneStats } from './officeSelection';

function statusMaterial(intensity: number, albedo = '#ffffff'): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: albedo,
    emissive: '#ffffff',
    emissiveIntensity: intensity,
    roughness: 0.78,
    metalness: 0,
  });
  material.customProgramCacheKey = () => 'office-status-emissive';
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       #if defined( USE_COLOR )
         totalEmissiveRadiance *= vColor.rgb;
       #endif`,
    );
  };
  return material;
}

function paintCursor(event: ThreeEvent<PointerEvent>, cursor: string) {
  const target = event.nativeEvent.target;
  if (target instanceof HTMLElement) target.style.cursor = cursor;
}

function Instances({
  geometry,
  material,
  poses,
  castShadow = false,
  receiveShadow = false,
  onPick,
  onHover,
}: {
  geometry: BufferGeometry | null;
  material: MeshStandardMaterial;
  poses: Pose[];
  castShadow?: boolean;
  receiveShadow?: boolean;
  onPick: (pose: Pose) => void;
  onHover: (pose: Pose | null) => void;
}) {
  const ref = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    applyInstancePoses(mesh, poses, matrix);
  }, [poses, geometry, matrix]);
  if (!geometry || poses.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, poses.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      frustumCulled={false}
      onClick={(event) => {
        event.stopPropagation();
        if (!isClick(event.delta)) return;
        const pose = poses[event.instanceId ?? 0];
        if (pose) onPick(pose);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        paintCursor(event, 'pointer');
        const pose = poses[event.instanceId ?? 0];
        if (pose) onHover(pose);
      }}
      onPointerOut={(event) => {
        paintCursor(event, 'auto');
        onHover(null);
      }}
    />
  );
}

function neonGeometry(runs: NeonRun[]): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const brights: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const tint = new Color();
  let along = 0;
  for (const run of runs) {
    const dx = run.x2 - run.x1;
    const dz = run.z2 - run.z1;
    const len = Math.hypot(dx, dz) || 1;
    const half = run.spine ? 0.1 : 0.065;
    const nx = (-dz / len) * half;
    const nz = (dx / len) * half;
    const y = 0.06;
    const base = positions.length / 3;
    const corners: Array<[number, number, number]> = [
      [run.x1 + nx, y, run.z1 + nz],
      [run.x1 - nx, y, run.z1 - nz],
      [run.x2 - nx, y, run.z2 - nz],
      [run.x2 + nx, y, run.z2 + nz],
    ];
    tint.set(run.color);
    corners.forEach((corner, index) => {
      positions.push(corner[0], corner[1], corner[2]);
      colors.push(tint.r, tint.g, tint.b);
      brights.push(run.bright ? 1 : 0);
      const u = index === 2 || index === 3 ? along + len : along;
      const v = index === 1 || index === 2 ? 1 : 0;
      uvs.push(u, v);
    });
    along += len;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aBright', new Float32BufferAttribute(brights, 1));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function recolor(poses: Pose[], color: string): Pose[] {
  return poses.map((pose) => ({ ...pose, color }));
}

function flickerAt(base: number, animate: boolean, time: number): number {
  return animate ? base * (0.86 + 0.14 * Math.sin(time * 6.4)) : base;
}

function Studio({ animate, flicker, wallScreen, led, neon }: {
  animate: boolean;
  flicker: MeshStandardMaterial;
  wallScreen: MeshStandardMaterial;
  led: MeshStandardMaterial;
  neon: ShaderMaterial;
}) {
  const { gl, scene, invalidate } = useThree();
  useEffect(() => {
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = PCFShadowMap;
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.12;
    room.dispose();
    pmrem.dispose();
    invalidate();
    return () => {
      env.dispose();
      scene.environment = null;
    };
  }, [gl, scene, invalidate]);
  useFrame((state) => {
    const time = animate ? state.clock.elapsedTime : 0;
    flicker.emissiveIntensity = flickerAt(MONITOR_EMISSIVE, animate, time);
    wallScreen.emissiveIntensity = flickerAt(REVIEW_WALL_EMISSIVE, animate, time);
    const blink = !animate || led.userData.steady === true
      ? 0.7
      : (Math.sin(time * 8) > 0 ? 0.95 : 0.12);
    led.emissiveIntensity = led.userData.dark === true ? 0.02 : blink;
    neon.uniforms.uTime.value = time;
    neon.uniforms.uMove.value = animate ? 1 : 0;
    if (import.meta.env.DEV) {
      const stage = gl.domElement;
      stage.dataset.drawCalls = String(gl.info.render.calls);
      stage.dataset.frame = String((Number(stage.dataset.frame) || 0) + 1);
    }
  });
  return null;
}

function CameraRig({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const next = new OrbitControls(camera, gl.domElement);
    next.target.set(OFFICE_AIM[0], OFFICE_AIM[1], OFFICE_AIM[2]);
    next.enableDamping = !reducedMotion;
    next.dampingFactor = 0.08;
    next.enablePan = true;
    next.minPolarAngle = 0.45;
    next.maxPolarAngle = Math.PI / 2.2;
    next.minZoom = 12;
    next.maxZoom = 70;
    const onChange = () => invalidate();
    next.addEventListener('change', onChange);
    next.update();
    controls.current = next;
    invalidate();
    return () => {
      next.removeEventListener('change', onChange);
      next.dispose();
      controls.current = null;
    };
  }, [camera, gl, invalidate, reducedMotion]);
  useFrame(() => {
    controls.current?.update();
  });
  return null;
}

/** Space kept either side of a name for its count chip, which hangs off the name's right edge. */
const CHIP_ROOM = 24;

function setShown(el: HTMLElement, shown: boolean) {
  const value = shown ? '1' : '0';
  if (el.dataset.show !== value) el.dataset.show = value;
}

function ProjectOverlays({
  root,
  selection,
  tasks,
  stats,
  rows,
  tvHot,
}: {
  root: React.RefObject<HTMLElement | null>;
  selection: OfficeSelection | null;
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  rows: DeskRowMap | null;
  tvHot: boolean;
}) {
  const { camera } = useThree();
  const scratch = useMemo(() => new Vector3(), []);
  const labels = useRef(new Map<string, { el: HTMLElement; w: number; h: number }>());
  const card = useRef<{ el: HTMLElement; w: number; h: number } | null>(null);
  const focus = useRef<string | null>(null);
  const selectionKey = selection
    ? `${selection.kind}:${selection.zoneId}:${selection.kind === 'desk' ? selection.taskId ?? '' : ''}`
    : '';
  const seenKey = useRef(selectionKey);
  if (seenKey.current !== selectionKey) {
    seenKey.current = selectionKey;
    card.current = null;
  }
  useFrame(() => {
    const host = root.current;
    if (!host) return;
    const viewW = host.clientWidth;
    const viewH = host.clientHeight;
    const view = { w: viewW, h: viewH };
    const remember = (el: HTMLElement) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      return w > 0 && h > 0 ? { el, w, h } : null;
    };
    for (const zone of ZONES) {
      if (labels.current.has(zone.id)) continue;
      const el = host.querySelector<HTMLElement>(`[data-label="${zone.id}"]`);
      const size = el ? remember(el) : null;
      if (size) labels.current.set(zone.id, size);
    }
    const cardEl = host.querySelector<HTMLElement>('[data-card]');
    if (!cardEl) card.current = null;
    else if (card.current?.el !== cardEl) {
      const size = remember(cardEl);
      if (size) card.current = size;
    }
    const project = (x: number, y: number, z: number) => {
      scratch.set(x, y, z).project(camera);
      return {
        x: (scratch.x * 0.5 + 0.5) * viewW,
        y: (-scratch.y * 0.5 + 0.5) * viewH,
      };
    };
    const roomBox = (layout: { x: number; z: number }): ScreenBox => {
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const x of [layout.x - ROOM_W / 2, layout.x + ROOM_W / 2]) {
        for (const y of [FLOOR_TOP, FLOOR_TOP + WALL_H]) {
          for (const z of [layout.z - ROOM_D / 2, layout.z + ROOM_D / 2]) {
            const point = project(x, y, z);
            left = Math.min(left, point.x);
            right = Math.max(right, point.x);
            top = Math.min(top, point.y);
            bottom = Math.max(bottom, point.y);
          }
        }
      }
      return { left, top, right, bottom };
    };
    const boxes = new Map<string, ScreenBox>();
    for (const zone of ZONES) {
      const layout = ROOM_LAYOUT[zone.id];
      if (layout) boxes.set(zone.id, roomBox(layout));
    }

    const nameItems: NameItem[] = [];
    ZONES.forEach((zone, order) => {
      const item = labels.current.get(zone.id);
      const layout = ROOM_LAYOUT[zone.id];
      if (!item || !layout) return;
      const point = project(layout.x, 1.7, layout.z);
      const chip = item.el.dataset.chip != null;
      nameItems.push({
        id: zone.id,
        cx: point.x,
        y: point.y,
        w: item.w + (chip ? CHIP_ROOM * 2 : 0),
        h: item.h,
        busy: (stats.get(zone.id)?.count ?? 0) > 0,
        order,
      });
    });
    const names = layoutNames(nameItems, view);
    const nameBoxes: ScreenBox[] = [];
    for (const entry of nameItems) {
      const item = labels.current.get(entry.id);
      if (!item) continue;
      const at = names.get(entry.id);
      const hidden = item.el.style.visibility === 'hidden';
      if (!at) {
        if (!hidden) item.el.style.visibility = 'hidden';
        continue;
      }
      if (hidden) item.el.style.visibility = '';
      const left = at.x + (entry.w - item.w) / 2;
      item.el.style.transform = `translate(${left}px, ${at.y}px)`;
      nameBoxes.push({ left: at.x, top: at.y, right: at.x + entry.w, bottom: at.y + entry.h });
    }

    const centres = ZONES.flatMap((zone) => {
      const box = boxes.get(zone.id);
      return box ? [{ id: zone.id, x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }] : [];
    });
    focus.current = pickFocus({ zoom: camera.zoom, view, rooms: centres, prev: focus.current });
    const shown = visibleReadouts({ focus: focus.current, selection, tvHot });

    const placeFor = (roomId: string, taken: ScreenBox[], cardBox: ScreenBox | null): ScreenBox | null => {
      const el = host.querySelector<HTMLElement>(`[data-readout="${roomId}"]`);
      if (!el) return null;
      const own = boxes.get(roomId);
      const visible = shown.has(roomId);
      setShown(el, visible && own != null);
      if (!visible || !own || el.offsetWidth <= 0) return null;
      const size = { w: el.offsetWidth, h: el.offsetHeight };
      const others = ZONES.flatMap((zone) => (zone.id !== roomId && boxes.get(zone.id)) || []);
      const at = placeReadout({ size, view, focus: own, names: taken, card: cardBox, rooms: others });
      el.style.transform = `translate(${at.x}px, ${at.y}px)`;
      return { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    };

    // The card keeps its own placement and readouts step around it, except the Blocked readout while a
    // task is selected: that list stays put and the card is placed clear of it.
    const taken = [...nameBoxes];
    const first = shown.has('blocked') && selection ? 'blocked' : null;
    const firstBox = first ? placeFor(first, taken, null) : null;
    if (firstBox) taken.push(firstBox);
    let cardBox: ScreenBox | null = null;
    const selected = card.current;
    const layout = selection ? ROOM_LAYOUT[selection.zoneId] : undefined;
    if (selected && layout) {
      let anchorBox: ScreenBox = roomBox(layout);
      if (selection?.zoneId === 'done' && selection.kind === 'desk') {
        const anchor = selectionAnchor(selection, tasks, stats, rows);
        if (anchor) {
          const point = project(anchor[0], anchor[1], anchor[2]);
          anchorBox = { left: point.x - 16, top: point.y - 16, right: point.x + 16, bottom: point.y + 16 };
        }
      }
      const next = firstBox
        ? placeCardClear({ anchor: anchorBox, view, size: { w: selected.w, h: selected.h }, avoid: [firstBox] })
        : placeBeside(anchorBox, viewW, viewH, selected.w, selected.h);
      selected.el.style.transform = `translate(${next.x}px, ${next.y}px)`;
      cardBox = { left: next.x, top: next.y, right: next.x + selected.w, bottom: next.y + selected.h };
    }

    for (const roomId of READOUT_ROOMS) {
      if (roomId === first) continue;
      const box = placeFor(roomId, taken, cardBox);
      if (box) taken.push(box);
    }
  });
  return null;
}

export function OfficeScene({
  tasks,
  stats,
  selection,
  onSelect,
  reducedMotion,
  animate,
  settled,
  labelRoot,
  devopsActive,
  deskRows = null,
  onDeskRows,
  closedToday = 0,
  tvHot = false,
  pile = 0,
  tableTaskId = null,
  streamOpen,
  awaitingReload,
  waitingOnEarth = 0,
}: {
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  selection: OfficeSelection | null;
  onSelect: (next: OfficeSelection | null) => void;
  reducedMotion: boolean;
  animate: boolean;
  /** False while the first task fetch is still in flight. Characters wait so the first snapshot sits. */
  settled: boolean;
  labelRoot: React.RefObject<HTMLElement | null>;
  devopsActive: boolean;
  deskRows?: DeskRowMap | null;
  onDeskRows?: (rows: DeskRowMap) => void;
  /** Tasks closed since local midnight. Zero keeps the lounge dark, including a failed flow. */
  closedToday?: number;
  /** A Done task is selected, so the Done readout shows highlighted at any zoom. */
  tvHot?: boolean;
  pile?: number;
  tableTaskId?: string | null;
  streamOpen: boolean;
  awaitingReload: boolean;
  /** Tasks waiting on Earth from every room. One bar of the Blocked queue board per task. */
  waitingOnEarth?: number;
}) {
  const [hover, setHover] = React.useState<Pose | null>(null);
  const [parts, setParts] = React.useState<OfficeParts | null>(null);
  const [decor, setDecor] = React.useState<DecorGeometries | null>(null);
  const [propError, setPropError] = React.useState(false);
  const poses = useMemo(
    () => buildOfficePoses(tasks, stats, selection, hover ? { zoneId: hover.zoneId, taskId: hover.taskId, kind: hover.kind } : null, deskRows),
    [tasks, stats, selection, hover, deskRows],
  );
  const geoms = useMemo(() => ({
    floor: new RoundedBoxGeometry(ROOM_W, FLOOR_TOP, ROOM_D, 2, 0.08),
    wallBack: new RoundedBoxGeometry(ROOM_W, WALL_H, WALL_T, 2, 0.04),
    wallSide: new RoundedBoxGeometry(WALL_T, WALL_H, ROOM_D, 2, 0.04),
    edge: new RoundedBoxGeometry(1, 1, 1, 1, 0.02),
    rack: new RoundedBoxGeometry(1, 1, 1, 2, 0.05),
  }), []);
  const mats = useMemo(() => ({
    screen: statusMaterial(MONITOR_EMISSIVE),
    wallScreen: statusMaterial(REVIEW_WALL_EMISSIVE, '#0e0c0a'),
    screenOff: statusMaterial(0.04),
    led: statusMaterial(0.7),
    // Lit bars of the queue board. Warm neutral white, never the amber status color.
    bars: new MeshStandardMaterial({ color: '#ffffff', emissive: BAR_COLOR, emissiveIntensity: 0.3, roughness: 0.6, metalness: 0 }),
    // Click boxes only. An invisible material is skipped by the renderer but still hit by the raycaster.
    hit: new MeshStandardMaterial({ visible: false }),
    paint: new MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, metalness: 0.04 }),
    shade: new MeshStandardMaterial({ color: SCENE.shade, emissive: SCENE.shade, emissiveIntensity: 1.4, roughness: 0.45 }),
    shadeDark: new MeshStandardMaterial({ color: SCENE.shade, emissive: SCENE.shade, emissiveIntensity: 0, roughness: 0.45 }),
    wall: new MeshStandardMaterial({ color: NIGHT.wall, roughness: 0.92, metalness: 0, side: DoubleSide }),
    wallSide: new MeshStandardMaterial({ color: NIGHT.wallSide, roughness: 0.92, metalness: 0, side: DoubleSide }),
    nightFloor: new MeshStandardMaterial({ color: NIGHT.floor, roughness: 0.82, metalness: 0 }),
    glass: new MeshStandardMaterial({
      color: SCENE.glass, transparent: true, opacity: 0.3, roughness: 0.08, metalness: 0,
      emissive: SCENE.glassEdge, emissiveIntensity: 0.06, depthWrite: false, side: DoubleSide,
    }),
    ground: new MeshStandardMaterial({ color: NIGHT.ground, roughness: 1, metalness: 0 }),
    poolSteady: poolMaterial(radialTexture()),
    poolPulse: poolMaterial(radialTexture()),
    rimSteady: new MeshBasicMaterial({ color: '#ffffff' }),
    rimPulse: new MeshBasicMaterial({ color: '#ffffff' }),
    neon: new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide,
      uniforms: { uTime: { value: 0 }, uMove: { value: 1 }, uGain: { value: 1.8 } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aBright;
        varying vec3 vColor;
        varying float vBright;
        varying float vAlong;
        void main() {
          vColor = aColor;
          vBright = aBright;
          vAlong = uv.x;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uMove;
        uniform float uGain;
        varying vec3 vColor;
        varying float vBright;
        varying float vAlong;
        void main() {
          float wave = uMove > 0.5 ? 0.72 + 0.28 * sin(vAlong * 8.0 - uTime * 2.2) : 0.85;
          gl_FragColor = vec4(vColor * (mix(0.55, 1.0, vBright) * wave) * uGain, 0.95);
        }
      `,
    }),
  }), []);
  const runs = useMemo(() => neonRuns(stats), [stats]);
  const glows = useMemo(
    () => roomGlows(stats, selection, hover?.zoneId ?? null, closedToday),
    [stats, selection, hover, closedToday],
  );
  const pools = useMemo(() => poolItems(glows), [glows]);
  const rims = useMemo(() => rimItems(glows), [glows]);
  const plane = useMemo(() => flatPlane(), []);
  const neon = useMemo(() => neonGeometry(runs), [runs]);
  const floorLampEmissive = shadeEmissiveFor('devops', stats);
  const loungeLampEmissive = closedToday > 0 ? LOUNGE_LAMP_EMISSIVE : 0;
  useEffect(() => {
    let live = true;
    loadOfficeParts()
      .then((next) => { if (live) setParts(next); })
      .catch(() => { if (live) setPropError(true); });
    loadDecorGeometries()
      .then((next) => { if (live) setDecor(next); })
      .catch(() => { if (live) setPropError(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => () => {
    for (const geometry of Object.values(geoms)) geometry.dispose();
    for (const material of Object.values(mats)) material.dispose();
  }, [geoms, mats]);
  useEffect(() => () => neon.dispose(), [neon]);
  useEffect(() => () => plane.dispose(), [plane]);
  useEffect(() => {
    mats.led.userData.dark = !devopsActive;
    mats.led.userData.steady = !animate;
  }, [mats.led, devopsActive, animate]);

  const pick = (pose: Pose) => {
    onSelect(pose.kind === 'desk'
      ? { kind: 'desk', zoneId: pose.zoneId, taskId: pose.taskId }
      : { kind: 'room', zoneId: pose.zoneId });
  };
  const part = (name: PartName) => parts?.[name] ?? null;
  const screens = [...poses.screenOn, ...poses.screenOff];
  const deskScreensOn = poses.screenOn.filter((pose) => pose.kind === 'desk');
  const deskScreensOff = poses.screenOff.filter((pose) => pose.kind === 'desk');
  const wallScreensOn = poses.screenOn.filter((pose) => pose.kind !== 'desk');
  const wallScreensOff = poses.screenOff.filter((pose) => pose.kind !== 'desk');
  const { lit: lampsLit, dark: lampsDark } = splitLampPoses(poses.lamp, stats);
  const queue = queueBoxCount(tasksInZone('inbox', tasks, stats).length);
  const heap = heapPieceCount(tasksInZone('aborted', tasks, stats).length);

  return (
    <Canvas
      frameloop={animate ? 'always' : 'demand'}
      shadows={{ type: PCFShadowMap }}
      orthographic
      dpr={reducedMotion ? 1 : [1, 1.5]}
      camera={{ position: [OFFICE_AIM[0] + 24, 20, OFFICE_AIM[2] + 20.5], zoom: 30, near: -200, far: 200 }}
      onCreated={({ camera, gl }) => {
        camera.lookAt(OFFICE_AIM[0], OFFICE_AIM[1], OFFICE_AIM[2]);
        gl.domElement.dataset.props = 'loading';
      }}
      gl={{ antialias: !reducedMotion, toneMapping: ACESFilmicToneMapping }}
      aria-label="Low-poly 3D office"
    >
      <color attach="background" args={[NIGHT.background]} />
      <ambientLight intensity={0.05} />
      <directionalLight
        position={[12, 22, 10]}
        color={NIGHT.moon}
        intensity={0.6}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-26}
        shadow-camera-right={26}
        shadow-camera-top={26}
        shadow-camera-bottom={-26}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-bias={-0.0012}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1]} receiveShadow material={mats.ground} onClick={(event) => {
        if (isClick(event.delta)) onSelect(null);
      }}>
        <planeGeometry args={[54, 44]} />
      </mesh>
      <gridHelper args={[54, 27, NIGHT.grid, NIGHT.grid]} position={[0, 0.012, 1]} />
      <Instances geometry={geoms.floor} material={mats.nightFloor} poses={recolor([...poses.floorSteady, ...poses.floorPulse], '#ffffff')} castShadow receiveShadow onPick={pick} onHover={setHover} />
      <GlowInstances geometry={plane} material={mats.poolSteady} items={pools.steady} />
      <GlowInstances geometry={plane} material={mats.poolPulse} items={pools.pulse} />
      <RoomSpots glows={glows} animate={animate} />
      <GlowInstances geometry={geoms.edge} material={mats.rimSteady} items={rims.steady} />
      <GlowInstances geometry={geoms.edge} material={mats.rimPulse} items={rims.pulse} />
      <NightPulse materials={[mats.poolPulse, mats.rimPulse]} animate={animate} />
      <Instances geometry={geoms.wallBack} material={mats.wall} poses={recolor(poses.wallBack, '#ffffff')} onPick={pick} onHover={setHover} />
      <Instances geometry={geoms.wallSide} material={mats.wallSide} poses={recolor(poses.wallSide, '#ffffff')} onPick={pick} onHover={setHover} />
      <Instances geometry={geoms.wallSide} material={mats.glass} poses={recolor(poses.glass, '#ffffff')} onPick={pick} onHover={setHover} />
      <mesh geometry={neon} material={mats.neon} frustumCulled={false} />
      <Instances geometry={part('deskWood')} material={mats.paint} poses={poses.desk} castShadow receiveShadow onPick={pick} onHover={setHover} />
      <Instances geometry={part('deskMetal')} material={mats.paint} poses={recolor(poses.desk, SCENE.metal)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('chairMetal')} material={mats.paint} poses={recolor(poses.chair, SCENE.metal)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('chairFabric')} material={mats.paint} poses={recolor(poses.chair, SCENE.fabric)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('screenBezel')} material={mats.paint} poses={recolor(screens, SCENE.metal)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('screenPanel')} material={mats.screen} poses={deskScreensOn} onPick={pick} onHover={setHover} />
      <Instances geometry={part('screenPanel')} material={mats.wallScreen} poses={wallScreensOn} onPick={pick} onHover={setHover} />
      <Instances geometry={part('screenPanel')} material={mats.screenOff} poses={[...deskScreensOff, ...wallScreensOff]} onPick={pick} onHover={setHover} />
      <Instances geometry={part('lampMetal')} material={mats.paint} poses={recolor(poses.lamp, SCENE.metal)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('lampShade')} material={mats.shade} poses={recolor(lampsLit, '#ffffff')} onPick={pick} onHover={setHover} />
      <Instances geometry={part('lampShade')} material={mats.shadeDark} poses={recolor(lampsDark, '#ffffff')} onPick={pick} onHover={setHover} />
      <Instances geometry={part('pot')} material={mats.paint} poses={recolor(poses.plant, SCENE.wood)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('soil')} material={mats.paint} poses={recolor(poses.plant, SCENE.soil)} onPick={pick} onHover={setHover} />
      <Instances geometry={part('foliage')} material={mats.paint} poses={poses.plant} onPick={pick} onHover={setHover} />
      <Instances geometry={geoms.rack} material={mats.paint} poses={poses.rackBody} onPick={pick} onHover={setHover} />
      <Instances geometry={geoms.rack} material={mats.led} poses={poses.rackLed} onPick={pick} onHover={setHover} />
      <Instances geometry={geoms.edge} material={mats.hit} poses={poses.benchHit} onPick={pick} onHover={setHover} />
      <QueueBars lit={boardBars(waitingOnEarth)} geometry={geoms.rack} material={mats.bars} reducedMotion={reducedMotion} />
      {decor && (
        <DecorMeshes
          geometries={decor}
          shadeEmissive={floorLampEmissive}
          loungeShadeEmissive={loungeLampEmissive}
        />
      )}
      <LoungeMeshes
        pile={pile}
        tableTaskId={tableTaskId}
        selectedTaskId={selection?.kind === 'desk' ? selection.taskId : null}
        onSelect={onSelect}
      />
      <QueueShelf count={queue} />
      <AbortedHeap pieces={heap} />
      <OfficeCharacterView tasks={tasks} stats={stats} animate={animate} reducedMotion={reducedMotion} settled={settled} streamOpen={streamOpen} awaitingReload={awaitingReload} onDeskRows={onDeskRows} />
      <Studio animate={animate} flicker={mats.screen} wallScreen={mats.wallScreen} led={mats.led} neon={mats.neon} />
      <CameraRig reducedMotion={reducedMotion} />
      <ProjectOverlays root={labelRoot} selection={selection} tasks={tasks} stats={stats} rows={deskRows} tvHot={tvHot} />
      <ReadyFlag ready={parts != null && decor != null} failed={propError} />
      <NightPost />
    </Canvas>
  );
}

function ReadyFlag({ ready, failed }: { ready: boolean; failed: boolean }) {
  const { gl, invalidate } = useThree();
  useEffect(() => {
    gl.domElement.dataset.props = failed ? 'error' : ready ? 'ready' : 'loading';
    invalidate();
  }, [gl, ready, failed, invalidate]);
  return null;
}
