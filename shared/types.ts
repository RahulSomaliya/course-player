// API contract between the course server (server/) and the web app (web/).
// Both sides import these types; change them here first, then both ends.

/** Stable id of a lecture or resource = its path relative to the course root,
 *  e.g. "05 Working With Components, Props, and JSX/13 Challenge #1 - Profile Card (v1).mp4".
 *  Progress in localStorage and in .player/data is keyed by it, so renaming a
 *  course file orphans that file's progress (acceptable; documented in CLAUDE.md). */
export type LectureId = string;

export type LectureKind = 'video' | 'article' | 'pdf';

export interface Resource {
  /** "CodeSandbox - Final v1", "GitHub Repository", "Theory Slides" */
  title: string;
  /** link = external URL parsed out of a redirect .html; pdf = served from /media */
  kind: 'link' | 'pdf';
  href: string;
}

export interface Lecture {
  id: LectureId;
  /** 13 for "13 Challenge #1 - Profile Card (v1).mp4" */
  number: number;
  title: string;
  kind: LectureKind;
  /** seconds; videos only (read from the mp4 header), 0 for article/pdf */
  duration: number;
  /** /media/<encodeURIComponent per path segment> */
  src: string;
  /** "NN.M ..." files attached to this lecture */
  resources: Resource[];
}

export interface Section {
  /** "05" — the folder's number prefix, zero-padded, unique */
  id: string;
  number: number;
  /** without the number prefix and without "(Optional)" */
  title: string;
  optional: boolean;
  /** set for "Part N - Title (K Projects)" divider folders */
  part: { number: number; projects: number | null } | null;
  lectures: Lecture[];
  /** sum of lecture durations, seconds */
  duration: number;
}

export interface Course {
  /** "react-2023" — the course JS Journey files her updates under, and the namespace of every browser
   *  storage key (`cp:<id>:<profile>:…`). v3: PINNED, never guessed from the folder name — see
   *  BootPayload.courseIdFrom (the 2026-10-05 incident: her copy's folder was not "React 2023"). */
  id: string;
  title: string;
  subtitle: string | null;
  sections: Section[];
  totals: { lectures: number; videos: number; duration: number };
}

export interface Profile {
  id: string; // "rahul", "mansi"
  name: string;
  /** true when this profile has a JS Journey link saved (the token never leaves the server) */
  journeyConnected: boolean;
}

/** Where the server got Course.id, first match wins (server/course-id.ts):
 *  'course.json' = `<course>/.player/course.json` `{ "id": "react-2023" }`, written by `npm run deploy`;
 *  'config.json' = the optional `courseId` in `.player/data/config.json`;
 *  'folder' = slug of the course folder name — a GUESS (logged loudly as `[scan]`): JS Journey only knows
 *  its own ids, so a copy in a folder not named "React 2023" got "react-course" and every update 4xx'd. */
export type CourseIdSource = 'course.json' | 'config.json' | 'folder';

export interface BootPayload {
  course: Course;
  profiles: Profile[];
  /** server build id; the web app shows nothing with it, QA uses it */
  version: string;
  /** v3: how course.id was resolved; 'folder' = guessed (JS Journey may not know it) */
  courseIdFrom: CourseIdSource;
  /** v3: slug of the course folder name — what v1/v2 used as course.id. Equal to course.id for a folder
   *  named "React 2023"; when it DIFFERS, this browser's pre-v3 data (the legacy `cp:<id>:<profile>:session`
   *  / `:pending` / `:wrap` keys, cached status + feed) sits under THIS id: read legacy keys under both, or
   *  an unsent v2 session is silently lost. */
  folderCourseId: string;
}

// ---- progress (per profile) -------------------------------------------------

export interface LectureProgress {
  /** last playback position, seconds */
  pos: number;
  done: boolean;
  doneAt: number | null; // epoch ms
}

export interface Prefs {
  rate: number; // 0.5..2
  volume: number; // 0..1
  muted: boolean;
  autoplay: boolean; // play next lecture after the countdown
  theme: 'light' | 'dark' | null; // null = follow the OS
}

export interface ProgressState {
  v: 1;
  /** epoch ms of the last local change — last-writer-wins between localStorage and the SSD copy */
  updatedAt: number;
  lectures: Record<LectureId, LectureProgress>;
  /** local date "YYYY-MM-DD" -> seconds studied that day (wall clock, see docs/spec.md "Study time") */
  days: Record<string, number>;
  lastLectureId: LectureId | null;
  prefs: Prefs;
}

// ---- JS Journey (Mansi's study tracker, https://js-journey-ten.vercel.app) ----
// The browser only ever talks to the local server; the server holds the
// student token and forwards. Contract mirrored in ~/Developer/js-journey (lib/player.ts).
// v2 (2026-10-01): one learner (Mansi); every sign-off is an "update" Rahul (coach) reads and
// replies to; replies + standalone coach notes come back as a feed; the player also pushes a
// progress snapshot so the coach sees exactly the stats she sees. See docs/spec-v2-coaching.md.
// v3 (2026-10-05, docs/spec-v3-study-timer.md): an update is NEVER dropped — rejected ones stay in the
// outbox (OutboxState.updates) until re-queued; updates are accepted while not connected; an unknown
// course id is a visible state (JourneyProblem), not a silent 204; JourneyStatus.plan.

/** What the player knows about her progress — the coach view renders these same numbers. */
export interface ProgressSnapshot {
  course: string; // Course.id
  /** epoch ms when the player computed it */
  takenAt: number;
  lecturesDone: number;
  lecturesTotal: number;
  videoSecondsDone: number;
  videoSecondsTotal: number;
  /** section numbers that are 100% done */
  sectionsDone: number[];
  /** the lecture "Continue" points at */
  current: { sectionNumber: number; lectureNumber: number; title: string } | null;
  /** local date "YYYY-MM-DD" -> seconds studied; last 120 days at most */
  days: Record<string, number>;
}

export interface JourneySession {
  /** uuid v4 made in the browser — JS Journey dedups on it, so retries are safe */
  id: string;
  course: string; // Course.id, e.g. "react-2023"
  startedAt: string; // ISO
  endedAt: string; // ISO
  /** local calendar date the session started on, "YYYY-MM-DD" */
  studyDate: string;
  /** wall-clock study minutes, rounded; 0 only for a note-only update (she studied away from the player) */
  minutes: number;
  /** section number she spent the most study time in (current section for a note-only update) */
  sectionNumber: number;
  lecturesCompleted: { section: number; lecture: number; title: string }[];
  /** sections that became 100% done during this session */
  finishedSections: number[];
  mood: string | null; // one of '😄' | '🙂' | '😐' | '😩' or null when skipped
  note: string | null;
  /** she ticked "I'm stuck" — the coach view flags the update */
  stuck: boolean;
  /** true when the player closed the session without her (app left open / closed without signing off) */
  autoClosed: boolean;
  /** progress right after this session — the coach's stats update with every update */
  progress: ProgressSnapshot | null;
}

export interface JourneyStatus {
  pace: 'ahead' | 'on-track' | 'behind';
  /** study days ahead (+) or behind (-) the plan */
  daysDelta: number;
  week: number;
  totalWeeks: number;
  targetDate: string; // "YYYY-MM-DD"
  deadline: string; // "YYYY-MM-DD"
  goal: { sectionNumber: number; title: string; due: string } | null;
  coachNote: { body: string; createdAt: string } | null;
  /** the plan break in progress, else the next one starting within 14 days, else null.
   *  Dates inclusive, "YYYY-MM-DD". Break days are not study days: no pace is lost on them. */
  planBreak: { label: string; start: string; end: string } | null;
  /** section number -> "YYYY-MM-DD" it is due by (the Friday of the plan week that finishes it) */
  sectionDue: Record<string, string>;
  /** sections her plan skips (React: [4], the JS review she no longer needs) */
  skippedSections: number[];
  /** the plan's study weekdays, ISO 1 = Mon … 7 = Sun (React: [1,2,3,4,5]). With planBreaks, the calendar
   *  the streak walks (web/src/lib/stats.ts streak = JS Journey lib/stats.ts): a missed study day ends it,
   *  a quiet weekend / break day does not. */
  studyWeekdays: number[];
  /** EVERY plan break, inclusive "YYYY-MM-DD" (planBreak is only the current / next one — a streak walking
   *  back through last month's break needs it too) */
  planBreaks: { label: string; start: string; end: string }[];
  /** v3: her whole plan, week by week — exactly the coach page's rows (JS Journey lib/journey-view.ts
   *  planRows), breaks in place. Optional: a JS Journey deployed before it, or a status cached before it,
   *  has none (the "See full plan" toggle hides). A malformed plan is dropped by the server (logged), the
   *  rest of the status is kept. */
  plan?: PlanRow[];
}

/** One row of her plan (JS Journey lib/journey-view.ts PlanRow — change both together). */
export type PlanRow =
  | {
      kind: 'week';
      week: number;
      /** the Friday this week's goal is due, "YYYY-MM-DD" */
      due: string;
      /** "§7 Thinking In React" or "Keep going: §29 …" */
      goal: string;
      /** past = a "keep going" week whose date passed with its section still open (not a miss) */
      state: 'done' | 'current' | 'behind' | 'upcoming' | 'past';
    }
  /** a plan break (Diwali), inclusive "YYYY-MM-DD"; now = today falls inside it */
  | { kind: 'break'; label: string; start: string; end: string; now: boolean };

/** A coach reply to one of her updates, or a standalone coach note. */
export interface CoachMessage {
  id: string;
  body: string;
  createdAt: string; // ISO
  /** when Mansi saw it (player or her web page); null = unread for her */
  readAt: string | null;
}

/** One of her sign-offs, as the feed returns it. */
export interface StudentUpdate {
  id: string; // JourneySession.id for player updates; log row id for manual ones
  source: 'player' | 'manual';
  studyDate: string;
  createdAt: string; // ISO
  minutes: number;
  sectionNumber: number | null;
  sectionTitle: string | null;
  lectures: { section: number; lecture: number; title: string }[];
  mood: string | null;
  note: string | null;
  stuck: boolean;
  /** when Rahul read it; null = unread for the coach */
  coachReadAt: string | null;
  replies: CoachMessage[]; // oldest first
}

export interface JourneyFeed {
  /** newest first; at most `limit` (default 30) */
  updates: StudentUpdate[];
  /** standalone coach notes (not replies), newest first */
  notes: CoachMessage[];
  /** FIRST page only ([] on later pages): older updates — not in `updates` — that carry a coach reply
   *  she has not seen, newest first, replies threaded. "From Rahul" = the unread replies in `updates`
   *  AND these: built from `updates` alone, a reply to an update outside the first page was never shown
   *  or marked read while unreadForStudent kept counting it. Optional: a JS Journey deployed before it
   *  (or a feed cached before it) has none. */
  unreadReplies?: StudentUpdate[];
  /** coach replies + notes she has not seen yet */
  unreadForStudent: number;
  /** opaque cursor for the next page of updates, null at the end */
  nextCursor: string | null;
}

// Local server routes (the browser calls these; the server forwards to JS Journey with the token):
//   GET  /api/journey/:profile/status            -> JourneyStatus | 204 (not connected / unreachable /
//                                                   malformed) | 409 JourneyProblem (v3: JS Journey does
//                                                   not know this course id — show it, never hide it)
//   POST /api/journey/:profile/sessions          body JourneySession -> 202 OutboxState (queued, retried).
//                                                   v3: accepted while NOT connected too (delivered once
//                                                   she connects); 400 only for a body JS Journey would
//                                                   reject anyway; 409 { error } = a CHANGED copy of an
//                                                   update already delivered (JS Journey would answer
//                                                   "duplicate" and drop it) — `error` is hers to read.
//                                                   The same update again = 202, a no-op
//   GET  /api/journey/:profile/outbox?wait=<ms>  -> OutboxState. wait (0–10000, default 0) = answer once
//                                                   the deliveries in flight have settled, or after <ms>:
//                                                   POST an update, then GET ?wait=8000 tells delivered /
//                                                   still queued / rejected in one round trip
//   POST /api/journey/:profile/outbox/retry      body {} | { ids: string[] } -> 202 OutboxState: re-queues
//                                                   the rejected updates (all, or those ids) and starts a
//                                                   delivery ("Try again"). Also done on every server
//                                                   start and on (re)connect
//   GET  /api/journey/:profile/feed?cursor=      -> JourneyFeed | 204; served from the last good copy
//                                                   (header x-course-player-stale: 1) when offline
//   POST /api/journey/:profile/feed/read         body { ids: string[] } -> 202 (queued, retried); 409 when
//                                                   not connected
//   PUT  /api/journey/:profile/progress          body ProgressSnapshot -> 202 (latest wins, retried); 409
//                                                   when not connected
//   PUT  /api/profiles/:profile/journey          body { link } -> 200 Profile | 400 malformed link | 502
//                                                   JS Journey refused the link / unreachable | 409
//                                                   JourneyProblem (the link is fine, the course id is not)
// JS Journey routes (Bearer = her student token): GET /api/player/status, POST /api/player/sessions,
//   GET /api/player/feed?course=&cursor=&limit=, POST /api/player/feed/read, PUT /api/player/progress.

/** v3: why JS Journey cannot be used for this copy of the course, as the 409 body of the status and
 *  connect routes (`error` = the sentence to show her). Today one kind: JS Journey answered 404
 *  "unknown course" for Course.id — the copy's id is wrong (fix: `.player/course.json`, see README). */
export interface JourneyProblem {
  error: string;
  problem: 'unknown-course';
  /** the id this copy asked JS Journey about */
  courseId: string;
}

/** v3: one of her updates as the outbox knows it. `at` (ISO): queued = when she sent it (its endedAt);
 *  rejected = when JS Journey refused it; delivered = when JS Journey took it (2xx). A queued or rejected
 *  update carries the whole session, so the web can list it (and re-send an edited copy) after a reload.
 *  An id appears once: queued beats rejected beats delivered. */
export type OutboxUpdate =
  | { id: string; state: 'queued'; at: string; error: null; session: JourneySession }
  /** JS Journey answered 4xx; `error` = "HTTP 400 — <its message>". Kept until re-queued — never dropped. */
  | { id: string; state: 'rejected'; at: string; error: string; session: JourneySession }
  | { id: string; state: 'delivered'; at: string; error: null };

/** The outbox (<data>/outbox-<profile>.json) as the browser sees it. */
export interface OutboxState {
  /** her updates still waiting to be delivered (state 'queued'); rejected ones are NOT counted (v2 field) */
  pending: number;
  /** what went wrong in the latest delivery attempt (any kind: update, read receipt, snapshot); null once
   *  a delivery went through cleanly (v2 field) */
  lastError: string | null;
  /** v3: every queued and rejected update + receipts of the last 50 delivered ones, newest `at` first */
  updates: OutboxUpdate[];
}
