// The Home plan strip (journey-connected profiles): pace pill, week + goal line, break line, coach note.
// During a plan break (Mansi's Diwali break) there is no pace to keep, so the strip says so warmly.
import type { JourneyStatus } from '../../../shared/types';
import { addDays } from './dates';
import { formatDay } from './format';

export interface PlanView {
  /** null during a break */
  pace: { label: string; tone: 'good' | 'quiet' } | null;
  line: string;
  /** active = the break is on today; otherwise an upcoming break (JS Journey sends those ≤ 14 days ahead) */
  breakLine: { active: boolean; text: string } | null;
  note: JourneyStatus['coachNote'];
}

function days(n: number): string {
  const abs = Math.abs(n);
  return `${abs} ${abs === 1 ? 'day' : 'days'}`;
}

function paceOf(s: JourneyStatus): NonNullable<PlanView['pace']> {
  if (s.pace === 'ahead') return { label: s.daysDelta > 0 ? `Ahead by ${days(s.daysDelta)}` : 'Ahead', tone: 'good' };
  if (s.pace === 'behind') return { label: s.daysDelta < 0 ? `Behind by ${days(s.daysDelta)}` : 'Behind', tone: 'quiet' };
  return { label: 'On track', tone: 'good' };
}

export function describePlan(s: JourneyStatus, today: string): PlanView {
  const week = `Week ${s.week} of ${s.totalWeeks}`;
  const goal = s.goal ? ` · Goal: finish §${String(s.goal.sectionNumber).padStart(2, '0')} by ${formatDay(s.goal.due)}` : '';
  // `?? null`: a JS Journey deployed before planBreak existed omits the field entirely.
  const brk = s.planBreak ?? null;
  const onBreak = brk !== null && brk.start <= today && today <= brk.end;
  let breakLine: PlanView['breakLine'] = null;
  if (brk !== null && onBreak) breakLine = { active: true, text: `${brk.label} · back on ${formatDay(addDays(brk.end, 1))}` };
  else if (brk !== null && brk.start > today) breakLine = { active: false, text: `${brk.label} from ${formatDay(brk.start)} to ${formatDay(brk.end)}` };
  return { pace: onBreak ? null : paceOf(s), line: `${week}${goal}`, breakLine, note: s.coachNote };
}
