import { describe, expect, it } from 'vitest';
import {
  FOCUS_ZOOM,
  chipValue,
  fitReadout,
  layoutNames,
  layoutNamesChecked,
  pickFocus,
  placeCardClear,
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

describe('a tall readout never covers a room name (SPAR-52)', () => {
  // DevOps in the middle with a 360 x 270 readout: the side gaps are 238 px, a name sits right
  // under the room (Val.Failed) and one above it, so no listed spot beside or below is clear.
  const view = { w: 1000, h: 700 };
  const focus: Rect = { left: 355, top: 245, right: 645, bottom: 455 };
  const size = { w: 360, h: 270 };
  const under: Rect = { left: 400, top: 462, right: 600, bottom: 480 };
  const above: Rect = { left: 400, top: 215, right: 600, bottom: 233 };
  const rect = (at: { x: number; y: number }): Rect => ({ left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h });

  it('takes a name-free spot beside or clear of the focused room when the stage has one', () => {
    const roomy = placeReadout({ size, view: { w: 1200, h: 800 }, focus, names: [under, above], card: null, rooms: [] });
    expect(rectsOverlap(rect(roomy), under)).toBe(false);
    expect(rectsOverlap(rect(roomy), above)).toBe(false);
    expect(rectsOverlap(rect(roomy), focus)).toBe(false);
  });

  it('gives up a name before the focused room when the stage is too tight (names then step aside)', () => {
    const tight = placeReadout({ size, view, focus, names: [under, above], card: null, rooms: [] });
    const onFocus = Math.max(0, Math.min(rect(tight).right, focus.right) - Math.max(rect(tight).left, focus.left));
    const clearOfNames = !rectsOverlap(rect(tight), under) && !rectsOverlap(rect(tight), above);
    expect(onFocus === 0 || clearOfNames).toBe(true);
  });

  it('makes a name step around a readout that has nowhere clear to go', () => {
    const readout: Rect = { left: 300, top: 400, right: 660, bottom: 670 };
    const item = name('failed', 500, 462, { w: 100 });
    const placed = layoutNames([item], view, [readout]);
    const at = placed.get('failed');
    expect(at).toBeTruthy();
    expect(rectsOverlap(box(item, at!), readout)).toBe(false);
  });

  it('keeps names where they are when no readout is near', () => {
    const item = name('failed', 500, 462, { w: 100 });
    expect(layoutNames([item], view, []).get('failed')).toEqual({ x: 450, y: 462 });
  });

  it('places the readout first and then names around it: no name under the readout', () => {
    const items = [
      name('failed', 500, 462, { w: 100, busy: true }),
      name('blocked', 500, 215, { w: 100, order: 1 }),
      name('left', 330, 300, { w: 100, order: 2 }),
      name('right', 670, 300, { w: 100, order: 3 }),
    ];
    const first = layoutNames(items, view);
    const nameBoxes = items.map((item) => box(item, first.get(item.id)!));
    const at = placeReadout({ size, view, focus, names: nameBoxes, card: null, rooms: [] });
    const readout = rect(at);
    const settled = layoutNames(items, view, [readout]);
    for (const item of items) {
      const put = settled.get(item.id);
      if (put) expect(rectsOverlap(box(item, put), readout)).toBe(false);
    }
  });
});

describe('a name stays with its own room; a readout that cannot clear it gets shorter (SPAR-52, option A)', () => {
  const view = { w: 880, h: 800 };
  // The Val.Failed room under DevOps: its name sits at the room's middle, the readout covers the whole room.
  const room: Rect = { left: 520, top: 470, right: 700, bottom: 590 };
  const valFailed = name('rejected', 610, 520, { w: 90, bounds: room });
  const readout: Rect = { left: 400, top: 440, right: 760, bottom: 710 };
  const touches = (a: Rect, b: Rect) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

  it('never moves a name out of its own room box, and reports the name it could not clear', () => {
    const { placed, stuck } = layoutNamesChecked([valFailed], view, [readout]);
    const at = placed.get('rejected');
    expect(at).toBeTruthy();
    expect(touches(box(valFailed, at!), room)).toBe(true);
    expect(stuck.has('rejected')).toBe(true);
  });

  it('steps a name aside inside its room when that clears the readout', () => {
    const low: Rect = { left: 400, top: 540, right: 760, bottom: 710 };
    const { placed, stuck } = layoutNamesChecked([valFailed], view, [low]);
    const at = placed.get('rejected')!;
    expect(stuck.size).toBe(0);
    expect(rectsOverlap(box(valFailed, at), low)).toBe(false);
    expect(touches(box(valFailed, at), room)).toBe(true);
  });

  it('shortens the readout, keeping its width and top edge, until it clears the name', () => {
    const { placed } = layoutNamesChecked([valFailed], view, [readout]);
    const nameBox = box(valFailed, placed.get('rejected')!);
    const fit = fitReadout(readout, [nameBox]);
    expect(rectsOverlap(fit.rect, nameBox)).toBe(false);
    expect(fit.rect.left).toBe(readout.left);
    expect(fit.rect.right).toBe(readout.right);
    expect(fit.rect.bottom - fit.rect.top).toBeLessThan(readout.bottom - readout.top);
    expect(fit.maxHeight).toBe(fit.rect.bottom - fit.rect.top);
  });

  it('leaves a readout alone, with no height cap, when no name is in the way', () => {
    const far = { left: 0, top: 0, right: 90, bottom: 18 };
    const fit = fitReadout(readout, [far]);
    expect(fit.rect).toEqual(readout);
    expect(fit.maxHeight).toBeNull();
  });

  it('keeps the taller side when the name is in the middle of the readout', () => {
    const fit = fitReadout({ left: 0, top: 100, right: 360, bottom: 370 }, [{ left: 100, top: 130, right: 190, bottom: 148 }]);
    expect(fit.rect.top).toBe(148 + 12);
    expect(fit.rect.bottom).toBe(370);
  });
});

describe('review follow-ups for SPAR-52', () => {
  const touches = (a: Rect, b: Rect) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

  it('never puts a name off the stage; a name with no on-stage spot is reported as stuck', () => {
    const view = { w: 900, h: 600 };
    // The room box runs past the top edge, the readout hugs the top: above the readout is off the stage.
    const room: Rect = { left: 430, top: -120, right: 640, bottom: 130 };
    const item = name('devops', 530, 110, { w: 100, bounds: room });
    const readout: Rect = { left: 300, top: 0, right: 660, bottom: 270 };
    const { placed, stuck } = layoutNamesChecked([item], view, [readout]);
    const at = placed.get('devops')!;
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.y + item.h).toBeLessThanOrEqual(view.h);
    expect(touches(box(item, at), room)).toBe(true);
    expect(stuck.has('devops')).toBe(true);
  });

  it('takes a spot slid along the room edge when all ten usual spots cover a name', () => {
    const view = { w: 1000, h: 700 };
    const focus: Rect = { left: 400, top: 300, right: 600, bottom: 400 };
    const size = { w: 150, h: 100 };
    const names: Rect[] = [
      { left: 612, top: 370, right: 762, bottom: 388 },
      { left: 238, top: 370, right: 388, bottom: 388 },
      { left: 420, top: 420, right: 570, bottom: 438 },
      { left: 420, top: 200, right: 570, bottom: 218 },
    ];
    const at = placeReadout({ size, view, focus, names, card: null, rooms: [] });
    const readout = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    for (const name of names) expect(rectsOverlap(readout, name)).toBe(false);
    expect(rectsOverlap(readout, focus)).toBe(false);
  });

  it('covers a name that can still move before it covers the focused room', () => {
    const view = { w: 360, h: 360 };
    const focus: Rect = { left: 80, top: 20, right: 280, bottom: 120 };
    const size = { w: 360, h: 200 };
    // Every spot either lies on the focused room or on this (large) name.
    const names: Rect[] = [{ left: 0, top: 135, right: 360, bottom: 300 }];
    const at = placeReadout({ size, view, focus, names, card: null, rooms: [] });
    expect(rectsOverlap({ left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h }, focus)).toBe(false);
  });
});

describe('chipValue', () => {
  const stats = new Map([
    ['devops', { count: 3 }],
    ['done', { count: 537 }],
    ['aborted', { count: 12 }],
  ]);
  const input = { stats, closedToday: 4, abortedTotal: 9, waitingOnEarth: 0, reviewWaiting: 2 };

  it('counts the tasks in an open room', () => {
    expect(chipValue('devops', input)).toBe(3);
  });

  it('counts only the tasks still waiting for a decision in Review, and hides at zero', () => {
    expect(chipValue('review', { ...input, stats: new Map([...stats, ['review', { count: 3 }]]) })).toBe(2);
    expect(chipValue('review', { ...input, reviewWaiting: 0 })).toBeNull();
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

  it('counts the tasks waiting on Earth for Blocked, from every room, not the tasks in the room', () => {
    const withBlocked = { ...input, stats: new Map([...stats, ['blocked', { count: 8 }]]), waitingOnEarth: 6 };
    expect(chipValue('blocked', withBlocked)).toBe(6);
    expect(chipValue('devops', withBlocked)).toBe(3);
  });

  it('hides the Blocked chip at zero waiting on Earth, even with tasks in the room', () => {
    const waitingOnOthers = { ...input, stats: new Map([...stats, ['blocked', { count: 2 }]]), waitingOnEarth: 0 };
    expect(chipValue('blocked', waitingOnOthers)).toBeNull();
  });
});

describe('visibleReadouts', () => {
  it('shows the focused room readout without a click', () => {
    expect([...visibleReadouts({ focus: 'done', selection: null, tvHot: false })]).toEqual(['done']);
    expect([...visibleReadouts({ focus: 'aborted', selection: null, tvHot: false })]).toEqual(['aborted']);
  });

  it('shows the Review readout when Review is focused, and keeps it while a task in Review is selected', () => {
    expect([...visibleReadouts({ focus: 'review', selection: null, tvHot: false })]).toEqual(['review']);
    const task = { kind: 'desk' as const, zoneId: 'review', taskId: 'TASK-EAR-390' };
    expect([...visibleReadouts({ focus: 'review', selection: task, tvHot: false })]).toEqual(['review']);
    expect(visibleReadouts({ focus: 'review', selection: { kind: 'room' as const, zoneId: 'review' }, tvHot: false }).size).toBe(0);
  });

  it('shows nothing for a room with no readout, or with no focus', () => {
    expect(visibleReadouts({ focus: 'dev', selection: null, tvHot: false }).size).toBe(0);
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

  it('shows the Blocked readout when that room is focused', () => {
    expect([...visibleReadouts({ focus: 'blocked', selection: null, tvHot: false })]).toEqual(['blocked']);
  });

  it('hides the Blocked readout only while the Blocked room itself is selected', () => {
    const room = { kind: 'room' as const, zoneId: 'blocked' };
    expect(visibleReadouts({ focus: 'blocked', selection: room, tvHot: false }).size).toBe(0);
  });

  it('keeps the Blocked readout while a task is selected, in Blocked or in another room', () => {
    const seat = { kind: 'desk' as const, zoneId: 'blocked', taskId: 'TASK-EAR-402' };
    const away = { kind: 'desk' as const, zoneId: 'dev', taskId: 'TASK-EAR-406' };
    expect([...visibleReadouts({ focus: 'blocked', selection: seat, tvHot: false })]).toEqual(['blocked']);
    expect([...visibleReadouts({ focus: 'blocked', selection: away, tvHot: false })]).toEqual(['blocked']);
  });

  it('still hides a Done or Aborted readout for a desk selected in that focused room', () => {
    const desk = { kind: 'desk' as const, zoneId: 'aborted', taskId: 'T' };
    expect(visibleReadouts({ focus: 'aborted', selection: desk, tvHot: false }).size).toBe(0);
  });
});

describe('placeCardClear', () => {
  const view = { w: 900, h: 600 };
  const size = { w: 250, h: 160 };
  const anchor: Rect = { left: 300, top: 200, right: 520, bottom: 380 };

  it('takes the usual spot beside the room when nothing is in the way', () => {
    const at = placeCardClear({ anchor, view, size, avoid: [] });
    expect(at.x).toBe(anchor.right + 12);
    expect(at.y).toBe(anchor.top);
  });

  it('moves off a readout that sits where the card would go', () => {
    const readout: Rect = { left: 520, top: 180, right: 840, bottom: 420 };
    const at = placeCardClear({ anchor, view, size, avoid: [readout] });
    const card: Rect = { left: at.x, top: at.y, right: at.x + size.w, bottom: at.y + size.h };
    expect(rectsOverlap(card, readout)).toBe(false);
  });

  it('stays inside the stage and covers the least when nothing is clear', () => {
    const everywhere: Rect = { left: 0, top: 0, right: view.w, bottom: view.h };
    const at = placeCardClear({ anchor, view, size, avoid: [everywhere] });
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.x + size.w).toBeLessThanOrEqual(view.w);
    expect(at.y + size.h).toBeLessThanOrEqual(view.h);
  });
});
