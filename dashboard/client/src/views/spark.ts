// SVG polyline points for a small multi-series sparkline. `max` is shared by
// every series drawn on the same chart so their heights compare.
export function sparkPolylinePoints<T>(
  points: T[],
  key: keyof T,
  max: number,
  width = 100,
  height = 34,
  padding = 2,
): string {
  const top = Math.max(1, max);
  const plotW = width - padding * 2;
  const plotH = height - padding * 2;

  return points.map((p, i) => {
    const x = padding + (i / Math.max(1, points.length - 1)) * plotW;
    const y = padding + plotH - (Number(p[key]) / top) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
