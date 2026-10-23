import { describe, expect, it } from 'vitest';
import {
  FOCUS_ZOOM,
  chipValue,
  layoutNames,
  pickFocus,
  placeReadout,
  rectsOverlap,
  visibleReadouts,
  type NameItem,
  type Rect,
} from './officeLabels';

const VIEW = { w: 900, h: 600 };

function name(id: string, cx: number, y: number, extra: Partial<NameItem> = {}): NameItem {
  return { id, cx, y, w: 60, h: 18, busy: false, order: 0, ...extra };
}

function box(item: NameItem, at: { x: number; y: number }): Rect {
  return { left: at.x, top: at.y, right: at.x + item.w, bottom: at.y + item.h };
}

describe('layoutNames', () => {
  it('moves two names whose anchors overlap apart, in a stable order', () => {
    const a = name('review', 300, 200, { order: 0 });
    const b = name('devops', 310, 204, { order: 1 });
    const first = layoutNames([a, b], VIEW);
    const again = layoutNames([b, a], VIEW);
    const pa = first.get('review');
    const pb = first.get('devops');
    expect(pa && pb).toBeTruthy();
    expect(rectsOverlap(box(a, pa!), box(b, pb!))).toBe(false);
    expect(again.get('review')).toEqual(pa);
    expect(again.get('devops')).toEqual(pb);
  });

  it('gives a room with tasks its spot first', () => {
    const idle = name('review', 300, 200, { order: 0 });
    const busy = name('devops', 300, 200, { order: 5, busy: true });
    const placed = layoutNames([idle, busy], VIEW);
    expect(placed.get('devops')).toEqual({ x: 270, y: 200 });
    expect(placed.get('review')).not.toEqual({ x: 270, y: 200 });
  });

  it('does not move a name that is already clear', () => {
    const placed = layoutNames([name('inbox', 100, 100), name('dev', 500, 400)], VIEW);
    expect(placed.get('inbox')).toEqual({ x: 70, y: 100 });
    expect(placed.get('dev')).toEqual({ x: 470, y: 400 });
  });

  it('hides a name whose anchor is off the stage instead of clamping it to the edge', () => {
    const placed = layoutNames([name('done', 300, 700), name('review', -40, 100), name('dev', 300, 300)], VIEW);
    expect(placed.has('done')).toBe(false);
    expect(placed.has('review')).toBe(false);
    expect(placed.has('dev')).toBe(true);
  });

  it('keeps every on-stage name, even when many anchors coincide', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id, order) => name(id, 400, 300, { order }));
    const placed = layoutNames(items, VIEW);
    expect(placed.size).toBe(5);
    const boxes = items.map((item) => box(item, placed.get(item.id)!));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) expect(rectsOverlap(boxes[i], boxes[j])).toBe(false);
    }
  });
});

describe('pickFocus', () => {
  const rooms = [
    { id: 'review', x: 300, y: 300 },
    { id: 'done', x: 460, y: 310 },
    { id: 'dev', x: 800, y: 500 },
  ];

  it('picks no room at the default camera zoom, on any stage width', () => {
    for (const w of [320, 600, 900, 1920]) {
      const centred = [{ id: 'done', x: w / 2, y: 300 }];
      expect(pickFocus({ zoom: 30, view: { w, h: 600 }, rooms: centred, prev: null })).toBeNull();
    }
  });

  it('picks the room nearest the middle above the zoom threshold', () => {
    expect(pickFocus({ zoom: FOCUS_ZOOM + 5, view: VIEW, rooms, prev: null })).toBe('done');
  });

  it('ignores rooms outside the middle third of the stage', () => {
    const edge = [{ id: 'dev', x: 800, y: 500 }];
    expect(pickFocus({ zoom: 60, view: VIEW, rooms: edge, prev: null })).toBeNull();
  });

  it('keeps the focus while the camera moves slightly toward a neighbour', () => {
    const slightly = [
      { id: 'review', x: 448, y: 300 },
      { id: 'done', x: 458, y: 300 },
    ];
    expect(pickFocus({ zoom: 60, view: VIEW, rooms: slightly, prev: 'done' })).toBe('done');
    expect(pickFocus({ zoom: 60, view: VIEW, rooms: slightly, prev: null })).toBe('review');
  });

  it('moves the focus once a neighbour is clearly nearer', () => {
    const clearly = [
      { id: 'review', x: 450, y: 300 },
      { id: 'done', x: 560, y: 300 },
    ];
    expect(pickFocus({ zoom: 60, view: VIEW, rooms: clearly, prev: 'done' })).toBe('review');
  });

  it('does not drop the focus the moment the zoom dips under the threshold', () => {
    const one = [{ id: 'done', x: 450, y: 300 }];
    expect(pickFocus({ zoom: FOCUS_ZOOM - 1, view: VIEW, rooms: one, prev: 'done' })).toBe('done');
    expect(pickFocus({ zoom: FOCUS_ZOOM - 1, view: VIEW, rooms: one, prev: null })).toBeNull();
    expect(pickFocus({ zoom: FOCUS_ZOOM - 10, view: VIEW, rooms: one, prev: 'done' })).toBeNull();
  });
});

describe('placeReadout', () => {
  const focus: Rect = { left: 350, top: 200, right: 550, bottom: 400 };
  const size = { w: 108, h: 50 };

  it('takes a clear spot beside the focused room when one exists', () => {
    const at = placeReadout({ size, view: VIEW, focus, names: [], card: null, rooms: [] });
    const readout = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    expect(rectsOverlap(readout, focus)).toBe(false);
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.x + size.w).toBeLessThanOrEqual(VIEW.w);
  });

  it('prefers the spot that covers the least of the other rooms', () => {
    const rightRoom: Rect = { left: 560, top: 150, right: 800, bottom: 450 };
    const at = placeReadout({ size, view: VIEW, focus, names: [], card: null, rooms: [rightRoom] });
    const readout = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    expect(rectsOverlap(readout, rightRoom)).toBe(false);
  });

  it('covers a neighbour rather than the focused room when nothing is clear', () => {
    const left: Rect = { left: 0, top: 0, right: 345, bottom: 600 };
    const right: Rect = { left: 555, top: 0, right: 900, bottom: 600 };
    const below: Rect = { left: 350, top: 405, right: 550, bottom: 600 };
    const at = placeReadout({ size, view: VIEW, focus, names: [], card: null, rooms: [left, right, below] });
    const readout = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    expect(rectsOverlap(readout, focus)).toBe(false);
  });

  it('never covers a name or the selection card', () => {
    const names: Rect[] = [{ left: 560, top: 200, right: 700, bottom: 218 }];
    const card: Rect = { left: 120, top: 200, right: 340, bottom: 320 };
    const at = placeReadout({ size, view: VIEW, focus, names, card, rooms: [] });
    const readout = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    expect(rectsOverlap(readout, focus)).toBe(false);
    expect(rectsOverlap(readout, names[0])).toBe(false);
    expect(rectsOverlap(readout, card)).toBe(false);
  });
});

describe('chipValue', () => {
  const stats = new Map([
    ['review', { count: 3 }],
    ['done', { count: 537 }],
    ['aborted', { count: 12 }],
  ]);
  const input = { stats, closedToday: 4, abortedTotal: 9 };

  it('counts the tasks in an open room', () => {
    expect(chipValue('review', input)).toBe(3);
  });

  it('shows tasks closed today for Done, not the all-time total', () => {
    expect(chipValue('done', input)).toBe(4);
  });

  it('shows the aborted total for Aborted', () => {
    expect(chipValue('aborted', input)).toBe(9);
  });

  it('gives no chip at zero', () => {
    expect(chipValue('dev', input)).toBeNull();
    expect(chipValue('done', { ...input, closedToday: 0 })).toBeNull();
    expect(chipValue('aborted', { ...input, abortedTotal: 0 })).toBeNull();
  });
});

describe('visibleReadouts', () => {
  it('shows the focused room readout without a click', () => {
    expect([...visibleReadouts({ focus: 'done', selection: null, tvHot: false })]).toEqual(['done']);
    expect([...visibleReadouts({ focus: 'aborted', selection: null, tvHot: false })]).toEqual(['aborted']);
  });

  it('shows nothing for a room with no readout, or with no focus', () => {
    expect(visibleReadouts({ focus: 'review', selection: null, tvHot: false }).size).toBe(0);
    expect(visibleReadouts({ focus: null, selection: null, tvHot: false }).size).toBe(0);
  });

  it('hides the focused room readout while that room is selected', () => {
    const selection = { kind: 'room' as const, zoneId: 'aborted' };
    expect(visibleReadouts({ focus: 'aborted', selection, tvHot: false }).size).toBe(0);
  });

  it('keeps the readout of a focused room when another room is selected', () => {
    const selection = { kind: 'room' as const, zoneId: 'review' };
    expect([...visibleReadouts({ focus: 'done', selection, tvHot: false })]).toEqual(['done']);
  });

  it('shows the Done readout for a selected Done task at any zoom', () => {
    const selection = { kind: 'desk' as const, zoneId: 'done', taskId: 'TASK-1' };
    expect([...visibleReadouts({ focus: null, selection, tvHot: true })]).toEqual(['done']);
    expect([...visibleReadouts({ focus: 'done', selection, tvHot: true })]).toEqual(['done']);
  });
});
