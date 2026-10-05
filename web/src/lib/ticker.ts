// WHERE she studies: a 1 s ticker counts seconds while a lecture plays (or an article is read). v3
// (docs/spec-v3-study-timer.md A3): it only picks the update's section (StudySession.sectionSeconds) —
// it no longer decides HOW LONG (the wall-clock timer does) and never writes ProgressState.days.
// Deltas come from performance.now() (monotonic; immune to clock changes) and each tick is capped at
// 5 s: a laptop that sleeps mid-video resumes with one huge delta, which must never become hours.

export const TICK_CAP_SECONDS = 5;
/** An open article/pdf counts only with user input in the last 3 min. */
export const IDLE_INPUT_MS = 3 * 60_000;

export interface StudySignals {
  /** a lecture video is playing */
  playing: boolean;
  /** an article or pdf lecture is open */
  reading: boolean;
  /** document.visibilityState === 'visible' */
  visible: boolean;
  /** performance.now() of the last pointer/key/scroll input */
  lastInputAt: number;
  now: number;
}

export function isStudying(s: StudySignals): boolean {
  if (s.playing) return true;
  return s.reading && s.visible && s.now - s.lastInputAt <= IDLE_INPUT_MS;
}

export class StudyTicker {
  private last: number;
  private carry = 0;

  constructor(now: number) {
    this.last = now;
  }

  /** Returns the whole seconds to credit for the time since the previous tick. */
  tick(now: number, studying: boolean): number {
    const delta = Math.min(Math.max(0, (now - this.last) / 1000), TICK_CAP_SECONDS);
    this.last = now; // a backwards step (never expected from performance.now) just re-baselines
    if (!studying) {
      this.carry = 0;
      return 0;
    }
    this.carry += delta;
    const whole = Math.floor(this.carry + 1e-9);
    this.carry -= whole;
    return whole;
  }
}
