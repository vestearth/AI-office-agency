import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BoxGeometry, CylinderGeometry, MeshBasicMaterial, type Mesh } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOOR_TOP } from './officeLook';
import { BEACON_COLOR, BEACON_SPEED, ESCALATION } from './officeEscalation';
import { ROOM_LAYOUT } from './officeSelection';

/**
 * The help desk's rotating beacon on the back wall: a warm white lens with a flat sweep bar, one mesh
 * and one draw call, only while a task is escalated. It never casts a shadow (a caster would add a
 * second draw call in the shadow pass). It turns slowly while `animate` is on and stays steady
 * otherwise, which is the reduced-motion and hidden-tab case.
 */
export function EscalationBeacon({ lit, animate }: { lit: boolean; animate: boolean }) {
  const { invalidate } = useThree();
  const ref = useRef<Mesh>(null);
  const geometry = useMemo(() => {
    const lens = new CylinderGeometry(0.075, 0.075, 0.13, 14);
    const bar = new BoxGeometry(0.4, 0.035, 0.05);
    const merged = mergeGeometries([lens.toNonIndexed(), bar.toNonIndexed()], false);
    lens.dispose();
    bar.dispose();
    for (const name of Object.keys(merged.attributes)) {
      if (name !== 'position') merged.deleteAttribute(name);
    }
    return merged;
  }, []);
  const material = useMemo(() => new MeshBasicMaterial({ color: BEACON_COLOR, toneMapped: false }), []);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);
  useEffect(() => {
    if (ref.current && !animate) ref.current.rotation.y = 0;
    invalidate();
  }, [animate, lit, invalidate]);
  useFrame((_, delta) => {
    if (animate && ref.current) ref.current.rotation.y += delta * BEACON_SPEED;
  });
  if (!lit) return null;
  const layout = ROOM_LAYOUT.escalation;
  return (
    <mesh
      ref={ref}
      geometry={geometry}
      material={material}
      position={[layout.x + ESCALATION.beacon.x, FLOOR_TOP + ESCALATION.beacon.y, layout.z + ESCALATION.beacon.z]}
      castShadow={false}
      receiveShadow={false}
      raycast={() => undefined}
      name="escalation-beacon"
    />
  );
}
