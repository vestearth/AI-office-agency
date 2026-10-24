import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { InstancedMesh, Matrix4, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { BAR_CAP, BLINK_STEPS, BLINK_STEP_MS, litBars } from './officeBlocked';
import { barPoses } from './officeLayout';
import { applyInstancePoses } from './officePick';

/**
 * The queue board's bars: one lit bar per task waiting on Earth, up to `BAR_CAP`. When the count
 * drops, the bar that went out blinks a few times first (not under reduced motion). The board has no
 * text, and the bars are not clickable, so this is one draw call and no raycast target.
 */
export function QueueBars({
  lit,
  geometry,
  material,
  reducedMotion,
}: {
  lit: number;
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  reducedMotion: boolean;
}) {
  const { invalidate } = useThree();
  const [ghosts, setGhosts] = useState(0);
  const [step, setStep] = useState(BLINK_STEPS);
  const before = useRef(lit);
  useEffect(() => {
    const dropped = before.current - lit;
    before.current = lit;
    if (dropped > 0 && !reducedMotion) {
      setGhosts(dropped);
      setStep(0);
    } else {
      setGhosts(0);
      setStep(BLINK_STEPS);
    }
  }, [lit, reducedMotion]);
  useEffect(() => {
    if (ghosts === 0 || step >= BLINK_STEPS) return undefined;
    const timer = window.setTimeout(() => setStep((current) => current + 1), BLINK_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [ghosts, step]);
  const shown = litBars(lit, ghosts, step, reducedMotion);
  const poses = useMemo(() => barPoses(shown), [shown]);
  const matrix = useMemo(() => new Matrix4(), []);
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (mesh) applyInstancePoses(mesh, poses, matrix);
    invalidate();
  }, [poses, matrix, invalidate]);
  if (poses.length === 0) return null;
  return (
    <instancedMesh
      key={poses.length}
      ref={ref}
      args={[geometry, material, Math.min(BAR_CAP, poses.length)]}
      frustumCulled={false}
      raycast={() => undefined}
    />
  );
}
