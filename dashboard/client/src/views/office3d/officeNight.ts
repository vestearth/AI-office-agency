import { Color } from 'three';
import { ZONE_BY_ID, ZONES, zoneNeedsEye, zoneTone, type Zone } from '../commandZones';
import { FLOOR_TOP, ROOM_D, ROOM_W, WALL_H } from './officeLook';
import { LOUNGE_LIGHT, LOUNGE_LIGHT_LEVEL } from './officeLounge';
import { ROOM_LAYOUT, type OfficeSelection, type OfficeZoneStats } from './officeSelection';

export const NIGHT = {
  background: '#05070b',
  ground: '#080b10',
  grid: '#111925',
  floor: '#1f2631',
  wall: '#161d27',
  wallSide: '#1b2430',
  moon: '#9db3e8',
  outline: '#7f93b0',
} as const;

/** Camera aim. The position stays one (24, 20, 20.5) offset away from this point. */
export const OFFICE_AIM: readonly [number, number, number] = [-1.2, 0, -0.1];

export const MONITOR_EMISSIVE = 2;
/** Review wall screen. 0.85 on a darkened albedo stays under the bloom threshold and dimmer than the desk monitors. */
export const REVIEW_WALL_EMISSIVE = 0.85;
export const LAMP_EMISSIVE = 1.4;
export const SPOT_INTENSITY = 1800;
export const HALO_STRENGTH = 0.6;
export const RIM_STRENGTH = 0.9;
export const EMPTY_OUTLINE = 0.22;

export interface RoomBrief {
  count: number;
  attention: boolean;
  active: boolean;
}

/**
 * 1 when the room is active or waiting on a person, 0.7 when it has idle work,
 * 0 when empty or terminal. Done is the exception: it lights at LOUNGE_LIGHT_LEVEL
 * once today's closed count is at least one, and stays dark otherwise.
 */
export function roomLightLevel(zone: Zone, stat: RoomBrief, closedToday = 0): 0 | 0.7 | 1 | typeof LOUNGE_LIGHT_LEVEL {
  if (zone.id === 'done') return closedToday > 0 ? LOUNGE_LIGHT_LEVEL : 0;
  if (!stat.count || zone.kind === 'terminal') return 0;
  if (zoneNeedsEye(zone, stat) || stat.active) return 1;
  return 0.7;
}

/** Shade glow follows the room: 1.4 while it has tasks, 0 when empty or terminal. */
export function lampShadeEmissive(zone: Zone, stat: Pick<RoomBrief, 'count'>): 0 | 1.4 {
  if (!stat.count || zone.kind === 'terminal') return 0;
  return LAMP_EMISSIVE;
}

/** Emissive for one room's shade, including the DevOps floor lamp. Unknown rooms stay dark. */
export function shadeEmissiveFor(zoneId: string, stats: OfficeZoneStats): 0 | 1.4 {
  const zone = ZONE_BY_ID.get(zoneId);
  if (!zone) return 0;
  return lampShadeEmissive(zone, stats.get(zoneId) ?? { count: 0 });
}

/** Desk lamps split by room occupancy. Empty and terminal shades stay on the dark material. */
export function splitLampPoses<T extends { zoneId: string }>(
  lamps: readonly T[],
  stats: OfficeZoneStats,
): { lit: T[]; dark: T[] } {
  const lit: T[] = [];
  const dark: T[] = [];
  for (const lamp of lamps) {
    if (shadeEmissiveFor(lamp.zoneId, stats) > 0) lit.push(lamp);
    else dark.push(lamp);
  }
  return { lit, dark };
}

export interface RoomGlow {
  zoneId: string;
  x: number;
  z: number;
  /** Zone outline. Done keeps its terminal gray even while the lounge is lit. */
  tone: string;
  /** Spot and floor pool. Done uses the warm white; every other room uses `tone`. */
  light: string;
  level: 0 | 0.7 | 1 | typeof LOUNGE_LIGHT_LEVEL;
  eye: boolean;
  hot: boolean;
}

export function roomGlows(
  stats: OfficeZoneStats,
  selection: OfficeSelection | null,
  hoverZone: string | null,
  closedToday = 0,
): RoomGlow[] {
  return ZONES.flatMap((zone) => {
    const layout = ROOM_LAYOUT[zone.id];
    if (!layout) return [];
    const stat = stats.get(zone.id);
    const brief: RoomBrief = stat ?? { count: 0, attention: false, active: false };
    const hot = hoverZone === zone.id || selection?.zoneId === zone.id;
    const today = zone.id === 'done' ? closedToday : 0;
    const tone = zoneTone(zone, brief);
    const level = roomLightLevel(zone, brief, today);
    return [{
      zoneId: zone.id,
      x: layout.x,
      z: layout.z,
      tone,
      light: zone.id === 'done' && level > 0 ? LOUNGE_LIGHT : tone,
      level,
      eye: zoneNeedsEye(zone, brief),
      hot,
    }];
  });
}

export interface GlowItem {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: Color;
}

function glowColor(room: RoomGlow, strength: number, emptyStrength: number, source: 'tone' | 'light'): Color {
  const boost = room.hot ? 1.6 : 1;
  if (room.level === 0) return new Color(NIGHT.outline).multiplyScalar(emptyStrength * boost);
  const hex = source === 'light' ? room.light : room.tone;
  return new Color(hex).multiplyScalar(strength * room.level * boost);
}

/** Additive halo around a lit island. Empty and terminal rooms get none. */
export function poolItems(glows: RoomGlow[], strength = HALO_STRENGTH) {
  const steady: GlowItem[] = [];
  const pulse: GlowItem[] = [];
  for (const room of glows) {
    if (room.level === 0) continue;
    const color = glowColor(room, strength, 0, 'light');
    const list = room.eye ? pulse : steady;
    list.push({ x: room.x, y: 0.016, z: room.z + 0.2, sx: ROOM_W * 1.75, sy: 1, sz: ROOM_D * 2.0, color });
    list.push({
      x: room.x, y: FLOOR_TOP + 0.006, z: room.z + 0.15,
      sx: ROOM_W * 1.05, sy: 1, sz: ROOM_D * 1.1, color: color.clone().multiplyScalar(0.85),
    });
  }
  return { steady, pulse };
}

/** Wall caps, front posts, and the floor lip. Dark rooms keep only the faint outline. */
export function rimItems(glows: RoomGlow[], strength = RIM_STRENGTH, emptyStrength = EMPTY_OUTLINE) {
  const steady: GlowItem[] = [];
  const pulse: GlowItem[] = [];
  const capY = FLOOR_TOP + WALL_H + 0.025;
  for (const room of glows) {
    const color = glowColor(room, strength, emptyStrength, 'tone');
    const list = room.eye ? pulse : steady;
    const { x, z } = room;
    list.push({ x, y: capY, z: z - ROOM_D / 2, sx: ROOM_W + 0.1, sy: 0.05, sz: 0.1, color });
    for (const side of [-1, 1]) {
      list.push({ x: x + side * (ROOM_W / 2), y: capY, z, sx: 0.1, sy: 0.05, sz: ROOM_D + 0.1, color });
      list.push({ x: x + side * (ROOM_W / 2), y: FLOOR_TOP + WALL_H / 2, z: z + ROOM_D / 2, sx: 0.07, sy: WALL_H, sz: 0.07, color });
    }
    list.push({ x, y: FLOOR_TOP + 0.005, z: z + ROOM_D / 2 + 0.02, sx: ROOM_W + 0.1, sy: 0.04, sz: 0.06, color });
  }
  return { steady, pulse };
}
