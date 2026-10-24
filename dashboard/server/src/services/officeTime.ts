/**
 * The office's time zone. status.yaml dates (created_at, completed_at, updated_at) are written as
 * local dates, so a bare date means local midnight and days are bucketed by local date; in UTC a run
 * opened after Bangkok midnight was "in the future" until 07:00 and the last bar lagged a day.
 */
const OFFICE_TZ = process.env.OFFICE_TZ || 'Asia/Bangkok';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const partsFormat = new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Office-local wall clock minus UTC at instant t. */
function tzOffsetMs(t: number): number {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/** "YYYY-MM-DD" in the office's time zone. */
export function localDay(t: number): string {
  return dayFormat.format(new Date(t));
}

/** A status.yaml date or timestamp as epoch ms; a bare date is midnight in the office's time zone. */
export function officeMs(value: string | null | undefined): number {
  if (!value) return NaN;
  if (DATE_ONLY.test(value)) {
    const utcMidnight = Date.parse(`${value}T00:00:00Z`);
    return utcMidnight - tzOffsetMs(utcMidnight);
  }
  return Date.parse(value);
}

/** The local day a date-only or timestamp field falls on. */
export function dayOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (DATE_ONLY.test(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? localDay(t) : undefined;
}
