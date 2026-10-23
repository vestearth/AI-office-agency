import { placeBeside } from './officeLook';
import type { OfficeSelection } from './officeSelection';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Size {
  w: number;
  h: number;
}

/** Camera zoom from which the room in the middle shows its readout. The default camera is 30, the maximum 70. */
export const FOCUS_ZOOM = 45;
/** Once focused, the readout stays until the zoom drops this far under `FOCUS_ZOOM`, so a slow zoom does not flicker. */
export const FOCUS_ZOOM_SLACK = 3;
/** A neighbour takes the focus only when it is nearer the middle by this share of the shorter stage side. */
export const FOCUS_MARGIN = 0.06;
/** Readouts fade over this long. Reduced motion has no fade. */
export const READOUT_FADE_MS = 150;
/** Rooms with a readout of their own. Each room's issue adds itself here. */
export const READOUT_ROOMS: readonly string[] = ['done', 'aborted', 'blocked'];

const NAME_STEPS = 8;
const READOUT_GAP = 12;

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface NameItem {
  id: string;
  /** Screen x of the name's centre and y of its top, before any nudge. */
  cx: number;
  y: number;
  w: number;
  h: number;
  /** A room with tasks gets its spot before an idle one. */
  busy: boolean;
  /** The fixed zone order, which settles ties. */
  order: number;
}

/**
 * Where each name goes. A name whose anchor is off the stage is left out, not clamped to the edge.
 * Names place in priority order (rooms with tasks, then zone order); one that would overlap a
 * placed name moves down or up by its own height until it is clear. The result depends only on
 * the anchors and the priority, so the same view always gives the same layout.
 */
export function layoutNames(items: readonly NameItem[], view: Size): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  const taken: Rect[] = [];
  const ranked = items
    .filter((item) => item.cx >= 0 && item.cx <= view.w && item.y >= 0 && item.y <= view.h)
    .sort((a, b) => Number(b.busy) - Number(a.busy) || a.order - b.order || a.id.localeCompare(b.id));
  for (const item of ranked) {
    const left = item.cx - item.w / 2;
    let chosen = { x: left, y: item.y };
    for (let step = 0; step <= NAME_STEPS; step += 1) {
      const lift = Math.ceil(step / 2) * item.h * (step % 2 === 1 ? 1 : -1);
      const rect = { left, top: item.y + lift, right: left + item.w, bottom: item.y + lift + item.h };
      if (!taken.some((other) => rectsOverlap(rect, other))) {
        chosen = { x: left, y: rect.top };
        break;
      }
    }
    placed.set(item.id, chosen);
    taken.push({ left: chosen.x, top: chosen.y, right: chosen.x + item.w, bottom: chosen.y + item.h });
  }
  return placed;
}

export interface FocusRoom {
  id: string;
  /** Screen position of the room's centre. */
  x: number;
  y: number;
}

/**
 * The room that shows its readout, or null. Only above `FOCUS_ZOOM` (the camera zoom, so it does not
 * depend on the stage width), and only for a room whose centre is inside the middle third of the
 * stage. The previous focus is kept while it is still in that third and not clearly beaten.
 */
export function pickFocus({
  zoom,
  view,
  rooms,
  prev,
}: {
  zoom: number;
  view: Size;
  rooms: readonly FocusRoom[];
  prev: string | null;
}): string | null {
  if (zoom < (prev ? FOCUS_ZOOM - FOCUS_ZOOM_SLACK : FOCUS_ZOOM)) return null;
  const cx = view.w / 2;
  const cy = view.h / 2;
  const near = rooms
    .filter((room) => Math.abs(room.x - cx) <= view.w / 6 && Math.abs(room.y - cy) <= view.h / 6)
    .map((room) => ({ id: room.id, d: Math.hypot(room.x - cx, room.y - cy) }))
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
  const best = near[0];
  if (!best) return null;
  const keep = prev ? near.find((room) => room.id === prev) : undefined;
  if (keep && keep.d <= best.d + FOCUS_MARGIN * Math.min(view.w, view.h)) return keep.id;
  return best.id;
}

/**
 * Top-left for a readout. Candidates sit beside the focused room (freer side first), then below and
 * above it. A candidate that covers a name, the card or the focused room is the last resort; among
 * the rest the one that covers the least of the other rooms' footprints wins, the first listed on a tie.
 */
export function placeReadout({
  size,
  view,
  focus,
  names,
  card,
  rooms,
}: {
  size: Size;
  view: Size;
  focus: Rect;
  names: readonly Rect[];
  card: Rect | null;
  rooms: readonly Rect[];
}): { x: number; y: number } {
  const clamp = (x: number, y: number) => ({
    x: Math.min(Math.max(0, view.w - size.w), Math.max(0, x)),
    y: Math.min(Math.max(0, view.h - size.h), Math.max(0, y)),
  });
  const rightX = focus.right + READOUT_GAP;
  const leftX = focus.left - READOUT_GAP - size.w;
  const rightFirst = view.w - (rightX + size.w) >= leftX;
  const sides = rightFirst ? [rightX, leftX] : [leftX, rightX];
  const midY = (focus.top + focus.bottom) / 2 - size.h / 2;
  const candidates = [
    ...sides.flatMap((x) => [clamp(x, focus.top), clamp(x, midY), clamp(x, focus.bottom - size.h)]),
    clamp(focus.left, focus.bottom + READOUT_GAP),
    clamp((focus.left + focus.right) / 2 - size.w / 2, focus.bottom + READOUT_GAP),
    clamp(focus.left, focus.top - READOUT_GAP - size.h),
    clamp((focus.left + focus.right) / 2 - size.w / 2, focus.top - READOUT_GAP - size.h),
  ];
  const hard = [focus, ...names, ...(card ? [card] : [])];
  let best = candidates[0];
  let bestScore = Infinity;
  for (const at of candidates) {
    const rect = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    const blocked = hard.reduce((sum, other) => sum + overlapArea(rect, other), 0);
    const cover = rooms.reduce((sum, other) => sum + overlapArea(rect, other), 0);
    const score = blocked * 1000 + cover;
    if (score < bestScore) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The number in a room's name chip, or null when there is none. Open rooms count their tasks, Done
 * counts tasks closed today (not the all-time total), Aborted counts every aborted task, and Blocked
 * counts the tasks waiting on Earth from every room (zero hides it, even with tasks waiting on others).
 */
export function chipValue(
  zoneId: string,
  input: { stats: ReadonlyMap<string, { count: number }>; closedToday: number; abortedTotal: number; waitingOnEarth: number },
): number | null {
  const value = zoneId === 'done'
    ? input.closedToday
    : zoneId === 'aborted'
      ? input.abortedTotal
      : zoneId === 'blocked'
        ? input.waitingOnEarth
        : input.stats.get(zoneId)?.count ?? 0;
  return value > 0 ? value : null;
}

/**
 * The rooms whose readout shows. The focused room's readout shows unless that room is the selected
 * room, because the card carries the details. The Blocked readout is the exception: it hides only
 * for the room selection itself and stays, with the selected line highlighted, while any task is
 * selected. A selected Done task keeps SPAR-41's behaviour: the Done readout shows, highlighted, at
 * any zoom.
 */
export function visibleReadouts({
  focus,
  selection,
  tvHot,
}: {
  focus: string | null;
  selection: (Pick<OfficeSelection, 'zoneId'> & { kind?: OfficeSelection['kind'] }) | null;
  tvHot: boolean;
}): Set<string> {
  const shown = new Set<string>();
  if (focus && READOUT_ROOMS.includes(focus)) {
    const covered = selection?.zoneId === focus && !(focus === 'blocked' && selection.kind === 'desk');
    if (!covered) shown.add(focus);
  }
  if (tvHot) shown.add('done');
  return shown;
}

/**
 * Top-left for the selection card when readouts are already placed. The usual spot beside the
 * anchor wins if it is clear; otherwise the candidate (beside, then above and below) that covers the
 * least of `avoid`, the first listed on a tie. The card always stays inside the stage.
 */
export function placeCardClear({
  anchor,
  view,
  size,
  avoid,
}: {
  anchor: Rect;
  view: Size;
  size: Size;
  avoid: readonly Rect[];
}): { x: number; y: number } {
  const clamp = (x: number, y: number) => ({
    x: Math.min(Math.max(0, view.w - size.w), Math.max(0, x)),
    y: Math.min(Math.max(0, view.h - size.h), Math.max(0, y)),
  });
  const gap = READOUT_GAP;
  const candidates = [
    placeBeside(anchor, view.w, view.h, size.w, size.h, gap),
    clamp(anchor.right + gap, anchor.top),
    clamp(anchor.left - gap - size.w, anchor.top),
    clamp(anchor.right + gap, anchor.bottom - size.h),
    clamp(anchor.left - gap - size.w, anchor.bottom - size.h),
    clamp(anchor.left, anchor.bottom + gap),
    clamp(anchor.left, anchor.top - gap - size.h),
    clamp(view.w - size.w, view.h - size.h),
    clamp(0, view.h - size.h),
  ];
  let best = candidates[0];
  let bestCover = Infinity;
  for (const at of candidates) {
    const rect = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    const cover = avoid.reduce((sum, other) => sum + overlapArea(rect, other), 0);
    if (cover < bestCover) {
      best = at;
      bestCover = cover;
      if (cover === 0) break;
    }
  }
  return best;
}
