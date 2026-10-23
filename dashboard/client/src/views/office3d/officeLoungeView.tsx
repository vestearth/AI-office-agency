import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { InstancedMesh, MeshStandardMaterial, Object3D, type BufferGeometry } from 'three';
import { FLOOR_TOP, SCENE } from './officeLook';
import { loadPropGeometry } from './officeDecor';
import { LOUNGE, LOUNGE_BOX_EMISSIVE, LOUNGE_LIGHT, pileSlots } from './officeLounge';
import { isClick } from './officePick';
import { ROOM_LAYOUT, type OfficeSelection } from './officeSelection';

const dummy = new Object3D();

/** The day's boxes and the glowing latest task. The pile is one instanced mesh. */
export function LoungeMeshes({
  pile,
  tableTaskId,
  selectedTaskId,
  onSelect,
}: {
  pile: number;
  tableTaskId: string | null;
  selectedTaskId: string | null;
  onSelect: (next: OfficeSelection) => void;
}) {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);
  const pileRef = useRef<InstancedMesh>(null);
  const slots = useMemo(() => pileSlots(pile), [pile]);
  const layout = ROOM_LAYOUT.done;
  useEffect(() => {
    let live = true;
    loadPropGeometry('cardboardBoxClosed')
      .then((next) => { if (live) setGeometry(next); })
      .catch(() => { if (live) setGeometry(null); });
    return () => { live = false; };
  }, []);
  const pileMaterial = useMemo(() => new MeshStandardMaterial({
    color: SCENE.wood, roughness: 0.8, metalness: 0.04,
  }), []);
  const glowMaterial = useMemo(() => new MeshStandardMaterial({
    color: LOUNGE_LIGHT, emissive: LOUNGE_LIGHT, emissiveIntensity: LOUNGE_BOX_EMISSIVE, roughness: 0.45,
  }), []);
  useEffect(() => () => {
    pileMaterial.dispose();
    glowMaterial.dispose();
  }, [pileMaterial, glowMaterial]);
  useLayoutEffect(() => {
    const mesh = pileRef.current;
    if (!mesh) return;
    slots.forEach((slot, index) => {
      dummy.position.set(
        layout.x + LOUNGE.pile.x + slot.x,
        FLOOR_TOP + slot.y,
        layout.z + LOUNGE.pile.z + slot.z,
      );
      dummy.rotation.set(0, slot.rotY, 0);
      dummy.scale.setScalar(1.15);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [geometry, layout, slots]);
  if (!geometry) return null;
  const hot = tableTaskId != null && selectedTaskId === tableTaskId;
  return (
    <>
      {slots.length > 0 && (
        <instancedMesh
          key={slots.length}
          ref={pileRef}
          args={[geometry, pileMaterial, slots.length]}
          frustumCulled={false}
          castShadow
          receiveShadow
          raycast={() => undefined}
        />
      )}
      {tableTaskId && (
        <mesh
          geometry={geometry}
          material={glowMaterial}
          position={[layout.x + LOUNGE.table.x, FLOOR_TOP + 0.42, layout.z + LOUNGE.table.z]}
          scale={hot ? 1.28 : 1.05}
          castShadow
          onClick={(event) => {
            event.stopPropagation();
            if (!isClick(event.delta)) return;
            onSelect({ kind: 'desk', zoneId: 'done', taskId: tableTaskId });
          }}
        />
      )}
    </>
  );
}
