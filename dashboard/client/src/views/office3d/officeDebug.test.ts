import { describe, expect, it } from 'vitest';
import { summarizeZones } from '../commandZones';
import { SLOT_Z_OFFSET } from './officeCharacters';
import {
  CLINIC_COLORS, DEBUG_LAB, LOOP_ROUND, ROUND_TAG_CAP, ROUND_TAG_RUN, ROUND_TAG_SIZE, roundTagBoxes, type ClinicBox,
} from './officeDebug';
import { DECOR_PLACEMENTS, debugFixtures } from './officeDecor';
import { DEVOPS } from './officeDevops';
import { buildOfficePoses } from './officeLayout';
import { DESK_Z, FLOOR_TOP, ROOM_D, ROOM_W, WALL_H, deskLocalX } from './officeLook';
import { loungeLightAllowed } from './officeLounge';
import { FRONT_OUTSET } from './officeMove';
import { ROOM_LAYOUT, officeTasksFromApi, type OfficeTask } from './officeSelection';

const debugTask = (taskId: string, debugRounds?: number, phase: OfficeTask['phase'] = 'debugging'): OfficeTask => ({
  taskId,
  title: taskId,
  phase,
  status: 'running',
  needsReview: false,
  updatedAt: `2026-10-24T00:0${taskId.length % 10}:00Z`,
  ...(debugRounds === undefined ? {} : { debugRounds }),
});

const posesFor = (tasks: OfficeTask[], rows?: Parameters<typeof buildOfficePoses>[4]) =>
  buildOfficePoses(tasks, summarizeZones(tasks), null, null, rows);
type Poses = ReturnType<typeof posesFor>;
/** The clinic's own-color pieces: Debug Lab room instances on the rack mesh (no mesh of their own). */
const clinicPoses = (poses: Poses) => poses.rackBody.filter((pose) => pose.zoneId === 'debug' && pose.kind === 'room');
/** Round tags with their posts and rails: Debug Lab desk instances on the rack mesh. */
const tagPoses = (poses: Poses) => poses.rackBody.filter((pose) => pose.zoneId === 'debug' && pose.kind === 'desk');

/** The DevOps rack as it was before the control room: three tiers at x 1.15, 0.32 from the back wall. */
const ORIGINAL_RACK_TIERS = [0, 1, 2].map((tier) => ({
  x: ROOM_LAYOUT.devops.x + 1.15,
  y: FLOOR_TOP + 0.18 + tier * 0.38,
  z: ROOM_LAYOUT.devops.z - ROOM_D / 2 + 0.42,
  size: [0.72, 0.3, 0.32],
}));
const devopsRackTiers = (poses: Poses) => poses.rackBody
  .filter((pose) => pose.zoneId === 'devops' && Math.abs(pose.x - (ROOM_LAYOUT.devops.x + DEVOPS.racks[0].x)) < 1e-9 && pose.sx === 0.72 && pose.sz === 0.32)
  .map((pose) => ({ x: pose.x, y: pose.y, z: pose.z, size: [pose.sx, pose.sy, pose.sz] }));

const DESK_HALF_X = (0.7345 * 1.15) / 2;
const DESK_HALF_Z = (0.3923 * 1.15) / 2;
/** About half a robot's width: a walk keeps this far from any clinic piece. */
const WALK_CLEARANCE = 0.2;

function footprintHit(item: ClinicBox, x: number, z: number, pad: number): boolean {
  return Math.abs(x - item.x) < item.w / 2 + pad && Math.abs(z - item.z) < item.d / 2 + pad;
}

describe('Debug Lab robot clinic furniture', () => {
  const clinic = [...DEBUG_LAB.frame, ...DEBUG_LAB.pieces];

  it('has the exam table, dummy, lamp, tool tray, monitor cart, curtain and bug board', () => {
    expect(new Set(clinic.map((item) => item.part))).toEqual(
      new Set(['table', 'dummy', 'lamp', 'tray', 'cart', 'curtain', 'board']),
    );
    // The dummy, the curtain panels, the bug silhouettes and the tray take their own colors.
    for (const part of ['dummy', 'curtain', 'board', 'tray'] as const) {
      expect(DEBUG_LAB.pieces.some((item) => item.part === part), part).toBe(true);
    }
    // The table frame, the lamp arm, the cart and the board backing are plain decor.
    for (const part of ['table', 'lamp', 'cart', 'board'] as const) {
      expect(DEBUG_LAB.frame.some((item) => item.part === part), part).toBe(true);
    }
  });

  it('no longer has the TV cabinet or the drawer cabinets', () => {
    const files = DECOR_PLACEMENTS.filter((item) => item.zoneId === 'debug').map((item) => item.file);
    expect(files).not.toContain('cabinetTelevisionDoors');
    expect(files).not.toContain('cabinetBedDrawer');
    expect(files).toEqual([]);
  });

  it('never uses the lamp-shade material, so nothing glows with DevOps', () => {
    expect(DECOR_PLACEMENTS.filter((item) => item.zoneId === 'debug' && item.file.startsWith('lamp'))).toEqual([]);
    expect(DEBUG_LAB.frame.every((item) => ['wood', 'metal', 'fabric'].includes(item.bucket))).toBe(true);
    const fixtures = debugFixtures();
    expect(Object.keys(fixtures).sort()).toEqual(['fabric', 'metal', 'wood']);
    const merged = Object.values(fixtures).reduce((sum, list) => sum + (list?.length ?? 0), 0);
    expect(merged).toBe(DEBUG_LAB.frame.length);
  });

  it('places the merged frames in the Debug Lab room, in world space', () => {
    const layout = ROOM_LAYOUT.debug;
    for (const list of Object.values(debugFixtures())) {
      for (const geometry of list ?? []) {
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!;
        expect(bounds.min.x).toBeGreaterThanOrEqual(layout.x - ROOM_W / 2);
        expect(bounds.max.x).toBeLessThanOrEqual(layout.x + ROOM_W / 2);
        expect(bounds.min.z).toBeGreaterThanOrEqual(layout.z - ROOM_D / 2);
        expect(bounds.max.z).toBeLessThanOrEqual(layout.z + ROOM_D / 2);
        expect(bounds.min.y).toBeGreaterThanOrEqual(FLOOR_TOP - 1e-6);
      }
    }
  });

  it('keeps every piece inside the room, under the wall top and off the desk row', () => {
    for (const item of clinic) {
      expect(Math.abs(item.x) + item.w / 2, item.part).toBeLessThanOrEqual(ROOM_W / 2);
      expect(Math.abs(item.z) + item.d / 2, item.part).toBeLessThanOrEqual(ROOM_D / 2);
      expect(item.y - item.h / 2, item.part).toBeGreaterThanOrEqual(-1e-6);
      expect(item.y + item.h / 2, item.part).toBeLessThanOrEqual(WALL_H);
    }
    for (let count = 1; count <= 4; count += 1) {
      for (let index = 0; index < count; index += 1) {
        const x = deskLocalX(index, count);
        for (const item of clinic) {
          const overlapX = Math.abs(item.x - x) < item.w / 2 + DESK_HALF_X;
          const overlapZ = Math.abs(item.z - DESK_Z) < item.d / 2 + DESK_HALF_Z;
          expect(overlapX && overlapZ, `${item.part} on desk ${index + 1}/${count}`).toBe(false);
        }
      }
    }
  });

  it('keeps the walk from the room front to every desk seat clear of the clinic', () => {
    const door = { x: 0, z: ROOM_D / 2 + FRONT_OUTSET };
    for (let count = 1; count <= 4; count += 1) {
      for (let index = 0; index < count; index += 1) {
        const seat = { x: deskLocalX(index, count), z: DESK_Z + SLOT_Z_OFFSET };
        for (let step = 0; step <= 40; step += 1) {
          const t = step / 40;
          const x = door.x + (seat.x - door.x) * t;
          const z = door.z + (seat.z - door.z) * t;
          for (const item of clinic) {
            expect(footprintHit(item, x, z, WALK_CLEARANCE), `${item.part} on the walk to desk ${index + 1}/${count}`).toBe(false);
          }
        }
      }
    }
  });

  it('draws the colored pieces as Debug Lab room instances', () => {
    const poses = posesFor([]);
    expect(clinicPoses(poses)).toHaveLength(DEBUG_LAB.pieces.length);
    const dummy = DEBUG_LAB.pieces.find((item) => item.part === 'dummy')!;
    const first = clinicPoses(poses)[DEBUG_LAB.pieces.indexOf(dummy)];
    expect(first.x).toBeCloseTo(ROOM_LAYOUT.debug.x + dummy.x);
    expect(first.y).toBeCloseTo(FLOOR_TOP + dummy.y);
    expect(first.z).toBeCloseTo(ROOM_LAYOUT.debug.z + dummy.z);
    expect([first.sx, first.sy, first.sz]).toEqual([dummy.w, dummy.h, dummy.d]);
    expect(first.color).toBe(dummy.color);
    // DevOps keeps its original three-tier rack, tier for tier (the room's other pieces ride the same mesh).
    expect(devopsRackTiers(poses)).toEqual(ORIGINAL_RACK_TIERS);
  });

  it('keeps every new color out of the status palette', () => {
    for (const [name, color] of Object.entries(CLINIC_COLORS)) expect(loungeLightAllowed(color), name).toBe(true);
  });
});

describe('Debug Lab round tags', () => {
  const tagsOf = (poses: Poses, taskId: string) =>
    tagPoses(poses).filter((pose) => pose.taskId === taskId && pose.sy === ROUND_TAG_SIZE.h);

  it('hangs one tag per round beside the task desk, from the server debugRounds', () => {
    const poses = posesFor([debugTask('ONE', 1), debugTask('FOUR', 4)]);
    expect(tagsOf(poses, 'ONE')).toHaveLength(1);
    expect(tagsOf(poses, 'FOUR')).toHaveLength(4);
    expect(new Set(tagPoses(poses).map((pose) => pose.taskId))).toEqual(new Set(['ONE', 'FOUR']));
    for (const taskId of ['ONE', 'FOUR']) {
      const desk = poses.desk.find((pose) => pose.zoneId === 'debug' && pose.taskId === taskId)!;
      const parts = tagPoses(poses).filter((pose) => pose.taskId === taskId);
      // A post, a rail and the tags, all just off the desk's -x side.
      expect(parts).toHaveLength(tagsOf(poses, taskId).length + 2);
      for (const part of parts) {
        expect(part.x).toBeLessThan(desk.x - DESK_HALF_X);
        expect(part.x).toBeGreaterThan(desk.x - 0.95 + DESK_HALF_X);
        expect(Math.abs(part.z - desk.z)).toBeLessThan(0.4);
      }
    }
  });

  it('follows the desk in the current row, not the static decor', () => {
    const tasks = [debugTask('MOVED', 2)];
    const held = posesFor(tasks, { debug: [{ taskId: 'MOVED', localX: 1.2 }] });
    const tags = tagsOf(held, 'MOVED');
    expect(tags).toHaveLength(2);
    for (const tag of tags) expect(tag.x).toBeCloseTo(ROOM_LAYOUT.debug.x + 1.2 - 0.47);
    const centred = tagsOf(posesFor(tasks), 'MOVED');
    for (const tag of centred) expect(tag.x).toBeCloseTo(ROOM_LAYOUT.debug.x - 0.47);
  });

  it('brightens from the third round on', () => {
    const poses = posesFor([debugTask('R2', 2), debugTask('R3', LOOP_ROUND), debugTask('R4', 4)]);
    expect(tagsOf(poses, 'R2').every((pose) => pose.color === CLINIC_COLORS.tag)).toBe(true);
    expect(tagsOf(poses, 'R3').every((pose) => pose.color === CLINIC_COLORS.tagLoop)).toBe(true);
    expect(tagsOf(poses, 'R4').every((pose) => pose.color === CLINIC_COLORS.tagLoop)).toBe(true);
  });

  it('draws nothing for round 0, unknown rounds, an empty room or a task in another room', () => {
    expect(tagPoses(posesFor([debugTask('ZERO', 0)]))).toEqual([]);
    expect(tagPoses(posesFor([debugTask('UNKNOWN')]))).toEqual([]);
    expect(tagPoses(posesFor([]))).toEqual([]);
    expect(tagPoses(posesFor([debugTask('REVIEW', 4, 'in_review')]))).toEqual([]);
  });

  it('keeps tags on a debugging_complete task, which still sits in the room', () => {
    expect(tagsOf(posesFor([debugTask('DONE', 2, 'debugging_complete')]), 'DONE')).toHaveLength(2);
  });

  it('caps the drawn tags and closes them up within the desk depth', () => {
    const tags = roundTagBoxes(12, 0, DESK_Z).filter((item) => item.kind === 'tag');
    expect(tags).toHaveLength(ROUND_TAG_CAP);
    const span = tags[tags.length - 1].z - tags[0].z;
    expect(span).toBeLessThanOrEqual(ROUND_TAG_RUN + 1e-9);
    const six = roundTagBoxes(6, 0, DESK_Z).filter((item) => item.kind === 'tag');
    expect(six[1].z - six[0].z).toBeCloseTo(0.08);
    // Even the longest run ends before the chair (desk z + 0.46).
    const rail = roundTagBoxes(12, 0, DESK_Z).find((item) => item.kind === 'rail')!;
    expect(rail.z + rail.d / 2).toBeLessThan(DESK_Z + 0.46 - 0.1);
  });

  it('keeps the tags of the end desks inside the room and off the clinic', () => {
    for (const index of [0, 3]) {
      const x = deskLocalX(index, 4);
      for (const item of roundTagBoxes(ROUND_TAG_CAP, x, DESK_Z)) {
        expect(Math.abs(item.x) + item.w / 2).toBeLessThan(ROOM_W / 2);
        for (const piece of [...DEBUG_LAB.frame, ...DEBUG_LAB.pieces]) {
          expect(footprintHit(piece, item.x, item.z, Math.max(item.w, item.d) / 2), piece.part).toBe(false);
        }
      }
    }
  });
});

describe('office tasks carry the debug rounds', () => {
  it('keeps debugRounds from the review read model', () => {
    const [task] = officeTasksFromApi(
      [{ taskId: 'T', title: 'T', phase: 'debugging', needsReview: false, debugRounds: 4 }],
      [],
    );
    expect(task.debugRounds).toBe(4);
  });
});
