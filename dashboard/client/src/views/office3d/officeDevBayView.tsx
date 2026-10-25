import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Color, InstancedMesh, Object3D, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { initialCatchUp, onFrame, onStreamPhase } from './officeCatchUp';
import {
  NOTE_INSTANCE_CAP, NO_BOARD, boardActive, noteInstances, stepBoard,
  type BoardBus, type BoardSignals, type BoardState,
} from './officeDevBay';
import { FLOOR_TOP } from './officeLook';
import { isClick } from './officePick';
import { ROOM_LAYOUT, type OfficeTask } from './officeSelection';

const dummy = new Object3D();
const tint = new Color();

/**
 * Dev Bay's sticky notes and their dots: one instanced mesh with per-instance colors, not emissive and without a
 * shadow. It is driven here, frame by frame, like the DevOps board's lights, so a note can slide. This mesh is
 * the room's one extra draw call. A gate that resolves between two loads makes the task's own robot walk to the
 * board (see the bus); the note moves, or its dot inks, when the robot arrives. First load, a hidden tab, a
 * stream gap and reduced motion show the board as it is, using the same catch-up guard as the Review line.
 */
export function DevBayNotes({
  tasks,
  geometry,
  material,
  selectedTaskId,
  onPick,
  animate,
  reducedMotion,
  streamOpen,
  awaitingReload,
  bus,
}: {
  tasks: readonly OfficeTask[];
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
  animate: boolean;
  reducedMotion: boolean;
  streamOpen: boolean;
  awaitingReload: boolean;
  bus: BoardBus;
}) {
  const { invalidate } = useThree();
  const ref = useRef<InstancedMesh>(null);
  const state = useRef<BoardState>(NO_BOARD);
  const drawn = useRef('');
  const owners = useRef<(string | null)[]>([]);
  const catchRef = useRef(initialCatchUp(streamOpen));
  const tasksRef = useRef(tasks);
  const selectedRef = useRef(selectedTaskId);
  const awaitingRef = useRef(awaitingReload);
  const streamRef = useRef(streamOpen);
  const animateRef = useRef(animate);
  const reducedRef = useRef(reducedMotion);
  tasksRef.current = tasks;
  selectedRef.current = selectedTaskId;
  awaitingRef.current = awaitingReload;
  streamRef.current = streamOpen;
  animateRef.current = animate;
  reducedRef.current = reducedMotion;
  const layout = ROOM_LAYOUT.dev;

  useEffect(() => {
    if (!animate) catchRef.current = { ...catchRef.current, armed: true };
  }, [animate]);
  useEffect(() => {
    const step = onStreamPhase(catchRef.current, streamOpen);
    catchRef.current = { ...step.state, awaitingReload: awaitingRef.current };
  }, [streamOpen]);

  const draw = (now: number, force: boolean) => {
    const mesh = ref.current;
    if (!mesh) return;
    const layoutNow = state.current.layout;
    const sliding = boardActive(state.current, now);
    const signature = `${selectedRef.current ?? ''}#${layoutNow.notes.map((note) => `${note.taskId}:${note.column}:${note.row}:${note.dots.map((dot) => (dot ? 1 : 0)).join('')}`).join('|')}#${layoutNow.stacks.map((stack) => `${stack.column}x${stack.extra}`).join(',')}`;
    if (!force && !sliding && signature === drawn.current) return;
    drawn.current = signature;
    const items = noteInstances(state.current, selectedRef.current, now).slice(0, NOTE_INSTANCE_CAP);
    owners.current = items.map((item) => item.taskId);
    items.forEach((item, index) => {
      dummy.position.set(layout.x + item.x, FLOOR_TOP + item.y, layout.z + item.z);
      dummy.rotation.set(0, 0, item.rotZ);
      dummy.scale.set(item.w, item.h, item.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, tint.set(item.color));
    });
    mesh.count = items.length;
    mesh.visible = items.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  };

  // A data round places the notes at once when nothing animates (hidden tab, reduced motion).
  useLayoutEffect(() => {
    if (!animate || reducedMotion) {
      state.current = stepBoard(state.current, tasks, { snap: true, now: performance.now() }).state;
      draw(performance.now(), true);
    }
    invalidate();
  }, [tasks, animate, reducedMotion, selectedTaskId, invalidate]);

  useFrame(() => {
    const now = performance.now();
    catchRef.current = { ...catchRef.current, awaitingReload: awaitingRef.current };
    const frame = onFrame(catchRef.current, animateRef.current, streamRef.current);
    catchRef.current = frame.state;
    const snap = frame.snap || reducedRef.current;
    const signals: BoardSignals = { claimed: new Set(bus.claimed), arrived: new Set(bus.arrived), rejected: new Set(bus.rejected) };
    bus.claimed.clear();
    bus.arrived.clear();
    bus.rejected.clear();
    const step = stepBoard(state.current, tasksRef.current, { snap, now }, signals);
    state.current = step.state;
    for (const request of step.requests) bus.requests.set(request.taskId, request);
    draw(now, false);
    if (boardActive(state.current, now)) invalidate();
  });

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, NOTE_INSTANCE_CAP]}
      frustumCulled={false}
      visible={false}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        if (!isClick(event.delta)) return;
        const taskId = owners.current[event.instanceId ?? -1];
        if (taskId) onPick(taskId);
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        const target = event.nativeEvent.target;
        if (target instanceof HTMLElement && owners.current[event.instanceId ?? -1]) target.style.cursor = 'pointer';
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        const target = event.nativeEvent.target;
        if (target instanceof HTMLElement) target.style.cursor = 'auto';
      }}
    />
  );
}
