/** Muted, desaturated tones for the pieces that need their own color. None of them is a status color. */
export const QA_LAB_COLORS = {
  paper: '#bdb8ad',
  paperCrumpled: '#a9a498',
  panelA: '#8a9299',
  panelB: '#a29e90',
  panelC: '#8c9690',
  line: '#c4c0b6',
  check: '#8a8f96',
} as const;

export type QaBucket = 'wood' | 'metal' | 'fabric';

export interface QaBox {
  part: 'rack' | 'board' | 'bin' | 'magnifier' | 'rug' | 'table';
  bucket: QaBucket;
  /** Room-local center. y is height above the floor slab. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export interface QaTinted {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}

const box = (part: QaBox['part'], bucket: QaBucket, x: number, y: number, z: number, w: number, h: number, d: number): QaBox =>
  ({ part, bucket, x, y, z, w, h, d });

/** Val.Failed room-local, +z is the door. Back wall z -1.7, left wall x -2.1; the desk row sits at z 0.35. */
const DIMS = {
  rack: { x: -1.5, z: -1.5, w: 0.8, h: 0.9, d: 0.3 },
  board: { x: -2.04, y: 0.62, z: -0.55, w: 0.06, h: 0.5, d: 0.8 },
  bin: { x: 1.1, z: -1.3, w: 0.34, h: 0.4, d: 0.34 },
  table: { x: -0.5, z: -1.4, w: 0.7, h: 0.4, d: 0.4 },
  rug: { x: 0, z: 0.6, w: 3.6, d: 1.5 },
  plant: { x: 1.88, z: -1.48 },
} as const;

function tintedPieces(): QaTinted[] {
  const out: QaTinted[] = [];
  const { rack, board, bin, table } = DIMS;
  // Indicator panels: a 3 x 2 grid on the rack front, flat and not emissive.
  const panels = [QA_LAB_COLORS.panelA, QA_LAB_COLORS.panelB, QA_LAB_COLORS.panelC];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out.push({
        x: rack.x - 0.24 + col * 0.24, y: 0.3 + row * 0.38, z: rack.z + rack.d / 2 + 0.01,
        w: 0.16, h: 0.12, d: 0.02, color: panels[(row + col) % panels.length],
      });
    }
  }
  // Checklist: a line and a box per row, no text.
  for (let row = 0; row < 3; row += 1) {
    const y = 0.76 - row * 0.15;
    out.push({ x: board.x + 0.04, y, z: board.z + 0.12, w: 0.02, h: 0.03, d: 0.42, color: QA_LAB_COLORS.line });
    out.push({ x: board.x + 0.04, y, z: board.z - 0.3, w: 0.02, h: 0.07, d: 0.07, color: QA_LAB_COLORS.check });
  }
  // Crumpled papers around the reject bin, and one sheet under the magnifier.
  out.push({ x: bin.x - 0.26, y: 0.05, z: bin.z + 0.2, w: 0.11, h: 0.1, d: 0.1, color: QA_LAB_COLORS.paperCrumpled });
  out.push({ x: bin.x + 0.2, y: 0.04, z: bin.z + 0.28, w: 0.09, h: 0.08, d: 0.09, color: QA_LAB_COLORS.paper });
  out.push({ x: bin.x - 0.06, y: bin.h + 0.04, z: bin.z, w: 0.14, h: 0.09, d: 0.12, color: QA_LAB_COLORS.paperCrumpled });
  out.push({ x: table.x - 0.12, y: table.h + 0.01, z: table.z + 0.02, w: 0.22, h: 0.015, d: 0.16, color: QA_LAB_COLORS.paper });
  return out;
}

/** The QA table is fixed, so what lives on it does not follow the desks. */
export const QA_LAB = { ...DIMS, tinted: tintedPieces() };

/** Plain-colored pieces for the merged decor. Wood, metal and fabric only: no shade, so nothing here glows. */
export function qaLabBoxes(): QaBox[] {
  const { rack, board, bin, table, rug } = DIMS;
  return [
    box('rack', 'metal', rack.x, rack.h / 2, rack.z, rack.w, rack.h, rack.d),
    box('board', 'wood', board.x, board.y, board.z, board.w, board.h, board.d),
    box('bin', 'metal', bin.x, bin.h / 2, bin.z, bin.w, bin.h, bin.d),
    box('table', 'wood', table.x, table.h - 0.02, table.z, table.w, 0.04, table.d),
    box('table', 'metal', table.x - table.w / 2 + 0.04, (table.h - 0.04) / 2, table.z, 0.04, table.h - 0.04, table.d - 0.06),
    box('table', 'metal', table.x + table.w / 2 - 0.04, (table.h - 0.04) / 2, table.z, 0.04, table.h - 0.04, table.d - 0.06),
    // Magnifier arm on the table: stand, boom, and a square frame for the lens.
    box('magnifier', 'metal', table.x + 0.2, table.h + 0.15, table.z - 0.08, 0.03, 0.3, 0.03),
    box('magnifier', 'metal', table.x + 0.12, table.h + 0.3, table.z - 0.02, 0.2, 0.025, 0.025),
    box('magnifier', 'metal', table.x + 0.04, table.h + 0.22, table.z + 0.04, 0.16, 0.015, 0.015),
    box('magnifier', 'metal', table.x + 0.04, table.h + 0.16, table.z + 0.04, 0.16, 0.015, 0.015),
    box('magnifier', 'metal', table.x - 0.04, table.h + 0.19, table.z + 0.04, 0.015, 0.075, 0.015),
    box('magnifier', 'metal', table.x + 0.12, table.h + 0.19, table.z + 0.04, 0.015, 0.075, 0.015),
    box('rug', 'fabric', rug.x, 0.008, rug.z, rug.w, 0.016, rug.d),
  ];
}
