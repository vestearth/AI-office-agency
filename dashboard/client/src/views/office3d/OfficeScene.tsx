import React, { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ZONES, ZONE_BY_ID, zoneTone } from '../commandZones';
import {
  OFFICE_TARGET,
  ROOM_LAYOUT,
  sceneDesks,
  desksForZone,
  type OfficeSelection,
  type OfficeTask,
  type OfficeZoneStats,
} from './officeSelection';

const ROOM_W = 4.2;
const ROOM_D = 3.4;
const WALL_H = 1.2;
const WALL_T = 0.1;

function paintCursor(event: ThreeEvent<PointerEvent>, cursor: string) {
  const target = event.nativeEvent.target;
  if (target instanceof HTMLElement) target.style.cursor = cursor;
}

function DeskMesh({
  index,
  count,
  selected,
  tone,
  occupied,
  onSelect,
}: {
  index: number;
  count: number;
  selected: boolean;
  tone: string;
  occupied: boolean;
  onSelect: (event: ThreeEvent<MouseEvent>) => void;
}) {
  const gap = count > 2 ? 0.95 : 1.2;
  const x = (index - (count - 1) / 2) * gap;
  return (
    <group position={[x, 0, 0.35]}>
      <mesh
        position={[0, 0.46, 0]}
        onClick={onSelect}
        onPointerOver={(event) => paintCursor(event, 'pointer')}
        onPointerOut={(event) => paintCursor(event, 'auto')}
      >
        <boxGeometry args={[0.9, 0.08, 0.52]} />
        <meshStandardMaterial color={selected ? tone : occupied ? '#8d6b3a' : '#4b5563'} emissive={selected ? tone : '#000000'} emissiveIntensity={selected ? 0.35 : 0} />
      </mesh>
      <mesh position={[-0.32, 0.22, 0]}>
        <boxGeometry args={[0.08, 0.44, 0.08]} />
        <meshStandardMaterial color="#2c261c" />
      </mesh>
      <mesh position={[0.32, 0.22, 0]}>
        <boxGeometry args={[0.08, 0.44, 0.08]} />
        <meshStandardMaterial color="#2c261c" />
      </mesh>
      <mesh position={[0, 0.72, -0.16]}>
        <boxGeometry args={[0.4, 0.28, 0.05]} />
        <meshStandardMaterial color={occupied ? tone : '#1b2430'} emissive={occupied ? tone : '#000000'} emissiveIntensity={occupied ? 0.45 : 0} />
      </mesh>
    </group>
  );
}

function RoomMesh({
  zoneId,
  tasks,
  stats,
  selection,
  onSelect,
}: {
  zoneId: string;
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  selection: OfficeSelection | null;
  onSelect: (next: OfficeSelection) => void;
}) {
  const zone = ZONE_BY_ID.get(zoneId);
  const layout = ROOM_LAYOUT[zoneId];
  if (!zone || !layout) return null;
  const stat = stats.get(zoneId) ?? { count: 0, attention: false, active: false };
  const tone = zoneTone(zone, stat);
  const roomOn = selection?.kind === 'room' && selection.zoneId === zoneId;
  const desks = sceneDesks(desksForZone(zoneId, tasks, stats));
  const selectRoom = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect({ kind: 'room', zoneId });
  };
  return (
    <group position={[layout.x, 0, layout.z]} onClick={selectRoom}>
      <mesh position={[0, 0.06, 0]} onPointerOver={(event) => paintCursor(event, 'pointer')} onPointerOut={(event) => paintCursor(event, 'auto')}>
        <boxGeometry args={[ROOM_W, 0.12, ROOM_D]} />
        <meshStandardMaterial color={roomOn ? tone : '#1b2836'} emissive={tone} emissiveIntensity={roomOn ? 0.4 : stat.count ? 0.14 : 0.03} />
      </mesh>
      <mesh position={[0, WALL_H / 2, -ROOM_D / 2]}>
        <boxGeometry args={[ROOM_W, WALL_H, WALL_T]} />
        <meshStandardMaterial color="#314155" />
      </mesh>
      <mesh position={[-ROOM_W / 2, WALL_H / 2, 0]}>
        <boxGeometry args={[WALL_T, WALL_H, ROOM_D]} />
        <meshStandardMaterial color="#3a4a5e" />
      </mesh>
      <mesh position={[ROOM_W / 2, WALL_H / 2, 0]}>
        <boxGeometry args={[WALL_T, WALL_H, ROOM_D]} />
        <meshStandardMaterial color="#2a3848" />
      </mesh>
      <mesh position={[0, WALL_H + 0.28, -ROOM_D / 2 + 0.28]}>
        <boxGeometry args={[0.26, 0.26, 0.26]} />
        <meshStandardMaterial color={tone} emissive={tone} emissiveIntensity={0.55} />
      </mesh>
      {desks.map((desk, index) => (
        <DeskMesh
          key={desk.key}
          index={index}
          count={desks.length}
          selected={selection?.kind === 'desk' && selection.zoneId === zoneId && selection.taskId === desk.taskId}
          tone={tone}
          occupied={desk.taskId !== null}
          onSelect={(event) => {
            event.stopPropagation();
            onSelect({ kind: 'desk', zoneId, taskId: desk.taskId });
          }}
        />
      ))}
    </group>
  );
}

function CameraRig({ reducedMotion }: { reducedMotion: boolean }) {
  const { camera, gl, invalidate } = useThree();
  const controls = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const next = new OrbitControls(camera, gl.domElement);
    next.target.set(OFFICE_TARGET[0], OFFICE_TARGET[1], OFFICE_TARGET[2]);
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

export function OfficeScene({
  tasks,
  stats,
  selection,
  onSelect,
  reducedMotion,
}: {
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  selection: OfficeSelection | null;
  onSelect: (next: OfficeSelection) => void;
  reducedMotion: boolean;
}) {
  return (
    <Canvas
      frameloop="demand"
      orthographic
      dpr={reducedMotion ? 1 : [1, 1.5]}
      camera={{ position: [24, 20, 24], zoom: 30, near: -200, far: 200 }}
      onCreated={({ camera }) => {
        camera.lookAt(OFFICE_TARGET[0], OFFICE_TARGET[1], OFFICE_TARGET[2]);
      }}
      gl={{ antialias: !reducedMotion }}
      aria-label="Low-poly 3D office"
    >
      <color attach="background" args={['#0a0e14']} />
      <ambientLight intensity={0.72} />
      <directionalLight position={[14, 20, 10]} intensity={1.15} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1]}>
        <planeGeometry args={[54, 44]} />
        <meshStandardMaterial color="#10161e" />
      </mesh>
      {ZONES.map((zone) => (
        <RoomMesh key={zone.id} zoneId={zone.id} tasks={tasks} stats={stats} selection={selection} onSelect={onSelect} />
      ))}
      <CameraRig reducedMotion={reducedMotion} />
    </Canvas>
  );
}
