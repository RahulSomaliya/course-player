# v4 — honest pace, her projection, a kinder chart, a calmer coach page (2026-10-12)

Builds on `spec-v3-study-timer.md`. Both apps change: the Course Player (this repo) and JS Journey
(`~/Developer/js-journey`). Contract: `shared/types.ts` here = `lib/player.ts` there. All new fields
are OPTIONAL in the player (an old JS Journey or an old cached status must still render).
Creed unchanged: "Less, but better". Warm to her, honest to him. 12 h times.

## Rahul's asks (2026-10-12, Mansi's first full week)

1. **No "§".** "§09" → "09" everywhere, both apps (goal lines, update facts, sign-off summary, Watch
   sidebar "Next:", "Up next in the player: 07 · lecture 1 — Section Overview", plan rows, coach pages).
2. **The pace is wrong.** Monday of week 2, goal "Finish 09 by Fri 16 Oct", she is on 07 (06 done) —
   and both apps said "Behind by 3 days". She is ahead. Fix it. Then **tell her, dynamically, how much
   is left and when she will finish if she keeps her current pace.**
3. **The 30-day chart:** the average must not be diluted by the days before she started (2 h a day read
   as "avg 24m"). And a subtle **appreciation when a day meets her expected hours**; no visual clue when
   it doesn't.
4. **Coach page gets all of it** (no §, the real pace, the projection, the chart).
5. **Coach plan:** each week is expandable — ONE at a time, smooth — and shows what is under it: the
   same Part → section → lecture view she has on her home.
6. **Coach history:** only the last day of updates by default; "Older updates" shows the rest.
7. **Coach "Send Mansi a note":** much smaller — a quiet optional thing that opens only when clicked.

## Root cause of the wrong pace (JS Journey `lib/status.ts` `planPace`)

- "Finished" came only from session LOGS (`finishedSectionIds(logs)`: sections that became 100 % done
  DURING a signed-off session). A section finished outside a session, or with one lecture/article left
  unticked, never counts — and the loop stops at the FIRST unfinished core section, so everything
  after it is ignored.
- Only WHOLE sections counted; being 80 % through a section counted as 0.
- Week 1's goal (through 05) therefore looked unmet → `finished < owed` → "Behind by ⌈gap⌉ days".
  The plan rows ("Week 1 Behind") and `planGoal` read the same logs.

## Contract (v4)

```ts
// ProgressSnapshot (additive)
/** section number -> the lecture numbers she has done in it, ascending. The coach page's
 *  week → section → lecture view reads it. Optional: an older player sends none. */
doneLectures?: Record<string, number[]>;

// JourneyStatus (additive; pace/daysDelta keep their names with the NEW meaning below)
/** the plan's first study day, "YYYY-MM-DD" (React: 2026-10-05) */
startDate?: string;
/** the plan's study minutes per study day (React: 150 = 2.5 h) — a day at or over it is "goal met" */
dailyGoalMinutes?: number;
/** where her CURRENT pace lands; null until there is a snapshot and ≥ 2 elapsed study days with study */
projection?: {
  /** the study day she finishes on at this pace, "YYYY-MM-DD" (breaks skipped) */
  finish: string;
  /** whole study days left at this pace */
  studyDaysLeft: number;
  /** lecture (video) minutes of COUNTED sections she covers per elapsed study day so far */
  minutesPerStudyDay: number;
  /** study days between finish and targetDate: + = before the target, - = after it */
  vsTarget: number;
} | null;
```

## Rules

### Pace (JS Journey computes; the player only prints it — one model, `lib/status.ts`)
- **Progress = content, not whole sections.** From the latest progress snapshot: lecture-video minutes
  done in COUNTED sections (skipped sections like 04 excluded; with `doneLectures` + the outline that is
  exact; without it fall back to `videoSecondsDone`). No snapshot yet → the old logs-based numbers.
- **Expected today = prorated plan, not today's end.** For the current plan week: expected = content
  owed through LAST week's milestone + this week's content × (study days of this week elapsed BEFORE
  today ÷ study days in this week). Today is never held against her until it is over (Monday morning
  expects exactly last week's goal). Break days are not study days.
- `daysDelta` = round((done − expected) ÷ the current week's content per study day); `|daysDelta| < 1` →
  on track. Ahead/behind words come from `daysDelta` alone (both apps' existing `paceLabel`/`paceOf`).
- **"Finished" anywhere** (plan row states, `planGoal`, the "done" marks) = snapshot `sectionsDone` ∪
  the logs. Never logs alone.

### Projection
- Rate = counted lecture minutes done ÷ elapsed plan study days from `startDate` through today (today
  counts only if today has ≥ 5 min of study). Left = counted minutes remaining. `studyDaysLeft` =
  ⌈left ÷ rate⌉; `finish` = that many study days after today (breaks skipped; today counts as a day if
  she has not studied yet). `vsTarget` in study days.
- Words (one formatter per app, mirrored, tested with the same table):
  "At your pace — about 1h 25m of lectures a study day — you'll finish around **Fri 27 Nov**,
  4 weeks before your target." · |vsTarget| < 3 days → "…, right around your target." · after →
  "…, 2 weeks after your target." (≥ 5 study days → weeks, rounded; else days). Coach page: the same
  line with "her"/"she'll".
- Player: a quiet line at the bottom of **This week**. Coach: a quiet line under her stats row.
  Hidden while `projection` is null/absent.

### Chart + daily goal (both apps; `web/src/lib/stats.ts` = JS Journey `lib/stats.ts`, one test table)
- **Average** = total study seconds from `startDate` through today ÷ elapsed plan study days in that
  range (today counted only with ≥ 5 min). Weekend study adds to the total, never to the divisor. No
  `startDate` → the day of her first study as the start. Label stays "avg 2h 5m".
- **Goal met** = a day with ≥ `dailyGoalMinutes` of study. Those bars are `accent` with a small accent ✓
  above them; every other day (today included, when not met) is `chart-bar`. No goal line, no
  "x min left", nothing marks a short day. Today keeps its "Today" axis label.
- **Today stat**: met → the number + a small accent ✓ and "Daily goal met" (`accent-ink`); not met → the
  number alone.
- **The moment (player only):** when today's total (signed-off + the running timer) first crosses the
  goal, the Today ✓ draws in and the today bar turns accent with one soft rise (≤ 600 ms) — once per
  day (remember the date), never on a reload after it already happened, instant under reduced motion.
  No confetti, no toast.

### Coach page (JS Journey `/r`)
- **Plan accordion:** every week row (not the break) is a button; ONE week open at a time (opening one
  closes the other), height + chevron animate like the player's `Collapse` (grid rows 220 ms,
  cubic-bezier(0.22,1,0.36,1); instant under reduced motion). Open week = the sections that week
  covers (after last week's through-section up to this week's; a "keep going" week = the section it
  continues), grouped under their Part header (overline "PART 2" + title), each section a row
  (number · title · quiet ✓ when done · length) that opens its lectures (✓ done / current dot / plain ·
  title · length). The current section opens by default inside the current week. Data: the React outline
  (committed JSON generated from the SSD — titles, numbers, kinds, seconds) + the latest snapshot's
  `doneLectures` / `current` / `sectionsDone`. Without `doneLectures`, sections still show ✓ from
  `sectionsDone` and lectures show no marks.
- **History:** only the updates of the most recent day that has any (her study day, IST), then a quiet
  "Older updates" button that reveals the rest of the page; the existing pager continues from there.
  The unread inbox above is unchanged.
- **Send Mansi a note:** collapsed by default to one quiet text button ("Send Mansi a note"); clicking
  opens the composer (and his sent-notes list). After sending it folds back with a quiet "Sent".

## Out of scope
- Wording of a Part-divider goal ("Finish 09 Part 2 - Intermediate React (2 Projects)") stays as is.
- No DB migration: everything reads the existing snapshot row / config.
