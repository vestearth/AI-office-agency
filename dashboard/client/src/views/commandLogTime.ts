type StampMode = 'date' | 'time' | 'moment';

export function formatLiveLogStamp(value: string | undefined, mode: StampMode): string {
  if (!value) return mode === 'date' ? '---- -- --' : '--:--:--';

  // A hand-off moment: "10-16 14:05" when the value carries a time of day, else its date.
  if (mode === 'moment') {
    const d = new Date(value);
    if (!value.includes('T') || isNaN(d.getTime())) return formatLiveLogStamp(value, 'date');
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  if (mode === 'date') {
    const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return dateOnly ? dateOnly[1] : '---- -- --';
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8);
}
