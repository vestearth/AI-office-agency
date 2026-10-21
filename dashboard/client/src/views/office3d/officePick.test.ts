import { BoxGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Pose } from './officeLayout';
import { applyInstancePoses, isClick } from './officePick';

function poseAt(x: number, z: number): Pose {
  return {
    x,
    y: 0,
    z,
    rotY: 0,
    sx: 1,
    sy: 1,
    sz: 1,
    zoneId: 'dev',
    taskId: null,
    kind: 'desk',
    color: '#ffffff',
    hot: false,
  };
}

describe('office pointer', () => {
  it('treats a movement past 3px as a camera drag, not a selection click', () => {
    expect(isClick(0)).toBe(true);
    expect(isClick(3)).toBe(true);
    expect(isClick(4)).toBe(false);
    expect(isClick(28)).toBe(false);
  });

  it('covers a desk in the bounding sphere after its pose moves', () => {
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial();
    const mesh = new InstancedMesh(geometry, material, 1);
    const matrix = new Matrix4();
    applyInstancePoses(mesh, [poseAt(0, 0)], matrix);
    mesh.computeBoundingSphere();
    const before = mesh.boundingSphere!.clone();
    const moved = new Vector3(40, 0, 40);
    applyInstancePoses(mesh, [poseAt(moved.x, moved.z)], matrix);
    expect(before.containsPoint(moved)).toBe(false);
    expect(mesh.boundingSphere!.containsPoint(moved)).toBe(true);
    geometry.dispose();
    material.dispose();
    mesh.dispose();
  });
});
