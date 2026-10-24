import { ZONE_BY_ID, ZONES, zoneNeedsEye, zonePreview, zoneTone } from '../commandZones';
import {
  FLOOR_TOP,
  NEON_SPINE,
  ROOM_D,
  ROOM_W,
  SCENE,
  WALL_H,
  deskLocalX,
  type DeskRowMap,
} from './officeLook';
import { BAR_CAP, BAR_COLOR, BLOCKED, blockedSeating } from './officeBlocked';
import { DEBUG_LAB, roundTagBoxes } from './officeDebug';
import { BOARD_SEGMENTS, DEVOPS, DEVOPS_COLORS, DEVOPS_TINTED, boardRows, segmentSlot, trainRows } from './officeDevops';
import { ESCALATION, escalationSeating } from './officeEscalation';
import { LOUNGE } from './officeLounge';
import { QA_LAB } from './officeQaLab';
import { REVIEW, reviewBoard } from './officeReview';
import { RECEPTION, deskZ } from './officeReception';
import { ROOM_LAYOUT, desksForZone, sceneDesks, tasksInZone, type OfficeSelection, type OfficeTask, type OfficeZoneStats } from './officeSelection';

export interface Pose {
  x: number;
  y: number;
  z: number;
  rotY: number;
  sx: number;
  sy: number;
  sz: number;
  zoneId: string;
  taskId: string | null;
  kind: 'room' | 'desk';
  color: string;
  hot: boolean;
}

export interface NeonRun {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  spine: boolean;
  bright: boolean;
  color: string;
}

export interface OfficePoses {
  floorSteady: Pose[];
  floorPulse: Pose[];
  wallBack: Pose[];
  wallSide: Pose[];
  glass: Pose[];
  glassEdge: Pose[];
  alertEdge: Pose[];
  desk: Pose[];
  chair: Pose[];
  /** Invisible per-seat click boxes on the waiting room's bench. */
  benchHit: Pose[];
  screenOn: Pose[];
  screenOff: Pose[];
  lamp: Pose[];
  plant: Pose[];
  rackBody: Pose[];
  rackLed: Pose[];
  neon: NeonRun[];
}

const SCREENS = new Set(['dev', 'debug', 'blocked', 'rejected']);
const LAMPS = new Set(['inbox']);

interface Hit {
  zoneId: string;
  taskId: string | null;
  kind: 'room' | 'desk';
}

function hotRoom(zoneId: string, selection: OfficeSelection | null, hover: Hit | null): boolean {
  if (hover?.zoneId === zoneId) return true;
  return selection?.zoneId === zoneId;
}

function hotDesk(zoneId: string, taskId: string | null, selection: OfficeSelection | null, hover: Hit | null): boolean {
  if (hover?.kind === 'desk' && hover.zoneId === zoneId && hover.taskId === taskId) return true;
  return selection?.kind === 'desk' && selection.zoneId === zoneId && selection.taskId === taskId;
}

function pose(
  x: number, y: number, z: number,
  zoneId: string,
  color: string,
  hot: boolean,
  extra?: Partial<Pose>,
): Pose {
  return {
    x, y, z, rotY: 0, sx: 1, sy: 1, sz: 1,
    zoneId, taskId: null, kind: 'room', color, hot,
    ...extra,
  };
}

function edge(x: number, y: number, z: number, sx: number, sy: number, sz: number, zoneId: string, color: string, hot: boolean): Pose {
  return pose(x, y, z, zoneId, color, hot, { sx, sy, sz });
}

/** Pull a center-to-center segment out to the room boundary so the strip sits in the aisle. */
function inset(ax: number, az: number, bx: number, bz: number, atStart: boolean): [number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const reach = Math.min(ROOM_W, ROOM_D) / 2 + 0.05;
  const sign = atStart ? 1 : -1;
  const baseX = atStart ? ax : bx;
  const baseZ = atStart ? az : bz;
  return [baseX + (dx / len) * reach * sign, baseZ + (dz / len) * reach * sign];
}

export function neonRuns(stats: OfficeZoneStats): NeonRun[] {
  const at = (id: string) => ROOM_LAYOUT[id];
  const link = (from: string, to: string, spine: boolean): NeonRun => {
    const a = at(from);
    const b = at(to);
    const [x1, z1] = inset(a.x, a.z, b.x, b.z, true);
    const [x2, z2] = inset(a.x, a.z, b.x, b.z, false);
    const count = stats.get(to)?.count ?? 0;
    return { x1, z1, x2, z2, spine, bright: count > 0, color: spine ? NEON_SPINE : SCENE.neonSpur };
  };
  return [
    link('inbox', 'dev', true),
    link('dev', 'review', true),
    link('review', 'done', true),
    link('dev', 'devops', false),
    link('review', 'escalation', false),
    link('dev', 'debug', false),
    link('dev', 'blocked', false),
    link('review', 'rejected', false),
    link('dev', 'aborted', false),
  ];
}

export function buildOfficePoses(
  tasks: OfficeTask[],
  stats: OfficeZoneStats,
  selection: OfficeSelection | null,
  hover: Hit | null,
  rows?: DeskRowMap | null,
): OfficePoses {
  const out: OfficePoses = {
    floorSteady: [], floorPulse: [], wallBack: [], wallSide: [], glass: [], glassEdge: [], alertEdge: [],
    desk: [], chair: [], benchHit: [], screenOn: [], screenOff: [], lamp: [], plant: [], rackBody: [], rackLed: [],
    neon: neonRuns(stats),
  };
  const roundsById = new Map(tasks.map((task) => [task.taskId, task.debugRounds]));
  for (const zone of ZONES) {
    const layout = ROOM_LAYOUT[zone.id];
    if (!layout) continue;
    const stat = stats.get(zone.id);
    const brief = stat ?? { count: 0, attention: false, active: false };
    const tone = zoneTone(zone, brief);
    const eye = zoneNeedsEye(zone, brief);
    const roomHot = hotRoom(zone.id, selection, hover);
    const floor = pose(layout.x, FLOOR_TOP / 2, layout.z, zone.id, tone, roomHot);
    (eye ? out.floorPulse : out.floorSteady).push(floor);
    const wallY = FLOOR_TOP + WALL_H / 2;
    out.wallBack.push(pose(layout.x, wallY, layout.z - ROOM_D / 2, zone.id, SCENE.wall, false));
    const glassRoom = zone.id === 'review';
    for (const side of [-1, 1]) {
      const x = layout.x + side * (ROOM_W / 2);
      if (glassRoom) {
        out.glass.push(pose(x, wallY, layout.z, zone.id, SCENE.glass, false));
        out.glassEdge.push(edge(x, FLOOR_TOP + WALL_H, layout.z, 0.1, 0.08, ROOM_D, zone.id, SCENE.glassEdge, false));
      } else {
        out.wallSide.push(pose(x, wallY, layout.z, zone.id, side < 0 ? SCENE.wallSide : SCENE.wall, false));
      }
    }
    if (eye && zone.kind === 'stuck') {
      out.alertEdge.push(edge(layout.x, FLOOR_TOP + WALL_H, layout.z - ROOM_D / 2, ROOM_W, 0.05, 0.1, zone.id, tone, roomHot));
      for (const side of [-1, 1]) {
        out.alertEdge.push(edge(layout.x + side * (ROOM_W / 2), FLOOR_TOP + WALL_H, layout.z, 0.1, 0.05, ROOM_D, zone.id, tone, roomHot));
      }
    }
    // Nobody sits in Done (lounge) or Aborted (discard heap); Blocked and Escalation have their own seats and Review stands its robots on the inspection line, so none of them draws a desk row.
    const deskless = zone.id === 'done' || zone.id === 'aborted' || zone.id === 'blocked' || zone.id === 'escalation' || zone.id === 'review';
    const liveDesks = deskless ? [] : sceneDesks(desksForZone(zone.id, tasks, stats));
    const row = deskless ? undefined : rows?.[zone.id];
    const desks = row
      ? row.map((slot) => ({ taskId: slot.taskId, localX: slot.localX }))
      : liveDesks.map((desk, index) => ({
          taskId: desk.taskId,
          localX: deskLocalX(index, liveDesks.length),
        }));
    const deskScale = 1.15;
    desks.forEach((desk) => {
      const x = layout.x + desk.localX;
      const z = layout.z + deskZ(zone.id);
      const deskHot = hotDesk(zone.id, desk.taskId, selection, hover);
      const occupied = desk.taskId !== null;
      out.desk.push(pose(x, FLOOR_TOP, z, zone.id, SCENE.wood, deskHot, { kind: 'desk', taskId: desk.taskId, sx: deskScale, sy: deskScale, sz: deskScale }));
      out.chair.push(pose(x, FLOOR_TOP, z + 0.46, zone.id, SCENE.metal, deskHot, {
        kind: 'desk', taskId: desk.taskId, rotY: Math.PI, sx: deskScale, sy: deskScale, sz: deskScale,
      }));
      if (SCREENS.has(zone.id)) {
        const screen = pose(x, FLOOR_TOP + 0.34 * deskScale, z - 0.22, zone.id, occupied ? tone : SCENE.screenOff, deskHot, {
          kind: 'desk', taskId: desk.taskId, rotY: 0, sx: deskScale, sy: deskScale, sz: deskScale,
        });
        (occupied ? out.screenOn : out.screenOff).push(screen);
      }
      if (LAMPS.has(zone.id)) {
        out.lamp.push(pose(x + 0.78, FLOOR_TOP, z - 0.2, zone.id, SCENE.shade, deskHot, {
          kind: 'desk', taskId: desk.taskId, sx: 1.1, sy: 1.1, sz: 1.1,
        }));
      }
      // Debug Lab round tags (post, rail, one tag per round) ride the rack mesh, placed from the current desk row.
      if (zone.id === 'debug' && desk.taskId) {
        for (const item of roundTagBoxes(roundsById.get(desk.taskId), desk.localX, deskZ(zone.id))) {
          out.rackBody.push(pose(layout.x + item.x, FLOOR_TOP + item.y, layout.z + item.z, zone.id, item.color, deskHot, {
            kind: 'desk', taskId: desk.taskId, sx: item.w, sy: item.h, sz: item.d,
          }));
        }
      }
    });
    if (zone.id === 'blocked') {
      const seating = blockedSeating(tasks);
      BLOCKED.chairs.forEach((spot, index) => {
        const taskId = seating.chairs[index] ?? null;
        out.chair.push(pose(layout.x + spot.x, FLOOR_TOP, layout.z + spot.z, zone.id, SCENE.metal,
          taskId ? hotDesk(zone.id, taskId, selection, hover) : roomHot, {
            kind: taskId ? 'desk' : 'room', taskId, rotY: Math.PI, sx: 1.15, sy: 1.15, sz: 1.15,
          }));
      });
      BLOCKED.bench.forEach((spot, index) => {
        const taskId = seating.bench[index] ?? null;
        out.benchHit.push(pose(layout.x + spot.x, FLOOR_TOP + 0.2, layout.z + spot.z, zone.id, '#ffffff',
          taskId ? hotDesk(zone.id, taskId, selection, hover) : roomHot, {
            kind: taskId ? 'desk' : 'room', taskId, sx: 0.58, sy: 0.4, sz: 0.5,
          }));
      });
    }
    if (zone.id === 'escalation') {
      const seating = escalationSeating(tasks);
      const deskTask = seating.desk;
      const kind = deskTask ? 'desk' : 'room';
      const deskHot = deskTask ? hotDesk(zone.id, deskTask, selection, hover) : roomHot;
      const x = layout.x + ESCALATION.desk.x;
      const z = layout.z + ESCALATION.desk.z;
      const big = ESCALATION.desk.scale;
      out.desk.push(pose(x, FLOOR_TOP, z, zone.id, SCENE.wood, deskHot, { kind, taskId: deskTask, sx: big, sy: big, sz: big }));
      out.chair.push(pose(layout.x + ESCALATION.farChair.x, FLOOR_TOP, layout.z + ESCALATION.farChair.z, zone.id, SCENE.metal, deskHot, {
        kind, taskId: deskTask, rotY: 0, sx: 1.15, sy: 1.15, sz: 1.15,
      }));
      const screen = pose(layout.x + ESCALATION.screen.x, FLOOR_TOP + 0.34 * big, layout.z + ESCALATION.screen.z, zone.id,
        deskTask ? tone : SCENE.screenOff, deskHot, {
          kind, taskId: deskTask, rotY: ESCALATION.screen.rotY, sx: ESCALATION.screen.scale, sy: ESCALATION.screen.scale, sz: ESCALATION.screen.scale,
        });
      (deskTask ? out.screenOn : out.screenOff).push(screen);
      // The desk lamp stays on the per-room lamp instances, so it glows only while this room holds a task.
      out.lamp.push(pose(layout.x + ESCALATION.lamp.x, FLOOR_TOP + ESCALATION.desk.top, layout.z + ESCALATION.lamp.z, zone.id, SCENE.shade, deskHot, {
        kind, taskId: deskTask, sx: ESCALATION.lamp.scale, sy: ESCALATION.lamp.scale, sz: ESCALATION.lamp.scale,
      }));
      out.plant.push(pose(layout.x + ESCALATION.plant.x, FLOOR_TOP, layout.z + ESCALATION.plant.z, zone.id, SCENE.foliage, roomHot, { sx: 1.15, sy: 1.15, sz: 1.15 }));
      ESCALATION.bench.forEach((spot, index) => {
        const taskId = seating.bench[index] ?? null;
        out.benchHit.push(pose(layout.x + spot.x, FLOOR_TOP + 0.2, layout.z + spot.z, zone.id, '#ffffff',
          taskId ? hotDesk(zone.id, taskId, selection, hover) : roomHot, {
            kind: taskId ? 'desk' : 'room', taskId, sx: 0.58, sy: 0.4, sz: 0.5,
          }));
      });
      seating.standing.forEach((taskId, index) => {
        const spot = ESCALATION.stand[index];
        out.benchHit.push(pose(layout.x + spot.x, FLOOR_TOP + 0.45, layout.z + spot.z, zone.id, '#ffffff',
          hotDesk(zone.id, taskId, selection, hover), { kind: 'desk', taskId, sx: 0.5, sy: 0.9, sz: 0.5 }));
      });
    }
    if (zone.id === 'debug') {
      // The clinic pieces that need their own color ride the rack mesh too (per-instance color, no glow).
      for (const item of DEBUG_LAB.pieces) {
        out.rackBody.push(pose(layout.x + item.x, FLOOR_TOP + item.y, layout.z + item.z, zone.id, item.color, false, {
          sx: item.w, sy: item.h, sz: item.d,
        }));
      }
    }
    if (zone.id === 'inbox') {
      out.plant.push(pose(
        layout.x + RECEPTION.plant.x,
        FLOOR_TOP,
        layout.z + RECEPTION.plant.z,
        zone.id,
        SCENE.foliage,
        roomHot,
        { sx: 1.15, sy: 1.15, sz: 1.15 },
      ));
      const on = (stat?.count ?? 0) > 0;
      const screen = pose(
        layout.x + RECEPTION.screen.x,
        FLOOR_TOP + RECEPTION.screen.y,
        layout.z + RECEPTION.screen.z,
        zone.id,
        on ? tone : SCENE.screenOff,
        roomHot,
        {
          rotY: RECEPTION.screen.rotY,
          sx: RECEPTION.screen.scale,
          sy: RECEPTION.screen.scale,
          sz: RECEPTION.screen.scale,
        },
      );
      (on ? out.screenOn : out.screenOff).push(screen);
    }
    if (zone.id === 'review') {
      const on = (stat?.count ?? 0) > 0;
      // A small panel on the gate header takes the place of the big back-wall screen.
      const { y, z, scale } = REVIEW.panel;
      const screen = pose(layout.x + REVIEW.gate.x, FLOOR_TOP + y, layout.z + z, zone.id, on ? tone : SCENE.screenOff, roomHot, {
        rotY: 0, sx: scale, sy: scale, sz: scale,
      });
      (on ? out.screenOn : out.screenOff).push(screen);
      // A task that is not waiting for a decision has no box: its standing spot is the click target.
      for (const entry of reviewBoard(tasks, new Date(0)).others) {
        if (!entry.spot) continue;
        out.benchHit.push(pose(layout.x + entry.spot.robot.x, FLOOR_TOP + 0.45, layout.z + entry.spot.robot.z, zone.id, '#ffffff',
          hotDesk(zone.id, entry.task.taskId, selection, hover), { kind: 'desk', taskId: entry.task.taskId, sx: 0.5, sy: 0.9, sz: 0.5 }));
      }
    }
    if (zone.id === 'rejected') {
      // Papers, indicator panels and checklist lines need their own color, so they ride the rack mesh
      // (per-instance color, no glow) and the plant rides the Inbox plant meshes: no new draw call.
      for (const piece of QA_LAB.tinted) {
        out.rackBody.push(pose(
          layout.x + piece.x, FLOOR_TOP + piece.y, layout.z + piece.z, zone.id, piece.color, roomHot,
          { sx: piece.w, sy: piece.h, sz: piece.d },
        ));
      }
      out.plant.push(pose(
        layout.x + QA_LAB.plant.x, FLOOR_TOP, layout.z + QA_LAB.plant.z, zone.id, SCENE.foliage, roomHot,
        { sx: 1.15, sy: 1.15, sz: 1.15 },
      ));
    }
    if (zone.id === 'devops') {
      const on = (stat?.count ?? 0) > 0;
      // Both racks keep the room's rule: their LEDs take the room tone while DevOps holds a task and go dark otherwise.
      DEVOPS.racks.forEach((rack) => {
        const rackX = layout.x + rack.x;
        const rackZ = layout.z + DEVOPS.rackZ;
        for (let tier = 0; tier < rack.tiers; tier += 1) {
          const y = FLOOR_TOP + 0.18 + tier * 0.38;
          out.rackBody.push(pose(rackX, y, rackZ, zone.id, SCENE.rack, roomHot, { sx: rack.w, sy: 0.3, sz: 0.32 }));
          out.rackLed.push(pose(rackX, y + 0.1, rackZ + 0.17, zone.id, on ? tone : SCENE.screenOff, roomHot, { sx: rack.w * (0.48 / 0.72), sy: 0.045, sz: 0.03 }));
        }
      });
      // Dark board slots, one per gate (a full dark row for a train with unreadable or no gates). Lit ones are a separate mesh.
      boardRows(trainRows(tasks)).forEach((row, rowIndex) => {
        for (let col = 0; col < row.slots; col += 1) {
          const slot = segmentSlot(rowIndex, col, false);
          out.rackBody.push(pose(layout.x + slot.x, FLOOR_TOP + slot.y, layout.z + slot.z, zone.id, DEVOPS_COLORS.segmentDark, false, {
            sx: slot.w, sy: slot.h, sz: slot.d,
          }));
        }
      });
      // Papers, checklist, clock face and the other own-color pieces ride the rack mesh too: no new draw call.
      for (const piece of DEVOPS_TINTED) {
        out.rackBody.push(pose(layout.x + piece.x, FLOOR_TOP + piece.y, layout.z + piece.z, zone.id, piece.color, false, {
          sx: piece.w, sy: piece.h, sz: piece.d,
        }));
      }
      out.plant.push(pose(layout.x + DEVOPS.plant.x, FLOOR_TOP, layout.z + DEVOPS.plant.z, zone.id, SCENE.foliage, roomHot, { sx: 1.15, sy: 1.15, sz: 1.15 }));
      // The console monitor follows the Inbox rule: dark until the room holds a task.
      const screen = pose(layout.x + DEVOPS.screen.x, FLOOR_TOP + DEVOPS.console.top, layout.z + DEVOPS.screen.z, zone.id, on ? tone : SCENE.screenOff, roomHot, {
        rotY: DEVOPS.screen.rotY, sx: DEVOPS.screen.scale, sy: DEVOPS.screen.scale, sz: DEVOPS.screen.scale,
      });
      (on ? out.screenOn : out.screenOff).push(screen);
    }
  }
  return out;
}

/** The release board's lit segments, from `segmentKey`s ("TASK:col"). A key whose train is off the board draws nothing. */
export function segmentPoses(keys: readonly string[], tasks: readonly OfficeTask[]): Pose[] {
  const layout = ROOM_LAYOUT.devops;
  const rowOf = new Map(boardRows(trainRows(tasks)).map((row, index) => [row.taskId, index]));
  const out: Pose[] = [];
  for (const key of keys) {
    const cut = key.lastIndexOf(':');
    const row = rowOf.get(key.slice(0, cut));
    const col = Number(key.slice(cut + 1));
    if (row === undefined || !(col >= 0 && col < BOARD_SEGMENTS)) continue;
    const slot = segmentSlot(row, col, true);
    out.push(pose(layout.x + slot.x, FLOOR_TOP + slot.y, layout.z + slot.z, 'devops', BAR_COLOR, false, { sx: slot.w, sy: slot.h, sz: slot.d }));
  }
  return out;
}

/** The queue board's lit bars, left to right, one per task waiting on Earth. */
export function barPoses(lit: number): Pose[] {
  const layout = ROOM_LAYOUT.blocked;
  const { bars } = BLOCKED;
  const count = Math.min(BAR_CAP, Math.max(0, Math.floor(lit)));
  return Array.from({ length: count }, (_, index) => pose(
    layout.x + BLOCKED.board.x + (index - (BAR_CAP - 1) / 2) * bars.pitch,
    FLOOR_TOP + bars.y,
    layout.z + bars.z,
    'blocked',
    BAR_COLOR,
    false,
    { sx: bars.w, sy: bars.h, sz: bars.d },
  ));
}

export function selectionAnchor(
  selection: OfficeSelection | null,
  tasks: OfficeTask[],
  stats: OfficeZoneStats,
  rows?: DeskRowMap | null,
): [number, number, number] | null {
  if (!selection) return null;
  const layout = ROOM_LAYOUT[selection.zoneId];
  if (!layout) return null;
  if (selection.zoneId === 'done' && selection.kind === 'desk') {
    const zone = ZONE_BY_ID.get('done');
    const inZone = tasksInZone('done', tasks, stats);
    const latest = zone ? zonePreview(zone, inZone, inZone.length || 1)[0]?.taskId ?? null : null;
    const spot = selection.taskId && selection.taskId === latest ? LOUNGE.table : LOUNGE.tv;
    return [layout.x + spot.x, 0.95, layout.z + spot.z];
  }
  if (selection.kind === 'room') return [layout.x, 1.15, layout.z];
  const row = rows?.[selection.zoneId];
  const slot = row?.find((desk) => desk.taskId === selection.taskId);
  const deskAnchorZ = layout.z + deskZ(selection.zoneId);
  if (slot) return [layout.x + slot.localX, 0.9, deskAnchorZ];
  const desks = sceneDesks(desksForZone(selection.zoneId, tasks, stats));
  const index = Math.max(0, desks.findIndex((desk) => desk.taskId === selection.taskId));
  return [layout.x + deskLocalX(index, desks.length), 0.9, deskAnchorZ];
}
