import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BoxGeometry, Color, InstancedMesh, MeshStandardMaterial, Object3D, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { initialCatchUp, onFrame, onStreamPhase } from './officeCatchUp';
import { loadPropGeometry } from './officeDecor';
import { FLOOR_TOP, SCENE } from './officeLook';
import { isClick } from './officePick';
import {
  REVIEW_LINE_CAP,
  REVIEW_SPOT_CAP,
  REVIEW_TAG_COLOR,
  stepBoxes,
  type BoxState,
  type BoxTarget,
  type ReviewBoard,
} from './officeReview';
import { ROOM_LAYOUT } from './officeSelection';

const dummy = new Object3D();
const tint = new Color();
/** Cardboard box at about 0.4 wide on the belt. */
const BOX_SCALE = 1.1;
/** Boxes the room can show: the line plus two at each of the four decided places. */
const BOX_CAP = REVIEW_LINE_CAP + 4 * REVIEW_SPOT_CAP;
/** A box lifted onto the rack, shelf or bin rises this far at mid-slide. */
const LIFT = 0.18;
const WOOD = new Color(SCENE.wood);

function tagGeometry(): BufferGeometry {
  const string = new BoxGeometry(0.012, 0.16, 0.012);
  string.translate(0, 0.08, 0);
  const plate = new BoxGeometry(0.13, 0.16, 0.02);
  plate.translate(0, -0.08, 0);
  const merged = mergeGeometries([string, plate], false);
  string.dispose();
  plate.dispose();
  return merged ?? new BoxGeometry(0.13, 0.3, 0.02);
}

/**
 * The boxes of the Review room: one instanced cardboard-box mesh for every box on the line and at
 * the decided places, and one for the plain tags over overdue boxes. Two draw calls, no shadow.
 * Boxes slide to a new place over about a second; first load, a hidden tab, a stream gap and
 * reduced motion place them with no slide.
 */
export function ReviewLine({
  board,
  animate,
  reducedMotion,
  streamOpen,
  awaitingReload,
  selectedTaskId,
  onPick,
}: {
  board: ReviewBoard;
  animate: boolean;
  reducedMotion: boolean;
  streamOpen: boolean;
  awaitingReload: boolean;
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  const { invalidate } = useThree();
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);
  const boxRef = useRef<InstancedMesh>(null);
  const tagRef = useRef<InstancedMesh>(null);
  const states = useRef(new Map<string, BoxState>());
  const order = useRef<string[]>([]);
  const catchRef = useRef(initialCatchUp(streamOpen));
  const awaitingRef = useRef(awaitingReload);
  const streamRef = useRef(streamOpen);
  const animateRef = useRef(animate);
  const reducedRef = useRef(reducedMotion);
  const selectedRef = useRef(selectedTaskId);
  awaitingRef.current = awaitingReload;
  streamRef.current = streamOpen;
  animateRef.current = animate;
  reducedRef.current = reducedMotion;
  selectedRef.current = selectedTaskId;

  const targets = useMemo<BoxTarget[]>(() => [...board.waiting, ...board.decided].flatMap((entry) => {
    const box = entry.spot?.box;
    if (!box) return [];
    const lifted = entry.spot!.kind === 'changes' || entry.spot!.kind === 'shelf' || entry.spot!.kind === 'bin';
    return [{ taskId: entry.task.taskId, x: box.x, y: box.y, z: box.z, rotY: box.rotY, lift: lifted ? LIFT : 0 }];
  }), [board]);
  const tagged = useMemo(() => new Set(board.tags.map((tag) => tag.taskId)), [board]);
  const targetsRef = useRef(targets);
  const taggedRef = useRef(tagged);
  targetsRef.current = targets;
  taggedRef.current = tagged;

  const boxMaterial = useMemo(() => new MeshStandardMaterial({ color: '#ffffff', roughness: 0.8, metalness: 0.04 }), []);
  const tagMaterial = useMemo(() => new MeshStandardMaterial({
    color: REVIEW_TAG_COLOR, emissive: REVIEW_TAG_COLOR, emissiveIntensity: 0.1, roughness: 0.6, metalness: 0,
  }), []);
  const tag = useMemo(tagGeometry, []);
  useEffect(() => () => {
    boxMaterial.dispose();
    tagMaterial.dispose();
    tag.dispose();
  }, [boxMaterial, tagMaterial, tag]);

  useEffect(() => {
    let live = true;
    loadPropGeometry('cardboardBoxClosed')
      .then((next) => { if (live) setGeometry(next); })
      .catch(() => { if (live) setGeometry(null); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!animate) catchRef.current = { ...catchRef.current, armed: true };
  }, [animate]);
  useEffect(() => {
    const step = onStreamPhase(catchRef.current, streamOpen);
    catchRef.current = { ...step.state, awaitingReload: awaitingRef.current };
  }, [streamOpen]);

  const draw = () => {
    const boxes = boxRef.current;
    const tags = tagRef.current;
    if (!boxes || !tags) return;
    const layout = ROOM_LAYOUT.review;
    const ids = [...states.current.keys()].sort();
    order.current = ids;
    ids.forEach((id, index) => {
      const state = states.current.get(id)!;
      const hot = selectedRef.current === id;
      dummy.position.set(layout.x + state.x, FLOOR_TOP + state.y, layout.z + state.z);
      dummy.rotation.set(0, state.rotY, 0);
      dummy.scale.setScalar(BOX_SCALE * (hot ? 1.12 : 1));
      dummy.updateMatrix();
      boxes.setMatrixAt(index, dummy.matrix);
      boxes.setColorAt(index, tint.copy(WOOD).multiplyScalar(hot ? 1.4 : 1));
    });
    boxes.count = ids.length;
    boxes.visible = ids.length > 0;
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    if (ids.length > 0) boxes.computeBoundingSphere();

    let shown = 0;
    for (const id of taggedRef.current) {
      const state = states.current.get(id);
      if (!state || shown >= REVIEW_LINE_CAP) continue;
      dummy.position.set(layout.x + state.x, FLOOR_TOP + state.y + 0.5, layout.z + state.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tags.setMatrixAt(shown, dummy.matrix);
      shown += 1;
    }
    tags.count = shown;
    tags.visible = shown > 0;
    tags.instanceMatrix.needsUpdate = true;
  };

  // A data round (or a click that changes the highlight) places the boxes at once when nothing animates.
  useLayoutEffect(() => {
    if (!animate || reducedMotion) {
      states.current = stepBoxes(states.current, targets, { snap: true, dt: 0 });
    }
    draw();
    invalidate();
  }, [geometry, targets, tagged, selectedTaskId, animate, reducedMotion, invalidate]);

  useFrame((_, delta) => {
    catchRef.current = { ...catchRef.current, awaitingReload: awaitingRef.current };
    const frame = onFrame(catchRef.current, animateRef.current, streamRef.current);
    catchRef.current = frame.state;
    const snap = frame.snap || reducedRef.current;
    states.current = stepBoxes(states.current, targetsRef.current, {
      snap,
      dt: animateRef.current ? Math.min(delta, 0.05) : 0,
    });
    draw();
  });

  if (!geometry) return null;
  return (
    <>
      <instancedMesh
        ref={boxRef}
        args={[geometry, boxMaterial, BOX_CAP]}
        frustumCulled={false}
        onClick={(event) => {
          event.stopPropagation();
          if (!isClick(event.delta)) return;
          const id = order.current[event.instanceId ?? -1];
          if (id) onPick(id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          const target = event.nativeEvent.target;
          if (target instanceof HTMLElement) target.style.cursor = 'pointer';
        }}
        onPointerOut={(event) => {
          const target = event.nativeEvent.target;
          if (target instanceof HTMLElement) target.style.cursor = 'auto';
        }}
      />
      <instancedMesh ref={tagRef} args={[tag, tagMaterial, REVIEW_LINE_CAP]} frustumCulled={false} raycast={() => undefined} />
    </>
  );
}
