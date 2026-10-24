import { describe, expect, it } from 'vitest';
import { summarizeZones } from '../commandZones';
import { DECOR_PLACEMENTS, placedDecorBucket } from './officeDecor';
import { buildOfficePoses } from './officeLayout';
import { loungeLightAllowed } from './officeLounge';
import { ROOM_LAYOUT, type OfficeTask } from './officeSelection';
import { QA_LAB, QA_LAB_COLORS, qaLabBoxes } from './officeQaLab';

const none = summarizeZones<OfficeTask>([]);

describe('Val.Failed QA lab decor', () => {
  it('swaps the trash can and the open box for the cabinet, and adds the plant', () => {
    const files = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'rejected').map((item) => item.file);
    expect(files).not.toContain('trashcan');
    expect(files).not.toContain('cardboardBoxOpen');
    expect(files).toContain('cabinetBedDrawer');
  });

  it('has the rack, board, bin, magnifier and rug as merged boxes in the three plain buckets', () => {
    const boxes = qaLabBoxes();
    const parts = new Set(boxes.map((box) => box.part));
    for (const part of ['rack', 'board', 'bin', 'magnifier', 'rug', 'table']) expect(parts).toContain(part);
    expect(boxes.every((box) => ['wood', 'metal', 'fabric'].includes(box.bucket))).toBe(true);
  });

  it('never uses a lamp-shade material, so nothing in the room glows with DevOps', () => {
    expect(qaLabBoxes().some((box) => (box.bucket as string) === 'shade' || (box.bucket as string) === 'loungeShade')).toBe(false);
    const files = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'rejected').map((item) => item.file);
    expect(files.some((file) => file.toLowerCase().includes('lamp'))).toBe(false);
    expect(placedDecorBucket('rejected', 'shade')).toBe('shade');
  });

  it('puts papers, indicator panels, checklist lines and the plant on existing per-instance meshes', () => {
    const poses = buildOfficePoses([], none, null, null);
    const mine = poses.rackBody.filter((pose) => pose.zoneId === 'rejected');
    expect(mine.length).toBe(QA_LAB.tinted.length);
    expect(new Set(mine.map((pose) => pose.color)).size).toBeGreaterThanOrEqual(4);
    const layout = ROOM_LAYOUT.rejected;
    expect(mine.every((pose) => Math.abs(pose.x - layout.x) < 2.1 && Math.abs(pose.z - layout.z) < 1.7)).toBe(true);
    expect(poses.plant.filter((pose) => pose.zoneId === 'rejected')).toHaveLength(1);
    // DevOps keeps its three racks, and the LED group (which follows DevOps) gets nothing from this room.
    expect(poses.rackBody.filter((pose) => pose.zoneId === 'devops')).toHaveLength(3);
    expect(poses.rackLed.filter((pose) => pose.zoneId === 'rejected')).toHaveLength(0);
  });

  it('adds no pose group, so the scene draws no new mesh', () => {
    expect(Object.keys(buildOfficePoses([], none, null, null)).sort()).toEqual([
      'alertEdge', 'chair', 'desk', 'floorPulse', 'floorSteady', 'glass', 'glassEdge', 'lamp', 'neon', 'plant',
      'rackBody', 'rackLed', 'screenOff', 'screenOn', 'wallBack', 'wallSide',
    ]);
  });

  it('keeps its colors muted and out of the status palette', () => {
    for (const color of Object.values(QA_LAB_COLORS)) expect(loungeLightAllowed(color)).toBe(true);
  });
});
