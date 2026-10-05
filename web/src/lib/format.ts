// Display formatting. Times in the player: "12:31" / "1:02:03". Study time and course length: "1h 12m".
import { dayAndMonth, dayOfWeekLabel, daysBetween, localDateKey } from './dates';

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

/** The running study timer: "<1m" · "12m" · "1h 23m" (header chip, sign-off card). */
export function formatElapsed(seconds: number): string {
  return seconds < 60 ? '<1m' : formatDuration(seconds);
}

/** formatElapsed for a screen reader: "less than 1 min" · "12 min" · "1 h 23 min". */
export function formatSpokenDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes === 0) return 'less than 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Local time of day, 24 h: "9:14" · "21:05" (when the timer started). */
export function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Tue 29 Sep" */
export function formatDay(key: string): string {
  const { day, month } = dayAndMonth(key);
  return `${dayOfWeekLabel(key)} ${day} ${month}`;
}

/** "12 Dec" */
export function formatShortDate(key: string): string {
  const { day, month } = dayAndMonth(key);
  return `${day} ${month}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** When Rahul wrote a message: "Today 21:05" · "Yesterday 07:00" · "Sat 18:30" · "Tue 22 Sep". */
export function formatMessageTime(iso: string, today: string): string {
  const d = new Date(iso);
  const key = localDateKey(d);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const ago = daysBetween(key, today);
  if (ago <= 0) return `Today ${time}`;
  if (ago === 1) return `Yesterday ${time}`;
  if (ago < 7) return `${dayOfWeekLabel(key)} ${time}`;
  return formatDay(key);
}
