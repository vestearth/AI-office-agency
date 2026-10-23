import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { InstancedMesh, MeshStandardMaterial, Object3D, type BufferGeometry } from 'three';
import { ABORTED_COLORS, HEAP_FILES, heapSlots, type HeapKind, type HeapSlot } from './officeAborted';
import { loadPropGeometry } from './officeDecor';
import { FLOOR_TOP, SCENE } from './officeLook';
import { ROOM_LAYOUT } from './officeSelection';

const dummy = new Object3D();
const KINDS: HeapKind[] = ['boxClosed', 'boxOpen', 'bags', 'papers'];

function HeapKindMesh({ geometry, material, slots }: { geometry: BufferGeometry; material: MeshStandardMaterial; slots: HeapSlot[] }) {
  const ref = useRef<InstancedMesh>(null);
  const layout = ROOM_LAYOUT.aborted;
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    slots.forEach((slot, index) => {
      dummy.position.set(layout.x + slot.x, FLOOR_TOP + slot.y, layout.z + slot.z);
      dummy.rotation.set(0, slot.rotY, 0);
      dummy.scale.setScalar(slot.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [geometry, layout, slots]);
  return (
    <instancedMesh
      key={slots.length}
      ref={ref}
      args={[geometry, material, slots.length]}
      frustumCulled={false}
      castShadow
      receiveShadow
      raycast={() => undefined}
    />
  );
}

/** The discard heap: one instanced mesh per piece kind, absent while a kind has no pieces. */
export function AbortedHeap({ pieces }: { pieces: number }) {
  const [geometries, setGeometries] = useState<Partial<Record<HeapKind, BufferGeometry>>>({});
  const slots = useMemo(() => heapSlots(pieces), [pieces]);
  useEffect(() => {
    let live = true;
    for (const kind of KINDS) {
      loadPropGeometry(HEAP_FILES[kind])
        .then((next) => { if (live) setGeometries((current) => ({ ...current, [kind]: next })); })
        .catch(() => undefined);
    }
    return () => { live = false; };
  }, []);
  const materials = useMemo(() => {
    const paint = (color: string) => new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.04 });
    return {
      boxClosed: paint(SCENE.wood),
      boxOpen: paint(SCENE.wood),
      bags: paint(ABORTED_COLORS.bags),
      papers: paint(ABORTED_COLORS.papers),
    } satisfies Record<HeapKind, MeshStandardMaterial>;
  }, []);
  useEffect(() => () => {
    for (const material of Object.values(materials)) material.dispose();
  }, [materials]);
  return (
    <>
      {KINDS.map((kind) => {
        const geometry = geometries[kind];
        const own = slots.filter((slot) => slot.kind === kind);
        if (!geometry || own.length === 0) return null;
        return <HeapKindMesh key={kind} geometry={geometry} material={materials[kind]} slots={own} />;
      })}
    </>
  );
}
