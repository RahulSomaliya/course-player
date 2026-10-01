// Local calendar dates as "YYYY-MM-DD" keys. Study time is keyed by the LOCAL day (spec "Study time"),
// so a late-night session lands on the day the learner lived it, not the UTC one.
// Key arithmetic goes through Date.UTC so a DST change can never make a "day" 23 or 25 hours long.

const pad = (n: number): string => String(n).padStart(2, '0');

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(): string {
  return localDateKey(new Date());
}

function utcOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function keyOfUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

export function addDays(key: string, n: number): string {
  return keyOfUtc(utcOf(key) + n * DAY_MS);
}

/** b − a in whole days */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function dayOfWeekLabel(key: string): string {
  return WEEKDAYS[new Date(utcOf(key)).getUTCDay()] as string;
}

export function dayAndMonth(key: string): { day: number; month: string } {
  const d = new Date(utcOf(key));
  return { day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()] as string };
}
