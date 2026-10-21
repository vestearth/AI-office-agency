import { Color, InstancedMesh, Matrix4, Object3D } from 'three';
import type { Pose } from './officeLayout';

const dummy = new Object3D();
const colorScratch = new Color();

function matrixOf(pose: Pose, target: Matrix4): Matrix4 {
  dummy.position.set(pose.x, pose.y, pose.z);
  dummy.rotation.set(0, pose.rotY, 0);
  dummy.scale.set(pose.sx, pose.sy, pose.sz);
  dummy.updateMatrix();
  return target.copy(dummy.matrix);
}

function colorOf(pose: Pose, target: Color): Color {
  target.set(pose.color);
  if (pose.hot) target.multiplyScalar(1.4);
  return target;
}

/** R3F reports the pointerdown-to-pointerup distance in pixels. Past 3px it is a camera drag. */
export function isClick(delta: number): boolean {
  return delta <= 3;
}

/** Writes instance matrices and refreshes the raycast sphere. Three only computes that sphere while it is null. */
export function applyInstancePoses(mesh: InstancedMesh, poses: Pose[], matrix: Matrix4): void {
  poses.forEach((pose, index) => {
    mesh.setMatrixAt(index, matrixOf(pose, matrix));
    mesh.setColorAt(index, colorOf(pose, colorScratch));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}
