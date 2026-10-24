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
import { LOUNGE } from './officeLounge';
import { REVIEW } from './officeReview';
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
  screenOn: Pose[];
  screenOff: Pose[];
  lamp: Pose[];
  plant: Pose[];
  rackBody: Pose[];
  rackLed: Pose[];
  neon: NeonRun[];
}

const SCREENS = new Set(['dev', 'debug', 'blocked', 'rejected']);
const LAMPS = new Set(['inbox', 'escalation']);

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
    desk: [], chair: [], screenOn: [], screenOff: [], lamp: [], plant: [], rackBody: [], rackLed: [],
    neon: neonRuns(stats),
  };
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
    // Nobody sits in Done (lounge), Aborted (discard heap) or Review (inspection line), so none draws desks.
    const deskless = zone.id === 'done' || zone.id === 'aborted' || zone.id === 'review';
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
    });
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
    }
    if (zone.id === 'devops') {
      const rackX = layout.x + 1.15;
      const rackZ = layout.z - ROOM_D / 2 + 0.42;
      for (let tier = 0; tier < 3; tier += 1) {
        const y = FLOOR_TOP + 0.18 + tier * 0.38;
        out.rackBody.push(pose(rackX, y, rackZ, zone.id, SCENE.rack, roomHot, { sx: 0.72, sy: 0.3, sz: 0.32 }));
        out.rackLed.push(pose(rackX, y + 0.1, rackZ + 0.17, zone.id, (stat?.count ?? 0) > 0 ? tone : SCENE.screenOff, roomHot, { sx: 0.48, sy: 0.045, sz: 0.03 }));
      }
    }
  }
  return out;
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
