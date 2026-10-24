import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { InstancedMesh, MeshStandardMaterial, Object3D, type BufferGeometry } from 'three';
import { loadPropGeometry } from './officeDecor';
import { FLOOR_TOP, SCENE } from './officeLook';
import { queueSlots } from './officeReception';
import { ROOM_LAYOUT } from './officeSelection';

const dummy = new Object3D();
const BOX_SCALE = 0.72;

/** Waiting boxes on the Inbox shelf. One instanced mesh, absent when the desks cover the queue. */
export function QueueShelf({ count }: { count: number }) {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);
  const meshRef = useRef<InstancedMesh>(null);
  const slots = useMemo(() => queueSlots(count), [count]);
  const layout = ROOM_LAYOUT.inbox;
  useEffect(() => {
    let live = true;
    loadPropGeometry('cardboardBoxClosed')
      .then((next) => { if (live) setGeometry(next); })
      .catch(() => { if (live) setGeometry(null); });
    return () => { live = false; };
  }, []);
  const material = useMemo(() => new MeshStandardMaterial({
    color: SCENE.wood, roughness: 0.8, metalness: 0.04,
  }), []);
  useEffect(() => () => material.dispose(), [material]);
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    slots.forEach((slot, index) => {
      dummy.position.set(layout.x + slot.x, FLOOR_TOP + slot.y, layout.z + slot.z);
      dummy.rotation.set(0, slot.rotY, 0);
      dummy.scale.setScalar(BOX_SCALE);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [geometry, layout, slots]);
  if (!geometry || slots.length === 0) return null;
  return (
    <instancedMesh
      key={slots.length}
      ref={meshRef}
      args={[geometry, material, slots.length]}
      frustumCulled={false}
      castShadow
      receiveShadow
      raycast={() => undefined}
    />
  );
}
