// Display formatting. Times in the player: "12:31" / "1:02:03". Study time and course length: "1h 12m".
import { dayAndMonth, dayOfWeekLabel } from './dates';

export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "Tue 29 Sep" */
export function formatDay(key: string): string {
  const { day, month } = dayAndMonth(key);
  return `${dayOfWeekLabel(key)} ${day} ${month}`;
}

/** "12 Dec"; "8 Jan 2027" when `reference` (today) is given and the year differs — a far-off finish
 *  estimate must not read as this year. */
export function formatShortDate(key: string, reference?: string): string {
  const { day, month } = dayAndMonth(key);
  const year = key.slice(0, 4);
  return reference !== undefined && reference.slice(0, 4) !== year ? `${day} ${month} ${year}` : `${day} ${month}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
