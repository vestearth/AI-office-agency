import type { RunsTrendPoint } from '../../../shared/types';

export function sparkPolylinePoints(
  trends: RunsTrendPoint[],
  key: keyof RunsTrendPoint,
  width = 100,
  height = 34,
  padding = 2,
): string {
  const max = Math.max(1, ...trends.map((t) => t.total));
  const plotW = width - padding * 2;
  const plotH = height - padding * 2;

  return trends.map((t, i) => {
    const x = padding + (i / Math.max(1, trends.length - 1)) * plotW;
    const y = padding + plotH - (Number(t[key]) / max) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
