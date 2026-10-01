# Course Player v2 — one student, one coach (2026-10-01)

Supersedes the parts of `docs/spec.md` it contradicts. Contract: `shared/types.ts`.

**Who:** Mansi is the only student (she studies Jonas's React course in this app, on the SSD). Rahul is
her coach; he never studies here. He coaches from **JS Journey** (`~/Developer/js-journey`, web):
he reads every update she sends when she signs off, replies, and watches the same stats she sees. If
she falls off track, he brings her back. Design creed unchanged: **"Less, but better."** Show only
what is essential and actually used; nothing that diverts her attention from studying.

Rahul's sign-off on the plan (verbatim decisions):
1. Only Mansi — the app opens straight to her. No "Who's studying?", no profiles UI. Rahul's test progress is dropped.
2. Her home, top to bottom: Rahul's feedback (unread first, big) → Continue → This week (goal, section
   due date, course due date, on pace?) → her history (streak, hours, 30-day chart, past updates with
   Rahul's replies) → course content.
3. Sign off: a "Sign off" button always in the header. A card that already shows time studied +
   lectures; she adds a note, a mood, and can tick "I'm stuck". Every sign-off is one update for Rahul
   (1–3 a day is normal).
4. Course content: a closed section shows only its title, a quiet ✓ when done, its length on hover.
   Parts are clear group headers with their sections under them. Lectures show only when a section is
   open. The Watch sidebar shows only the section she is in.
5. "finish ≈ 4 Feb 2027" goes. It becomes "Due Fri 25 Dec · On track" from her plan.
6. Motion: the Continue picture grows into the player; sections slide open; ticks draw in; numbers
   and the chart rise on load. All of it off with the Mac's "reduce motion".
7. Coach view (JS Journey, web): unread updates on top, each with its own reply box; read ones fold
   into a history; the same stats she sees, live (the player sends her progress).
8. His replies show up in her app (and her JS Journey page), marked new until she sees them.
9. Both JS Journey pages (hers and his) redesigned in the course-player look. JS history kept, tucked away.
10. Nothing goes live (prod DB change, deploy) without Rahul's yes.

## A. Course Player changes

### Single learner
`config.json` keeps a `profiles` array for the server, but the web app uses the first profile and
never shows a picker, avatar switcher or profile name UI. Remove `WhoScreen` and the switching code
(delete, don't hide). The small header menu keeps: theme (System/Light/Dark) and "JS Journey:
Connected / Connect…" (Rahul sets it up once; paste her `/m/<token>` link).

### Header
Course title (left; on Watch it is the back link) · **Sign off** (always there; shows the live session
time inside it while studying, e.g. "Sign off · 42m"; a small dot when an earlier session still waits
for her note) · menu · Quit. Quit with an unsigned session opens the sign-off card first ("Sign off &
quit"), then stops.

### Sign-off card (= one update for Rahul)
- Auto summary at the top: studied time since the last sign-off, the lectures completed since then
  (titles, compact; "+4 more" past 5), the section. Nothing for her to fill in there.
- Note (the main field; placeholder like "What did you learn? Anything unclear?"), 4 moods, an
  "I'm stuck" toggle (flags it for Rahul). Primary **Send to Rahul**. Quiet "Send without a note".
- After send: a short success moment ("Sent ✓"), card closes, the session resets to 0.
- Note-only updates are allowed (she studied away from the player): minutes 0.
- A session under 5 min with no note is not sent.
- Idle 20 min no longer sends anything by itself: the session just stops growing and the header
  button shows the waiting dot. If she closes the app without signing off, the next app open shows the
  card for that earlier session ("You studied 1h 12m on Tue — add a note for Rahul?"); "Send without
  a note" sends it with `autoClosed: false`. A pending session older than 24 h that she still skips
  is sent with `autoClosed: true` so Rahul never misses study time.
- Every update carries `progress: ProgressSnapshot`.

### Progress snapshot
After each sign-off, on Quit, and debounced (≤ 1 per 5 min) when progress changes, the web app PUTs a
`ProgressSnapshot` to the local server, which forwards it (latest wins, retried with the outbox
cadence). That is how the coach sees her exact numbers.

### Feed (Rahul → Mansi)
GET the feed on app open, on focus after 5 min, and after a sign-off. Cache the last good feed in
localStorage too (the server also serves its last good copy when offline).
- **Top of home: "From Rahul"** — every unread coach reply/note, newest first. A reply shows the
  snippet of her update it answers ("On your Tue update: 'useEffect cleanup confused me'"). One
  "Got it" marks them read (POST feed/read) with a calm acknowledgement. Nothing unread → the block
  is absent (no empty card).
- **History** (below stats/chart): "Your updates" — her latest 3 updates, each with Rahul's replies
  threaded under it; "See all" opens `#/updates` (full list, paginated with the cursor, same layout).

### This week + stats (no more ETA)
- "This week" block from `JourneyStatus`: Week 3 of 10 · goal "Finish §12 Effects and Data
  Fetching by Fri 23 Oct" · pace pill (Ahead by N days / On track / Behind by N days) · course due
  "Fri 25 Dec". During a break: "Diwali break · back Mon 16 Nov" instead of a pace.
- Stats row (max 4): Today · Streak · Complete (% + n / total lectures) · **Due** (course target date
  + pace word). Remove the finish-date projection and its code. Not connected / offline → Due shows
  the last cached status, else is omitted.

### Course content (home)
- Part header = a real level above sections: overline "PART 1", title "React Fundamentals", quiet
  "4 projects"; sections sit under it as a visibly nested group. The part's own intro lectures
  ("Introduction to Part 1", "Useful Resources for Part 1") live inside the part as a collapsible
  "Part introduction" row like a section — never as loose lecture rows.
- Closed section row: number · title · quiet ✓ if 100% done. Duration (and due date) appear on
  hover/focus only. No progress bars, no counts, no "Optional" badges. Her plan skips §04 →
  render it dimmed with a quiet "Skipped" (from `JourneyStatus.skippedSections`; none when unknown).
- The section she is in shows a subtle "you're here" mark and its due date ("due Fri 9 Oct").
- Open section: lecture rows (✓ done / current dot / plain), title, duration, resource count.
  Lectures render only while their section is open.
- Course header line stays: "31 sections · 410 lectures · 67h 10m".

### Watch sidebar
Only the current section: header "Section 07 · Thinking In React - State Management" + due date +
‹ › to step to the previous/next section (still only one section listed at a time). Bottom: "Next:
§08 Practice Project - Eat-'N-Split". No other sections.

### Motion (professional, quiet, purposeful)
- Home → Watch: the View Transitions API morphs the Continue thumbnail into the player
  (`view-transition-name` on both; feature-detect `document.startViewTransition`).
- Section open/close: height via `grid-template-rows: 0fr → 1fr`, ~220 ms, chevron rotates; lecture
  rows fade/rise with a ≤ 15 ms stagger (cap the stagger to the first ~12 rows).
- A lecture or section becoming done: the ✓ draws in (SVG stroke-dashoffset) — only on the change,
  never on first render.
- First paint of home: stats count up (≤ 700 ms, ease-out); chart bars grow from the baseline with a
  small stagger; nothing starts hidden (complete at rest for screenshots — animate from a visible state).
- "From Rahul" card: a soft rise on arrival; "Got it" collapses it smoothly.
- Sign-off card: rises in; Send → a check morph → closes.
- Durations 150–300 ms, `cubic-bezier(.2,.8,.2,1)`-style ease-out; springy only where it means
  something. `prefers-reduced-motion: reduce` turns every one of these off (instant states).
  No `transition-colors` on state indicators.

## B. JS Journey changes (`~/Developer/js-journey`, branch `react-course`)

### Data (migration 0003, additive, applied after 0002)
- `log_entries.stuck boolean not null default false`, `log_entries.auto_closed boolean not null
  default false`, `log_entries.coach_read_at timestamptz` (backfill: every existing row read = now(),
  so history does not flood the unread inbox).
- `messages.log_entry_id uuid null references log_entries(id)` (a reply), `messages.student_read_at
  timestamptz` (backfill existing coach messages as read).
- `progress_snapshots(course course_id primary key, payload jsonb not null, updated_at timestamptz not null)`.
- Indexes for the feed: `log_entries(course, created_at desc)`, `messages(log_entry_id)`.

### API (Bearer = her student token, no-store, validated like the existing player routes)
- `GET /api/player/status` adds `sectionDue` and `skippedSections`.
- `POST /api/player/sessions` stores `stuck`, `autoClosed`, and upserts `progress` into
  `progress_snapshots` (only if newer `takenAt`). `minutes` may be 0 when `note` is non-empty.
- `GET /api/player/feed?course=react-2023&cursor=&limit=30` → `JourneyFeed`, paginated in SQL.
- `POST /api/player/feed/read {ids}` → sets `student_read_at` on those coach messages (idempotent).
- `PUT /api/player/progress` → upsert snapshot if newer.

### Coach view `/r/<token>` (redesign)
Top: Mansi · React · pace pill · due date. Then **Unread updates** (prominent): each shows date, time
studied, lectures, section, mood, stuck flag, her note, and an inline reply box (server action:
insert coach message with `log_entry_id`, mark the update read). "Mark read" without replying. Then
a "Send Mansi a note" composer (standalone note). Then **her stats — the same ones she sees**
(Today, Streak, Complete, Due + the 30-day chart, current lecture) computed from the latest snapshot
(+ sessions as fallback). Then the plan (weekly goals with status, the Diwali break). Then the
**history**: read updates with their replies, paginated. JS course history behind a quiet link.
Unread count in the tab title.

### Student view `/m/<token>` (redesign, phone-friendly mirror)
Rahul's feedback first (marks read when shown, like the player) → this week / due / pace → her
history (updates + replies) → a manual sign-off form (for study away from the player; creates a
`manual` update). Warm to her; honest to him.

### Visual system
Port the course player's `docs/design.md` tokens, type scale, spacing, elevation and motion rules
into JS Journey (Tailwind v4 there as well). System font stack (no Fraunces / Plex anymore). Light +
dark. The same quiet, essentialist feel.
