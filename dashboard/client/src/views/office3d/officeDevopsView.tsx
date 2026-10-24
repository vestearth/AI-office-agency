import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { InstancedMesh, Matrix4, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { initialCatchUp, onFrame, onStreamPhase } from './officeCatchUp';
import { BOARD_ROWS, BOARD_SEGMENTS, NO_LIGHTS, blinkActive, boardRows, stepLights, trainRows, visibleLit, type LightState } from './officeDevops';
import { segmentPoses } from './officeLayout';
import { applyInstancePoses } from './officePick';
import type { OfficeTask } from './officeSelection';

/**
 * The release board's lit gate segments: one instanced mesh on the Blocked board's bar material, so the
 * two boards match. It is one draw call, has no shadow and is not clickable. A gate that resolves
 * between two loads blinks once; first load, a hidden tab, a stream gap and reduced motion show the
 * board as it is, using the same catch-up guard as the Review line.
 */
export function ReleaseBoardLights({
  tasks,
  geometry,
  material,
  animate,
  reducedMotion,
  streamOpen,
  awaitingReload,
}: {
  tasks: readonly OfficeTask[];
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  animate: boolean;
  reducedMotion: boolean;
  streamOpen: boolean;
  awaitingReload: boolean;
}) {
  const { invalidate } = useThree();
  const ref = useRef<InstancedMesh>(null);
  const matrix = useMemo(() => new Matrix4(), []);
  const rows = useMemo(() => boardRows(trainRows(tasks)), [tasks]);
  const state = useRef<LightState>(NO_LIGHTS);
  const drawn = useRef('');
  const catchRef = useRef(initialCatchUp(streamOpen));
  const rowsRef = useRef(rows);
  const tasksRef = useRef(tasks);
  const awaitingRef = useRef(awaitingReload);
  const streamRef = useRef(streamOpen);
  const animateRef = useRef(animate);
  const reducedRef = useRef(reducedMotion);
  rowsRef.current = rows;
  tasksRef.current = tasks;
  awaitingRef.current = awaitingReload;
  streamRef.current = streamOpen;
  animateRef.current = animate;
  reducedRef.current = reducedMotion;

  useEffect(() => {
    if (!animate) catchRef.current = { ...catchRef.current, armed: true };
  }, [animate]);
  useEffect(() => {
    const step = onStreamPhase(catchRef.current, streamOpen);
    catchRef.current = { ...step.state, awaitingReload: awaitingRef.current };
  }, [streamOpen]);

  const draw = (now: number) => {
    const mesh = ref.current;
    if (!mesh) return;
    const keys = visibleLit(state.current, now);
    const signature = `${rowsRef.current.map((row) => row.taskId).join(',')}#${keys.join('|')}`;
    if (signature === drawn.current) return;
    drawn.current = signature;
    const poses = segmentPoses(keys, tasksRef.current);
    applyInstancePoses(mesh, poses, matrix);
    mesh.count = poses.length;
    mesh.visible = poses.length > 0;
    invalidate();
  };

  // A data round places the lights at once when nothing animates (hidden tab, reduced motion).
  useLayoutEffect(() => {
    if (!animate || reducedMotion) {
      state.current = stepLights(state.current, rows, { snap: true, now: performance.now() });
      draw(performance.now());
    }
    invalidate();
  }, [rows, animate, reducedMotion, invalidate]);

  useFrame(() => {
    const now = performance.now();
    catchRef.current = { ...catchRef.current, awaitingReload: awaitingRef.current };
    const frame = onFrame(catchRef.current, animateRef.current, streamRef.current);
    catchRef.current = frame.state;
    const snap = frame.snap || reducedRef.current;
    state.current = stepLights(state.current, rowsRef.current, { snap, now });
    // Redraw when a gate changed, and keep drawing through the blink.
    draw(now);
    if (blinkActive(state.current, now)) invalidate();
  });

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, BOARD_ROWS * BOARD_SEGMENTS]}
      frustumCulled={false}
      raycast={() => undefined}
      visible={false}
    />
  );
}
